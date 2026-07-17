// src/lib/psp.js — Xendit escrow adapter.
//
// Berespro never touches customer funds. Xendit holds the money and, on our
// instruction, either captures + splits (partner / platform) or returns it.
//
// Flow, mapped onto the states the rest of the app already uses:
//   authorizePayment -> POST /v3/payment_requests  (capture_method: MANUAL)
//                       status REQUIRES_ACTION, customer redirected to pay
//                       webhook  -> status AUTHORIZED   == our "held"
//   capturePayment   -> POST /v3/payments/{payment_id}/capture
//                       status SUCCEEDED                == our "captured"
//   voidPayment      -> cancel (not yet captured) or refund (already captured)
//
// Built against the published OpenAPI specs (api-version 2024-11-11):
//   https://docs.xendit.co/apidocs/create-payment-request.md
//   https://docs.xendit.co/apidocs/capture-payment.md
//
// Needed in the Xendit dashboard before this is live:
//   XENDIT_SECRET_KEY      secret API key (Settings > Developers > API Keys)
//   XENDIT_CALLBACK_TOKEN  webhook token (Settings > Developers > Webhooks)
//   XENDIT_SPLIT_RULE_ID   xenPlatform split rule that peels off the platform fee
//
// With no XENDIT_SECRET_KEY set, every function falls back to the simulation
// path, so the app still runs end-to-end before the account is switched on.
//
// KNOWN GAP: cards support a real authorize-then-capture hold. FPX (online
// banking) debits immediately and cannot be held the same way. Until that is
// confirmed with Xendit for this account, CARDS is the only escrow channel.

const API = "https://api.xendit.co";
const API_VERSION = "2024-11-11";

// Xendit amounts are in major units (MYR); our ledger is in cents. Convert in one place.
const toMajor = (cents) => Number((cents / 100).toFixed(2));

function simulating(env) {
  return !env.XENDIT_SECRET_KEY;
}

async function xendit(env, method, path, { body, forUserId, withSplitRule, idempotencyKey } = {}) {
  const headers = {
    // Basic auth: secret key as username, empty password.
    authorization: "Basic " + btoa(env.XENDIT_SECRET_KEY + ":"),
    "content-type": "application/json",
    "api-version": API_VERSION,
  };
  if (forUserId) headers["for-user-id"] = forUserId;
  if (withSplitRule) headers["with-split-rule"] = withSplitRule;
  // Xendit retries, and networks fail. An idempotency key stops a retry from
  // charging or capturing the same job twice.
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json.message || json.error_code || `Xendit ${res.status}`);
    e.code = json.error_code;
    e.status = res.status;
    throw e;
  }
  return json;
}

// Same physical card = same fingerprint, across tokens AND across accounts.
// This is what lets us spot one card quietly funding many accounts.
export function cardFingerprint(obj) {
  return (obj && obj.channel_properties && obj.channel_properties.card_details &&
          obj.channel_properties.card_details.fingerprint) || null;
}

// Where the customer must be sent to actually pay.
function actionUrl(pr) {
  const actions = pr.actions || [];
  const a = actions.find((x) => x.type === "REDIRECT_CUSTOMER") ||
            actions.find((x) => x.descriptor === "WEB_URL");
  return a ? a.value : null;
}

// Create a payment that HOLDS `amountCents` from the customer.
// Returns { pspRef, paymentUrl } — the app sends the customer to paymentUrl.
export async function authorizePayment(env, { paymentId, amountCents, feeCents, netCents,
                                              customer, partnerMerchantId, taskTitle }) {
  if (simulating(env)) {
    return {
      pspRef: "sim_" + paymentId,
      paymentUrl: (env.PUBLIC_URL || "") + "/dev/simulate-pay?ref=sim_" + paymentId,
    };
  }

  const pr = await xendit(env, "POST", "/v3/payment_requests", {
    // Collect into the partner's sub-account and let the split rule take the
    // platform fee. That keeps Berespro out of the flow of funds.
    forUserId: partnerMerchantId || undefined,
    withSplitRule: env.XENDIT_SPLIT_RULE_ID || undefined,
    idempotencyKey: paymentId,
    body: {
      reference_id: paymentId,          // must be unique for CARDS
      type: "PAY",
      country: "MY",
      currency: "MYR",
      request_amount: toMajor(amountCents),
      capture_method: "MANUAL",         // authorize now, capture on confirmation
      channel_code: "CARDS",
      channel_properties: {
        success_return_url: (env.PUBLIC_URL || "") + "/pay/return?ref=" + paymentId,
        failure_return_url: (env.PUBLIC_URL || "") + "/pay/return?ref=" + paymentId + "&failed=1",
      },
      description: "Berespro: " + String(taskTitle || "").slice(0, 200),
      metadata: {
        berespro_payment_id: paymentId,
        fee_cents: String(feeCents),
        net_cents: String(netCents),
      },
      ...(customer && customer.name
        ? {
            customer: {
              type: "INDIVIDUAL",
              reference_id: "cust_" + paymentId,
              individual_detail: { given_names: String(customer.name).slice(0, 50) },
              ...(customer.email ? { email: customer.email } : {}),
              ...(customer.phone ? { mobile_number: customer.phone } : {}),
            },
          }
        : {}),
    },
  });

  return {
    pspRef: pr.payment_request_id,
    paymentUrl: actionUrl(pr),
    pspPaymentId: pr.latest_payment_id || null,
    cardFp: cardFingerprint(pr),
    status: pr.status,
  };
}

// Capture a held payment -> Xendit settles it and the split rule applies the fee.
// NOTE: capture needs the PAYMENT id (py-...), not the payment REQUEST id (pr-...).
// The webhook gives us the payment id; we store it next to psp_ref.
export async function capturePayment(env, { pspRef, pspPaymentId, netCents, feeCents, amountCents }) {
  if (simulating(env)) return { ok: true };

  const payId = pspPaymentId || pspRef;
  const total = amountCents != null ? amountCents : (netCents || 0) + (feeCents || 0);
  const out = await xendit(env, "POST", `/v3/payments/${payId}/capture`, {
    idempotencyKey: "cap_" + payId,
    body: { capture_amount: toMajor(total) },
  });
  return { ok: out.status === "SUCCEEDED", status: out.status, raw: out };
}

// Give the money back. Before capture that is a cancel; after capture it is a
// refund. Callers should not have to know which.
export async function voidPayment(env, { pspRef, pspPaymentId, amountCents, captured }) {
  if (simulating(env)) return { ok: true };

  const payId = pspPaymentId || pspRef;
  if (!captured) {
    const out = await xendit(env, "POST", `/v3/payments/${payId}/cancel`, {
      idempotencyKey: "cxl_" + payId,
    });
    return { ok: /CANCELL?ED/i.test(out.status || ""), status: out.status };
  }
  const out = await xendit(env, "POST", "/v3/refunds", {
    idempotencyKey: "ref_" + payId,
    body: {
      payment_request_id: pspRef,
      reason: "REQUESTED_BY_CUSTOMER",
      ...(amountCents != null ? { amount: toMajor(amountCents) } : {}),
    },
  });
  return { ok: out.status === "SUCCEEDED" || out.status === "PENDING", status: out.status };
}

// Create a partner payout sub-account (xenPlatform). Xendit runs the KYC.
export async function createMerchant(env, { userId, name, email, phone }) {
  if (simulating(env)) {
    return { merchantId: "sim_merch_" + userId, onboardingUrl: null, active: true };
  }
  const acc = await xendit(env, "POST", "/v2/accounts", {
    idempotencyKey: "acc_" + userId,
    body: {
      email,
      type: "MANAGED",              // Xendit onboards and KYCs the partner
      public_profile: { business_name: name || "Berespro partner" },
    },
  });
  return {
    merchantId: acc.id,
    onboardingUrl: null,
    // A new managed account cannot be paid until Xendit clears KYC; the account
    // status webhook flips this to active.
    active: acc.status === "LIVE",
  };
}

// Xendit signs webhooks with a STATIC token in x-callback-token (not an HMAC).
// Constant-time compare so a timing side-channel cannot leak it.
export function verifyWebhook(env, req) {
  const got = req.headers.get("x-callback-token") || "";
  const want = env.XENDIT_CALLBACK_TOKEN || "";
  if (!want || !got || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}
