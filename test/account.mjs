// ACCOUNT CLOSURE: the exit door. The question that matters is whether someone
// can use "delete my account" to walk away from money or a dispute.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, id, now } from '../src/lib/util.js';

class FakeR2 {
  constructor(){ this.o = new Map(); }
  async put(k,b,o){ this.o.set(k,{body:b,httpMetadata:o&&o.httpMetadata}); return {}; }
  async get(k){ const v=this.o.get(k); return v?{body:v.body,httpMetadata:v.httpMetadata}:null; }
  async delete(k){ this.o.delete(k); }
}
const R2 = new FakeR2();
const env = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', CLERK_ISSUER:'https://x.clerk.accounts.dev',
              REQUIRE_KYC_TO_BID:'0', ADMIN_IDS:'admin1', KYC_DOCS:R2 };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

const mkUser = async (uid, mode='customer') => {
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?)")
    .bind(uid,'fb_'+uid,'+6012'+Math.random().toString().slice(2,9),uid+'@t.my','Real Name '+uid,214,mode,'KL',3.139,101.687,'[]',now()).run();
};
for (const u of ['admin1','cust','cust2']) await mkUser(u);
for (const p of ['p1','p2']) { await mkUser(p,'partner');
  await env.DB.prepare("INSERT INTO partner_merchants (user_id,psp_merchant_id,status,created_at,updated_at) VALUES (?,?,'active',?,?)").bind(p,'m_'+p,now(),now()).run(); }
const T = async u => await signJWT({uid:u}, env.JWT_SECRET, 3600);
const ta=await T('admin1'), tc=await T('cust'), tc2=await T('cust2'), t1=await T('p1'), t2=await T('p2');
const call = async (p,m,b,t) => { const r = await worker.fetch(new Request('https://t.dev'+p,
  {method:m,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}),env);
  return {status:r.status, body:await r.json().catch(()=>({}))}; };
const newTask = async (tok=tc) => (await call('/tasks','POST',{title:'Job',category:'cleaning',city:'KL',addr:'x',lat:3.139,lng:101.687,budget_cents:10000}, tok)).body.task.id;
const userRow = async u => await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(u).first();

console.log("\n\u2014 Clean account can close \u2014");
let r = await call('/account/closure-check','GET',null, tc2);
ok("closure-check says clear", r.status===200 && r.body.can_close===true, r.body);

console.log("\n\u2014 MONEY IN ESCROW BLOCKS CLOSURE (both sides) \u2014");
const tid = await newTask();
const bid = (await call(`/tasks/${tid}/bids`,'POST',{amount_cents:10000,message:'hi'}, t1)).body.bid_id;
await call(`/bids/${bid}/accept`,'POST',{}, tc);
const pay = await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(tid).first();
const { onHeld } = await import('../src/routes/payments.js'); await onHeld(env, pay);
r = await call('/account/closure-check','GET',null, tc);
ok("customer with held money: blocked", r.body.can_close===false && r.body.blockers[0].code==='money_in_escrow', r.body);
r = await call('/account/deactivate','POST',{}, tc);
ok("deactivate refused", r.status===409 && r.body.error.code==='money_in_escrow', r.body);
r = await call('/account','DELETE',{confirm:'DELETE'}, tc);
ok("delete refused too", r.status===409, r.body);
r = await call('/account/closure-check','GET',null, t1);
ok("PARTNER with held money also blocked", r.body.can_close===false, r.body);

console.log("\n\u2014 OPEN DISPUTE BLOCKS CLOSURE (cannot escape it) \u2014");
await call(`/jobs/${tid}/dispute`,'POST',{reason:'bad work'}, tc);
r = await call('/account','DELETE',{confirm:'DELETE'}, tc);
ok("customer cannot delete away from their dispute", r.status===409, r.body);
r = await call('/account','DELETE',{confirm:'DELETE'}, t1);
ok("partner cannot delete away from it either", r.status===409, r.body);
// resolve everything
const d = await env.DB.prepare("SELECT * FROM disputes WHERE task_id=?").bind(tid).first();
await call(`/disputes/${d.id}/resolve`,'POST',{action:'refund'}, ta);
r = await call('/account/closure-check','GET',null, tc);
ok("once resolved and refunded, closure is clear", r.body.can_close===true, r.body);

console.log("\n\u2014 Deactivate: reversible, and it frees other people \u2014");
const t_open = await newTask();
await call(`/tasks/${t_open}/bids`,'POST',{amount_cents:9000,message:'me'}, t2);
r = await call('/account/deactivate','POST',{reason:'taking a break'}, tc);
ok("deactivate succeeds", r.status===200 && r.body.status==='deactivated', r.body);
ok("their open task was cancelled (nobody left waiting)",
   (await env.DB.prepare("SELECT status FROM tasks WHERE id=?").bind(t_open).first()).status==='cancelled');
const bn = (await env.DB.prepare("SELECT * FROM notifications WHERE user_id=?").bind('p2').all()).results;
ok("the bidder was told", bn.some(n=>/withdrawn/i.test(n.title)), bn.map(n=>n.title));
ok("sessions were killed",
   (await env.DB.prepare("SELECT * FROM sessions WHERE user_id=?").bind('cust').all()).results.length===0);
ok("nothing was destroyed — name intact", (await userRow('cust')).name.startsWith('Real Name'), (await userRow('cust')).name);

console.log("\n\u2014 Deactivated = cannot act (fail-closed allowlist) \u2014");
r = await call('/tasks','POST',{title:'x',category:'cleaning',city:'KL',addr:'x',lat:3.1,lng:101.6,budget_cents:5000}, tc);
ok("cannot post a task", r.status===403 && r.body.error.code==='account_deactivated', r.body);
r = await call('/tasks','GET',null, tc);
ok("cannot browse the feed", r.status===403, r.status);
r = await call('/me/threads','GET',null, tc);
ok("cannot read messages", r.status===403, r.status);
r = await call('/me','GET',null, tc);
ok("CAN still see own account", r.status===200, r.status);
r = await call('/account/closure-check','GET',null, tc);
ok("CAN still check closure", r.status===200, r.status);

console.log("\n\u2014 Reactivate restores everything \u2014");
r = await call('/account/reactivate','POST',{}, tc);
ok("reactivate succeeds", r.status===200 && r.body.status==='active', r.body);
r = await call('/tasks','POST',{title:'back',category:'cleaning',city:'KL',addr:'x',lat:3.139,lng:101.687,budget_cents:9000}, tc);
ok("can post again", r.status===201, r.status);
ok("still the same person", (await userRow('cust')).name.startsWith('Real Name'));

console.log("\n\u2014 DELETE: anonymise, purge documents, keep the money trail \u2014");
// A partner who has NOT yet been verified — submitKyc returns early for anyone
// already id_verified, so seeding p2 as verified meant no KYC row ever existed
// and the purge had nothing to purge. This is the real pre-verification state.
await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?)")
  .bind('p7','fb_p7','+60123334444','p7@t.my','Real Name p7',214,'partner','KL',3.139,101.687,'[]',now()).run();
const t7 = await T('p7');

const JPEG = new Uint8Array([0xFF,0xD8,0xFF,0xE0,0,0x10,0x4A,0x46,0x49,0x46,0,1,...new Array(64).fill(0x41)]);
const upr = await worker.fetch(new Request('https://t.dev/kyc/upload?kind=front',
  {method:'POST',headers:{authorization:'Bearer '+t7,'content-type':'image/jpeg'},body:JPEG}), env);
const kFront = (await upr.json()).key;
const upr2 = await worker.fetch(new Request('https://t.dev/kyc/upload?kind=selfie',
  {method:'POST',headers:{authorization:'Bearer '+t7,'content-type':'image/jpeg'},body:JPEG}), env);
const kSelfie = (await upr2.json()).key;
const subR = await call('/kyc/submit','POST',{full_name:'Real Name p7',ic_last4:'9911',doc_front_key:kFront,selfie_key:kSelfie}, t7);
ok("kyc submitted for p2 (precondition)", subR.status===201, subR.body);
ok("document really is in storage before deletion", !!(await R2.get(kFront)));
// p2 also has a completed payment (accounting record)
await env.DB.prepare("INSERT INTO payments (id,task_id,bid_id,customer_id,partner_id,amount_cents,fee_cents,net_cents,discount_cents,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  .bind('pay_hist','tsk_hist','bid_hist','cust2','p7',20000,4000,16000,0,'captured',now(),now()).run();

r = await call('/account','DELETE',{}, t7);
ok("delete needs explicit confirmation", r.status===400 && r.body.error.code==='confirm_required', r.body);
r = await call('/account','DELETE',{confirm:'DELETE'}, t7);
ok("delete succeeds", r.status===200 && r.body.status==='deleted', r.body);

const gone = await userRow('p7');
ok("name anonymised", gone.name==='Deleted user', gone.name);
ok("phone removed", !gone.phone, gone.phone);
ok("email removed", !gone.email, gone.email);
ok("location removed", gone.lat===null && gone.lng===null, {lat:gone.lat,lng:gone.lng});
ok("IC DOCUMENTS PURGED FROM STORAGE", !(await R2.get(kFront)) && !(await R2.get(kSelfie)), "documents survived deletion");
const ks = await env.DB.prepare("SELECT * FROM kyc_submissions WHERE user_id=?").bind('p7').first();
ok("KYC row stripped of name and IC", ks.full_name==='Deleted user' && ks.ic_last4==='0000', ks);
ok("payment record RETAINED (accounting)",
   !!(await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind('pay_hist').first()));
ok("payment still shows the amounts",
   (await env.DB.prepare("SELECT net_cents FROM payments WHERE id=?").bind('pay_hist').first()).net_cents===16000);
ok("firebase_uid cleared — signing in with Google makes a NEW account, not this one",
   gone.firebase_uid!=='fb_p7', gone.firebase_uid);
ok("old token no longer works", (await call('/me','GET',null,t7)).status===401);
r = await call('/account/reactivate','POST',{}, t7);
ok("a deleted account cannot be reactivated", r.status===401||r.status===410, r.status);

console.log("\n\u2014 Guards \u2014");
r = await call('/account/deactivate','POST',{}, 'rubbish');
ok("needs a session", r.status===401, r.status);
r = await call('/account','DELETE',{confirm:'delete'}, tc);
ok("lowercase confirm rejected", r.status===400, r.status);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
