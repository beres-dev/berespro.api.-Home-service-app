// src/lib/settings.js — tunable platform parameters with code defaults.
const DEFAULTS = {
  algo_w_distance: "50",   // recommended-feed weight: closeness
  algo_w_recency: "30",    // freshness of the task
  algo_w_budget: "20",     // budget attractiveness
  commission_bps: "",      // if set, overrides env.COMMISSION_BPS
};

export async function getSettings(env) {
  const out = { ...DEFAULTS };
  try {
    const { results } = await env.DB.prepare("SELECT s_key, s_value FROM settings").all();
    for (const r of results) out[r.s_key] = r.s_value;
  } catch {}
  return out;
}

export async function setSetting(env, key, value) {
  const existing = await env.DB.prepare("SELECT s_key FROM settings WHERE s_key=?").bind(key).first();
  if (existing) {
    await env.DB.prepare("UPDATE settings SET s_value=? WHERE s_key=?").bind(String(value), key).run();
  } else {
    await env.DB.prepare("INSERT INTO settings (s_key, s_value) VALUES (?,?)").bind(key, String(value)).run();
  }
}

export async function commissionBps(env) {
  const s = await getSettings(env);
  const v = parseInt(s.commission_bps || env.COMMISSION_BPS || "2000", 10);
  return Number.isFinite(v) && v >= 0 && v <= 5000 ? v : 2000; // hard cap 50%
}
