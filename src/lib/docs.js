// src/lib/docs.js — private storage for KYC documents (R2).
//
// THREAT MODEL. These are IC photos and selfies: the most sensitive data on the
// platform. A leak is a PDPA incident, not a bug. So:
//   1. The bucket is PRIVATE. No public URL to a document exists, ever.
//   2. The CLIENT NEVER CHOOSES THE KEY. It uploads bytes; the Worker decides
//      where they land. (Before this, the client literally posted a "url" string
//      and the server believed it.)
//   3. Admins read documents THROUGH the Worker, which checks they are an admin
//      on every single request. No signed URL that can be forwarded or that
//      outlives the review.
//   4. Content is validated by MAGIC BYTES, not the Content-Type header, which
//      any client can lie about.
//
// KNOWN LIMITATION (accepted, not hidden): we do not strip EXIF. A photo can
// carry the GPS coordinates of where it was taken. Stripping needs an image
// decoder, which is heavy in a Worker. The bucket is private and only admins can
// read it, so the exposure is internal. Revisit if documents are ever handled by
// anyone outside the company.

const MAX_BYTES = 6 * 1024 * 1024;         // 6MB — a phone photo, not a video
export const DOC_KINDS = ["front", "back", "selfie"];

// Sniff the real type. A client can set any Content-Type; bytes do not lie.
function sniff(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export function docsReady(env) { return !!env.KYC_DOCS; }

// Key layout: kyc/<userId>/<random>-<kind>. The userId prefix means a document
// can always be traced to a person and purged per person, and it lets us prove
// on submit that the uploader owns the key they are claiming.
export async function putDoc(env, userId, kind, buf, declaredType) {
  if (!docsReady(env)) return { ok: false, reason: "storage_unavailable" };
  if (!DOC_KINDS.includes(kind)) return { ok: false, reason: "bad_kind" };
  if (!buf || buf.byteLength === 0) return { ok: false, reason: "empty" };
  if (buf.byteLength > MAX_BYTES) return { ok: false, reason: "too_large" };

  const real = sniff(buf);
  if (!real) return { ok: false, reason: "not_an_image" };
  // If they declared a type, it must match what the bytes actually are.
  if (declaredType && !declaredType.startsWith(real)) return { ok: false, reason: "type_mismatch" };

  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const key = `kyc/${userId}/${rand}-${kind}`;
  await env.KYC_DOCS.put(key, buf, {
    httpMetadata: { contentType: real, cacheControl: "no-store" },
    customMetadata: { user_id: userId, kind, uploaded_at: String(Math.floor(Date.now() / 1000)) },
  });
  return { ok: true, key, contentType: real, bytes: buf.byteLength };
}

// A user may only claim keys under their own prefix. Without this check, a
// partner could submit someone else's document key as their own.
export function keyBelongsTo(key, userId) {
  return typeof key === "string" && key.startsWith(`kyc/${userId}/`);
}

export async function getDoc(env, key) {
  if (!docsReady(env)) return null;
  return env.KYC_DOCS.get(key);
}

// Retention: documents live as long as the partner is active (Zaini's call).
// Purge is used when a resubmission replaces older documents, and when an
// account is removed. Deleting a key that is already gone is not an error.
export async function deleteDocs(env, keys) {
  if (!docsReady(env)) return;
  for (const k of keys.filter(Boolean)) {
    try { await env.KYC_DOCS.delete(k); } catch (_) {}
  }
}
