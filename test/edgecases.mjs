// ADVERSARIAL AUDIT: every state collision the system can reach, especially
// where money moves. Each block is an attack or a race, not a happy path.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, id, now } from '../src/lib/util.js';
import { onHeld } from '../src/routes/payments.js';

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
const cust2 = await mkUser('Cust2','customer');
const p1 = await mkUser('P1','partner');
const p2 = await mkUser('P2','partner');
const tc=await T(cust), tc2=await T(cust2), t1=await T(p1), t2=await T(p2);
env.ADMIN_IDS = cust2; // cust2 doubles as admin
for (const p of [p1,p2]) await env.DB.prepare("INSERT INTO partner_merchants (user_id,psp_merchant_id,status,created_at,updated_at) VALUES (?,?,'active',?,?)").bind(p,'m_'+p,now(),now()).run();

const newTask = async (tok=tc) => (await call('/tasks','POST',{title:'Job',category:'cleaning',city:'KL',addr:'x',lat:3.139,lng:101.687,budget_cents:10000}, tok)).body.task.id;
const bid = async (tid, tok, amt=10000) => (await call(`/tasks/${tid}/bids`,'POST',{amount_cents:amt,message:'hi'}, tok)).body.bid_id;
const hold = async (tid) => { const p = await env.DB.prepare("SELECT * FROM payments WHERE task_id=? AND status='pending'").bind(tid).first(); if(p) await onHeld(env,p); return p; };
const payRow = async tid => await env.DB.prepare("SELECT * FROM payments WHERE task_id=? ORDER BY created_at DESC").bind(tid).first();
const taskRow = async tid => await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(tid).first();

console.log("\n\u2014 IDENTITY & OWNERSHIP \u2014");
let tid = await newTask();
let b1 = await bid(tid, t1);
let r = await call(`/tasks/${tid}/bids`,'POST',{amount_cents:9000,message:'x'}, tc);
ok("customer cannot bid on own task", r.status===409, r.status);
r = await call(`/tasks/${tid}/bids`,'POST',{amount_cents:9000,message:'x'}, t1);
ok("partner cannot bid twice", r.status===409, r.status);
r = await call(`/bids/${b1}/accept`,'POST',{}, tc2);
ok("stranger cannot accept someone else's bid", r.status===403, r.status);
r = await call(`/bids/${b1}`,'DELETE',null, t2);
ok("partner cannot withdraw another partner's bid", r.status===403, r.status);

console.log("\n\u2014 DOUBLE-ACCEPT / DOUBLE-PAY \u2014");
let b2 = await bid(tid, t2, 9000);
r = await call(`/bids/${b1}/accept`,'POST',{}, tc);
ok("first accept creates pending payment", r.status===200, r.body);
r = await call(`/bids/${b2}/accept`,'POST',{}, tc);
ok("!! second accept while first pending: task still open, so ALLOWED?", r.status===200||r.status===409, r.status);
const pays = (await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(tid).all()).results;
console.log("     pending payments on one task:", pays.length);
await hold(tid); // first webhook lands
const t_ = await taskRow(tid);
ok("task inprogress after first hold", t_.status==='inprogress', t_.status);
// second webhook lands for the OTHER payment — task no longer open
const p2nd = (await env.DB.prepare("SELECT * FROM payments WHERE task_id=? AND status='pending'").bind(tid).all()).results[0];
if (p2nd){ await onHeld(env, p2nd);
  const after = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(p2nd.id).first();
  ok("second hold auto-voided (task no longer open)", after.status==='refunded', after.status);
} else { ok("second accept was blocked, no orphan payment", true); }

console.log("\n\u2014 DOUBLE CONFIRM / DOUBLE CAPTURE \u2014");
r = await call(`/jobs/${tid}/confirm`,'POST',{}, tc);
ok("confirm captures", r.status===200, r.body);
r = await call(`/jobs/${tid}/confirm`,'POST',{}, tc);
ok("second confirm rejected (no double capture)", r.status===409, r.status);
r = await call(`/jobs/${tid}/cancel`,'POST',{}, tc);
ok("cancel after completion rejected", r.status===409, r.status);

console.log("\n\u2014 CANCEL vs WITHDRAW RACE \u2014");
tid = await newTask(); b1 = await bid(tid, t1);
await call(`/bids/${b1}/accept`,'POST',{}, tc); await hold(tid);
r = await call(`/bids/${b1}`,'DELETE',null, t1);
ok("withdraw after acceptance rejected (bid_settled)", r.status===409 && r.body.error.code==='bid_settled', r.body);
r = await call(`/tasks/${tid}/cancel`,'POST',{}, tc);
ok("open-task cancel on inprogress task rejected", r.status===409 && r.body.error.code==='not_open', r.body);

console.log("\n\u2014 ACCEPT-THEN-CANCEL-BEFORE-WEBHOOK (payment in flight) \u2014");
tid = await newTask(); b1 = await bid(tid, t1);
await call(`/bids/${b1}/accept`,'POST',{}, tc);
// customer cancels while payment page still open (task still 'open')
r = await call(`/tasks/${tid}/cancel`,'POST',{}, tc);
ok("cancel-while-paying allowed (task still open)", r.status===200, r.status);
// then the webhook arrives late
await hold(tid);
let pr = await payRow(tid);
ok("late webhook: hold auto-refunded, money returned", pr.status==='refunded', pr.status);
ok("task stays cancelled, not resurrected", (await taskRow(tid)).status==='cancelled', (await taskRow(tid)).status);

console.log("\n\u2014 DISPUTE LOCKS EVERYTHING \u2014");
tid = await newTask(); b1 = await bid(tid, t1);
await call(`/bids/${b1}/accept`,'POST',{}, tc); await hold(tid);
await call(`/jobs/${tid}/dispute`,'POST',{reason:'bad work'}, tc);
for (const [name, path, tok] of [["confirm",`/jobs/${tid}/confirm`,tc],["customer cancel",`/jobs/${tid}/cancel`,tc],["partner cancel",`/jobs/${tid}/partner-cancel`,t1]]){
  r = await call(path,'POST',{reason:'x'}, tok);
  ok(`${name} blocked by open dispute`, r.status===409 && r.body.error.code==='dispute_open', r.body);
}
pr = await payRow(tid);
r = await call(`/admin/payments/${pr.id}/release`,'POST',{}, tc2);
ok("admin direct release blocked by open dispute", r.status===409, r.status);
// resolve as refund
const disp = await env.DB.prepare("SELECT * FROM disputes WHERE task_id=?").bind(tid).first();
r = await call(`/disputes/${disp.id}/resolve`,'POST',{action:'refund'}, tc2);
ok("dispute resolve refund works", r.status===200, r.body);
r = await call(`/disputes/${disp.id}/resolve`,'POST',{action:'release'}, tc2);
ok("double-resolve rejected", r.status===409, r.status);
pr = await payRow(tid);
ok("payment refunded exactly once", pr.status==='refunded', pr.status);

console.log("\n\u2014 VOUCHER + CANCEL FEE (money math) \u2014");
await call('/admin/vouchers','POST',{code:'HALF',type:'percent',value:5000,min_amount_cents:0,per_user_limit:5}, tc2);
tid = await newTask(); b1 = await bid(tid, t1, 10000);
r = await call(`/bids/${b1}/accept`,'POST',{voucher_code:'HALF'}, tc);
console.log("     accept w/ voucher:", JSON.stringify(r.body).slice(0,160));
const authorized = r.body.customer_pays_cents;
await hold(tid);
await env.DB.prepare("UPDATE payments SET updated_at=? WHERE task_id=?").bind(now()-7200, tid).run();
r = await call(`/jobs/${tid}/cancel`,'POST',{}, tc);
pr = await payRow(tid);
ok("cancel with voucher succeeds", r.status===200, r.body);
ok("!! compensation does not exceed what customer actually paid",
   r.body.compensation_cents <= authorized, {comp:r.body.compensation_cents, authorized});
ok("!! reported refund does not exceed what customer actually paid",
   r.body.refunded_cents <= authorized, {refund:r.body.refunded_cents, authorized});

console.log("\n\u2014 SUSPENDED USER \u2014");
const bad = await mkUser('Bad','partner'); const tbad = await T(bad);
await env.DB.prepare("INSERT INTO partner_merchants (user_id,psp_merchant_id,status,created_at,updated_at) VALUES (?,?,'active',?,?)").bind(bad,'m_'+bad,now(),now()).run();
await call(`/admin/users/${bad}/suspend`,'POST',{suspend:true}, tc2);
tid = await newTask();
r = await call(`/tasks/${tid}/bids`,'POST',{amount_cents:9000,message:'x'}, tbad);
ok("suspended partner cannot bid", r.status===403||r.status===401, r.status);
r = await call('/tasks','POST',{title:'x',category:'cleaning',city:'KL',addr:'x',lat:3.1,lng:101.6,budget_cents:5000}, tbad);
ok("suspended user cannot post tasks", r.status===403||r.status===401, r.status);

console.log("\n\u2014 INPUT ABUSE \u2014");
r = await call('/tasks','POST',{title:'x'.repeat(5000),category:'cleaning',city:'KL',addr:'x',lat:3.1,lng:101.6,budget_cents:5000}, tc);
ok("oversized title rejected", r.status===400, r.status);
r = await call('/tasks','POST',{title:'ok',category:'cleaning',city:'KL',addr:'x',lat:3.1,lng:101.6,budget_cents:-500}, tc);
ok("negative budget rejected", r.status===400, r.status);
r = await call('/tasks','POST',{title:'ok',category:'cleaning',city:'KL',addr:'x',lat:999,lng:101.6,budget_cents:5000}, tc);
ok("impossible latitude rejected", r.status===400, r.status);
tid = await newTask();
r = await call(`/tasks/${tid}/bids`,'POST',{amount_cents:0.5,message:'x'}, t1);
ok("fractional-cent bid rejected", r.status===400, r.status);
r = await call(`/tasks/nonexistent/cancel`,'POST',{}, tc);
ok("cancel nonexistent task 404", r.status===404, r.status);
r = await call('/me','GET',null,'garbage-token');
ok("garbage token 401", r.status===401, r.status);

console.log("\n\u2014 PARTNER-CANCEL vs CONFIRM RACE \u2014");
tid = await newTask(); b1 = await bid(tid, t1);
await call(`/bids/${b1}/accept`,'POST',{}, tc); await hold(tid);
await call(`/jobs/${tid}/confirm`,'POST',{}, tc);          // customer confirms first
r = await call(`/jobs/${tid}/partner-cancel`,'POST',{reason:'x'}, t1);
ok("partner-cancel after confirm rejected (money already moved)", r.status===409, r.status);
pr = await payRow(tid);
ok("payment stays captured, no refund on top", pr.status==='captured', pr.status);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
