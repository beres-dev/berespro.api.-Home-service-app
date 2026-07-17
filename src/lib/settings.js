// src/lib/settings.js — tunable platform parameters with code defaults.
const DEFAULTS = {
  algo_w_distance: "50",   // recommended-feed weight: closeness
  algo_w_recency: "30",    // freshness of the task
  algo_w_budget: "20",     // budget attractiveness
  commission_bps: "",      // if set, overrides env.COMMISSION_BPS
};

// Micro-cache: settings are now read several times per request (commission
// resolution + cancel policy + feed weights). One D1 round-trip per ~10s per
// isolate is plenty; setSetting() invalidates immediately so admin changes
// still apply right away on the instance that made them.
let _cache = null, _cacheAt = 0;
const CACHE_MS = 10_000;
export function invalidateSettingsCache() { _cache = null; _cacheAt = 0; }
export async function getSettings(env) {
  const t = Date.now();
  if (_cache && t - _cacheAt < CACHE_MS) return _cache;
  const out = { ...DEFAULTS };
  try {
    const { results } = await env.DB.prepare("SELECT s_key, s_value FROM settings").all();
    for (const r of results) out[r.s_key] = r.s_value;
  } catch {}
  _cache = out; _cacheAt = t;
  return out;
}

export async function setSetting(env, key, value) {
  invalidateSettingsCache();
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

// Effective commission for one payment. Most specific wins:
//   partner override > category override > global default.
// Overrides live in settings as commission_partner_<userId> / commission_cat_<category>
// so they ride the existing settings table, audit trail, and admin PATCH plumbing.
export async function commissionBpsFor(env, { partnerId, category } = {}) {
  const s = await getSettings(env);
  const pick = (raw) => {
    const v = parseInt(raw, 10);
    return Number.isFinite(v) && v >= 0 && v <= 5000 ? v : null;
  };
  if (partnerId != null) {
    const v = pick(s["commission_partner_" + partnerId]);
    if (v !== null) return v;
  }
  if (category != null) {
    const v = pick(s["commission_cat_" + String(category).toLowerCase()]);
    if (v !== null) return v;
  }
  return commissionBps(env);
}

// Customer-cancels-mid-job policy. Both admin-tunable via settings.
//   cancel_grace_min  minutes after funds are held during which cancelling is free
//                     (partner has barely committed; default 60)
//   cancel_fee_bps    after grace, this share of the agreed price is captured and
//                     paid out to the partner as compensation (default 1000 = 10%)
export async function cancelPolicy(env) {
  const s = await getSettings(env);
  const grace = parseInt(s.cancel_grace_min ?? "60", 10);
  const fee = parseInt(s.cancel_fee_bps ?? "1000", 10);
  return {
    graceMin: Number.isFinite(grace) && grace >= 0 && grace <= 1440 ? grace : 60,
    feeBps: Number.isFinite(fee) && fee >= 0 && fee <= 5000 ? fee : 1000, // cap 50%
  };
}
