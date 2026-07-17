// src/lib/guard.js — protection layer: rate limiting, input validation, audit trail.
import { id, now } from "./util.js";

// ---- fixed-window rate limiter (D1-backed, good enough for MVP scale) ----
// returns true if allowed, false if over limit.
export async function rateLimit(env, key, limit, windowSec) {
  // Prefer KV: it is purpose-built for high-rate edge counters and keeps the
  // limiter off the D1 write path (which is the real bottleneck under load).
  // Falls back to D1 when RL_KV is not bound, so behaviour is unchanged until
  // the binding is added in wrangler.toml.
  if (env.RL_KV) return rateLimitKV(env, key, limit, windowSec);
  return rateLimitD1(env, key, limit, windowSec);
}

async function rateLimitKV(env, key, limit, windowSec) {
  // Fixed-window counter. Bucket the window into the key so it self-expires;
  // KV TTL cleans up old buckets with no sweeping.
  const bucket = Math.floor(now() / windowSec);
  const k = `rl:${key}:${bucket}`;
  let n = 0;
  try { n = parseInt(await env.RL_KV.get(k), 10) || 0; } catch { return true; } // KV down: fail open, never lock users out
  if (n >= limit) return false;
  // TTL a little past the window so late reads still see the count.
  try { await env.RL_KV.put(k, String(n + 1), { expirationTtl: windowSec + 60 }); } catch { /* best effort */ }
  return true;
}

async function rateLimitD1(env, key, limit, windowSec) {
  const t = now();
  const row = await env.DB.prepare("SELECT window_start, count FROM rate_limits WHERE rl_key=?")
    .bind(key).first();
  if (!row || t - row.window_start >= windowSec) {
    if (row) {
      await env.DB.prepare("UPDATE rate_limits SET window_start=?, count=1 WHERE rl_key=?")
        .bind(t, key).run();
    } else {
      await env.DB.prepare("INSERT INTO rate_limits (rl_key, window_start, count) VALUES (?,?,1)")
        .bind(key, t).run();
    }
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare("UPDATE rate_limits SET count=count+1 WHERE rl_key=?").bind(key).run();
  return true;
}

export function clientIp(req) {
  return req.headers.get("cf-connecting-ip") || "0.0.0.0";
}

// ---- input validation ----
// vstr: required string within length; returns trimmed string or null.
export function vstr(v, max, min = 1) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length < min || s.length > max) return null;
  return s;
}
// vint: integer within [lo, hi]; returns number or null.
export function vint(v, lo, hi) {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < lo || n > hi) return null;
  return n;
}
// vnum: finite number within [lo, hi]
export function vnum(v, lo, hi) {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return null;
  return n;
}

// Business bounds (cents): tasks RM 10 – RM 100,000; bids RM 5 – RM 100,000.
export const LIMITS = {
  TITLE_MAX: 120,
  DESC_MAX: 2000,
  MSG_MAX: 1000,
  NAME_MAX: 80,
  BUDGET_MIN: 1000, BUDGET_MAX: 10_000_000,
  BID_MIN: 500,     BID_MAX: 10_000_000,
  OPEN_TASKS_MAX: 10,          // per customer
  TASKS_PER_DAY: 20,
  BIDS_PER_DAY: 60,
  AUTH_PER_10MIN: 10,          // per IP
  KYC_PER_DAY: 3,
};

// ---- audit trail ----
export async function audit(env, actorId, action, ref, meta) {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (id, actor_id, action, ref, meta, created_at) VALUES (?,?,?,?,?,?)"
    ).bind(id("aud"), actorId || null, action, ref || null,
           meta ? JSON.stringify(meta) : null, now()).run();
  } catch (_) { /* audit must never break the request */ }
}
