// src/lib/auth.js — verify Clerk session JWTs, then mint our own session JWT.
//
// Clerk (client SDK) handles Google sign-in AND phone OTP on the app. The app
// sends us a Clerk session token (JWT, RS256). We verify it against Clerk's
// public JWKS for your instance, then issue our own session JWT for every other
// call. No SHA-1, no google-services.json — that's the whole point of the switch.
//
// Config (wrangler secrets):
//   CLERK_ISSUER   e.g. https://your-app.clerk.accounts.dev  (or your prod domain)
//   CLERK_JWKS_URL optional; defaults to `${CLERK_ISSUER}/.well-known/jwks.json`

import { verifyJWT } from "./util.js";

let _jwks = { at: 0, keys: null, url: null };

async function clerkJwks(env) {
  const url = env.CLERK_JWKS_URL || (env.CLERK_ISSUER
    ? env.CLERK_ISSUER.replace(/\/+$/, "") + "/.well-known/jwks.json"
    : null);
  if (!url) throw new Error("CLERK_ISSUER or CLERK_JWKS_URL not set");
  // cache 1h, keyed by url so a config change refetches
  if (_jwks.keys && _jwks.url === url && Date.now() - _jwks.at < 3600_000) return _jwks.keys;
  const res = await fetch(url);
  const data = await res.json();
  _jwks = { at: Date.now(), keys: data.keys || [], url };
  return _jwks.keys;
}

function b64urlToBytes(b64) {
  b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  const bin = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Verify a Clerk session token. Returns the decoded payload or null.
// Clerk tokens carry: sub (Clerk user id), iss (your instance), exp, iat, and
// (if you add them via a JWT template) phone_number / email / name claims.
export async function verifyClerkToken(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
    payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return null; }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < nowSec) return null;
  if (payload.nbf && payload.nbf > nowSec + 5) return null;
  // issuer check (defends against tokens from another Clerk instance)
  if (env.CLERK_ISSUER && payload.iss !== env.CLERK_ISSUER.replace(/\/+$/, "")) return null;
  if (!payload.sub) return null;

  // signature check (RS256) against Clerk JWKS
  const keys = await clerkJwks(env);
  const jwk = keys.find((k) => k.kid === header.kid) || keys[0];
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), data);
  if (!ok) return null;
  return payload; // { sub, iss, exp, phone_number?, email?, name?, ... }
}

// Middleware: pull our session JWT from Authorization header, return the user row.
export async function requireUser(req, env) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  const claims = await verifyJWT(token, env.JWT_SECRET);
  if (!claims || !claims.uid) return null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(claims.uid).first();
  if (user && user.suspended) return null;   // suspended accounts lose all access
  return user || null;
}
