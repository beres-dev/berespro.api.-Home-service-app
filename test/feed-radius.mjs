// PARTNER FEED: the radius cap is enforced by the SERVER, not the UI.
// Zaini asked for a maximum radius — this locks it in so no client can ask
// for a 500km sweep of the whole country.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, now } from '../src/lib/util.js';
const env = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', CLERK_ISSUER:'https://x.clerk.accounts.dev' };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };
const mk = async (u,mode,lat,lng) => env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?)")
  .bind(u,'fb_'+u,'+6012'+u,u+'@t.my','U'+u,214,mode,'KL',lat,lng,'[]',now()).run();
await mk('p1','partner',3.139,101.687);   // KL centre
await mk('c1','customer',3.139,101.687);
const tp = await signJWT({uid:'p1'}, env.JWT_SECRET, 3600);
const tc = await signJWT({uid:'c1'}, env.JWT_SECRET, 3600);
const call = async (p,m,b,t) => { const r = await worker.fetch(new Request('https://t.dev'+p,
  {method:m,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}),env);
  return {status:r.status, body:await r.json().catch(()=>({}))}; };
const mkTask = async (title,lat,lng,cat='cleaning') => call('/tasks','POST',
  {title,category:cat,city:'KL',addr:'x',lat,lng,budget_cents:10000}, tc);

// near (2km), mid (30km), far (120km — Ipoh-ish), very far (300km — Penang-ish)
await mkTask('Near job',    3.155, 101.700);
await mkTask('Mid job',     3.400, 101.700);
await mkTask('Far job',     4.200, 101.400, 'moving');
await mkTask('VeryFar job', 5.414, 100.329);

console.log("\n\u2014 Radius is respected \u2014");
let r = await call('/tasks?lat=3.139&lng=101.687&radius=5','GET',null,tp);
ok("5km returns only the near job", r.body.tasks.length===1 && r.body.tasks[0].title==='Near job', r.body.tasks.map(t=>t.title));
r = await call('/tasks?lat=3.139&lng=101.687&radius=50','GET',null,tp);
const titles50 = r.body.tasks.map(t=>t.title);
ok("50km reaches near + mid", titles50.includes('Near job') && titles50.includes('Mid job'), titles50);
ok("50km does NOT reach the 300km job", !titles50.includes('VeryFar job'), titles50);

console.log("\n\u2014 THE CAP: a client cannot ask for more than 50km \u2014");
r = await call('/tasks?lat=3.139&lng=101.687&radius=500','GET',null,tp);
const t500 = r.body.tasks.map(t=>t.title);
ok("radius=500 is silently clamped to 50", !t500.includes('VeryFar job'), t500);
r = await call('/tasks?lat=3.139&lng=101.687&radius=99999','GET',null,tp);
ok("radius=99999 still clamped", !r.body.tasks.map(t=>t.title).includes('VeryFar job'), r.body.tasks.map(t=>t.title));
r = await call('/tasks?lat=3.139&lng=101.687&radius=abc','GET',null,tp);
ok("garbage radius falls back to the default, not Infinity", r.body.tasks.length>0 && !r.body.tasks.map(t=>t.title).includes('VeryFar job'), r.body.tasks.map(t=>t.title));
r = await call('/tasks?lat=3.139&lng=101.687&radius=-10','GET',null,tp);
ok("negative radius cannot invert the filter", !r.body.tasks.map(t=>t.title).includes('VeryFar job'), r.body.tasks.map(t=>t.title));

console.log("\n\u2014 What the map needs is in the payload \u2014");
r = await call('/tasks?lat=3.139&lng=101.687&radius=50','GET',null,tp);
const j = r.body.tasks[0];
ok("each job carries lat/lng for plotting", typeof j.lat==='number' && typeof j.lng==='number', j);
ok("distance_km precomputed by the server", typeof j.distance_km==='number', j);
ok("bid_count present (map badge)", typeof j.bid_count==='number', j);
ok("my_bid flag present (so the map can grey out mine)", 'my_bid' in j, Object.keys(j));

console.log("\n\u2014 Filtering \u2014");
r = await call('/tasks?lat=3.139&lng=101.687&radius=50&cat=moving','GET',null,tp);
ok("category filter applies", r.body.tasks.every(t=>t.category==='moving'), r.body.tasks.map(t=>t.category));
r = await call('/tasks?lat=3.139&lng=101.687&radius=50','GET',null,tc);
ok("a partner never sees their OWN posted jobs", !r.body.tasks.some(t=>t.customer_id==='c1'), r.body.tasks.length);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
