// src/routes/messages.js — in-app chat between a customer and a partner.
//
// THREAD IDENTITY: (task_id, partner_id). One open task can have several bidding
// partners, so the customer has one thread PER partner; each partner only ever
// sees their own. A partner can never see another partner's thread, and a bid
// amount is never inferable from a thread they cannot read.
//
// WHY THIS EXISTS: without chat, a partner who needs to ask "is there back-door
// access?" has to swap phone numbers, and the moment they do that the job leaves
// the platform — the customer and partner settle privately, Berespro loses the
// commission and any record for a dispute. Chat keeps the conversation where the
// escrow, the audit trail, and the dispute evidence are.
//
// ACCESS RULE (enforced on every call): you may touch a thread only if you are
// the task's customer, or a partner who has actually bid on that task. Anything
// else is 403. Suspended accounts are already rejected by requireUser.

import { json, err, id, now, readBody } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { rateLimit, vstr, LIMITS } from "../lib/guard.js";
import { createNotif } from "./bids.js";
import { pushNotify } from "../lib/notify.js";

const MSGS_PER_HOUR = 120;   // generous for real talk, useless for spamming

// Resolve the thread and authorise the caller in one step. Returns
// { task, partnerId, isCustomer } or an error Response.
async function openThread(req, env, taskId, wantPartnerId) {
  const user = await requireUser(req, env);
  if (!user) return { error: err("unauthorized", 401) };
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(taskId).first();
  if (!task) return { error: err("task not found", 404) };

  if (task.customer_id === user.id) {
    // Customer must say WHICH partner's thread they mean.
    const pid = vstr(wantPartnerId || "", 60);
    if (!pid) return { error: err("partner_id required", 400) };
    const bid = await env.DB.prepare("SELECT id FROM bids WHERE task_id=? AND partner_id=?")
      .bind(taskId, pid).first();
    if (!bid) return { error: err("no such conversation", 404) };
    return { user, task, partnerId: pid, isCustomer: true };
  }

  // Partner side: they own exactly one thread on this task, and only if they bid.
  const bid = await env.DB.prepare("SELECT id FROM bids WHERE task_id=? AND partner_id=?")
    .bind(taskId, user.id).first();
  if (!bid) return { error: err("place a bid before messaging", 403, "bid_required") };
  return { user, task, partnerId: user.id, isCustomer: false };
}

// GET /tasks/:taskId/messages?partner_id=&after=
// `after` lets the app poll for only what is new instead of refetching the thread.
export async function listMessages(req, env, params) {
  const u = new URL(req.url);
  const t = await openThread(req, env, params.taskId, u.searchParams.get("partner_id"));
  if (t.error) return t.error;

  // `after` is a whole-second timestamp, so `> after` would silently drop a
  // message written in the SAME second as the one the client already has — two
  // people typing at once is normal, and losing a message off the screen is
  // unacceptable. Use >= and let the client de-dupe on id: at worst it refetches
  // one message it already had, which is invisible; the alternative loses it.
  const after = parseInt(u.searchParams.get("after") || "0", 10) || 0;
  const { results } = await env.DB.prepare(
    "SELECT id, sender_id, body, created_at, read_at FROM messages " +
    "WHERE task_id=? AND partner_id=? AND created_at >= ? ORDER BY created_at LIMIT 200"
  ).bind(params.taskId, t.partnerId, after).all();

  return json({
    messages: results.map((m) => ({
      id: m.id, body: m.body, created_at: m.created_at,
      mine: m.sender_id === t.user.id, read: !!m.read_at,
    })),
    task: { id: t.task.id, title: t.task.title, status: t.task.status },
  });
}

// POST /tasks/:taskId/messages   body: { body, partner_id? }
export async function sendMessage(req, env, params) {
  const b = await readBody(req);
  const t = await openThread(req, env, params.taskId, b.partner_id);
  if (t.error) return t.error;

  if (!(await rateLimit(env, `msg:${t.user.id}:hr`, MSGS_PER_HOUR, 3600)))
    return err("too many messages — slow down", 429);

  const body = vstr(b.body, LIMITS.MSG_MAX);
  if (!body) return err(`body required (1..${LIMITS.MSG_MAX} chars)`, 400);

  const mid = id("msg");
  const ts = now();
  await env.DB.prepare(
    "INSERT INTO messages (id,task_id,partner_id,sender_id,body,created_at) VALUES (?,?,?,?,?,?)"
  ).bind(mid, params.taskId, t.partnerId, t.user.id, body, ts).run();

  // Tell the other side. Best-effort: a notification failure must not lose the
  // message that is already stored.
  const to = t.isCustomer ? t.partnerId : t.task.customer_id;
  const preview = body.length > 60 ? body.slice(0, 60) + "\u2026" : body;
  try {
    await createNotif(env, to, "msg", `New message \u2014 ${t.task.title}`, preview);
    pushNotify(env, to, t.user.name || "New message", preview);
  } catch (_) {}

  return json({ ok: true, id: mid, created_at: ts }, 201);
}

// POST /tasks/:taskId/messages/read   body: { partner_id? }
// Marks everything the OTHER party sent as read.
export async function markThreadRead(req, env, params) {
  const b = await readBody(req).catch(() => ({}));
  const t = await openThread(req, env, params.taskId, b.partner_id);
  if (t.error) return t.error;
  await env.DB.prepare(
    "UPDATE messages SET read_at=? WHERE task_id=? AND partner_id=? AND sender_id!=? AND read_at IS NULL"
  ).bind(now(), params.taskId, t.partnerId, t.user.id).run();
  return json({ ok: true });
}

// GET /me/threads — every conversation the caller is part of, newest first,
// with the last message and an unread count. Two queries total, not per-thread.
export async function listThreads(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);

  // Pull the caller's messages and fold them into threads in JS. Deliberately
  // NOT a GROUP BY: the aggregate version is harder to test against the shim,
  // and at this size (a user's own messages, capped) the work is identical —
  // one indexed scan either way. Both indexes on messages cover this.
  // No JOIN, no OR — two flat indexed lookups, then stitch in JS.
  //   1. every message in a thread that is mine as the PARTNER
  //   2. every message on a task I own as the CUSTOMER
  // This is also the shape SQLite likes: each hits one index directly, instead
  // of an OR across two tables that makes the planner drop the index entirely.
  const asPartner = (await env.DB.prepare(
    "SELECT task_id, partner_id, sender_id, body, created_at, read_at FROM messages " +
    "WHERE partner_id = ? ORDER BY created_at LIMIT 2000"
  ).bind(user.id).all()).results || [];

  const myTasks = (await env.DB.prepare(
    "SELECT id FROM tasks WHERE customer_id = ? LIMIT 300"
  ).bind(user.id).all()).results || [];

  let asCustomer = [];
  if (myTasks.length) {
    const tph = myTasks.map(() => "?").join(",");
    asCustomer = (await env.DB.prepare(
      `SELECT task_id, partner_id, sender_id, body, created_at, read_at FROM messages ` +
      `WHERE task_id IN (${tph}) ORDER BY created_at LIMIT 2000`
    ).bind(...myTasks.map((t) => t.id)).all()).results || [];
  }

  const myTaskIds = new Set(myTasks.map((t) => t.id));
  const seen = new Set();
  const rows = [...asPartner, ...asCustomer]
    .filter((r) => { const k = r.task_id + "|" + r.partner_id + "|" + r.created_at + "|" + r.sender_id;
      if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.created_at - b.created_at);

  // Titles/status for the tasks involved, one batched query.
  const taskIds = [...new Set(rows.map((r) => r.task_id))];
  const meta = {};
  if (taskIds.length) {
    const mph = taskIds.map(() => "?").join(",");
    const { results: ts } = await env.DB.prepare(
      `SELECT id, title, status, customer_id FROM tasks WHERE id IN (${mph})`
    ).bind(...taskIds).all();
    for (const t of ts) meta[t.id] = t;
  }

  const threads = new Map();
  for (const r of rows) {
    const tm = meta[r.task_id];
    if (!tm) continue;
    // A customer sees one thread per bidding partner; a partner sees only their
    // own. Anything else is not this user's thread.
    const iAmCustomer = myTaskIds.has(r.task_id);
    if (!iAmCustomer && r.partner_id !== user.id) continue;
    const key = `${r.task_id}|${r.partner_id}`;
    let t = threads.get(key);
    if (!t) {
      t = { task_id: r.task_id, partner_id: r.partner_id, title: tm.title,
            task_status: tm.status, i_am_customer: iAmCustomer,
            other_id: iAmCustomer ? r.partner_id : tm.customer_id,
            last_body: "", last_at: 0, unread: 0 };
      threads.set(key, t);
    }
    if (r.created_at >= t.last_at) { t.last_at = r.created_at; t.last_body = r.body; }
    if (r.sender_id !== user.id && !r.read_at) t.unread++;
  }

  const list = [...threads.values()].sort((a, b) => b.last_at - a.last_at).slice(0, 100);
  if (!list.length) return json({ threads: [] });

  // Names for the other side, one batched query rather than one per thread.
  const otherIds = [...new Set(list.map((t) => t.other_id))];
  const ph = otherIds.map(() => "?").join(",");
  const { results: people } = await env.DB.prepare(
    `SELECT id, name, avatar_hue FROM users WHERE id IN (${ph})`).bind(...otherIds).all();
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));

  return json({
    threads: list.map((t) => {
      const o = byId[t.other_id] || {};
      return {
        task_id: t.task_id, partner_id: t.partner_id, title: t.title,
        task_status: t.task_status, i_am_customer: t.i_am_customer,
        with: { id: t.other_id, name: o.name || "User", avatar_hue: o.avatar_hue || 214 },
        last_body: t.last_body, last_at: t.last_at, unread: t.unread,
      };
    }),
  });
}

// GET /admin/threads/:taskId — support reading a conversation to settle a
// dispute. Read-only: admins can see, never write, so a thread can always be
// trusted as evidence of what the two parties actually said.
export async function adminGetThread(req, env, params) {
  const admin = await requireUser(req, env);
  if (!admin) return err("unauthorized", 401);
  if (!env.ADMIN_IDS || !env.ADMIN_IDS.split(",").includes(admin.id)) return err("forbidden", 403);
  const { results } = await env.DB.prepare(
    "SELECT m.id, m.partner_id, m.sender_id, m.body, m.created_at, u.name sender_name " +
    "FROM messages m LEFT JOIN users u ON u.id = m.sender_id " +
    "WHERE m.task_id=? ORDER BY m.created_at LIMIT 500"
  ).bind(params.taskId).all();
  return json({ messages: results });
}
