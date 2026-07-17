// Verifies the adapter speaks Xendit's actual contract. Money code: if the
// request shape is wrong we find out here, not from a customer's bank statement.
import { authorizePayment, capturePayment, voidPayment, createMerchant,
         verifyWebhook, cardFingerprint } from '../src/lib/psp.js';

let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

// Capture what the adapter sends, and reply with a realistic Xendit response.
let sent = [];
function mockFetch(reply, status=200){
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, method: opts.method, headers: opts.headers,
                body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: status < 400, status, json: async () => reply };
  };
}
const LIVE = { XENDIT_SECRET_KEY: 'xnd_test_123', PUBLIC_URL: 'https://api.berespro.my',
               XENDIT_SPLIT_RULE_ID: 'splitru_abc', XENDIT_CALLBACK_TOKEN: 'tok_secret' };

console.log("\n\u2014 Authorize: create a MANUAL-capture hold \u2014");
sent = [];
mockFetch({
  payment_request_id: 'pr-123', latest_payment_id: 'py-123', status: 'REQUIRES_ACTION',
  actions: [{ type:'REDIRECT_CUSTOMER', descriptor:'WEB_URL', value:'https://pay.xendit.co/abc' }],
  channel_properties: { card_details: { fingerprint: 'fp_aaa', masked_card_number: '4000****1091' } },
}, 201);
let r = await authorizePayment(LIVE, { paymentId:'pay_1', amountCents:12000, feeCents:2400,
  netCents:9600, customer:{name:'Nadia', email:'n@x.my', phone:'+60123'},
  partnerMerchantId:'acc_partner1', taskTitle:'Fix leaking sink' });
const req = sent[0];

ok("hits POST /v3/payment_requests", req.url==='https://api.xendit.co/v3/payment_requests' && req.method==='POST', req.url);
ok("capture_method is MANUAL (money held, not taken)", req.body.capture_method==='MANUAL', req.body.capture_method);
ok("amount converted cents -> MYR major units", req.body.request_amount===120, req.body.request_amount);
ok("country MY / currency MYR", req.body.country==='MY' && req.body.currency==='MYR', [req.body.country,req.body.currency]);
ok("our payment id is the reference_id", req.body.reference_id==='pay_1', req.body.reference_id);
ok("collects into the partner sub-account", req.headers['for-user-id']==='acc_partner1', req.headers['for-user-id']);
ok("split rule applied so the fee is peeled off", req.headers['with-split-rule']==='splitru_abc', req.headers['with-split-rule']);
ok("idempotency key set (a retry must not double-charge)", req.headers['idempotency-key']==='pay_1', req.headers['idempotency-key']);
ok("basic auth, secret as username", req.headers.authorization==='Basic '+btoa('xnd_test_123:'), req.headers.authorization);
ok("api-version pinned", req.headers['api-version']==='2024-11-11', req.headers['api-version']);
ok("returns the pay URL to send the customer to", r.paymentUrl==='https://pay.xendit.co/abc', r.paymentUrl);
ok("returns payment_request_id as pspRef", r.pspRef==='pr-123', r.pspRef);
ok("captures the card fingerprint", r.cardFp==='fp_aaa', r.cardFp);

console.log("\n\u2014 Capture: release the held money \u2014");
sent = [];
mockFetch({ status:'SUCCEEDED', payment_id:'py-123' });
r = await capturePayment(LIVE, { pspRef:'pr-123', pspPaymentId:'py-123', amountCents:12000, netCents:9600, feeCents:2400 });
ok("captures by PAYMENT id, not request id", sent[0].url==='https://api.xendit.co/v3/payments/py-123/capture', sent[0].url);
ok("captures the full authorised amount", sent[0].body.capture_amount===120, sent[0].body.capture_amount);
ok("reports success", r.ok===true, r);

console.log("\n\u2014 Void: held money goes back \u2014");
sent = [];
mockFetch({ status:'CANCELED' });
r = await voidPayment(LIVE, { pspRef:'pr-123', pspPaymentId:'py-123', captured:false });
ok("not captured yet -> cancels the authorisation", sent[0].url==='https://api.xendit.co/v3/payments/py-123/cancel', sent[0].url);
ok("cancel reported ok", r.ok===true, r);

sent = [];
mockFetch({ status:'SUCCEEDED' });
r = await voidPayment(LIVE, { pspRef:'pr-123', pspPaymentId:'py-123', amountCents:12000, captured:true });
ok("already captured -> issues a refund instead", sent[0].url==='https://api.xendit.co/v3/refunds', sent[0].url);
ok("refund references the payment request", sent[0].body.payment_request_id==='pr-123', sent[0].body);

console.log("\n\u2014 Webhook: static token, constant-time \u2014");
const mk = (tok) => ({ headers: { get: (h) => h==='x-callback-token' ? tok : null } });
ok("correct token accepted", verifyWebhook(LIVE, mk('tok_secret'))===true);
ok("wrong token rejected", verifyWebhook(LIVE, mk('tok_wrong!'))===false);
ok("missing token rejected", verifyWebhook(LIVE, mk(null))===false);
ok("no token configured -> reject everything (fail closed)", verifyWebhook({}, mk('anything'))===false);

console.log("\n\u2014 Simulation mode still works before Xendit is switched on \u2014");
sent = [];
r = await authorizePayment({ PUBLIC_URL:'https://x.dev' }, { paymentId:'pay_9', amountCents:100 });
ok("no secret key -> no live API call", sent.length===0, sent.length);
ok("still returns a usable pay URL", /simulate-pay/.test(r.paymentUrl), r.paymentUrl);
ok("capture in sim mode is a no-op that succeeds", (await capturePayment({}, {})).ok===true);

console.log("\n\u2014 Errors surface instead of silently passing \u2014");
mockFetch({ error_code:'CARD_DECLINED', message:'Card was declined' }, 400);
let threw = null;
try { await authorizePayment(LIVE, { paymentId:'pay_2', amountCents:5000 }); } catch(e){ threw = e; }
ok("a declined card throws", !!threw, threw && threw.message);
ok("the decline reason is preserved", threw && threw.code==='CARD_DECLINED', threw && threw.code);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
