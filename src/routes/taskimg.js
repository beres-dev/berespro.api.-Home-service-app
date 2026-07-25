// src/routes/taskimg.js — photos attached to tasks ("move this box", "fix this
// leak"). Same private R2 bucket as KYC, different prefix, OPPOSITE audience:
//   kyc/<uid>/...      admin-only, identity documents
//   taskimg/<uid>/...  any signed-in user — partners must see the job photos
// One bucket keeps Zaini's setup to a single "create bucket" step; the prefix
// decides the access rule, and the serve route below only ever reads taskimg/.
//
// The client never chooses keys (upload returns one), and magic bytes decide
// the type, not the Content-Type header. The app downscales to ~1600px JPEG
// before upload, which also strips EXIF (and its GPS position) client-side —
// task photos are shown to strangers, so that matters more here than for KYC.

import { json, err, id } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { docsReady } from "../lib/docs.js";

const MAX_BYTES = 3 * 1024 * 1024;  // post-downscale a photo is ~200-500KB; 3MB is generous

function sniff(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

// POST /tasks/photo-upload  (raw image body) -> { key }
export async function uploadTaskPhoto(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (!docsReady(env))
    return err("photo storage is not configured yet — try again later", 503, "storage_unbound");

  const buf = await req.arrayBuffer();
  if (!buf || buf.byteLength === 0) return err("empty upload", 400);
  if (buf.byteLength > MAX_BYTES) return err("photo too large (max 3MB)", 413);
  const mime = sniff(buf);
  if (!mime) return err("not a supported image (JPEG, PNG or WebP)", 415);

  const key = `taskimg/${user.id}/${id("img")}`;
  await env.KYC_DOCS.put(key, buf, { httpMetadata: { contentType: mime } });
  return json({ key }, 201);
}

// GET /timg/:key1/:key2/:key3  -> streams the image to any signed-in user.
// The path is reassembled and HARD-CHECKED to stay under taskimg/ — this route
// must never become a generic R2 reader that could reach a KYC document.
export async function serveTaskPhoto(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (!docsReady(env)) return err("photo storage is not configured", 503);

  const key = `taskimg/${params.uid}/${params.file}`;
  if (key.includes("..")) return err("not found", 404);
  const obj = await env.KYC_DOCS.get(key);
  if (!obj) return err("not found", 404);
  return new Response(obj.body, {
    headers: {
      "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg",
      "cache-control": "private, max-age=3600",
    },
  });
}
