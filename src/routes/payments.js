// src/routes/payments.js — PSP escrow: webhook, capture on completion, status read.
import { json, err, id, now, readBody, sha256hex } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { capturePayment, voidPayment } from "../lib/psp.js";
import { createNotif } from "./bids.js";
import { pushNotify } from "../lib/notify.js";

// GET /payments/:id  (customer or partner on that payment)
export async function getPayment(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const p = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(params.id).first();
  if (!p) return err("not found", 404);
  if (p.customer_id !== user.id && p.partner_id !== user.id) return err("forbidden", 403);
  return json({ payment: shapePayment(p) });
}

// POST /webhooks/psp  (called by the gateway)
// Handles: funds held (finalize acceptance), captured, refunded, merchant activated.
export async function pspWebhook(req, env) {
  const raw = await req.text();
  const sig = req.headers.get("x-signature") || "";
  const expected = await sha256hex(raw + env.PSP_SECRET);
  // SECURITY: signature is REQUIRED — an unsigned webhook is rejected.
  if (!sig || sig !== expected) return err("bad signature", 401);

  let ev;
  try { ev = JSON.parse(raw); } catch { ev = Object.fromEntries(new URLSearchParams(raw)); }

  const type = ev.type || ev.event || ev.status; // provider-specific; adapt in your adapter
  const pspRef = ev.reference || ev.id || ev.payment_id || ev.ref;

  // --- merchant activation ---
  if (type === "merchant.activated" || ev.merchant_status === "active") {
    const mref = ev.merchant_reference || ev.reference; // we passed userId as reference
    if (mref) {
      await env.DB.prepare("UPDATE partner_merchants SET status='active', updated_at=? WHERE user_id=?")
        .bind(now(), mref).run();
    }
    return json({ ok: true });
  }

  if (!pspRef) return json({ ok: true });
  const pay = await env.DB.prepare("SELECT * FROM payments WHERE psp_ref=?").bind(pspRef).first();
  if (!pay) return json({ ok: true });

  // --- funds now HELD -> finalize the acceptance (idempotent) ---
  if (type === "payment.held" || type === "authorized" || ev.state === "held") {
    if (pay.status !== "pending") return json({ ok: true });
    await onHeld(env, pay);
    return json({ ok: true });
  }

  // --- captured (release done) ---
  if (type === "payment.captured" || ev.state === "captured") {
    if (pay.status === "captured") return json({ ok: true });
    await env.DB.prepare("UPDATE payments SET status='captured', updated_at=? WHERE id=?").bind(now(), pay.id).run();
    return json({ ok: true });
  }

  // --- refunded/voided ---
  if (type === "payment.refunded" || ev.state === "refunded" || ev.state === "voided") {
    await env.DB.prepare("UPDATE payments SET status='refunded', updated_at=? WHERE id=?").bind(now(), pay.id).run();
    return json({ ok: true });
  }

  // --- failed ---
  if (type === "payment.failed" || ev.state === "failed") {
    await env.DB.prepare("UPDATE payments SET status='failed', updated_at=? WHERE id=?").bind(now(), pay.id).run();
    return json({ ok: true });
  }

  return json({ ok: true });
}

// Finalize acceptance once the PSP is holding the funds.
export async function onHeld(env, pay) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(pay.task_id).first();
  if (!task || task.status !== "open") {
    // task changed since accept — safest is to refund the hold
    await voidPayment(env, { pspRef: pay.psp_ref });
    await env.DB.prepare("UPDATE payments SET status='refunded', updated_at=? WHERE id=?").bind(now(), pay.id).run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE payments SET status='held', updated_at=? WHERE id=?").bind(now(), pay.id),
    env.DB.prepare("UPDATE bids SET status='accepted' WHERE id=?").bind(pay.bid_id),
    env.DB.prepare("UPDATE bids SET status='lost' WHERE task_id=? AND id!=?").bind(pay.task_id, pay.bid_id),
    env.DB.prepare("UPDATE tasks SET status='inprogress', accepted_bid_id=? WHERE id=?").bind(pay.bid_id, pay.task_id),
  ]);
  await createNotif(env, pay.partner_id, "job", "Your bid was accepted",
    `${task.title} — payment secured. Start when ready.`);
  await pushNotify(env, pay.partner_id, "Bid accepted!", `You won: ${task.title}`);
}

// Internal: capture the held payment for a task (called from jobs.confirm).
export async function captureForTask(env, taskId) {
  const pay = await env.DB.prepare("SELECT * FROM payments WHERE task_id=? AND status='held'").bind(taskId).first();
  if (!pay) return { ok: false, reason: "no_held_payment" };
  const merch = await env.DB.prepare("SELECT psp_merchant_id FROM partner_merchants WHERE user_id=?")
    .bind(pay.partner_id).first();
  const cap = await capturePayment(env, {
    pspRef: pay.psp_ref, netCents: pay.net_cents,
    feeCents: pay.fee_cents - (pay.discount_cents || 0),
    partnerMerchantId: merch ? merch.psp_merchant_id : null,
  });
  if (!cap.ok) return { ok: false, reason: "capture_failed" };
  await env.DB.prepare("UPDATE payments SET status='captured', updated_at=? WHERE id=?").bind(now(), pay.id).run();
  await createNotif(env, pay.partner_id, "pay", `Payment released — RM ${(pay.net_cents/100).toFixed(2)}`,
    `Your 80% share for the completed job is on the way to your bank.`);
  return { ok: true, net_cents: pay.net_cents, fee_cents: pay.fee_cents };
}

// Internal: refund the held payment for a task (cancel/dispute).
export async function refundForTask(env, taskId) {
  const pay = await env.DB.prepare("SELECT * FROM payments WHERE task_id=? AND status='held'").bind(taskId).first();
  if (!pay) return { ok: false };
  await voidPayment(env, { pspRef: pay.psp_ref });
  await env.DB.prepare("UPDATE payments SET status='refunded', updated_at=? WHERE id=?").bind(now(), pay.id).run();
  return { ok: true };
}

// GET /me/earnings  (partner) — captured payouts + totals
export async function myEarnings(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const { results } = await env.DB.prepare(
    "SELECT p.id, p.net_cents, p.amount_cents, p.updated_at, t.title FROM payments p " +
    "JOIN tasks t ON t.id = p.task_id WHERE p.partner_id=? AND p.status='captured' " +
    "ORDER BY p.updated_at DESC LIMIT 100"
  ).bind(user.id).all();
  const total = results.reduce((s, r) => s + r.net_cents, 0);
  const held = await env.DB.prepare(
    "SELECT COALESCE(SUM(net_cents),0) s FROM payments WHERE partner_id=? AND status='held'"
  ).bind(user.id).first();
  return json({ total_earned_cents: total, pending_release_cents: held.s, payouts: results });
}

// GET /dev/simulate-pay?ref=sim_xxx
// DEV ONLY (env.DEV_LOGIN === "1"): stands in for the PSP payment page — marks the
// payment as held via the same finalization path the real webhook uses.
export async function devSimulatePay(req, env) {
  if (env.DEV_LOGIN !== "1") return err("not found", 404);
  const ref = new URL(req.url).searchParams.get("ref");
  if (!ref) return err("ref required", 400);
  const pay = await env.DB.prepare("SELECT * FROM payments WHERE psp_ref=?").bind(ref).first();
  if (!pay) return err("payment not found", 404);
  if (pay.status === "pending") await onHeld(env, pay);
  return new Response(
    "<html><body style='font-family:sans-serif;background:#0B1526;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
    "<div style='text-align:center'><div style='font-size:48px'>&#10003;</div><h2>Payment simulated (DEV)</h2>" +
    "<p style='color:#9FB0CF'>Funds are now held. Return to the Berespro app.</p></div></body></html>",
    { headers: { "content-type": "text/html" } });
}

export function shapePayment(p) {
  return { id: p.id, task_id: p.task_id, status: p.status,
           amount_cents: p.amount_cents, fee_cents: p.fee_cents, net_cents: p.net_cents,
           created_at: p.created_at, updated_at: p.updated_at };
}

// GET /dev/simulate-pay?ref=sim_pay_xxx
// DEV ONLY (env.DEV_LOGIN === "1"). Simulates the customer completing payment at
