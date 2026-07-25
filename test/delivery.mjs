// DELIVERY: multi-stop routes, server-side km, photo keys, pricing config.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, now, haversineKm } from '../src/lib/util.js';

class FakeR2 {
  constructor(){ this.o = new Map(); }
  async put(k,b,o){ this.o.set(k,{body:b,httpMetadata:o&&o.httpMetadata}); return {}; }
  async get(k){ const v=this.o.get(k); return v?{body:v.body,httpMetadata:v.httpMetadata}:null; }
  async delete(k){ this.o.delete(k); }
}
const R2 = new FakeR2();
const env = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', CLERK_ISSUER:'https://x.clerk.accounts.dev', KYC_DOCS:R2 };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };
await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES ('c1','fb_c1','+60121','c@t.my','Cust',214,'customer','KL',3.139,101.687,'[]',1,0,?)").bind(now()).run();
await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES ('x9','fb_x9','+60129','x@t.my','Other',214,'customer','KL',3.139,101.687,'[]',1,0,?)").bind(now()).run();
const tc = await signJWT({uid:'c1'}, env.JWT_SECRET, 3600);
const tx = await signJWT({uid:'x9'}, env.JWT_SECRET, 3600);
const call = async (p,m,b,t) => { const r = await worker.fetch(new Request('https://t.dev'+p,
  {method:m,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}),env);
  return {status:r.status, body:await r.json().catch(()=>({}))}; };
const base = { title:'Move box', category:'moving', city:'Kuala Lumpur', addr:'Danga Bay',
               lat:3.139, lng:101.687, budget_cents:10000 };

console.log("\n\u2014 Pricing config reaches the app \u2014");
let r = await call('/me','GET',null, tc);
ok("per-vehicle pricing in /me", r.body.delivery_pricing
   && r.body.delivery_pricing.motor.per_km_cents===100
   && r.body.delivery_pricing.car.per_km_cents===150, r.body.delivery_pricing);
ok("motor is cheaper than car (otherwise the choice is meaningless)",
   r.body.delivery_pricing.motor.base_cents < r.body.delivery_pricing.car.base_cents, r.body.delivery_pricing);

console.log("\n\u2014 Stops: validated, km computed SERVER-side \u2014");
const stops = [{addr:'Stop A, Cheras',lat:3.085,lng:101.745},{addr:'Stop B, Kajang',lat:2.993,lng:101.787}];
r = await call('/tasks','POST',{...base, stops}, tc);
ok("create with 2 stops", r.status===201, r.body);
const t = r.body.task;
ok("stops echoed back", t.stops.length===2 && t.stops[1].addr.includes('Kajang'), t.stops);
const expect = Math.round((haversineKm(3.139,101.687,3.085,101.745)+haversineKm(3.085,101.745,2.993,101.787))*10)/10;
ok(`route_km matches independent calc (${expect})`, t.route_km===expect, t.route_km);
ok("client CANNOT dictate km", (await call('/tasks','POST',{...base, stops, route_km: 1}, tc)).body.task.route_km===expect);
r = await call('/tasks','POST',{...base, stops:[{addr:'no pin'}]}, tc);
ok("stop without pin rejected", r.status===400 && r.body.error.code==='bad_stop', r.body);
r = await call('/tasks','POST',{...base, stops:Array(6).fill({addr:'x',lat:3,lng:101})}, tc);
ok("6 stops rejected (max 5)", r.status===400, r.status);
r = await call('/tasks','POST',{...base, stops:[{addr:'jauh',lat:6.1,lng:116.1}]}, tc);
ok(">400km route rejected", r.status===400, r.status);
r = await call('/tasks','POST',{...base}, tc);
ok("no stops still fine (normal task)", r.status===201 && r.body.task.stops.length===0, r.body.task && r.body.task.stops);

console.log("\n\u2014 Vehicle mode \u2014");
r = await call('/tasks','POST',{...base, category:'delivery', vehicle:'car', stops}, tc);
ok("delivery task stores vehicle", r.status===201 && r.body.task.vehicle==='car', r.body.task && r.body.task.vehicle);
r = await call('/tasks','POST',{...base, category:'delivery', stops}, tc);
ok("defaults to motor when unspecified", r.body.task.vehicle==='motor', r.body.task && r.body.task.vehicle);
r = await call('/tasks','POST',{...base, category:'delivery', vehicle:'lorry', stops}, tc);
ok("unknown vehicle rejected", r.status===400 && r.body.error.code==='bad_vehicle', r.body);
r = await call('/tasks','POST',{...base, category:'cleaning', vehicle:'car'}, tc);
ok("non-delivery task stores NO vehicle (no misleading data)", r.body.task.vehicle===null, r.body.task && r.body.task.vehicle);

console.log("\n\u2014 Photos: upload, ownership, serve auth \u2014");
const JPEG = new Uint8Array([0xFF,0xD8,0xFF,0xE0,0,0x10,0x4A,0x46,0x49,0x46,0,1,...new Array(64).fill(0x41)]);
let up = await worker.fetch(new Request('https://t.dev/tasks/photo-upload',
  {method:'POST',headers:{authorization:'Bearer '+tc},body:JPEG}), env);
const k1 = (await up.json()).key;
ok("upload returns a key under MY prefix", up.status===201 && k1.startsWith('taskimg/c1/'), k1);
up = await worker.fetch(new Request('https://t.dev/tasks/photo-upload',
  {method:'POST',headers:{authorization:'Bearer '+tc},body:new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13])}), env);
ok("garbage bytes rejected (magic sniff)", up.status===415, up.status);
r = await call('/tasks','POST',{...base, photo_keys:[k1]}, tc);
ok("create with photo", r.status===201 && r.body.task.photos[0]===k1, r.body.task && r.body.task.photos);
r = await call('/tasks','POST',{...base, photo_keys:['taskimg/c1/a','taskimg/c1/b','taskimg/c1/c','taskimg/c1/d','taskimg/c1/e']}, tc);
ok("5 photos rejected (max 4)", r.status===400, r.status);
r = await call('/tasks','POST',{...base, photo_keys:['kyc/c1/steal']}, tc);
ok("kyc/ key rejected (prefix forgery)", r.status===400, r.status);
r = await call('/tasks','POST',{...base, photo_keys:[k1]}, tx);
ok("someone ELSE cannot claim my key", r.status===400, r.status);
let sv = await worker.fetch(new Request('https://t.dev/'+k1.replace('taskimg/','timg/')), env);
ok("serve WITHOUT session -> 401", sv.status===401, sv.status);
sv = await worker.fetch(new Request('https://t.dev/'+k1.replace('taskimg/','timg/'),
  {headers:{authorization:'Bearer '+tx}}), env);
ok("any SIGNED-IN user can view (partners must see job photos)", sv.status===200, sv.status);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
