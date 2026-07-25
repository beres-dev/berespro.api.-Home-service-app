// KYC DOCUMENTS: real bytes, private storage, and the checks that stop someone
// being "verified" without ever uploading anything.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, id, now } from '../src/lib/util.js';

// Minimal in-memory stand-in for an R2 bucket.
class FakeR2 {
  constructor(){ this.o = new Map(); }
  async put(key, buf, opts){ this.o.set(key, { body: buf, httpMetadata: opts&&opts.httpMetadata, customMetadata: opts&&opts.customMetadata }); return {}; }
  async get(key){ const v = this.o.get(key); return v ? { body: v.body, httpMetadata: v.httpMetadata } : null; }
  async delete(key){ this.o.delete(key); }
}
const R2 = new FakeR2();
const env = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', CLERK_ISSUER:'https://x.clerk.accounts.dev',
              ADMIN_IDS:'admin1', KYC_DOCS:R2, REQUIRE_KYC_TO_BID:'1' };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

const mkUser = async (uid, mode='partner') => {
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?)")
    .bind(uid,'fb_'+uid,'+60'+Math.random().toString().slice(2,11),uid+'@t.my',uid,1,mode,'KL',3.139,101.687,'[]',now()).run();
};
await mkUser('admin1','customer'); await mkUser('p1'); await mkUser('p2');
const ta=await signJWT({uid:'admin1'},env.JWT_SECRET,3600);
const t1=await signJWT({uid:'p1'},env.JWT_SECRET,3600);
const t2=await signJWT({uid:'p2'},env.JWT_SECRET,3600);

const JPEG = new Uint8Array([0xFF,0xD8,0xFF,0xE0,0,0x10,0x4A,0x46,0x49,0x46,0,1,...new Array(200).fill(0x41)]);
const PNG  = new Uint8Array([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,...new Array(200).fill(0x42)]);
const TEXT = new TextEncoder().encode("this is definitely not an image, it is a php shell");

const up = async (kind, bytes, tok, ctype='image/jpeg') => {
  const r = await worker.fetch(new Request('https://t.dev/kyc/upload?kind='+kind, {
    method:'POST', headers:{ authorization:'Bearer '+tok, 'content-type':ctype }, body:bytes }), env);
  return { status:r.status, body: await r.json().catch(()=>({})) };
};
const call = async (p,m,b,t) => { const r = await worker.fetch(new Request('https://t.dev'+p,
  {method:m,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}),env);
  return {status:r.status, body:await r.json().catch(()=>({}))}; };

console.log("\n\u2014 Upload validates the BYTES, not the header \u2014");
let r = await up('front', JPEG, t1);
ok("real JPEG accepted", r.status===201 && !!r.body.key, r.body);
const frontKey = r.body.key;
ok("key is namespaced to the user (never client-chosen)", frontKey.startsWith('kyc/p1/'), frontKey);
r = await up('selfie', PNG, t1, 'image/png');
ok("real PNG accepted", r.status===201, r.body);
const selfieKey = r.body.key;
r = await up('front', TEXT, t1, 'image/jpeg');
ok("text file claiming to be a JPEG rejected", r.status===400 && r.body.error.code==='not_an_image', r.body);
r = await up('front', PNG, t1, 'image/jpeg');
ok("PNG bytes declared as JPEG rejected (type mismatch)", r.status===400, r.body);
r = await up('front', new Uint8Array(0), t1);
ok("empty file rejected", r.status===400, r.status);
r = await up('front', new Uint8Array(7*1024*1024).fill(0xFF), t1);
ok("oversized file rejected", r.status===400, r.status);
r = await up('passport', JPEG, t1);
ok("unknown kind rejected", r.status===400, r.status);
r = await up('front', JPEG, 'garbage');
ok("upload needs a valid session", r.status===401, r.status);

console.log("\n\u2014 You cannot be verified without actually uploading \u2014");
r = await call('/kyc/submit','POST',{full_name:'Ali Bin Abu',ic_last4:'4421',
  doc_front_key:'kyc/p1/i-made-this-up-front', selfie_key:'kyc/p1/invented-selfie'}, t1);
ok("invented keys rejected (not in storage)", r.status===400 && r.body.error.code==='doc_missing', r.body);
r = await call('/kyc/submit','POST',{full_name:'Ali',ic_last4:'4421',
  doc_front_url:'https://evil.com/anything.jpg', selfie_url:'https://evil.com/x.jpg'}, t1);
ok("legacy 'just send a URL' path is dead", r.status===400, r.body);

console.log("\n\u2014 You cannot claim someone else's documents \u2014");
r = await up('front', JPEG, t2);
const p2Front = r.body.key;
ok("p2 uploads their own doc", p2Front.startsWith('kyc/p2/'), p2Front);
r = await call('/kyc/submit','POST',{full_name:'Ali',ic_last4:'4421',
  doc_front_key:p2Front, selfie_key:selfieKey}, t1);
ok("p1 cannot submit p2's document", r.status===400 && r.body.error.code==='bad_doc_key', r.body);

console.log("\n\u2014 Honest submission works \u2014");
// Fresh partner: the earlier rejected attempts legitimately burned p1's daily
// submit allowance (KYC_PER_DAY=3), which is the intended production behaviour.
await mkUser('p9');
const t9 = await signJWT({uid:'p9'}, env.JWT_SECRET, 3600);
const f9 = (await up('front', JPEG, t9)).body.key;
const s9 = (await up('selfie', PNG, t9, 'image/png')).body.key;
r = await call('/kyc/submit','POST',{full_name:'Ali Bin Abu',ic_last4:'4421',
  doc_front_key:f9, selfie_key:s9}, t9);
ok("submit with real uploaded docs", r.status===201 && r.body.status==='pending', r.body);
const kycId = r.body.kyc_id;
r = await call('/kyc/submit','POST',{full_name:'Ali',ic_last4:'4421',
  doc_front_key:f9, selfie_key:s9}, t9);
ok("second pending submission blocked", r.status===409 && r.body.error.code==='kyc_pending', r.body);
r = await call('/me/kyc','GET',null,t9);
ok("partner sees pending status", r.body.status==='pending', r.body);
const stored = await env.DB.prepare("SELECT * FROM kyc_submissions WHERE id=?").bind(kycId).first();
ok("full IC number never stored (last4 only)", stored.ic_last4==='4421' && !JSON.stringify(stored).match(/\d{12}/), stored.ic_last4);
const audits = (await env.DB.prepare("SELECT * FROM audit_log WHERE action='kyc.submit'").all()).results;
ok("audit trail does NOT contain the document keys", !JSON.stringify(audits).includes('kyc/p9/'), audits);

console.log("\n\u2014 Documents are private: only admins, only through the Worker \u2014");
let raw = await worker.fetch(new Request(`https://t.dev/kyc/doc/${kycId}/front`, {headers:{authorization:'Bearer '+ta}}), env);
ok("admin can stream the document", raw.status===200, raw.status);
ok("served with the sniffed content type", raw.headers.get('content-type')==='image/jpeg', raw.headers.get('content-type'));
ok("never cached", /no-store/.test(raw.headers.get('cache-control')||''), raw.headers.get('cache-control'));
raw = await worker.fetch(new Request(`https://t.dev/kyc/doc/${kycId}/front`, {headers:{authorization:'Bearer '+t9}}), env);
ok("the OWNER cannot fetch via the admin route", raw.status===403, raw.status);
raw = await worker.fetch(new Request(`https://t.dev/kyc/doc/${kycId}/front`, {headers:{authorization:'Bearer '+t2}}), env);
ok("another partner cannot fetch it", raw.status===403, raw.status);
raw = await worker.fetch(new Request(`https://t.dev/kyc/doc/${kycId}/front`), env);
ok("no token, no document", raw.status===401, raw.status);
raw = await worker.fetch(new Request(`https://t.dev/kyc/doc/${kycId}/nonsense`, {headers:{authorization:'Bearer '+ta}}), env);
ok("unknown document kind 404", raw.status===404, raw.status);

console.log("\n\u2014 Review flow \u2014");
r = await call('/kyc/pending','GET',null,ta);
ok("admin sees the queue", r.status===200 && r.body.submissions.length===1, r.body);
r = await call(`/kyc/${kycId}/review`,'POST',{action:'approve'}, ta);
ok("approve works", r.status===200, r.body);
ok("partner is now id_verified", (await env.DB.prepare("SELECT id_verified FROM users WHERE id=?").bind('p9').first()).id_verified===1);
ok("documents RETAINED after approval (partner is active)", !!(await R2.get(f9)), "docs were deleted");
r = await call(`/kyc/${kycId}/review`,'POST',{action:'reject'}, ta);
ok("double review blocked", r.status===409, r.status);

console.log("\n\u2014 Storage not configured: refuse, never pretend \u2014");
const env2 = { ...env, KYC_DOCS: undefined, DB: env.DB };
let r2 = await worker.fetch(new Request('https://t.dev/kyc/upload?kind=front',
  {method:'POST',headers:{authorization:'Bearer '+t2,'content-type':'image/jpeg'},body:JPEG}), env2);
ok("upload refuses with 503 when no bucket", r2.status===503, r2.status);
r2 = await worker.fetch(new Request('https://t.dev/kyc/submit',
  {method:'POST',headers:{authorization:'Bearer '+t2,'content-type':'application/json'},
   body:JSON.stringify({full_name:'X',ic_last4:'1234',doc_front_key:'a',selfie_key:'b'})}), env2);
ok("submit refuses with 503 when no bucket (no fake verification)", r2.status===503, r2.status);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
