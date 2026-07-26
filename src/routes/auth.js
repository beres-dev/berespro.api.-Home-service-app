// src/routes/auth.js
import { json, err, id, now, signJWT, randomToken, sha256hex, readBody } from "../lib/util.js";
import { verifyClerkToken, requireUser } from "../lib/auth.js";
import { commissionBpsFor, cancelPolicy, getSettings } from "../lib/settings.js";
import { rateLimit, clientIp, LIMITS, vstr } from "../lib/guard.js";

// POST /auth/session
// body: { clerkToken }  (Clerk session JWT from the app: Google or phone OTP sign-in)
// -> creates/updates the user, returns { accessToken, refreshToken, user }
export async function postSession(req, env) {
  if (!(await rateLimit(env, `auth:${clientIp(req)}:10m`, LIMITS.AUTH_PER_10MIN, 600)))
    return err("too many attempts — try again later", 429);
  const body = await readBody(req);
  const clerkToken = body.clerkToken || body.firebaseToken; // accept legacy key gracefully
  if (!clerkToken) return err("clerkToken required", 400);

  const c = await verifyClerkToken(clerkToken, env);
  if (!c) {
    // Diagnose the common misconfiguration without weakening the rejection or
    // leaking config: decode the (already-rejected) token's issuer locally and
    // compare. Values are logged server-side for `wrangler tail`, never returned.
    let iss = null;
    try { iss = JSON.parse(atob(clerkToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).iss; } catch (_) {}
    if (!env.CLERK_ISSUER) {
      console.error("auth: CLERK_ISSUER is not set");
      return err("server auth is not configured — contact support", 503, "issuer_not_set");
    }
    if (iss && iss !== env.CLERK_ISSUER.replace(/\/+$/, "")) {
      console.error("auth: issuer mismatch. token iss=", iss, " expected=", env.CLERK_ISSUER);
      return err("sign-in is pointing at the wrong Clerk instance", 401, "issuer_mismatch");
    }
    return err("invalid clerk token", 401, "bad_token");
  }

  // Clerk user id lives in `sub`. Phone/email/name come through if you add them to
  // the Clerk JWT template (see GUIDE §5). We store the Clerk id in firebase_uid
  // (kept as the external-identity column to avoid a migration).
  let user = await env.DB.prepare("SELECT * FROM users WHERE firebase_uid = ?").bind(c.sub).first();
  if (!user) {
    const uid = id("usr");
    const hue = 200 + (c.sub.charCodeAt(0) % 40);
    const phone = c.phone_number || c.phone || null;
    const email = c.email || c.email_address || null;
    const name = c.name || c.full_name || (phone ? "New user" : (email || "New user").split("@")[0]);
    await env.DB.prepare(
      "INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(uid, c.sub, phone, email, name, hue, now()).run();
    user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(uid).first();
  }

  return issueTokens(env, user);
}

// POST /auth/refresh  body: { refreshToken }
export async function postRefresh(req, env) {
  const { refreshToken } = await readBody(req);
  if (!refreshToken) return err("refreshToken required", 400);
  const hash = await sha256hex(refreshToken);
  const ses = await env.DB.prepare("SELECT * FROM sessions WHERE refresh_hash = ?").bind(hash).first();
  if (!ses || ses.expires_at < now()) return err("invalid refresh token", 401);
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(ses.user_id).first();
  if (!user) return err("user gone", 401);
  // rotate: delete old session, issue new pair
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(ses.id).run();
  return issueTokens(env, user);
}

// GET /me
export async function getMe(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  // Partner-facing effective commission (their override or the default) and the
  // customer-facing cancel policy, so the app never hard-codes either number.
  // Category overrides still apply per task at accept time; this is the
  // partner's baseline for display.
  const bps = await commissionBpsFor(env, { partnerId: user.id });
  const cancel = await cancelPolicy(env);
  // Per-km delivery pricing (Lalamove-style SUGGESTION, not a forced price —
  // this stays a bidding marketplace). Admin-tunable via the settings table;
  // the client uses these to pre-fill the budget, the server recomputes the
  // route distance itself on create.
  const s = await getSettings(env).catch(() => ({}));
  // Per vehicle: a motorbike is cheaper and beats traffic but carries little;
  // a car costs more and carries more. The customer picks the trade-off, so the
  // price has to differ or the choice is meaningless.
  // Bigger vehicle, bigger cost to run. min_cents is a FLOOR on the suggestion:
  // a lorry job is never worth quoting at RM8 no matter how short the trip,
  // because the driver still has to load, secure, drive and unload.
  const vp = (k, base, perKm, min) => ({
    base_cents:   parseInt(s[`delivery_${k}_base_cents`]   || String(base),  10),
    per_km_cents: parseInt(s[`delivery_${k}_per_km_cents`] || String(perKm), 10),
    min_cents:    parseInt(s[`delivery_${k}_min_cents`]    || String(min),   10),
  });
  const delivery_pricing = {
    motor: vp("motor", 400, 100, 0),      // RM4  + RM1.00/km
    car:   vp("car",   500, 150, 0),      // RM5  + RM1.50/km  (Zaini's number)
    "4x4": vp("4x4",   800, 200, 0),      // RM8  + RM2.00/km
    van:   vp("van",  1000, 250, 0),      // RM10 + RM2.50/km
    lorry: vp("lorry", 2000, 300, 6000),  // RM20 + RM3.00/km, never below RM60
  };
  return json({ user: publicUser(user, env), delivery_pricing, commission_bps: bps,
                cancel_policy: { grace_min: cancel.graceMin, fee_bps: cancel.feeBps } });
}

// PATCH /me  body: { name?, mode?, city?, lat?, lng?, skills? }
export async function patchMe(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const b = await readBody(req);
  const fields = [], vals = [];
  for (const k of ["name", "mode", "city", "lat", "lng"]) {
    if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(b[k]); }
  }
  if (b.phone !== undefined) {
    const phone = String(b.phone).trim();
    // E.164-ish: + and 8..15 digits (covers +60xxxxxxxxx)
    if (!/^\+?[0-9]{8,15}$/.test(phone.replace(/[\s-]/g, "")))
      return err("invalid phone number", 400, "bad_phone");
    const norm = phone.replace(/[\s-]/g, "");
    const taken = await env.DB.prepare("SELECT id FROM users WHERE phone = ? AND id != ?")
      .bind(norm, user.id).first();
    if (taken) return err("phone already in use", 409, "phone_taken");
    fields.push("phone = ?"); vals.push(norm);
  }
  if (b.skills !== undefined) {
    // Skills were previously JSON.stringify'd unvalidated — any shape, any size.
    if (!Array.isArray(b.skills) || b.skills.length > 12)
      return err("skills must be a list (max 12)", 400);
    const skills = [];
    for (const s of b.skills) {
      const v = vstr(s, 24);
      if (!v) return err("invalid skill name", 400);
      skills.push(v.toLowerCase());
    }
    // Delivery/moving means driving other people's goods: licence first. The
    // check is HERE, server-side — the app also guides the flow, but the app
    // is not the gate.
    const needsLicence = skills.some(s => s === "delivery" || s === "moving");
    if (needsLicence && !user.licence_key)
      return err("upload your driving licence before taking the delivery skill", 403, "licence_required");
    fields.push("skills = ?"); vals.push(JSON.stringify(skills));
  }
  if (!fields.length) return json({ user: publicUser(user, env) });
  vals.push(user.id);
  await env.DB.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).bind(...vals).run();
  const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  return json({ user: publicUser(updated, env) });
}

// POST /auth/dev-login  body: { phone, name, mode }
// DEV ONLY — enabled only when env.DEV_LOGIN === "1". Lets the app integrate and
// be tested end-to-end BEFORE a Firebase project exists. NEVER enable in production.
export async function devLogin(req, env) {
  if (env.DEV_LOGIN !== "1") return err("not found", 404);
  const b = await readBody(req);
  const phone = (b.phone || "").trim();
  if (!phone) return err("phone required", 400);
  let user = await env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
  if (!user) {
    const uid = id("usr");
    await env.DB.prepare(
      "INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?)"
    ).bind(uid, "dev_" + uid, phone, null, b.name || "Dev User", 200 + (phone.length * 7) % 40,
           b.mode === "partner" ? "partner" : "customer", "Kuala Lumpur", 3.139, 101.687, "[]", now()).run();
    user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(uid).first();
  }
  if (user.suspended) return err("account suspended", 403);
  return issueTokens(env, user);
}

// ---------- helpers ----------
async function issueTokens(env, user) {
  const accessToken = await signJWT({ uid: user.id }, env.JWT_SECRET, 60 * 60); // 1h
  const refreshToken = randomToken();
  const hash = await sha256hex(refreshToken);
  await env.DB.prepare(
    "INSERT INTO sessions (id,user_id,refresh_hash,expires_at,created_at) VALUES (?,?,?,?,?)"
  ).bind(id("ses"), user.id, hash, now() + 30 * 24 * 3600, now()).run();
  return json({ accessToken, refreshToken, user: publicUser(user, env) });
}

export function publicUser(u, env) {
  return {
    id: u.id, name: u.name, phone: u.phone, email: u.email,
    mode: u.mode, city: u.city, lat: u.lat, lng: u.lng,
    avatar_hue: u.avatar_hue, id_verified: !!u.id_verified,
    skills: JSON.parse(u.skills || "[]"),
    needs_phone: !u.phone,   // Google sign-in gives email+name, not phone → app collects it
    has_avatar: !!u.avatar_key,
    has_licence: !!u.licence_key,
    // Admin-only UI (the control-panel token) is hidden from everyone else. The
    // app cannot work this out on its own, and this flag grants NOTHING — every
    // admin route re-checks ADMIN_IDS server-side regardless of what it says.
    is_admin: !!(env && env.ADMIN_IDS && env.ADMIN_IDS.split(",").map(s => s.trim()).includes(u.id)),
  };
}

// POST /auth/dev-login  body: { phone, name?, mode? }
// DEV ONLY — enabled only when env.DEV_LOGIN === "1". Lets you test the full flow
