// PSP SAFETY GATE: the whole point of the platform's revenue model is the
// commission taken via Xendit's split rule. Malaysia accounts don't get
// Split Payments automatically — Xendit has to activate it — so a partner
// with a live sub-account but no split rule configured would otherwise
// receive the FULL payment with the platform's cut never collected, silently.
// These tests pin the refusal that stops that from happening quietly.
import { authorizePayment, capturePayment } from '../src/lib/psp.js';
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

const base = { paymentId:"pay_1", amountCents:10000, feeCents:2000, netCents:8000,
               customer:{name:"Ali"}, taskTitle:"Cleaning" };

console.log("\n\u2014 Simulation mode (no secret key) is never gated \u2014");
let r = await authorizePayment({}, { ...base, partnerMerchantId:"acc_real_partner" });
ok("simulation still works even with a partnerMerchantId and no split rule",
   r.pspRef === "sim_pay_1", r);

console.log("\n\u2014 THE GATE: real key + partner sub-account + no split rule \u2014");
const liveEnvNoSplit = { XENDIT_SECRET_KEY: "live_fake_key_for_test" };
let threw = null;
try { await authorizePayment(liveEnvNoSplit, { ...base, partnerMerchantId:"acc_real_partner" }); }
catch (e) { threw = e; }
ok("refuses outright (would otherwise leak 100% to the partner)",
   threw && threw.code === "split_rule_missing", threw && threw.message);

console.log("\n\u2014 Cases the gate must NOT block \u2014");
// No partner sub-account yet: money goes to Berespro's own master account.
// That's a different (tracked) gap, not a silent revenue leak, so it must not
// be blocked by this specific gate — blocking it would stop ALL real payments
// (including ones with no partner attached yet) rather than just the unsafe one.
threw = null;
try {
  // will still attempt a real fetch() and fail on the network in this test
  // environment — that's fine, we're only checking it gets PAST the gate.
  await authorizePayment(liveEnvNoSplit, { ...base, partnerMerchantId: null });
} catch (e) { threw = e; }
ok("no partner account + no split rule -> NOT the split_rule_missing gate",
   !threw || threw.code !== "split_rule_missing", threw && threw.code);

console.log("\n\u2014 Once a split rule IS configured, the gate opens \u2014");
const liveEnvWithSplit = { XENDIT_SECRET_KEY: "live_fake_key_for_test", XENDIT_SPLIT_RULE_ID: "splitru_abc" };
threw = null;
try { await authorizePayment(liveEnvWithSplit, { ...base, partnerMerchantId:"acc_real_partner" }); }
catch (e) { threw = e; }
ok("gate does not fire once XENDIT_SPLIT_RULE_ID is set",
   !threw || threw.code !== "split_rule_missing", threw && threw.code);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
