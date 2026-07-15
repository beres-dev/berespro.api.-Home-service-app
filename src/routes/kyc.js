// src/routes/kyc.js — partner identity verification.
// PROTECTS USERS: partners enter customers' homes — identity must be verified
// before they can bid. PROTECTS PARTNERS: verified badge wins more jobs.
// PROTECTS BERESPRO: audit trail + due diligence record.
//
// Privacy by design: we store document REFERENCES (R2 URLs) and the IC's last-4
// only — never the full IC number. Documents should live in a private R2 bucket
// with short-lived signed URLs for admin review.
import { json, err, id, now, readBody } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { rateLimit, vstr, LIMITS, audit } from "../lib/guard.js";
import { createNotif } from "./bids.js";

// POST /kyc/submit  body: { full_name, ic_last4, doc_front_url, doc_back_url?, selfie_url }
export async function submitKyc(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (user.id_verified) return json({ status: "approved" });

  if (!(await rateLimit(env, `kyc:${user.id}:day`, LIMITS.KYC_PER_DAY, 86400)))
    return err("too many KYC attempts today", 429);

  const b = await readBody(req);
  const fullName = vstr(b.full_name, LIMITS.NAME_MAX);
  const icLast4 = vstr(b.ic_last4, 4, 4);
  const front = vstr(b.doc_front_url, 500);
  const selfie = vstr(b.selfie_url, 500);
  if (!fullName || !icLast4 || !/^\d{4}$/.test(icLast4) || !front || !selfie)
    return err("full_name, ic_last4 (4 digits), doc_front_url, selfie_url required", 400);

  // one pending submission at a time
  const pending = await env.DB.prepare(
    "SELECT id FROM kyc_submissions WHERE user_id=? AND status='pending'"
  ).bind(user.id).first();
  if (pending) return err("a submission is already under review", 409, "kyc_pending");

  const kid = id("kyc");
  await env.DB.prepare(
    "INSERT INTO kyc_submissions (id,user_id,full_name,ic_last4,doc_front_url,doc_back_url,selfie_url,status,created_at) " +
    "VALUES (?,?,?,?,?,?,?, 'pending', ?)"
  ).bind(kid, user.id, fullName, icLast4, front, vstr(b.doc_back_url || "", 500) || null, selfie, now()).run();
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
