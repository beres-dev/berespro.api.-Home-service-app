// src/lib/notify.js — FCM push (best-effort; never blocks the request).
export async function pushNotify(env, userId, title, body) {
  try {
    if (!env.FCM_SERVER_KEY) return;
    const { results } = await env.DB.prepare("SELECT fcm_token FROM devices WHERE user_id=?")
      .bind(userId).all();
    for (const d of results) {
      await fetch("https://fcm.googleapis.com/fcm/send", {
        method: "POST",
        headers: { authorization: "key=" + env.FCM_SERVER_KEY, "content-type": "application/json" },
        body: JSON.stringify({ to: d.fcm_token, notification: { title, body } }),
      });
    }
  } catch (_) { /* swallow — push is non-critical */ }
}
