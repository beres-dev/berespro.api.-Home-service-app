// src/lib/voucher.js — voucher engine.
// RULE: discounts are ALWAYS absorbed by the PLATFORM FEE, never the partner's 80%.
// Therefore max effective discount = platform fee for that payment. This keeps the
// PSP split valid (partner net unchanged) and Berespro's exposure bounded.
import { id, now } from "./util.js";

// Validate a code for a user + amount. Returns { ok, discount_cents, voucher } or { ok:false, reason }.
export async function evaluateVoucher(env, code, userId, amountCents, feeCents) {
  const v = await env.DB.prepare("SELECT * FROM vouchers WHERE code=?").bind(code.toUpperCase()).first();
  if (!v) return { ok: false, reason: "invalid_code" };
  if (!v.active) return { ok: false, reason: "inactive" };
  if (v.expires_at && v.expires_at < now()) return { ok: false, reason: "expired" };
  if (amountCents < v.min_amount_cents) return { ok: false, reason: "below_min_spend" };

  if (v.usage_limit != null) {
    const t = await env.DB.prepare("SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=?")
      .bind(v.id).first();
    if (t.n >= v.usage_limit) return { ok: false, reason: "fully_redeemed" };
  }
  const u = await env.DB.prepare(
    "SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=? AND user_id=?"
  ).bind(v.id, userId).first();
  if (u.n >= v.per_user_limit) return { ok: false, reason: "user_limit_reached" };

  let discount = v.type === "percent"
    ? Math.floor((amountCents * v.value) / 10000)   // value in basis points
    : v.value;                                      // fixed cents
  if (v.max_discount_cents != null) discount = Math.min(discount, v.max_discount_cents);
  discount = Math.min(discount, feeCents);          // platform-fee cap (core rule)
  if (discount <= 0) return { ok: false, reason: "no_discount_applicable" };

  return { ok: true, discount_cents: discount, voucher: v };
}

export async function recordRedemption(env, voucherId, userId, paymentId, discountCents) {
  await env.DB.prepare(
    "INSERT INTO voucher_redemptions (id,voucher_id,user_id,payment_id,discount_cents,created_at) VALUES (?,?,?,?,?,?)"
  ).bind(id("vrd"), voucherId, userId, paymentId, discountCents, now()).run();
}
