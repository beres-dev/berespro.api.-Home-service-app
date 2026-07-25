// PARTNER MEDIA: licence gate on delivery skill, avatar, optional ic_last4.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, now } from '../src/lib/util.js';
class FakeR2 {
  constructor(){ this.o = new Map(); }
  async put(k,b,o){ this.o.set(k,{body:b,httpMetadata:o&&o.httpMetadata}); return {}; }
  async get(k){ const v=this.o.get(k); return v?{body:v.body,httpMetadata:v.httpMetadata}:null; }
  async delete(k){ this.o.delete(k); }
}
const R2 = new FakeR2();
const env = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', CLERK_ISSUER:'https://x.clerk.accounts.dev',
              KYC_DOCS:R2, ADMIN_IDS:'adm1' };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };
for (const [u,ver] of [['p1',0],['adm1',1],['v9',1]]) {
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)")
    .bind(u,'fb_'+u,'+6012'+u,u+'@t.my','U'+u,214,'partner','KL',3.139,101.687,'[]',ver,now()).run();
}
const t1 = await signJWT({uid:'p1'}, env.JWT_SECRET, 3600);
const ta = await signJWT({uid:'adm1'}, env.JWT_SECRET, 3600);
const call = async (p,m,b,t) => { const r = await worker.fetch(new Request('https://t.dev'+p,
  {method:m,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}),env);
  return {status:r.status, body:await r.json().catch(()=>({}))}; };
const upload = async (path,t,bytes) => { const r = await worker.fetch(new Request('https://t.dev'+path,
  {method:'POST',headers:{authorization:'Bearer '+t},body:bytes}),env);
  return {status:r.status, body:await r.json().catch(()=>({}))}; };
const JPEG = new Uint8Array([0xFF,0xD8,0xFF,0xE0,0,0x10,0x4A,0x46,0x49,0x46,0,1,...new Array(64).fill(0x41)]);

console.log("\n\u2014 THE GATE: delivery skill needs a licence \u2014");
let r = await call('/me','PATCH',{skills:['cleaning','delivery']}, t1);
ok("delivery skill WITHOUT licence -> 403 licence_required",
   r.status===403 && r.body.error.code==='licence_required', r.body);
r = await call('/me','PATCH',{skills:['cleaning','plumbing']}, t1);
ok("non-driving skills fine without licence", r.status===200, r.body);
r = await upload('/me/licence', t1, JPEG);
ok("licence upload accepted", r.status===201, r.body);
r = await call('/me','PATCH',{skills:['cleaning','delivery']}, t1);
ok("delivery skill ALLOWED after licence", r.status===200, r.body);
ok("has_licence exposed to the app", r.body.user.has_licence===true, r.body.user);
r = await call('/me','PATCH',{skills:['Moving']}, t1);
ok("moving also gated+allowed, and lowercased", r.status===200 && r.body.user.skills[0]==='moving', r.body.user && r.body.user.skills);
r = await call('/me','PATCH',{skills:'notalist'}, t1);
ok("garbage skills rejected", r.status===400, r.status);
r = await call('/me','PATCH',{skills:Array(13).fill('x')}, t1);
ok("13 skills rejected (max 12)", r.status===400, r.status);
const u1 = await env.DB.prepare("SELECT licence_key FROM users WHERE id='p1'").first();
ok("licence stored under kyc/ (admin-only prefix)", u1.licence_key.startsWith('kyc/p1/') && u1.licence_key.endsWith('-licence'), u1.licence_key);

console.log("\n\u2014 Admin can view the licence; others cannot \u2014");
let sv = await worker.fetch(new Request('https://t.dev/admin/licence/p1',{headers:{authorization:'Bearer '+ta}}),env);
ok("admin streams the licence", sv.status===200, sv.status);
sv = await worker.fetch(new Request('https://t.dev/admin/licence/p1',{headers:{authorization:'Bearer '+t1}}),env);
ok("non-admin -> 403", sv.status===403, sv.status);

console.log("\n\u2014 Avatar \u2014");
r = await upload('/me/avatar', t1, JPEG);
ok("avatar upload", r.status===201, r.body);
r = await call('/me','GET',null, t1);
ok("has_avatar true after upload", r.body.user.has_avatar===true, r.body.user);
sv = await worker.fetch(new Request('https://t.dev/avatar/p1',{headers:{authorization:'Bearer '+ta}}),env);
ok("any signed-in user can view an avatar", sv.status===200, sv.status);
sv = await worker.fetch(new Request('https://t.dev/avatar/p1'),env);
ok("no session -> 401", sv.status===401, sv.status);
r = await upload('/me/avatar', t1, JPEG);
const u2 = await env.DB.prepare("SELECT avatar_key FROM users WHERE id='p1'").first();
ok("re-upload overwrites SAME key (no orphans)", u2.avatar_key==='avatar/p1', u2.avatar_key);

console.log("\n\u2014 KYC: ic_last4 now optional \u2014");
const upk = async (kind) => (await (await worker.fetch(new Request('https://t.dev/kyc/upload?kind='+kind,
  {method:'POST',headers:{authorization:'Bearer '+t1,'content-type':'image/jpeg'},body:JPEG}),env)).json()).key;
const kf = await upk('front'), ks = await upk('selfie');
r = await call('/kyc/submit','POST',{full_name:'Ali Partner',doc_front_key:kf,selfie_key:ks}, t1);
ok("submit WITHOUT ic_last4 accepted", r.status===201, r.body);
r = await call('/kyc/submit','POST',{full_name:'Ali',ic_last4:'12ab',doc_front_key:kf,selfie_key:ks}, t1);
ok("but a MALFORMED ic_last4 still rejected", r.status===400, r.status);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
