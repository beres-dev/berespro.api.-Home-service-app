// SCALE: prove the high-traffic paths do bounded work, not work that grows
// with the number of users. We count DB operations, not wall-clock.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, id, now } from '../src/lib/util.js';

// instrument the DB: count prepare() calls and batch sizes
class CountingDB extends MockDB {
  constructor(){ super(); this.prepares=0; this.batches=0; this.batchRows=0; }
  prepare(sql){ this.prepares++; return super.prepare(sql); }
  async batch(stmts){ this.batches++; this.batchRows+=stmts.length; return super.batch(stmts); }
  reset(){ this.prepares=0; this.batches=0; this.batchRows=0; }
}
const env = { DB:new CountingDB(), JWT_SECRET:'s'.repeat(40), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', CLERK_ISSUER:'https://x.clerk.accounts.dev', REQUIRE_KYC_TO_BID:'0' };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

const mkUser = async (mode, lat=3.139, lng=101.687) => { const uid=id('usr');
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?)")
    .bind(uid,'fb_'+uid,'+60'+Math.random().toString().slice(2,11),uid+'@t.my','U',1,mode,'KL',lat,lng,'[]',now()).run();
  return uid; };
const T = async uid => await signJWT({uid}, env.JWT_SECRET, 3600);
const call = async (p,m,b,t) => { const r = await worker.fetch(new Request('https://t.dev'+p,
  {method:m,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}),env);
  return {status:r.status, body:await r.json().catch(()=>({}))}; };

console.log("\n\u2014 Seeding 5000 partners clustered near KL \u2014");
const cust = await mkUser('customer');
const tc = await T(cust);
// 5000 partners within notify radius
for (let i=0;i<5000;i++){ await mkUser('partner', 3.139 + (Math.random()-0.5)*0.1, 101.687 + (Math.random()-0.5)*0.1); }
console.log("     seeded.");

console.log("\n\u2014 POST TASK: fanout is ONE batch, not N inserts \u2014");
env.DB.reset();
let r = await call('/tasks','POST',{title:'Clean',category:'cleaning',city:'KL',addr:'x',lat:3.139,lng:101.687,budget_cents:12000}, tc);
ok("task posted", r.status===201, r.status);
console.log(`     prepares=${env.DB.prepares} batches=${env.DB.batches} batchRows=${env.DB.batchRows}`);
ok("notification fanout used a batch (not a per-partner loop)", env.DB.batches>=1, env.DB.batches);
ok("fanout capped at NOTIFY_MAX (50), not all 5000", env.DB.batchRows<=50, env.DB.batchRows);
ok("total prepares bounded regardless of 5000 users", env.DB.prepares < 30, env.DB.prepares);

console.log("\n\u2014 FEED: query count is constant, not per-task \u2014");
// post 40 tasks so the feed has plenty to return
for (let i=0;i<40;i++) await call('/tasks','POST',{title:'J'+i,category:'cleaning',city:'KL',addr:'x',lat:3.139+Math.random()*0.02,lng:101.687+Math.random()*0.02,budget_cents:10000}, tc);
const partner = await mkUser('partner'); const tp = await T(partner);
env.DB.reset();
r = await call('/tasks?lat=3.139&lng=101.687&radius=15&cat=all&sort=nearest','GET',null,tp);
ok("feed returns tasks", Array.isArray(r.body.tasks) && r.body.tasks.length>0, r.body.tasks&&r.body.tasks.length);
console.log(`     feed prepares=${env.DB.prepares} for ${r.body.tasks.length} tasks`);
ok("feed is O(1) queries, not O(tasks) (<=6 regardless of feed size)", env.DB.prepares<=6, env.DB.prepares);

console.log("\n\u2014 RATE LIMITER: KV path keeps limiting off D1 \u2014");
// bind a fake KV
const kv = new Map();
env.RL_KV = { get:async k=>kv.get(k)??null, put:async (k,v)=>{kv.set(k,v);} };
env.DB.reset();
const { rateLimit } = await import('../src/lib/guard.js');
let allowed=0; for (let i=0;i<10;i++){ if (await rateLimit(env,'test:key',5,60)) allowed++; }
ok("KV limiter enforces the limit (5 of 10 allowed)", allowed===5, allowed);
ok("KV limiter touched D1 zero times", env.DB.prepares===0, env.DB.prepares);
// without KV, falls back to D1 and still works
delete env.RL_KV; env.DB.reset();
allowed=0; for (let i=0;i<10;i++){ if (await rateLimit(env,'test:key2',5,60)) allowed++; }
ok("D1 fallback still enforces the limit", allowed===5, allowed);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
