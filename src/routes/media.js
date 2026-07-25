// src/routes/media.js — the two remaining personal uploads.
//
//   LICENCE  an identity document (driving licence). Lives under kyc/ so it
//            inherits the strictest rule on the platform: admin-only reads.
//            Required before a partner can take the delivery/moving skill —
//            they will be driving customers' goods around.
//   AVATAR   a face for the profile. One R2 key per user (avatar/<uid>),
//            overwritten on every change so there is nothing to garbage-
//            collect, readable by any signed-in user (it appears on bids).
//
// Same invariants as every other upload here: the server picks the key, magic
// bytes decide the type, and the app downscales client-side first (which also
// strips EXIF).

import { json, err, id } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { requireAdmin } from "./admin.js";
import { docsReady } from "../lib/docs.js";

const MAX_BYTES = 3 * 1024 * 1024;

function sniff(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

async function readImage(req) {
  const buf = await req.arrayBuffer();
  if (!buf || buf.byteLength === 0) return { error: err("empty upload", 400) };
  if (buf.byteLength > MAX_BYTES) return { error: err("image too large (max 3MB)", 413) };
  const mime = sniff(buf);
  if (!mime) return { error: err("not a supported image (JPEG, PNG or WebP)", 415) };
  return { buf, mime };
}

// POST /me/licence (raw image) -> { ok } — stores the doc, marks the user.
export async function uploadLicence(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (!docsReady(env))
    return err("document storage is not configured yet — try again later", 503, "storage_unbound");
  const r = await readImage(req);
  if (r.error) return r.error;
  const key = `kyc/${user.id}/${id("doc")}-licence`;
  await env.KYC_DOCS.put(key, r.buf, { httpMetadata: { contentType: r.mime } });
  await env.DB.prepare("UPDATE users SET licence_key=? WHERE id=?").bind(key, user.id).run();
  return json({ ok: true }, 201);
}

// GET /admin/licence/:userId — admins verify the licence is real.
export async function adminGetLicence(req, env, params) {
  const admin = await requireAdmin(req, env);
  if (!admin) return err("forbidden", 403);
  if (!docsReady(env)) return err("storage not configured", 503);
  const u = await env.DB.prepare("SELECT licence_key FROM users WHERE id=?").bind(params.userId).first();
  if (!u || !u.licence_key) return err("no licence on file", 404);
  const obj = await env.KYC_DOCS.get(u.licence_key);
  if (!obj) return err("not found", 404);
  return new Response(obj.body, { headers: {
    "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg",
    "cache-control": "no-store",   // identity document: never cache
  }});
}

// POST /me/avatar (raw image) -> { ok } — one fixed key, overwritten in place.
export async function uploadAvatar(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (!docsReady(env))
    return err("photo storage is not configured yet — try again later", 503, "storage_unbound");
  const r = await readImage(req);
  if (r.error) return r.error;
  const key = `avatar/${user.id}`;
  await env.KYC_DOCS.put(key, r.buf, { httpMetadata: { contentType: r.mime } });
  await env.DB.prepare("UPDATE users SET avatar_key=? WHERE id=?").bind(key, user.id).run();
  return json({ ok: true }, 201);
}

// GET /avatar/:userId — any signed-in user (avatars appear on bids and chat).
export async function serveAvatar(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (!docsReady(env)) return err("storage not configured", 503);
  if (String(params.userId).includes("..")) return err("not found", 404);
  const obj = await env.KYC_DOCS.get(`avatar/${params.userId}`);
  if (!obj) return err("not found", 404);
  return new Response(obj.body, { headers: {
    "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg",
    "cache-control": "private, max-age=300",  // short: it changes when they change it
  }});
}
