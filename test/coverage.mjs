// COVERAGE: admin switches states/districts on and off. The rule that matters:
// closing an area blocks NEW tasks only — work already in progress is untouched.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, id, now } from '../src/lib/util.js';
import { resolveDistrict, DISTRICTS } from '../src/lib/geo.js';
import { invalidateCoverageCache } from '../src/lib/coverage.js';

const env = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', CLERK_ISSUER:'https://x.clerk.accounts.dev',
              REQUIRE_KYC_TO_BID:'0', ADMIN_IDS:'admin1' };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

const mkUser = async (uid, mode='customer') => {
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?)")
    .bind(uid,'fb_'+uid,'+60'+Math.random().toString().slice(2,11),uid+'@t.my',uid,1,mode,'KL',3.139,101.687,'[]',now()).run();
};
await mkUser('admin1'); await mkUser('cust'); await mkUser('p1','partner');
await env.DB.prepare("INSERT INTO partner_merchants (user_id,psp_merchant_id,status,created_at,updated_at) VALUES (?,?,'active',?,?)").bind('p1','m1',now(),now()).run();
const ta = await signJWT({uid:'admin1'}, env.JWT_SECRET, 3600);
const tc = await signJWT({uid:'cust'}, env.JWT_SECRET, 3600);
const tp = await signJWT({uid:'p1'}, env.JWT_SECRET, 3600);
const call = async (p,m,b,t) => { const r = await worker.fetch(new Request('https://t.dev'+p,
  {method:m,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}),env);
  return {status:r.status, body:await r.json().catch(()=>({}))}; };
const post = async (lat,lng) => call('/tasks','POST',{title:'Job',category:'cleaning',city:'X',addr:'a',lat,lng,budget_cents:10000}, tc);
const cov = async (scope,active) => { const r = await call('/admin/coverage','PATCH',{scope,active}, ta); invalidateCoverageCache(); return r; };

const KL=[3.139,101.687], JB=[1.4927,103.7414], PENANG=[5.4141,100.3288], PJ=[3.107,101.606];

console.log("\n\u2014 Geography resolves correctly \u2014");
ok("121 districts loaded", DISTRICTS.length>100, DISTRICTS.length);
ok("KL pin -> WP Kuala Lumpur", resolveDistrict(...KL).district==='Kuala Lumpur');
ok("JB pin -> Johor / Johor Bahru", resolveDistrict(...JB).state==='Johor' && resolveDistrict(...JB).district==='Johor Bahru');
ok("PJ pin -> Selangor / Petaling", resolveDistrict(...PJ).district==='Petaling');
ok("pin far outside Malaysia -> no match", resolveDistrict(13.75,100.5)===null);

console.log("\n\u2014 Default: everywhere is OPEN (deploy changes nothing) \u2014");
let r = await post(...KL);
ok("task in KL accepted by default", r.status===201, r.body);
ok("resolved area recorded on the task", r.body.task && (await env.DB.prepare("SELECT state,district FROM tasks WHERE id=?").bind(r.body.task.id).first()).district==='Kuala Lumpur');
r = await post(...JB);
ok("task in JB accepted by default", r.status===201, r.status);
r = await post(13.75,100.5);
ok("task pinned outside Malaysia rejected", r.status===403 && r.body.error.code==='area_not_covered', r.body);

console.log("\n\u2014 Close ONE district \u2014");
r = await cov('district:WP Kuala Lumpur|Kuala Lumpur', false);
ok("admin closes KL district", r.status===200, r.body);
r = await post(...KL);
ok("new task in KL now blocked", r.status===403 && r.body.error.code==='area_not_covered', r.body);
ok("error names the place", /Kuala Lumpur/.test(r.body.error.message), r.body.error.message);
r = await post(...JB);
ok("other districts unaffected", r.status===201, r.status);
r = await cov('district:WP Kuala Lumpur|Kuala Lumpur', null);
ok("clearing the exception reopens it", r.status===200 && (await post(...KL)).status===201);

console.log("\n\u2014 Close a whole STATE \u2014");
await cov('state:Johor', false);
r = await post(...JB);
ok("state closed blocks its districts", r.status===403, r.status);
r = await post(2.0250,103.3185); // Kluang, also Johor
ok("another district in that state also blocked", r.status===403, r.status);
r = await post(...PENANG);
ok("other states unaffected", r.status===201, r.status);

console.log("\n\u2014 Most specific wins: reopen ONE district inside a closed state \u2014");
await cov('district:Johor|Johor Bahru', true);
r = await post(...JB);
ok("district explicitly ON overrides its closed state", r.status===201, r.body);
r = await post(2.0250,103.3185);
ok("rest of the closed state stays blocked", r.status===403, r.status);
await cov('state:Johor', null); await cov('district:Johor|Johor Bahru', null);

console.log("\n\u2014 IN-PROGRESS WORK IS NEVER TOUCHED (the whole point) \u2014");
r = await post(...PENANG);
const tid = r.body.task.id;
let b = (await call(`/tasks/${tid}/bids`,'POST',{amount_cents:10000,message:'hi'}, tp)).body.bid_id;
await call(`/bids/${b}/accept`,'POST',{}, tc);
const pay = await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(tid).first();
const { onHeld } = await import('../src/routes/payments.js'); await onHeld(env, pay);
ok("job is in progress", (await env.DB.prepare("SELECT status FROM tasks WHERE id=?").bind(tid).first()).status==='inprogress');
await cov('state:Pulau Pinang', false);   // close the state UNDER the live job
r = await call(`/jobs/${tid}/complete`,'POST',{}, tp);
ok("partner can still mark complete in a closed area", r.status===200, r.body);
r = await call(`/jobs/${tid}/confirm`,'POST',{}, tc);
ok("customer can still confirm and release payment", r.status===200, r.body);
ok("money still captured normally", (await env.DB.prepare("SELECT status FROM payments WHERE id=?").bind(pay.id).first()).status==='captured');
r = await post(...PENANG);
ok("but NEW tasks there are blocked", r.status===403, r.status);
await cov('state:Pulau Pinang', null);

console.log("\n\u2014 Admin view + guards \u2014");
r = await call('/admin/coverage','GET',null, ta);
ok("coverage list returns all 16 states", r.body.states && r.body.states.length===16, r.body.states && r.body.states.length);
ok("each state carries its districts", r.body.states[0].districts.length>0);
ok("live task counts included", r.body.states.some(s=>s.districts.some(d=>d.live_tasks>=0)));
r = await call('/admin/coverage','GET',null, tc);
ok("non-admin cannot read coverage", r.status===403, r.status);
r = await call('/admin/coverage','PATCH',{scope:'state:Johor',active:false}, tc);
ok("non-admin cannot change coverage", r.status===403, r.status);
r = await cov('state:Atlantis', false);
ok("unknown state rejected", r.status===404, r.status);
r = await cov('district:Johor|Nowhere', false);
ok("unknown district rejected", r.status===404, r.status);
r = await cov('rubbish', false);
ok("malformed scope rejected", r.status===400, r.status);
r = await call('/admin/coverage','PATCH',{scope:'state:Johor',active:'yes'}, ta);
ok("non-boolean active rejected", r.status===400, r.status);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
