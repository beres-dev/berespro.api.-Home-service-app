// src/routes/jobs.js — lifecycle. Confirm triggers PSP CAPTURE (release + split).
import { json, err, id, now, readBody } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { createNotif } from "./bids.js";
import { captureForTask, refundForTask } from "./payments.js";
import { hasOpenDispute } from "./disputes.js";
import { audit } from "../lib/guard.js";
import { pushNotify } from "../lib/notify.js";

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

// POST /jobs/:taskId/cancel  (customer cancels an in-progress job -> refund hold)
export async function cancelJob(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(params.taskId).first();
  if (!task) return err("not found", 404);
  if (task.customer_id !== user.id) return err("forbidden", 403);
  if (task.status !== "inprogress") return err("task not in progress", 409);
  if (await hasOpenDispute(env, task.id))
    return err("cannot cancel — a dispute is open; support will resolve it", 409, "dispute_open");
  await refundForTask(env, task.id);
  await audit(env, user.id, "payment.refund", task.id, {});
  await env.DB.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").bind(task.id).run();
  const bid = await env.DB.prepare("SELECT partner_id FROM bids WHERE id=?").bind(task.accepted_bid_id).first();
  if (bid) await createNotif(env, bid.partner_id, "job", "Job cancelled", `${task.title} — the hold was refunded to the customer`);
  return json({ ok: true });
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
