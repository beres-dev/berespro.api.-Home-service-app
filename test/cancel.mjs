// The Refund & Cancellation Policy is a contract. These tests check the code
// actually does what users are told it does, on both sides.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, id, now } from '../src/lib/util.js';

const env = { DB:new MockDB(), JWT_SECRET:'x'.repeat(20), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', PSP_SECRET:'p', CLERK_ISSUER:'https://x.clerk.accounts.dev',
              REQUIRE_KYC_TO_BID:'0' };
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
const p2 = await mkUser('Partner2','partner');
const tc = await T(cust), t1 = await T(p1), t2 = await T(p2);

// A bid cannot be accepted until the partner can actually be paid. That guard is
// real, so the test has to satisfy it rather than route around it.
for (const p of [p1, p2]) {
  await env.DB.prepare("INSERT INTO partner_merchants (user_id,psp_merchant_id,status,created_at,updated_at) VALUES (?,?,'active',?,?)")
    .bind(p, 'mch_'+p, now(), now()).run();
}

const newTask = async () => {
  const r = await call('/tasks','POST',{title:'Clean flat',category:'cleaning',city:'KL',
    addr:'x',lat:3.139,lng:101.687,budget_cents:10000}, tc);
  return r.body.task.id;
};
const bidOn = async (taskId, tok, amt=9000) => {
  const r = await call(`/tasks/${taskId}/bids`,'POST',{amount_cents:amt, message:'hi'}, tok);
  return r.body.bid_id;
};
const taskRow = async tid => await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(tid).first();
const bidRow  = async bid => await env.DB.prepare("SELECT * FROM bids WHERE id=?").bind(bid).first();

console.log("\n\u2014 Customer cancels an OPEN task (policy: free, no payment yet) \u2014");
let tid = await newTask();
await bidOn(tid, t1); await bidOn(tid, t2);
let r = await call(`/tasks/${tid}/cancel`,'POST',{reason:'posted by mistake'}, tc);
ok("cancel succeeds", r.status===200, r.body);
ok("task marked cancelled", (await taskRow(tid)).status==='cancelled');
ok("no refund needed (no money existed)", r.body.refund===null, r.body);
const bidsAfter = (await env.DB.prepare("SELECT * FROM bids WHERE task_id=?").bind(tid).all()).results;
ok("all bids closed off", bidsAfter.every(b=>b.status==='lost'), bidsAfter.map(b=>b.status));
const n1 = (await env.DB.prepare("SELECT * FROM notifications WHERE user_id=?").bind(p1).all()).results;
ok("bidders told it was withdrawn", n1.some(n=>/withdrawn/i.test(n.title)), n1.map(n=>n.title));

console.log("\n\u2014 Guards on cancelling an open task \u2014");
tid = await newTask();
r = await call(`/tasks/${tid}/cancel`,'POST',{}, t1);
ok("a partner cannot cancel someone's task", r.status===403, r.status);
await call(`/tasks/${tid}/cancel`,'POST',{}, tc);
r = await call(`/tasks/${tid}/cancel`,'POST',{}, tc);
ok("cannot cancel twice", r.status===409 && r.body.error.code==='not_open', r.body);

console.log("\n\u2014 Partner withdraws their own bid \u2014");
tid = await newTask();
const bid1 = await bidOn(tid, t1);
r = await call(`/bids/${bid1}`,'DELETE',null, t2);
ok("cannot withdraw someone else's bid", r.status===403, r.status);
r = await call(`/bids/${bid1}`,'DELETE',null, t1);
ok("own bid withdraws", r.status===200, r.body);
ok("bid marked withdrawn", (await bidRow(bid1)).status==='withdrawn');
const cn = (await env.DB.prepare("SELECT * FROM notifications WHERE user_id=?").bind(cust).all()).results;
ok("customer told the bid was pulled", cn.some(n=>/withdrew/i.test(n.title)||/withdrawn/i.test(n.title)), cn.map(n=>n.title));
const strikes0 = (await env.DB.prepare("SELECT * FROM cancellations WHERE user_id=?").bind(p1).all()).results;
ok("withdrawing an unaccepted bid is NOT a strike", strikes0.length===0, strikes0.length);
r = await call(`/bids/${bid1}`,'DELETE',null, t1);
ok("cannot withdraw twice", r.status===409, r.body);


console.log("\n\u2014 Partner walks away from a job they WON (money is held) \u2014");
// accept a bid so the task is inprogress with a held payment
tid = await newTask();
const wonBid = await bidOn(tid, t1, 9000);
r = await call(`/bids/${wonBid}/accept`,'POST',{}, tc);
ok("bid accepted (payment created)", r.status===200 || r.status===201, r.body);
// simulate the PSP confirming the hold
let pay = await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(tid).first();
if (pay) { const { onHeld } = await import('../src/routes/payments.js'); await onHeld(env, pay); }
ok("task is inprogress", (await taskRow(tid)).status==='inprogress', (await taskRow(tid)).status);
pay = await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(tid).first();
ok("money is held", pay && pay.status==='held', pay && pay.status);

r = await call(`/jobs/${tid}/partner-cancel`,'POST',{reason:'van broke down'}, t2);
ok("a different partner cannot cancel it", r.status===403, r.status);

r = await call(`/jobs/${tid}/partner-cancel`,'POST',{reason:'van broke down'}, t1);
ok("winning partner can withdraw", r.status===200, r.body);
ok("customer is refunded", r.body.refunded===true, r.body);
pay = await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(tid).first();
ok("hold released back to customer", pay && pay.status==='refunded', pay && pay.status);
ok("task reopened for other partners", (await taskRow(tid)).status==='open', (await taskRow(tid)).status);
ok("accepted bid cleared", (await taskRow(tid)).accepted_bid_id==null, (await taskRow(tid)).accepted_bid_id);
ok("THIS is a strike", r.body.strikes===1, r.body.strikes);
const cn2 = (await env.DB.prepare("SELECT * FROM notifications WHERE user_id=?").bind(cust).all()).results;
ok("customer told, and told they were refunded", cn2.some(n=>/Partner cancelled/i.test(n.title)), cn2.map(n=>n.title).slice(-2));

console.log("\n\u2014 Strikes accumulate and warn (policy: 3 in 30 days) \u2014");
for (let i=0;i<2;i++){
  const t = await newTask();
  const b = await bidOn(t, t1, 9000);
  await call(`/bids/${b}/accept`,'POST',{}, tc);
  const p = await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(t).first();
  if (p) { const { onHeld } = await import('../src/routes/payments.js'); await onHeld(env, p); }
  r = await call(`/jobs/${t}/partner-cancel`,'POST',{}, t1);
}
ok("third cancellation counted", r.body.strikes===3, r.body.strikes);
ok("partner is warned at the limit", !!r.body.warning, r.body.warning);
ok("but NOT auto-suspended (a human decides)",
   (await env.DB.prepare("SELECT suspended FROM users WHERE id=?").bind(p1).first()).suspended===0);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
