// src/routes/disputes.js — freeze escrow until an admin resolves.
// PROTECTS CUSTOMERS: money isn't released while contested.
// PROTECTS PARTNERS: customers can't unilaterally refund once work started —
// cancel is blocked while a dispute is open; an admin decides.
import { json, err, id, now, readBody } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { vstr, audit } from "../lib/guard.js";
import { createNotif } from "./bids.js";
import { captureForTask, refundForTask } from "./payments.js";

// POST /jobs/:taskId/dispute  body: { reason }  (customer OR partner on the task)
export async function openDispute(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(params.taskId).first();
  if (!task) return err("not found", 404);
  if (task.status !== "inprogress") return err("disputes only on in-progress jobs", 409);
  const bid = await env.DB.prepare("SELECT partner_id FROM bids WHERE id=?").bind(task.accepted_bid_id).first();
  if (user.id !== task.customer_id && (!bid || user.id !== bid.partner_id)) return err("forbidden", 403);

  const existing = await env.DB.prepare(
    "SELECT id FROM disputes WHERE task_id=? AND status='open'").bind(task.id).first();
  if (existing) return err("a dispute is already open", 409);

  const reason = vstr((await readBody(req)).reason, 1000);
  if (!reason) return err("reason required (max 1000 chars)", 400);

  const did = id("dsp");
  await env.DB.prepare(
    "INSERT INTO disputes (id,task_id,opened_by,reason,status,created_at) VALUES (?,?,?,?, 'open', ?)"
  ).bind(did, task.id, user.id, reason, now()).run();
  await audit(env, user.id, "dispute.open", did, { task: task.id });

  const other = user.id === task.customer_id ? bid.partner_id : task.customer_id;
  await createNotif(env, other, "job", "A dispute was opened",
    `${task.title} — payment is frozen until Berespro support resolves it.`);
  return json({ dispute_id: did, status: "open" }, 201);
}

// helper used by jobs.confirm / jobs.cancel to block while contested
export async function hasOpenDispute(env, taskId) {
  const d = await env.DB.prepare("SELECT id FROM disputes WHERE task_id=? AND status='open'")
    .bind(taskId).first();
  return !!d;
}

// POST /disputes/:id/resolve  (ADMIN)  body: { action: "refund"|"release", note? }
export async function resolveDispute(req, env, params) {
  const admin = await requireUser(req, env);
  if (!admin) return err("unauthorized", 401);
  if (!env.ADMIN_IDS || !env.ADMIN_IDS.split(",").includes(admin.id)) return err("forbidden", 403);
  const d = await env.DB.prepare("SELECT * FROM disputes WHERE id=?").bind(params.id).first();
  if (!d) return err("not found", 404);
  if (d.status !== "open") return err("already resolved", 409);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(d.task_id).first();
  const b = await readBody(req);
  const note = vstr(b.note || "", 500) || null;

  if (b.action === "refund") {
    await refundForTask(env, d.task_id);
    await env.DB.batch([
      env.DB.prepare("UPDATE disputes SET status='resolved_refund', resolved_by=?, resolution_note=?, resolved_at=? WHERE id=?")
        .bind(admin.id, note, now(), d.id),
      env.DB.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").bind(d.task_id),
    ]);
    await audit(env, admin.id, "dispute.resolve", d.id, { action: "refund", task: d.task_id });
    await createNotif(env, task.customer_id, "pay", "Dispute resolved — refund issued",
      `${task.title} — the held payment was returned to you.`);
    return json({ ok: true, resolution: "refund" });
  }
  if (b.action === "release") {
    const cap = await captureForTask(env, d.task_id);
    if (!cap.ok) return err("release failed: " + cap.reason, 409);
    await env.DB.batch([
      env.DB.prepare("UPDATE disputes SET status='resolved_release', resolved_by=?, resolution_note=?, resolved_at=? WHERE id=?")
        .bind(admin.id, note, now(), d.id),
      env.DB.prepare("UPDATE tasks SET status='completed' WHERE id=?").bind(d.task_id),
    ]);
    await audit(env, admin.id, "dispute.resolve", d.id, { action: "release", task: d.task_id });
    return json({ ok: true, resolution: "release" });
  }
  return err("action must be refund or release", 400);
}

// GET /disputes/open  (ADMIN) — queue
export async function openDisputes(req, env) {
  const admin = await requireUser(req, env);
  if (!admin) return err("unauthorized", 401);
  if (!env.ADMIN_IDS || !env.ADMIN_IDS.split(",").includes(admin.id)) return err("forbidden", 403);
  const { results } = await env.DB.prepare(
    "SELECT d.*, t.title FROM disputes d JOIN tasks t ON t.id=d.task_id WHERE d.status='open' ORDER BY d.created_at ASC LIMIT 50"
  ).all();
  return json({ disputes: results });
}
