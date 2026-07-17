// src/routes/payments.js — PSP escrow: webhook, capture on completion, status read.
import { json, err, id, now, readBody, sha256hex } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { capturePayment, voidPayment, verifyWebhook } from "../lib/psp.js";
import { createNotif } from "./bids.js";
import { pushNotify } from "../lib/notify.js";
import { audit } from "../lib/guard.js";

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
  // Xendit signs webhooks with a static token in x-callback-token, not an HMAC.
  // An unverified webhook can move money, so this is a hard gate.
  if (!verifyWebhook(env, req)) return err("bad callback token", 401);

  const raw = await req.text();
  let ev;
  try { ev = JSON.parse(raw); } catch { return json({ ok: true }); }

  // Xendit shape: { event, business_id, created, data: { payment_id, payment_request_id,
  //                 reference_id, status, channel_properties: { card_details: {...} } } }
  const event = ev.event || "";
  const d = ev.data || {};

  // --- partner sub-account went live (xenPlatform) ---
  if (/account/i.test(event)) {
    const accId = d.id || d.account_id || ev.id;
    if (accId && /LIVE|ACTIVE/i.test(d.status || ev.status || "")) {
      await env.DB.prepare("UPDATE partner_merchants SET status='active', updated_at=? WHERE psp_merchant_id=?")
        .bind(now(), accId).run();
    }
    return json({ ok: true });
  }

  // reference_id is the id we generated; payment_request_id is what we stored as psp_ref.
  const ourRef = d.reference_id || null;
  const prId = d.payment_request_id || null;
  const pyId = d.payment_id || null;

  let pay = null;
  if (ourRef) pay = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(ourRef).first();
  if (!pay && prId) pay = await env.DB.prepare("SELECT * FROM payments WHERE psp_ref=?").bind(prId).first();
  // Unknown payment: ack anyway. Xendit retries 6 times on non-2xx, and retrying
  // something we will never recognise just generates noise.
  if (!pay) return json({ ok: true });

  // Capture needs the payment id, and the card fingerprint only appears here.
  // Record both the first time we see them.
  const fp = (d.channel_properties && d.channel_properties.card_details &&
              d.channel_properties.card_details.fingerprint) || null;
  if ((pyId && !pay.psp_payment_id) || (fp && !pay.card_fp)) {
    await env.DB.prepare("UPDATE payments SET psp_payment_id=COALESCE(?,psp_payment_id), card_fp=COALESCE(?,card_fp), updated_at=? WHERE id=?")
      .bind(pyId, fp, now(), pay.id).run();
    pay = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(pay.id).first();
  }

  const status = d.status || "";

  // --- money is now HELD on the customer's card -> finalise acceptance ---
  if (event === "payment.authorization" || status === "AUTHORIZED") {
    if (pay.status !== "pending") return json({ ok: true });   // idempotent
    await onHeld(env, pay);
    return json({ ok: true });
  }

  // --- captured: money released and split ---
  if (event === "payment.capture" || status === "SUCCEEDED") {
    if (pay.status === "captured") return json({ ok: true });
    await env.DB.prepare("UPDATE payments SET status='captured', updated_at=? WHERE id=?").bind(now(), pay.id).run();
    return json({ ok: true });
  }

  // --- failed / cancelled / expired ---
  if (event === "payment.failure" || status === "FAILED") {
    await env.DB.prepare("UPDATE payments SET status='failed', updated_at=? WHERE id=?").bind(now(), pay.id).run();
    return json({ ok: true });
  }
  if (/CANCELL?ED|EXPIRED/i.test(status)) {
    await env.DB.prepare("UPDATE payments SET status='refunded', updated_at=? WHERE id=?").bind(now(), pay.id).run();
    return json({ ok: true });
  }

  return json({ ok: true });
}

// Finalize acceptance once the PSP is holding the funds.
export async function onHeld(env, pay) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(pay.task_id).first();
  if (!task || task.status !== "open") {
    // task changed since accept — safest is to give the hold back
    await voidPayment(env, { pspRef: pay.psp_ref, pspPaymentId: pay.psp_payment_id, captured: false });
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
    `${task.title} \u2014 payment secured. Start when ready.`);
  await pushNotify(env, pay.partner_id, "Bid accepted!", `You won: ${task.title}`);

  // A real card is the customer's strongest identity signal: the bank already
  // verified them. But one card can quietly fund many accounts, so we flag reuse
  // rather than trust it blindly. Flag, never block: families share cards.
  try { await flagCardReuse(env, pay); } catch (_) {}
}

const CARD_REUSE_MAX_ACCOUNTS = 3;
async function flagCardReuse(env, pay) {
  if (!pay.card_fp) return;   // PSP gave us no fingerprint; nothing to check
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT customer_id FROM payments WHERE card_fp = ?"
  ).bind(pay.card_fp).all();
  // Dedupe here too: never depend on the DB honouring DISTINCT to get this right.
  const accounts = [...new Set(results.map((r) => r.customer_id))];
  if (accounts.length < CARD_REUSE_MAX_ACCOUNTS) return;

  await audit(env, pay.customer_id, "card_reuse_flagged", pay.id, {
    card_fp: pay.card_fp,
    account_count: accounts.length,
    accounts,
  });
}

// Internal: capture the held payment for a task (called from jobs.confirm).
export async function captureForTask(env, taskId) {
  const pay = await env.DB.prepare("SELECT * FROM payments WHERE task_id=? AND status='held'").bind(taskId).first();
  if (!pay) return { ok: false, reason: "no_held_payment" };
  const merch = await env.DB.prepare("SELECT psp_merchant_id FROM partner_merchants WHERE user_id=?")
    .bind(pay.partner_id).first();
  const cap = await capturePayment(env, {
    pspRef: pay.psp_ref,
    pspPaymentId: pay.psp_payment_id,   // Xendit captures by PAYMENT id, not request id
    amountCents: pay.amount_cents,      // capture the full authorised amount
    netCents: pay.net_cents,
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
  // Still held means nothing was taken yet, so this cancels the authorisation
  // rather than refunding a settled charge.
  await voidPayment(env, { pspRef: pay.psp_ref, pspPaymentId: pay.psp_payment_id,
                           amountCents: pay.amount_cents, captured: false });
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
