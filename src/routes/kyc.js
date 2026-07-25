// src/routes/kyc.js — partner identity verification.
// PROTECTS USERS: partners enter customers' homes — identity must be verified
// before they can bid. PROTECTS PARTNERS: verified badge wins more jobs.
// PROTECTS BERESPRO: audit trail + due diligence record.
//
// Privacy by design: we store the IC's last-4 only, never the full number, and
// document bytes live in a PRIVATE R2 bucket (see lib/docs.js). The columns named
// *_url hold R2 KEYS, not URLs — no public URL to a document exists. Admins read
// documents through an authenticated Worker route, never a shareable link.
import { json, err, id, now, readBody } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { rateLimit, vstr, LIMITS, audit } from "../lib/guard.js";
import { createNotif } from "./bids.js";
import { putDoc, getDoc, deleteDocs, docsReady, keyBelongsTo, DOC_KINDS } from "../lib/docs.js";

// POST /kyc/upload?kind=front|back|selfie   body: raw image bytes
// Returns a storage KEY. The client never picks the key, the path, or the name —
// it hands over bytes and gets back an opaque reference it can submit later.
export async function uploadKycDoc(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (!docsReady(env)) {
    // Fail loudly. The old code accepted any string as a "document url", so a
    // partner could pass verification having uploaded nothing at all. If storage
    // is not configured we refuse rather than pretend.
    return err("document storage is not configured — contact support", 503, "storage_unavailable");
  }
  if (!(await rateLimit(env, `kycup:${user.id}:day`, 20, 86400)))
    return err("too many uploads today", 429);

  const kind = new URL(req.url).searchParams.get("kind") || "";
  if (!DOC_KINDS.includes(kind)) return err("kind must be front, back or selfie", 400);

  const buf = await req.arrayBuffer();
  const r = await putDoc(env, user.id, kind, buf, req.headers.get("content-type") || "");
  if (!r.ok) {
    const msg = { too_large: "image is too large (max 6MB)",
                  not_an_image: "that file is not a JPEG, PNG or WebP image",
                  type_mismatch: "file content does not match its type",
                  empty: "empty file" }[r.reason] || "upload failed";
    return err(msg, 400, r.reason);
  }
  await audit(env, user.id, "kyc.upload", r.key, { kind, bytes: r.bytes });
  return json({ ok: true, key: r.key, kind }, 201);
}

// GET /kyc/doc/:kycId/:kind  (ADMIN) — stream a document for review.
// Auth is checked on EVERY request; there is no link that works without it and
// nothing to forward. Never cached.
export async function getKycDoc(req, env, params) {
  const admin = await requireUser(req, env);
  if (!admin) return err("unauthorized", 401);
  if (!env.ADMIN_IDS || !env.ADMIN_IDS.split(",").includes(admin.id)) return err("forbidden", 403);

  const sub = await env.DB.prepare("SELECT * FROM kyc_submissions WHERE id=?").bind(params.kycId).first();
  if (!sub) return err("not found", 404);
  const key = { front: sub.doc_front_url, back: sub.doc_back_url, selfie: sub.selfie_url }[params.kind];
  if (!key) return err("no such document", 404);

  const obj = await getDoc(env, key);
  if (!obj) return err("document missing from storage", 404);
  await audit(env, admin.id, "kyc.doc.view", sub.id, { kind: params.kind });
  return new Response(obj.body, {
    headers: {
      "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream",
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}

// POST /kyc/submit  body: { full_name, ic_last4, doc_front_key, doc_back_key?, selfie_key }
export async function submitKyc(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (user.id_verified) return json({ status: "approved" });

  if (!(await rateLimit(env, `kyc:${user.id}:day`, LIMITS.KYC_PER_DAY, 86400)))
    return err("too many KYC attempts today", 429);

  if (!docsReady(env))
    return err("document storage is not configured — contact support", 503, "storage_unavailable");

  const b = await readBody(req);
  const fullName = vstr(b.full_name, LIMITS.NAME_MAX);
  const icLast4 = vstr(b.ic_last4, 4, 4);
  // Keys come from /kyc/upload. Accept the legacy *_url names too so an older
  // app build gets a clear rejection below rather than a confusing 400.
  const front = vstr(b.doc_front_key || b.doc_front_url || "", 300);
  const selfie = vstr(b.selfie_key || b.selfie_url || "", 300);
  const back = vstr(b.doc_back_key || b.doc_back_url || "", 300) || null;
  if (!fullName || !icLast4 || !/^\d{4}$/.test(icLast4) || !front || !selfie)
    return err("full_name, ic_last4 (4 digits), doc_front_key, selfie_key required", 400);

  // THE CHECK THAT MATTERS: you may only submit documents you uploaded. Without
  // it, a partner could claim someone else's key — or, as before, invent a
  // string and be "verified" having uploaded nothing.
  for (const k of [front, selfie, ...(back ? [back] : [])]) {
    if (!keyBelongsTo(k, user.id))
      return err("document reference is not yours — upload again", 400, "bad_doc_key");
    if (!(await getDoc(env, k)))
      return err("document not found in storage — upload again", 400, "doc_missing");
  }

  // one pending submission at a time
  const pending = await env.DB.prepare(
    "SELECT id FROM kyc_submissions WHERE user_id=? AND status='pending'"
  ).bind(user.id).first();
  if (pending) return err("a submission is already under review", 409, "kyc_pending");

  // Resubmitting after a rejection: purge the old images. Retention is "as long
  // as the partner is active", and a rejected set is not part of that.
  const old = await env.DB.prepare(
    "SELECT doc_front_url, doc_back_url, selfie_url FROM kyc_submissions WHERE user_id=? AND status='rejected'"
  ).bind(user.id).all();
  for (const o of (old.results || [])) {
    const stale = [o.doc_front_url, o.doc_back_url, o.selfie_url].filter(k => k && k !== front && k !== back && k !== selfie);
    await deleteDocs(env, stale);
  }

  const kid = id("kyc");
  await env.DB.prepare(
    "INSERT INTO kyc_submissions (id,user_id,full_name,ic_last4,doc_front_url,doc_back_url,selfie_url,status,created_at) " +
    "VALUES (?,?,?,?,?,?,?, 'pending', ?)"
  ).bind(kid, user.id, fullName, icLast4, front, back, selfie, now()).run();
  // Never log the document keys themselves into the audit trail — the trail is
  // widely readable by admins and the keys are the only thing guarding storage.
  await audit(env, user.id, "kyc.submit", kid, { ic_last4: icLast4 });
  return json({ kyc_id: kid, status: "pending" }, 201);
}

// GET /me/kyc
export async function myKyc(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (user.id_verified) return json({ status: "approved" });
  const row = await env.DB.prepare(
    "SELECT id,status,reject_reason,created_at FROM kyc_submissions WHERE user_id=? ORDER BY created_at DESC LIMIT 1"
  ).bind(user.id).first();
  return json({ status: row ? row.status : "not_submitted",
                reject_reason: row ? row.reject_reason : null });
}

// POST /kyc/:id/review  (ADMIN)  body: { action: "approve"|"reject", reason? }
export async function reviewKyc(req, env, params) {
  const admin = await requireUser(req, env);
  if (!admin) return err("unauthorized", 401);
  if (!env.ADMIN_IDS || !env.ADMIN_IDS.split(",").includes(admin.id)) return err("forbidden", 403);
  const sub = await env.DB.prepare("SELECT * FROM kyc_submissions WHERE id=?").bind(params.id).first();
  if (!sub) return err("not found", 404);
  if (sub.status !== "pending") return err("already reviewed", 409);
  const b = await readBody(req);

  if (b.action === "approve") {
    await env.DB.batch([
      env.DB.prepare("UPDATE kyc_submissions SET status='approved', reviewed_at=?, reviewed_by=? WHERE id=?")
        .bind(now(), admin.id, sub.id),
      env.DB.prepare("UPDATE users SET id_verified=1 WHERE id=?").bind(sub.user_id),
    ]);
    await audit(env, admin.id, "kyc.approve", sub.id, { user: sub.user_id });
    await createNotif(env, sub.user_id, "job", "Identity verified",
      "Your ID Verified badge is live — you can now bid on jobs.");
    return json({ ok: true, status: "approved" });
  }
  if (b.action === "reject") {
    const reason = vstr(b.reason || "documents unclear", 300);
    await env.DB.prepare(
      "UPDATE kyc_submissions SET status='rejected', reject_reason=?, reviewed_at=?, reviewed_by=? WHERE id=?"
    ).bind(reason, now(), admin.id, sub.id).run();
    await audit(env, admin.id, "kyc.reject", sub.id, { user: sub.user_id, reason });
    await createNotif(env, sub.user_id, "job", "Verification needs another try", reason);
    return json({ ok: true, status: "rejected" });
  }
  return err("action must be approve or reject", 400);
}

// GET /kyc/pending  (ADMIN) — review queue
export async function pendingKyc(req, env) {
  const admin = await requireUser(req, env);
  if (!admin) return err("unauthorized", 401);
  if (!env.ADMIN_IDS || !env.ADMIN_IDS.split(",").includes(admin.id)) return err("forbidden", 403);
  const { results } = await env.DB.prepare(
    "SELECT id,user_id,full_name,ic_last4,doc_front_url,doc_back_url,selfie_url,created_at " +
    "FROM kyc_submissions WHERE status='pending' ORDER BY created_at ASC LIMIT 50"
  ).all();
  return json({ submissions: results });
}
