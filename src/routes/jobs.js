// src/routes/jobs.js — lifecycle. Confirm triggers PSP CAPTURE (release + split).
import { json, err, id, now, readBody } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { createNotif } from "./bids.js";
import { captureForTask, refundForTask, compensatePartnerOnCancel } from "./payments.js";
import { hasOpenDispute } from "./disputes.js";
import { audit } from "../lib/guard.js";
import { pushNotify } from "../lib/notify.js";
import { cancelPolicy } from "../lib/settings.js";

// POST /jobs/:taskId/complete  (partner marks work done)
export async function markComplete(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(params.taskId).first();
  if (!task) return err("not found", 404);
  if (task.status !== "inprogress") return err("task not in progress", 409);
  const bid = await env.DB.prepare("SELECT partner_id FROM bids WHERE id=?").bind(task.accepted_bid_id).first();
  if (!bid || bid.partner_id !== user.id) return err("forbidden", 403);
  await createNotif(env, task.customer_id, "job", "Work marked complete",
    `${task.title} — confirm to release payment`);
  await pushNotify(env, task.customer_id, "Job marked complete", `Confirm: ${task.title}`);
  return json({ ok: true });
}

// POST /jobs/:taskId/confirm  (customer confirms -> CAPTURE payment, split 80/20)
export async function confirmComplete(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(params.taskId).first();
  if (!task) return err("not found", 404);
  if (task.customer_id !== user.id) return err("forbidden", 403);
  if (task.status !== "inprogress") return err("task not in progress", 409);
  if (await hasOpenDispute(env, task.id))
    return err("payment frozen — a dispute is open on this job", 409, "dispute_open");

  const cap = await captureForTask(env, task.id);
  if (!cap.ok) return err("could not release payment: " + cap.reason, 409);

  await env.DB.prepare("UPDATE tasks SET status='completed' WHERE id=?").bind(task.id).run();
  await audit(env, user.id, "payment.capture", task.id, { net: cap.net_cents, fee: cap.fee_cents });
  return json({ ok: true, released_net_cents: cap.net_cents, platform_fee_cents: cap.fee_cents });
}

// POST /jobs/:taskId/cancel  (customer cancels an in-progress job)
//
// Fairness: the partner reserved the slot, maybe turned other work down, maybe
// already travelled. A full free refund at any time puts all of that cost on
// the partner. Policy (admin-tunable in settings):
//   - within cancel_grace_min of the funds being held: free, full refund
//   - after grace: cancel_fee_bps of the agreed price is captured and paid to
//     the partner as compensation (platform commission applies to it like any
//     other payment); the remainder of the hold is refunded to the customer
export async function cancelJob(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(params.taskId).first();
  if (!task) return err("not found", 404);
  if (task.customer_id !== user.id) return err("forbidden", 403);
  if (task.status !== "inprogress") return err("task not in progress", 409);
  if (await hasOpenDispute(env, task.id))
    return err("cannot cancel — a dispute is open; support will resolve it", 409, "dispute_open");

  const b = await readBody(req).catch(() => ({}));
  const pay = await env.DB.prepare(
    "SELECT * FROM payments WHERE task_id=? AND status='held'").bind(task.id).first();
  const { graceMin, feeBps } = await cancelPolicy(env);
  const heldFor = pay ? now() - pay.updated_at : 0;
  // graceMin=0 means "no free window at all", so the time check only applies
  // when a window exists.
  const inGrace = !pay || feeBps === 0 || (graceMin > 0 && heldFor <= graceMin * 60);

  // Snapshot the gross BEFORE any write: compensatePartnerOnCancel rewrites the
  // payments row, and a DB layer that hands back live references (MockDB does)
  // would otherwise corrupt this arithmetic mid-flight.
  const grossCents = pay ? pay.amount_cents : 0;
  // What the customer actually paid: gross minus any voucher discount. The
  // hold at the PSP is for THIS amount, so every customer-facing number and
  // the capture cap must come from it, not from gross.
  const paidCents = pay ? grossCents - (pay.discount_cents || 0) : 0;
  let compensation = 0, refunded = paidCents;
  if (inGrace) {
    await refundForTask(env, task.id);
    await audit(env, user.id, "payment.refund", task.id, { grace: true });
  } else {
    // Fee is a % of the AGREED price — the partner's loss is not smaller just
    // because the platform funded a discount — but it can never exceed the
    // money actually held.
    const comp = Math.min(Math.round((grossCents * feeBps) / 10000), paidCents);
    const r = await compensatePartnerOnCancel(env, task.id, comp);
    if (!r.ok) return err("cancellation failed — try again or contact support", 502, "cancel_failed");
    compensation = comp; refunded = paidCents - comp;
    await audit(env, user.id, "payment.cancel_fee", task.id,
      { fee_bps: feeBps, compensation_cents: comp, refunded_cents: refunded });
  }

  await env.DB.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").bind(task.id).run();
  await recordCancellation(env, task.id, user.id, "customer", "inprogress", b.reason);
  const bid = await env.DB.prepare("SELECT partner_id FROM bids WHERE id=?").bind(task.accepted_bid_id).first();
  if (bid) {
    await createNotif(env, bid.partner_id, "job", "Job cancelled",
      compensation > 0
        ? `${task.title} — the customer cancelled. A cancellation fee of RM ${(compensation/100).toFixed(2)} is being paid out to you as compensation.`
        : `${task.title} — the hold was refunded to the customer`);
  }
  return json({ ok: true, in_grace: inGrace,
                compensation_cents: compensation, refunded_cents: refunded });
}

// POST /jobs/:taskId/review  body: { rating, text }
export async function postReview(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(params.taskId).first();
  if (!task) return err("not found", 404);
  if (task.status !== "completed") return err("job not completed", 409);
  const b = await readBody(req);
  const rating = parseInt(b.rating, 10);
  if (!(rating >= 1 && rating <= 5)) return err("rating 1..5 required", 400);
  const bid = await env.DB.prepare("SELECT partner_id FROM bids WHERE id=?").bind(task.accepted_bid_id).first();
  let rateeId;
  if (user.id === task.customer_id) rateeId = bid.partner_id;
  else if (user.id === bid.partner_id) rateeId = task.customer_id;
  else return err("forbidden", 403);
  try {
    await env.DB.prepare(
      "INSERT INTO reviews (id,task_id,rater_id,ratee_id,rating,text,created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(id("rev"), task.id, user.id, rateeId, rating, b.text || null, now()).run();
  } catch { return err("already reviewed", 409); }
  await createNotif(env, rateeId, "star", `You received a ${rating}-star rating`, b.text || "");
  return json({ ok: true });
}

/* ---------------------------------------------------------------------------
   Cancellation. The Refund & Cancellation Policy promises four behaviours that
   the code did not implement, so a customer could not even delete a task posted
   by mistake, and a partner who won a job had no way out. Building them here so
   the product matches the contract users agree to.
--------------------------------------------------------------------------- */

const PARTNER_STRIKE_WINDOW_DAYS = 30;
const PARTNER_STRIKE_LIMIT = 3;

async function recordCancellation(env, taskId, userId, role, stage, reason) {
  await env.DB.prepare(
    "INSERT INTO cancellations (id,task_id,user_id,role,stage,reason,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(id("can"), taskId, userId, role, stage, reason || null, now()).run();
}

// Rolling 30-day count, per the policy: "three within 30 days may lead to
// temporary suspension". We surface it; we do not auto-suspend, because a
// wrongly-suspended partner loses income and that deserves a human decision.
async function partnerStrikes(env, userId) {
  const since = now() - PARTNER_STRIKE_WINDOW_DAYS * 86400;
  const r = await env.DB.prepare(
    "SELECT COUNT(*) n FROM cancellations WHERE user_id=? AND role='partner' AND created_at >= ?"
  ).bind(userId, since).first();
  return r ? r.n : 0;
}

// POST /tasks/:taskId/cancel   (customer, task still open — no money involved)
export async function cancelOpenTask(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(params.id).first();
  if (!task) return err("not found", 404);
  if (task.customer_id !== user.id) return err("forbidden", 403);
  if (task.status !== "open") return err("task is no longer open", 409, "not_open");

  const b = await readBody(req).catch(() => ({}));
  await env.DB.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").bind(task.id).run();
  await env.DB.prepare("UPDATE bids SET status='lost' WHERE task_id=?").bind(task.id).run();
  await recordCancellation(env, task.id, user.id, "customer", "open", b.reason);
  await audit(env, user.id, "task.cancel_open", task.id, {});

  // Anyone who bid deserves to know, so they stop waiting on it.
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT partner_id FROM bids WHERE task_id=?").bind(task.id).all();
  for (const r of results) {
    await createNotif(env, r.partner_id, "job", "Task withdrawn",
      `${task.title} \u2014 the customer cancelled before choosing a partner`);
  }
  return json({ ok: true, refund: null });
}

// DELETE /bids/:bidId   (partner withdraws their own bid, before acceptance)
export async function withdrawBid(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const bid = await env.DB.prepare("SELECT * FROM bids WHERE id=?").bind(params.id).first();
  if (!bid) return err("not found", 404);
  if (bid.partner_id !== user.id) return err("forbidden", 403);
  if (bid.status !== "pending") return err("bid already settled", 409, "bid_settled");

  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(bid.task_id).first();
  if (task && task.status !== "open") return err("task no longer open", 409, "not_open");

  await env.DB.prepare("UPDATE bids SET status='withdrawn' WHERE id=?").bind(bid.id).run();
  await audit(env, user.id, "bid.withdraw", bid.id, { task_id: bid.task_id });
  // Withdrawing a bid nobody accepted costs the customer nothing, so it is not
  // a strike. Only walking away from a job you won is.
  if (task) {
    await createNotif(env, task.customer_id, "bid", "A bid was withdrawn",
      `${user.name} withdrew their offer on "${task.title}"`);
  }
  return json({ ok: true });
}

// POST /jobs/:taskId/partner-cancel   (partner walks away from a job they won)
export async function partnerCancelJob(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(params.taskId).first();
  if (!task) return err("not found", 404);
  if (task.status !== "inprogress") return err("job not in progress", 409);
  if (!task.accepted_bid_id) return err("no accepted bid", 409);

  const bid = await env.DB.prepare("SELECT * FROM bids WHERE id=?").bind(task.accepted_bid_id).first();
  if (!bid || bid.partner_id !== user.id) return err("forbidden", 403);
  if (await hasOpenDispute(env, task.id))
    return err("cannot cancel \u2014 a dispute is open; support will resolve it", 409, "dispute_open");

  const b = await readBody(req).catch(() => ({}));
  // The customer must not be out of pocket because the partner changed their mind.
  await refundForTask(env, task.id);
  await env.DB.prepare("UPDATE tasks SET status='open', accepted_bid_id=NULL WHERE id=?").bind(task.id).run();
  await env.DB.prepare("UPDATE bids SET status='withdrawn' WHERE id=?").bind(bid.id).run();
  await recordCancellation(env, task.id, user.id, "partner", "inprogress", b.reason);
  await audit(env, user.id, "job.partner_cancel", task.id, { refunded: true });

  const strikes = await partnerStrikes(env, user.id);
  await createNotif(env, task.customer_id, "job", "Partner cancelled",
    `${user.name} withdrew from "${task.title}". You were refunded in full; the task is open for bids again.`);
  await pushNotify(env, task.customer_id, "Partner cancelled", `${task.title} \u2014 refunded, task reopened`);

  return json({ ok: true, refunded: true, strikes,
                warning: strikes >= PARTNER_STRIKE_LIMIT
                  ? `${strikes} cancellations in the last ${PARTNER_STRIKE_WINDOW_DAYS} days. Further cancellations may suspend your account.`
                  : null });
}
