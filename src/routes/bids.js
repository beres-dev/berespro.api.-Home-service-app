// src/routes/bids.js
import { json, err, id, now, readBody } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { authorizePayment } from "../lib/psp.js";
import { pushNotify } from "../lib/notify.js";
import { rateLimit, vint, vstr, LIMITS, audit } from "../lib/guard.js";
import { evaluateVoucher, recordRedemption } from "../lib/voucher.js";
import { commissionBps, commissionBpsFor } from "../lib/settings.js";

// POST /tasks/:id/bids  (partner)
export async function placeBid(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(params.id).first();
  if (!task) return err("task not found", 404);
  if (task.status !== "open") return err("task not open", 409);
  if (task.customer_id === user.id) return err("cannot bid on own task", 409);

  // KYC gate — partners enter people's homes; identity must be verified first
  if ((env.REQUIRE_KYC_TO_BID || "1") !== "0" && !user.id_verified) {
    return err("identity verification required before bidding", 403, "kyc_required");
  }
  if (!(await rateLimit(env, `bids:${user.id}:day`, LIMITS.BIDS_PER_DAY, 86400)))
    return err("daily bid limit reached", 429);

  const b = await readBody(req);
  const amount = vint(b.amount_cents, LIMITS.BID_MIN, LIMITS.BID_MAX);
  if (!amount) return err(`amount_cents must be ${LIMITS.BID_MIN}..${LIMITS.BID_MAX}`, 400);
  b.amount_cents = amount;
  if (b.message !== undefined && b.message !== null && b.message !== "") {
    const m = vstr(b.message, LIMITS.MSG_MAX);
    if (!m) return err("message too long", 400);
    b.message = m;
  }

  const bidId = id("bid");
  try {
    await env.DB.prepare(
      "INSERT INTO bids (id,task_id,partner_id,amount_cents,message,status,created_at) VALUES (?,?,?,?,?, 'pending', ?)"
    ).bind(bidId, task.id, user.id, b.amount_cents, b.message || null, now()).run();
  } catch {
    return err("you already bid on this task", 409);
  }
  await createNotif(env, task.customer_id, "bid",
    `New bid on "${task.title}"`, `${user.name} offered RM ${(b.amount_cents/100).toFixed(2)}`);
  await pushNotify(env, task.customer_id, "New bid received", `${user.name} bid on your task`);
  return json({ bid_id: bidId }, 201);
}

// POST /bids/:id/accept  (customer)
// Creates a PSP-held payment (authorize). Returns payment_url for the customer to
// complete. Acceptance is FINALIZED only when the PSP webhook confirms funds held
// (payments.js -> onHeld). Avoids locking a task on an unpaid accept.
export async function acceptBid(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const bid = await env.DB.prepare("SELECT * FROM bids WHERE id=?").bind(params.id).first();
  if (!bid) return err("bid not found", 404);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(bid.task_id).first();
  if (!task) return err("task not found", 404);
  if (task.customer_id !== user.id) return err("forbidden", 403);
  if (task.status !== "open") return err("task not open", 409);

  // partner must have an ACTIVE payout account or the PSP can't pay them on capture
  const merch = await env.DB.prepare("SELECT * FROM partner_merchants WHERE user_id=?")
    .bind(bid.partner_id).first();
  if (!merch || merch.status !== "active") {
    return err("partner has not set up a payout account yet", 409, "partner_payout_not_connected");
  }

  const bps = await commissionBpsFor(env, { partnerId: bid.partner_id, category: task.category });
  const fee = Math.round((bid.amount_cents * bps) / 10000);
  const net = bid.amount_cents - fee;

  // optional voucher — discount comes out of the PLATFORM FEE only; partner net unchanged
  const body = await readBody(req);
  let discount = 0, voucher = null;
  if (body.voucher_code) {
    const ev = await evaluateVoucher(env, String(body.voucher_code), user.id, bid.amount_cents, fee);
    if (!ev.ok) return err("voucher: " + ev.reason, 400, "voucher_" + ev.reason);
    discount = ev.discount_cents; voucher = ev.voucher;
  }
  const customerPays = bid.amount_cents - discount;

  const customer = await env.DB.prepare("SELECT name,email,phone FROM users WHERE id=?").bind(user.id).first();
  const paymentId = id("pay");
  let auth;
  try {
    auth = await authorizePayment(env, {
      paymentId, amountCents: customerPays, feeCents: fee - discount, netCents: net,
      customer, partnerMerchantId: merch.psp_merchant_id, taskTitle: task.title,
    });
  } catch (e) {
    // A misconfigured PSP must not look like a generic crash to whoever is
    // debugging it — least of all "split_rule_missing", which needs a human
    // to go activate Split Payments with Xendit, not a code fix.
    if (e.code === "split_rule_missing" || e.code === "unsupported_channel")
      return err("Payments are not fully configured yet — contact support", 503, e.code);
    throw e;
  }

  await env.DB.prepare(
    "INSERT INTO payments (id,task_id,bid_id,customer_id,partner_id,amount_cents,fee_cents,net_cents,discount_cents,voucher_code,psp_ref,status,created_at,updated_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)"
  ).bind(paymentId, task.id, bid.id, user.id, bid.partner_id,
         bid.amount_cents, fee, net, discount, voucher ? voucher.code : null,
         auth.pspRef, now(), now()).run();
  if (voucher) await recordRedemption(env, voucher.id, user.id, paymentId, discount);

  await audit(env, user.id, "bid.accept", bid.id,
    { task: task.id, payment: paymentId, amount: bid.amount_cents, discount });
  return json({ payment_id: paymentId, payment_url: auth.paymentUrl,
                amount_cents: bid.amount_cents, discount_cents: discount,
                customer_pays_cents: customerPays, fee_cents: fee, net_cents: net });
}

// POST /bids/:id/decline  (customer)
export async function declineBid(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const bid = await env.DB.prepare("SELECT * FROM bids WHERE id=?").bind(params.id).first();
  if (!bid) return err("not found", 404);
  const task = await env.DB.prepare("SELECT customer_id FROM tasks WHERE id=?").bind(bid.task_id).first();
  if (!task || task.customer_id !== user.id) return err("forbidden", 403);
  await env.DB.prepare("UPDATE bids SET status='declined' WHERE id=?").bind(bid.id).run();
  return json({ ok: true });
}

// GET /me/bids  (partner)
export async function myBids(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const { results } = await env.DB.prepare(
    "SELECT b.*, t.title, t.addr, t.category, t.status tstatus FROM bids b " +
    "JOIN tasks t ON t.id=b.task_id WHERE b.partner_id=? ORDER BY b.created_at DESC"
  ).bind(user.id).all();
  return json({
    bids: results.map((b) => ({
      id: b.id, task_id: b.task_id, amount_cents: b.amount_cents, status: b.status,
      created_at: b.created_at, title: b.title, addr: b.addr, category: b.category,
    })),
  });
}

export async function createNotif(env, userId, type, title, body) {
  await env.DB.prepare(
    "INSERT INTO notifications (id,user_id,type,title,body,read,created_at) VALUES (?,?,?,?,?,0,?)"
  ).bind(id("ntf"), userId, type, title, body || null, now()).run();
}

// POST /vouchers/preview  body: { code, amount_cents } — app-side check before paying
export async function previewVoucher(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const b = await readBody(req);
  const amount = vint(b.amount_cents, LIMITS.BID_MIN, LIMITS.BID_MAX);
  if (!b.code || !amount) return err("code and amount_cents required", 400);
  const bps = await commissionBps(env);
  const fee = Math.round((amount * bps) / 10000);
  const ev = await evaluateVoucher(env, String(b.code), user.id, amount, fee);
  if (!ev.ok) return json({ valid: false, reason: ev.reason });
  return json({ valid: true, discount_cents: ev.discount_cents,
                customer_pays_cents: amount - ev.discount_cents });
}
