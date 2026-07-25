// TIPS: 100% to partner, only after completion, only the customer, only once.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, now } from '../src/lib/util.js';
const env = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', CLERK_ISSUER:'https://x.clerk.accounts.dev',
              REQUIRE_KYC_TO_BID:'0', ADMIN_IDS:'adm1' };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };
const mk = async (u,mode) => { await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?)")
  .bind(u,'fb_'+u,'+6012'+u,u+'@t.my','U'+u,214,mode,'KL',3.139,101.687,'[]',now()).run(); };
for (const u of ['cust','other','adm1']) await mk(u,'customer');
await mk('p1','partner');
await env.DB.prepare("INSERT INTO partner_merchants (user_id,psp_merchant_id,status,created_at,updated_at) VALUES ('p1','m1','active',?,?)").bind(now(),now()).run();
const tc=await signJWT({uid:'cust'},env.JWT_SECRET,3600), to=await signJWT({uid:'other'},env.JWT_SECRET,3600),
      tp=await signJWT({uid:'p1'},env.JWT_SECRET,3600), ta=await signJWT({uid:'adm1'},env.JWT_SECRET,3600);
const call = async (p,m,b,t) => { const r = await worker.fetch(new Request('https://t.dev'+p,
  {method:m,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}),env);
  return {status:r.status, body:await r.json().catch(()=>({}))}; };
// full job to completion
const tid = (await call('/tasks','POST',{title:'Job',category:'cleaning',city:'KL',addr:'x',lat:3.139,lng:101.687,budget_cents:10000}, tc)).body.task.id;
const bid = (await call(`/tasks/${tid}/bids`,'POST',{amount_cents:10000,message:'hi'}, tp)).body.bid_id;
await call(`/bids/${bid}/accept`,'POST',{}, tc);
const pay = await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(tid).first();
const { onHeld } = await import('../src/routes/payments.js'); await onHeld(env, pay);

console.log("\n\u2014 Cannot tip before the job is done \u2014");
let r = await call(`/jobs/${tid}/tip`,'POST',{amount_cents:1000}, tc);
ok("tip while in progress -> not_complete", r.status===409 && r.body.error.code==='not_complete', r.body);
r = await call(`/jobs/${tid}/tip`,'GET',null, tc);
ok("can_tip is false before completion", r.body.can_tip===false, r.body);

await call(`/jobs/${tid}/complete`,'POST',{}, tp);
await call(`/jobs/${tid}/confirm`,'POST',{}, tc);

console.log("\n\u2014 After completion \u2014");
r = await call(`/jobs/${tid}/tip`,'GET',null, tc);
ok("can_tip true once complete", r.body.can_tip===true, r.body);
r = await call(`/jobs/${tid}/tip`,'POST',{amount_cents:1500}, tc);
ok("tip accepted", r.status===201 && r.body.tip.amount_cents===1500, r.body);

console.log("\n\u2014 100% to the partner: platform takes NOTHING \u2014");
const tip = await env.DB.prepare("SELECT * FROM tips WHERE task_id=?").bind(tid).first();
ok("stored amount is the full tip", tip.amount_cents===1500, tip);
ok("tips table has no fee column at all", !('fee_cents' in tip) && !('net_cents' in tip), Object.keys(tip));
r = await call('/me/earnings','GET',null, tp);
ok("partner sees tips separately from job earnings", r.body.tips_cents===1500, r.body);
ok("job earnings NOT inflated by the tip", r.body.total_earned_cents===8000, r.body);
const notif = (await env.DB.prepare("SELECT * FROM notifications WHERE user_id='p1'").all()).results;
ok("partner is notified", notif.some(n=>/tip/i.test(n.title)), notif.map(n=>n.title));

console.log("\n\u2014 Guards \u2014");
r = await call(`/jobs/${tid}/tip`,'POST',{amount_cents:1000}, tc);
ok("cannot tip twice", r.status===409 && r.body.error.code==='already_tipped', r.body);
r = await call(`/jobs/${tid}/tip`,'POST',{amount_cents:500}, to);
ok("a stranger cannot tip on someone else's job", r.status===403, r.status);
// fresh completed job for amount checks
const t2 = (await call('/tasks','POST',{title:'J2',category:'cleaning',city:'KL',addr:'x',lat:3.139,lng:101.687,budget_cents:10000}, tc)).body.task.id;
const b2 = (await call(`/tasks/${t2}/bids`,'POST',{amount_cents:10000,message:'x'}, tp)).body.bid_id;
await call(`/bids/${b2}/accept`,'POST',{}, tc);
const p2 = await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(t2).first(); await onHeld(env, p2);
await call(`/jobs/${t2}/complete`,'POST',{}, tp); await call(`/jobs/${t2}/confirm`,'POST',{}, tc);
r = await call(`/jobs/${t2}/tip`,'POST',{amount_cents:50}, tc);
ok("below RM1 rejected", r.status===400 && r.body.error.code==='bad_amount', r.body);
r = await call(`/jobs/${t2}/tip`,'POST',{amount_cents:60000}, tc);
ok("above RM500 rejected", r.status===400, r.status);
r = await call(`/jobs/${t2}/tip`,'POST',{amount_cents:-500}, tc);
ok("negative rejected", r.status===400, r.status);
r = await call(`/jobs/${t2}/tip`,'POST',{amount_cents:1000}, 'rubbish');
ok("needs a session", r.status===401, r.status);
// dispute blocks tipping
const t3 = (await call('/tasks','POST',{title:'J3',category:'cleaning',city:'KL',addr:'x',lat:3.139,lng:101.687,budget_cents:10000}, tc)).body.task.id;
const b3 = (await call(`/tasks/${t3}/bids`,'POST',{amount_cents:10000,message:'x'}, tp)).body.bid_id;
await call(`/bids/${b3}/accept`,'POST',{}, tc);
const p3 = await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(t3).first(); await onHeld(env, p3);
await call(`/jobs/${t3}/complete`,'POST',{}, tp); await call(`/jobs/${t3}/confirm`,'POST',{}, tc);
r = await call(`/jobs/${t3}/dispute`,'POST',{reason:'issue'}, tc);
ok("a completed job cannot be disputed at all (so the states can't overlap today)", r.status===409, r.status);
// The tip guard is defence-in-depth for the day disputes ARE allowed after
// completion. Exercise it directly rather than through a path that cannot
// currently happen, so it is genuinely covered instead of silently dead.
await env.DB.prepare("INSERT INTO disputes (id,task_id,opened_by,reason,status,created_at) VALUES ('dsp_x',?,'cust','late','open',?)").bind(t3, now()).run();
r = await call(`/jobs/${t3}/tip`,'POST',{amount_cents:1000}, tc);
ok("an open dispute pauses tipping", r.status===409 && r.body.error.code==='dispute_open', r.body);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
