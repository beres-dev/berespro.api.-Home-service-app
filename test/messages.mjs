// CHAT: threads are (task, partner). The security question that matters is
// whether one partner can ever read another partner's conversation.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, id, now } from '../src/lib/util.js';

const env = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', CLERK_ISSUER:'https://x.clerk.accounts.dev',
              REQUIRE_KYC_TO_BID:'0', ADMIN_IDS:'admin1' };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

const mkUser = async (uid, mode='customer') => {
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?)")
    .bind(uid,'fb_'+uid,'+60'+Math.random().toString().slice(2,11),uid+'@t.my',uid,214,mode,'KL',3.139,101.687,'[]',now()).run();
};
for (const u of ['admin1','cust','cust2']) await mkUser(u);
for (const p of ['p1','p2','p3']) { await mkUser(p,'partner');
  await env.DB.prepare("INSERT INTO partner_merchants (user_id,psp_merchant_id,status,created_at,updated_at) VALUES (?,?,'active',?,?)").bind(p,'m_'+p,now(),now()).run(); }
const T = async u => await signJWT({uid:u}, env.JWT_SECRET, 3600);
const ta=await T('admin1'), tc=await T('cust'), tc2=await T('cust2'), t1=await T('p1'), t2=await T('p2'), t3=await T('p3');
const call = async (p,m,b,t) => { const r = await worker.fetch(new Request('https://t.dev'+p,
  {method:m,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}),env);
  return {status:r.status, body:await r.json().catch(()=>({}))}; };

const tid = (await call('/tasks','POST',{title:'Fix sink',category:'plumbing',city:'KL',addr:'x',lat:3.139,lng:101.687,budget_cents:15000}, tc)).body.task.id;
await call(`/tasks/${tid}/bids`,'POST',{amount_cents:14000,message:'hi'}, t1);
await call(`/tasks/${tid}/bids`,'POST',{amount_cents:13000,message:'hi'}, t2);
// p3 does NOT bid

console.log("\n\u2014 Partner must bid before messaging (anti-spam) \u2014");
let r = await call(`/tasks/${tid}/messages`,'POST',{body:'buy my services'}, t3);
ok("non-bidding partner cannot message", r.status===403 && r.body.error.code==='bid_required', r.body);
r = await call(`/tasks/${tid}/messages`,'GET',null, t3);
ok("non-bidding partner cannot read", r.status===403, r.status);

console.log("\n\u2014 Basic send + read \u2014");
r = await call(`/tasks/${tid}/messages`,'POST',{body:'Is there back-door access?'}, t1);
ok("partner sends", r.status===201, r.body);
r = await call(`/tasks/${tid}/messages`,'GET',null, t1);
ok("partner sees own message", r.body.messages.length===1 && r.body.messages[0].mine===true, r.body);
r = await call(`/tasks/${tid}/messages?partner_id=p1`,'GET',null, tc);
ok("customer reads that thread", r.body.messages.length===1, r.body);
ok("message not marked 'mine' for the customer", r.body.messages[0].mine===false, r.body.messages[0]);
r = await call(`/tasks/${tid}/messages`,'POST',{body:'Yes, side gate is open', partner_id:'p1'}, tc);
ok("customer replies", r.status===201, r.body);
r = await call(`/tasks/${tid}/messages`,'GET',null, t1);
ok("partner sees both", r.body.messages.length===2, r.body.messages.length);

console.log("\n\u2014 ISOLATION: one partner must never see another's thread \u2014");
await call(`/tasks/${tid}/messages`,'POST',{body:'secret undercut price'}, t2);
r = await call(`/tasks/${tid}/messages`,'GET',null, t1);
ok("p1 does NOT see p2's message", r.body.messages.length===2 && !JSON.stringify(r.body).includes('undercut'), r.body.messages.length);
r = await call(`/tasks/${tid}/messages`,'GET',null, t2);
ok("p2 sees only their own thread", r.body.messages.length===1, r.body.messages.length);
r = await call(`/tasks/${tid}/messages?partner_id=p2`,'GET',null, t1);
ok("p1 cannot read p2's thread by passing partner_id", r.body.messages.length===2, "leaked!");
r = await call(`/tasks/${tid}/messages`,'POST',{body:'x', partner_id:'p2'}, t1);
ok("p1 cannot WRITE into p2's thread", (await call(`/tasks/${tid}/messages`,'GET',null,t2)).body.messages.length===1, "wrote into wrong thread");

console.log("\n\u2014 Strangers are locked out \u2014");
r = await call(`/tasks/${tid}/messages?partner_id=p1`,'GET',null, tc2);
ok("another customer cannot read", r.status===403||r.status===404, r.status);
r = await call(`/tasks/${tid}/messages`,'GET',null, 'rubbish-token');
ok("garbage token rejected", r.status===401, r.status);
r = await call('/tasks/nonexistent/messages','GET',null, tc);
ok("unknown task 404", r.status===404, r.status);
r = await call(`/tasks/${tid}/messages?partner_id=nobody`,'GET',null, tc);
ok("customer asking for a non-bidder thread 404", r.status===404, r.status);
r = await call(`/tasks/${tid}/messages`,'GET',null, tc);
ok("customer must name a partner", r.status===400, r.status);

console.log("\n\u2014 Unread counts + read receipts \u2014");
r = await call('/me/threads','GET',null, tc);
ok("customer sees 2 threads (one per bidder)", r.body.threads.length===2, r.body.threads.length);
const th1 = r.body.threads.find(t=>t.partner_id==='p1');
ok("thread shows the other party's name", th1.with.name==='p1', th1.with);
ok("thread carries last message", /back-door|side gate/i.test(th1.last_body), th1.last_body);
ok("unread counted for customer", r.body.threads.some(t=>t.unread>0), r.body.threads.map(t=>t.unread));
await call(`/tasks/${tid}/messages/read`,'POST',{partner_id:'p1'}, tc);
r = await call('/me/threads','GET',null, tc);
ok("after read, that thread has 0 unread", r.body.threads.find(t=>t.partner_id==='p1').unread===0, r.body.threads);
ok("the OTHER thread is still unread", r.body.threads.find(t=>t.partner_id==='p2').unread===1, r.body.threads);
r = await call('/me/threads','GET',null, t1);
ok("partner sees only their own 1 thread", r.body.threads.length===1 && r.body.threads[0].partner_id==='p1', r.body.threads);
r = await call('/me/threads','GET',null, t3);
ok("non-participant has no threads", r.body.threads.length===0, r.body.threads);

console.log("\n\u2014 Polling with ?after= \u2014");
const all = (await call(`/tasks/${tid}/messages`,'GET',null, t1)).body.messages;
const lastTs = all[all.length-1].created_at;
r = await call(`/tasks/${tid}/messages?after=${lastTs}`,'GET',null, t1);
ok("after=last is inclusive — returns the boundary second, drops nothing",
   r.body.messages.length>=1 && r.body.messages.every(m=>m.created_at>=lastTs), r.body.messages.length);
await call(`/tasks/${tid}/messages`,'POST',{body:'on my way', partner_id:'p1'}, tc);
r = await call(`/tasks/${tid}/messages?after=${lastTs}`,'GET',null, t1);
ok("poll picks up the new message", r.body.messages.some(m=>/on my way/.test(m.body)), r.body.messages);
r = await call(`/tasks/${tid}/messages?after=${lastTs+9999}`,'GET',null, t1);
ok("future cursor returns nothing", r.body.messages.length===0, r.body.messages.length);

console.log("\n\u2014 Notifications reach the other side \u2014");
const n = (await env.DB.prepare("SELECT * FROM notifications WHERE user_id=?").bind('p1').all()).results;
ok("partner notified of customer's message", n.some(x=>x.type==='msg'), n.map(x=>x.type));

console.log("\n\u2014 Input validation \u2014");
r = await call(`/tasks/${tid}/messages`,'POST',{body:''}, t1);
ok("empty message rejected", r.status===400, r.status);
r = await call(`/tasks/${tid}/messages`,'POST',{body:'x'.repeat(5000)}, t1);
ok("oversized message rejected", r.status===400, r.status);
r = await call(`/tasks/${tid}/messages`,'POST',{body:'<script>alert(1)</script>'}, t1);
ok("script tags stored as plain text (app escapes on render)", r.status===201, r.body);

console.log("\n\u2014 Chat stays open during a dispute (they need to talk) \u2014");
const b1 = (await env.DB.prepare("SELECT id FROM bids WHERE task_id=? AND partner_id=?").bind(tid,'p1').first()).id;
await call(`/bids/${b1}/accept`,'POST',{}, tc);
const pay = await env.DB.prepare("SELECT * FROM payments WHERE task_id=?").bind(tid).first();
const { onHeld } = await import('../src/routes/payments.js'); await onHeld(env, pay);
await call(`/jobs/${tid}/dispute`,'POST',{reason:'bad work'}, tc);
r = await call(`/tasks/${tid}/messages`,'POST',{body:'lets sort this out'}, t1);
ok("messaging still works with a dispute open", r.status===201, r.body);

console.log("\n\u2014 Admin can read a thread as dispute evidence \u2014");
r = await call(`/admin/threads/${tid}`,'GET',null, ta);
ok("admin reads every thread on the task", r.status===200 && r.body.messages.length>=4, r.body.messages&&r.body.messages.length);
ok("admin sees sender names", r.body.messages[0].sender_name!==undefined, r.body.messages[0]);
r = await call(`/admin/threads/${tid}`,'GET',null, tc);
ok("non-admin cannot use the admin view", r.status===403, r.status);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
