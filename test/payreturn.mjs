// /pay/return — the customer's browser lands here after paying (or failing to
// pay) via Xendit's hosted page. No auth: this is Xendit redirecting the
// customer, not an authenticated app call.
import worker from '../src/index.js';
import { MockDB } from './mockdb.mjs';
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };
const env = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), CLERK_ISSUER:'https://x.clerk.accounts.dev' };

let r = await worker.fetch(new Request('https://t.dev/pay/return?ref=pay_1'), env);
ok("no auth required (Xendit redirects the browser, not the app)", r.status===200, r.status);
ok("HTML content type", (r.headers.get('content-type')||'').includes('text/html'));
let body = await r.text();
ok("success page reads as reassuring, not an error", /thanks/i.test(body), body.slice(0,60));
ok("tells the customer they can go back to the app", /return to the berespro app/i.test(body));

r = await worker.fetch(new Request('https://t.dev/pay/return?ref=pay_1&failed=1'), env);
body = await r.text();
ok("failed=1 shows the FAILURE message, not success", /didn.t go through/i.test(body), body.slice(0,80));
ok("failure page reassures no money moved", /no money has left/i.test(body));
ok("still 200 — a 4xx/5xx here would be its own confusing page", r.status===200, r.status);

r = await worker.fetch(new Request('https://t.dev/pay/return'), env);
ok("missing ref doesn't crash — still renders something", r.status===200, r.status);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
