// src/lib/psp.js — LICENSED-PSP escrow adapter.
// Berespro NEVER touches customer funds. The PSP holds the money and, on our
// API instruction, either captures+splits (80% partner / 20% platform) or refunds.
//
// Every function here is generic. Fill the bodies to match YOUR chosen Malaysian
// marketplace PSP (iPay88 split settlement, Curlec/Razorpay Route, senangPay
// marketplace, etc.). The rest of the app only depends on the SHAPES returned below.
//
// NUANCE: card rails support true authorize-hold-then-capture. FPX (online banking)
// does not — for FPX the PSP debits into a trust/escrow account and "capture"
// becomes "release from trust". Both map onto the states pending -> held ->
// captured/refunded used here; your adapter hides the difference.

// Create a payment that HOLDS `amountCents` from the customer.
// Returns { pspRef, paymentUrl } — the app opens paymentUrl for the customer to pay.
export async function authorizePayment(env, { paymentId, amountCents, feeCents, netCents,
                                              customer, partnerMerchantId, taskTitle }) {
  // ---- EXAMPLE shape (pseudo, adapt to your PSP) ----
  // const res = await fetch(env.PSP_BASE + "/v1/payments", {
  //   method: "POST",
  //   headers: { authorization: "Bearer " + env.PSP_KEY, "content-type": "application/json" },
  //   body: JSON.stringify({
  //     capture: false,                       // AUTHORIZE only — hold, don't take yet
  //     amount: amountCents, currency: "MYR",
  //     description: "Berespro: " + taskTitle,
  //     customer: { name: customer.name, email: customer.email, phone: customer.phone },
  //     transfers: [{ merchant_id: partnerMerchantId, amount: netCents }], // applied at capture
  //     platform_fee: feeCents,
  //     reference: paymentId,
  //     callback_url: env.PUBLIC_URL + "/webhooks/psp",
  //     redirect_url: env.PUBLIC_URL + "/pay/return",
  //   }),
  // });
  // const p = await res.json();
  // return { pspRef: p.id, paymentUrl: p.payment_url };

  // ---- MVP simulation (lets the whole flow run before a real PSP is wired) ----
  return {
    pspRef: "sim_" + paymentId,
    paymentUrl: (env.PUBLIC_URL || "") + "/dev/simulate-pay?ref=sim_" + paymentId,
  };
}

// Capture a held payment -> PSP moves money and splits to partner + platform.
export async function capturePayment(env, { pspRef, netCents, feeCents, partnerMerchantId }) {
  // const res = await fetch(env.PSP_BASE + "/v1/payments/" + pspRef + "/capture", {
  //   method: "POST", headers: { authorization: "Bearer " + env.PSP_KEY, "content-type": "application/json" },
  //   body: JSON.stringify({ transfers: [{ merchant_id: partnerMerchantId, amount: netCents }], platform_fee: feeCents }) });
  // return { ok: res.ok };
  return { ok: true }; // simulation
}

// Void / refund a held payment -> money returns to the customer.
export async function voidPayment(env, { pspRef }) {
  // const res = await fetch(env.PSP_BASE + "/v1/payments/" + pspRef + "/refund", {
  //   method: "POST", headers: { authorization: "Bearer " + env.PSP_KEY } });
  // return { ok: res.ok };
  return { ok: true }; // simulation
}

// Create a partner payout sub-merchant at the PSP (KYC handled by the PSP).
// Returns { merchantId, onboardingUrl?, active }.
export async function createMerchant(env, { userId, name, email, phone }) {
  // const res = await fetch(env.PSP_BASE + "/v1/merchants", {
  //   method: "POST", headers: { authorization: "Bearer " + env.PSP_KEY, "content-type": "application/json" },
  //   body: JSON.stringify({ name, email, phone, reference: userId }) });
  // const m = await res.json();
  // return { merchantId: m.id, onboardingUrl: m.kyc_url || null, active: false };
  return { merchantId: "sim_merch_" + userId, onboardingUrl: null, active: true }; // simulation: auto-active
}
