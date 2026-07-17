// Customer cancels MID-JOB. New policy: free inside the grace window, after
// that a cancellation fee compensates the partner. Also: per-partner and
// per-category commission overrides.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, id, now } from '../src/lib/util.js';

const env = { DB:new MockDB(), JWT_SECRET:'x'.repeat(20), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', PSP_SECRET:'p', CLERK_ISSUER:'https://x.clerk.accounts.dev',
              REQUIRE_KYC_TO_BID:'0', ADMIN_IDS:'' };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

const mkUser = async (name, mode) => { const uid=id('usr');
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?)")
    .bind(uid,'fb_'+uid,'+60'+Math.random().toString().slice(2,11),name+'@t.my',name,214,mode,'KL',3.139,101.687,'[]',now()).run();
  return uid; };
const T = async uid => await signJWT({uid}, env.JWT_SECRET, 3600);
const call = async (p,m,b,t) => { const r = await worker.fetch(new Request('https://t.dev'+p,
  {method:m, headers:{authorization:'Bearer '+t,'content-type':'application/json'},
   body:b?JSON.stringify(b):undefined}), env); return {status:r.status, body:await r.json().catch(()=>({}))}; };

const cust = await mkUser('Cust','customer');
const p1 = await mkUser('Partner1','partner');
const tc = await T(cust), t1 = await T(p1);
env.ADMIN_IDS = cust; // reuse customer as admin for settings PATCH
await env.DB.prepare("INSERT INTO partner_merchants (user_id,psp_merchant_id,status,created_at,updated_at) VALUES (?,?,'active',?,?)")
  .bind(p1, 'mch_'+p1, now(), now()).run();

const newTask = async (cat='cleaning') => {
  const r = await call('/tasks','POST',{title:'Job',category:cat,city:'KL',
    addr:'x',lat:3.139,lng:101.687,budget_cents:10000}, tc);
  return r.body.task.id;
};
const startJob = async (tid, amt=10000) => {
  const b = (await call(`/tasks/${tid}/bids`,'POST',{amount_cents:amt, message:'hi'}, t1)).body.bid_id;
  await call(`/bids/${b}/accept`,'POST',{}, tc);
  const p = await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(tid).first();
  const { onHeld } = await import('../src/routes/payments.js'); await onHeld(env, p);
  return p.id;
};
const payRow = async pid => await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(pid).first();

console.log("\n\u2014 Inside the grace window: free, full refund \u2014");
let tid = await newTask(); let pid = await startJob(tid);
let r = await call(`/jobs/${tid}/cancel`,'POST',{reason:'changed plans'}, tc);
ok("cancel succeeds", r.status===200, r.body);
ok("marked as in-grace", r.body.in_grace===true, r.body);
ok("no compensation taken", r.body.compensation_cents===0, r.body);
ok("full amount refunded", r.body.refunded_cents===10000, r.body);
ok("payment refunded", (await payRow(pid)).status==='refunded');
ok("cancellation recorded for the customer",
   !!(await env.DB.prepare("SELECT * FROM cancellations WHERE task_id=?").bind(tid).first()));

console.log("\n\u2014 Past the grace window: partner is compensated \u2014");
tid = await newTask(); pid = await startJob(tid);
// age the hold beyond the 60-min default grace
await env.DB.prepare("UPDATE payments SET updated_at=? WHERE id=?").bind(now()-7200, pid).run();
r = await call(`/jobs/${tid}/cancel`,'POST',{reason:'changed plans'}, tc);
ok("cancel succeeds", r.status===200, r.body);
ok("NOT in grace", r.body.in_grace===false, r.body);
ok("10% default fee taken (RM 10 of RM 100)", r.body.compensation_cents===1000, r.body);
ok("rest refunded", r.body.refunded_cents===9000, r.body);
let p = await payRow(pid);
ok("payment captured (partially)", p.status==='captured', p.status);
ok("original gross preserved for audit", p.original_amount_cents===10000, p);
ok("captured amount is the fee", p.amount_cents===1000, p);
ok("commission applied to the fee (20% of RM10 = RM2)", p.fee_cents===200, p);
ok("partner nets RM8", p.net_cents===800, p);
const notif = (await env.DB.prepare("SELECT * FROM notifications WHERE user_id=?").bind(p1).all()).results;
ok("partner told about the compensation", notif.some(n=>/Cancellation fee/i.test(n.title)), notif.map(n=>n.title));
const earn = await call('/me/earnings','GET',null,t1);
ok("compensation shows in partner earnings", earn.body.total_earned_cents===800, earn.body.total_earned_cents);

console.log("\n\u2014 Admin can tune the policy \u2014");
r = await call('/admin/settings','PATCH',{cancel_fee_bps:2500, cancel_grace_min:0}, tc);
ok("policy PATCH accepted", r.status===200 && r.body.applied.cancel_fee_bps===2500, r.body);
tid = await newTask(); pid = await startJob(tid);
r = await call(`/jobs/${tid}/cancel`,'POST',{}, tc);
ok("25% fee, zero grace", r.body.compensation_cents===2500 && r.body.in_grace===false, r.body);
await call('/admin/settings','PATCH',{cancel_fee_bps:0, cancel_grace_min:60}, tc);
tid = await newTask(); pid = await startJob(tid);
await env.DB.prepare("UPDATE payments SET updated_at=? WHERE id=?").bind(now()-7200, pid).run();
r = await call(`/jobs/${tid}/cancel`,'POST',{}, tc);
ok("fee=0 restores old full-refund behaviour", r.body.compensation_cents===0 && r.body.refunded_cents===10000, r.body);
await call('/admin/settings','PATCH',{cancel_fee_bps:1000}, tc);

console.log("\n\u2014 A dispute still blocks cancellation \u2014");
tid = await newTask(); await startJob(tid);
await call(`/jobs/${tid}/dispute`,'POST',{reason:'not happy'}, tc);
r = await call(`/jobs/${tid}/cancel`,'POST',{}, tc);
ok("blocked with dispute_open", r.status===409 && r.body.error.code==='dispute_open', r.body);

console.log("\n\u2014 Commission overrides: partner > category > default \u2014");
r = await call('/admin/settings','PATCH',{['commission_cat_cleaning']:1500}, tc);
ok("category override accepted", r.status===200, r.body);
tid = await newTask('cleaning'); pid = await startJob(tid);
p = await payRow(pid);
ok("category rate applied (15% of RM100)", p.fee_cents===1500 && p.net_cents===8500, p);

r = await call('/admin/settings','PATCH',{['commission_partner_'+p1]:1000}, tc);
ok("partner override accepted", r.status===200, r.body);
tid = await newTask('cleaning'); pid = await startJob(tid);
p = await payRow(pid);
ok("partner rate beats category rate (10%)", p.fee_cents===1000 && p.net_cents===9000, p);

r = await call('/admin/settings','PATCH',{['commission_partner_'+p1]:null}, tc);
ok("clearing an override works", r.status===200, r.body);
tid = await newTask('cleaning'); pid = await startJob(tid);
p = await payRow(pid);
ok("falls back to category rate after clear", p.fee_cents===1500, p);

r = await call('/admin/settings','PATCH',{['commission_partner_nonexistent']:1000}, tc);
ok("override for unknown partner rejected", r.status===404, r.status);
r = await call('/admin/settings','PATCH',{['commission_cat_cleaning']:9999}, tc);
ok("override above 50% cap rejected", r.status===400, r.status);
r = await call('/admin/settings','PATCH',{cancel_fee_bps:1000}, t1);
ok("non-admin cannot touch policy", r.status===403, r.status);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
