// src/routes/partners.js — public profile + PSP payout account connect
import { json, err, now } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { createMerchant } from "../lib/psp.js";

// GET /partners/:id  (public profile with review aggregate)
export async function getPartner(req, env, params) {
  const u = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(params.id).first();
  if (!u) return err("not found", 404);
  const agg = await env.DB.prepare(
    "SELECT COUNT(*) n, COALESCE(AVG(rating),0) avg FROM reviews WHERE ratee_id=?"
  ).bind(u.id).first();
  const jobs = await env.DB.prepare(
    "SELECT COUNT(*) n FROM tasks t JOIN bids b ON b.id=t.accepted_bid_id " +
    "WHERE b.partner_id=? AND t.status='completed'"
  ).bind(u.id).first();
  const { results: reviews } = await env.DB.prepare(
    "SELECT r.rating, r.text, r.created_at, u.name by_name FROM reviews r " +
    "JOIN users u ON u.id=r.rater_id WHERE r.ratee_id=? ORDER BY r.created_at DESC LIMIT 20"
  ).bind(u.id).all();
  const merch = await env.DB.prepare("SELECT status FROM partner_merchants WHERE user_id=?").bind(u.id).first();
  return json({
    partner: {
      id: u.id, name: u.name, avatar_hue: u.avatar_hue, id_verified: !!u.id_verified,
      skills: JSON.parse(u.skills || "[]"),
      rating: +agg.avg.toFixed(2), review_count: agg.n, jobs_completed: jobs.n,
      payout_status: merch ? merch.status : "not_connected",
      reviews,
    },
  });
}

// POST /partners/connect  (partner sets up payout account at the PSP)
// Returns { status, onboarding_url? }. With real PSPs the partner may need to finish
// KYC at onboarding_url; the PSP then calls our webhook with merchant.activated.
export async function connectPayout(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const existing = await env.DB.prepare("SELECT * FROM partner_merchants WHERE user_id=?").bind(user.id).first();
  if (existing && existing.status === "active") {
    return json({ status: "active" });
  }
  const m = await createMerchant(env, { userId: user.id, name: user.name, email: user.email, phone: user.phone });
  const status = m.active ? "active" : "pending";
  if (existing) {
    await env.DB.prepare("UPDATE partner_merchants SET psp_merchant_id=?, status=?, updated_at=? WHERE user_id=?")
      .bind(m.merchantId, status, now(), user.id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO partner_merchants (user_id,psp_merchant_id,status,created_at,updated_at) VALUES (?,?,?,?,?)"
    ).bind(user.id, m.merchantId, status, now(), now()).run();
  }
  return json({ status, onboarding_url: m.onboardingUrl || null });
}

// GET /me/payout  (partner checks their payout account status)
export async function payoutStatus(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const m = await env.DB.prepare("SELECT status FROM partner_merchants WHERE user_id=?").bind(user.id).first();
  return json({ status: m ? m.status : "not_connected" });
}

// POST /partners/:id/verify  (admin only — mark ID verified)
export async function verifyPartner(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (!env.ADMIN_IDS || !env.ADMIN_IDS.split(",").includes(user.id)) return err("forbidden", 403);
  await env.DB.prepare("UPDATE users SET id_verified=1 WHERE id=?").bind(params.id).run();
  return json({ ok: true });
}
