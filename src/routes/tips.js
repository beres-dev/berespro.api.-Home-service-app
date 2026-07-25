// src/routes/tips.js — a customer thanking a partner after the job is done.
//
// RULES, and why:
//   100% TO THE PARTNER. The platform takes no cut of a tip. A tip is a gift
//     between two people; skimming it would be indefensible, and partners would
//     find out and stop trusting the number they see.
//   NO ESCROW. Escrow protects the customer before the work happens. This is
//     after — there is nothing left to protect against, so it charges straight
//     through instead of sitting in a held state nobody will release.
//   ONLY AFTER COMPLETION, ONLY THE CUSTOMER, ONLY ONCE. A unique index on
//     task_id enforces once at the database level, not just in this function.
//   NOT WHILE A DISPUTE IS OPEN. Money and a dispute do not mix; and a tip
//     during a dispute would muddy what was actually paid for the work.

import { json, err, now, readBody, id } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { vint, audit } from "../lib/guard.js";
import { hasOpenDispute } from "./disputes.js";
import { createNotif } from "./bids.js";

const TIP_MIN_CENTS = 100;      // RM1 — below this it is noise, not thanks
const TIP_MAX_CENTS = 50000;    // RM500 — a ceiling against fat fingers and fraud

// GET /jobs/:taskId/tip — what the app needs to decide whether to offer tipping.
export async function getTip(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT id, customer_id, status FROM tasks WHERE id=?")
    .bind(params.taskId).first();
  if (!task) return err("not found", 404);
  const tip = await env.DB.prepare("SELECT amount_cents, status, created_at FROM tips WHERE task_id=?")
    .bind(task.id).first();
  return json({
    tip: tip || null,
    can_tip: task.customer_id === user.id && task.status === "completed" && !tip,
    min_cents: TIP_MIN_CENTS, max_cents: TIP_MAX_CENTS,
  });
}

// POST /jobs/:taskId/tip  body: { amount_cents }
export async function createTip(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);

  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(params.taskId).first();
  if (!task) return err("not found", 404);
  if (task.customer_id !== user.id) return err("forbidden", 403);
  if (task.status !== "completed")
    return err("you can tip once the job is complete", 409, "not_complete");
  if (await hasOpenDispute(env, task.id))
    return err("there's an open dispute on this job — tipping is paused", 409, "dispute_open");

  const existing = await env.DB.prepare("SELECT id FROM tips WHERE task_id=?").bind(task.id).first();
  if (existing) return err("you've already tipped for this job", 409, "already_tipped");

  const b = await readBody(req);
  const amount = vint(b.amount_cents, TIP_MIN_CENTS, TIP_MAX_CENTS);
  if (amount === null)
    return err(`tip must be between RM${TIP_MIN_CENTS/100} and RM${TIP_MAX_CENTS/100}`, 400, "bad_amount");

  // Who gets it: the partner who actually did the work, via the accepted bid.
  if (!task.accepted_bid_id) return err("no partner on this job", 409);
  const bid = await env.DB.prepare("SELECT partner_id FROM bids WHERE id=?")
    .bind(task.accepted_bid_id).first();
  if (!bid) return err("no partner on this job", 409);

  // Charged, not held. Until a live PSP is wired the charge is simulated and the
  // row is marked captured so earnings reflect it; the money movement itself
  // arrives with the PSP. The status column is what will tell them apart.
  const tid = id("tip");
  const simulated = !env.XENDIT_SECRET_KEY;
  await env.DB.prepare(
    "INSERT INTO tips (id,task_id,customer_id,partner_id,amount_cents,status,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(tid, task.id, user.id, bid.partner_id, amount, simulated ? "captured" : "pending", now()).run();

  try {
    await createNotif(env, bid.partner_id, "payment", "You received a tip",
      `${task.title} — RM${(amount/100).toFixed(2)}, all yours.`);
  } catch (_) {}
  await audit(env, user.id, "tip.create", task.id, { amount_cents: amount, partner: bid.partner_id });

  return json({ ok: true, tip: { id: tid, amount_cents: amount, status: simulated ? "captured" : "pending" } }, 201);
}
