// src/lib/util.js — shared helpers (no external deps, Web Crypto only)

export const now = () => Math.floor(Date.now() / 1000);

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...cors(), ...extra },
  });

export const err = (message, status = 400, code) =>
  json({ error: { message, code: code || null } }, status);

export function cors() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    // API returns JSON only and never HTML, so lock scripting down entirely.
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
  };
}

export function id(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${s}`;
}

export async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// distance in km between two lat/lng points
export function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLa = ((bLat - aLat) * Math.PI) / 180;
  const dLo = ((bLng - aLng) * Math.PI) / 180;
  const h =
    Math.sin(dLa / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ---------- base64url ----------
const b64url = {
  enc(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  encStr(str) {
    return b64url.enc(new TextEncoder().encode(str));
  },
  decStr(b64) {
    b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
    return atob(b64 + "=".repeat(pad));
  },
};

// ---------- HS256 JWT (session tokens we mint ourselves) ----------
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signJWT(payload, secret, ttlSec = 7 * 24 * 3600) {
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: now(), exp: now() + ttlSec };
  const p1 = b64url.encStr(JSON.stringify(header));
  const p2 = b64url.encStr(JSON.stringify(body));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${p1}.${p2}`));
  return `${p1}.${p2}.${b64url.enc(new Uint8Array(sig))}`;
}

export async function verifyJWT(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [p1, p2, p3] = parts;
  const key = await hmacKey(secret);
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${p1}.${p2}`));
  // Constant-time comparison: a fast !== leaks how many leading chars matched,
  // which over many tries can reconstruct a valid signature.
  const a = b64url.enc(new Uint8Array(expected));
  if (a.length !== p3.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ p3.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(b64url.decStr(p2));
    if (payload.exp && payload.exp < now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
