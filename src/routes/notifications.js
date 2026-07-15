// src/routes/notifications.js
import { json, err, id, now, readBody } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";

// POST /me/devices  body: { fcm_token, platform }
export async function registerDevice(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const b = await readBody(req);
  if (!b.fcm_token) return err("fcm_token required", 400);
  try {
    await env.DB.prepare(
      "INSERT INTO devices (id,user_id,fcm_token,platform,created_at) VALUES (?,?,?,?,?)"
    ).bind(id("dev"), user.id, b.fcm_token, b.platform || null, now()).run();
  } catch { /* already registered */ }
  return json({ ok: true });
}

// GET /me/notifications
export async function listNotifs(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const { results } = await env.DB.prepare(
    "SELECT id,type,title,body,read,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100"
  ).bind(user.id).all();
  const unread = results.filter((n) => !n.read).length;
  return json({ notifications: results, unread });
}

// POST /notifications/read  body: { ids? }  (omit ids to mark all read)
export async function markRead(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const b = await readBody(req);
  if (Array.isArray(b.ids) && b.ids.length) {
    const q = b.ids.map(() => "?").join(",");
    await env.DB.prepare(`UPDATE notifications SET read=1 WHERE user_id=? AND id IN (${q})`)
      .bind(user.id, ...b.ids).run();
  } else {
    await env.DB.prepare("UPDATE notifications SET read=1 WHERE user_id=?").bind(user.id).run();
  }
  return json({ ok: true });
}
