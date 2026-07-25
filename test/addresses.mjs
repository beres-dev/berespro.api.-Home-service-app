// SAVED ADDRESSES: Home/Office/custom labels with map pins.
// The behaviours that matter: same-label REPLACES (one "Home", not five),
// the cap holds, and nobody can read or delete another person's addresses.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, now } from '../src/lib/util.js';

const env = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', CLERK_ISSUER:'https://x.clerk.accounts.dev' };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

for (const u of ['u1','u2']) {
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?)")
    .bind(u,'fb_'+u,'+6012'+u,'u@t.my','User '+u,214,'customer','KL',3.139,101.687,'[]',now()).run();
}
const t1 = await signJWT({uid:'u1'}, env.JWT_SECRET, 3600);
const t2 = await signJWT({uid:'u2'}, env.JWT_SECRET, 3600);
const call = async (p,m,b,t) => { const r = await worker.fetch(new Request('https://t.dev'+p,
  {method:m,headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}),env);
  return {status:r.status, body:await r.json().catch(()=>({}))}; };

console.log("\n\u2014 Create and list \u2014");
let r = await call('/me/addresses','POST',{label:'Home',addr:'12 Jalan Ampang, KL',lat:3.16,lng:101.71}, t1);
ok("create Home", r.status===201 && r.body.address.label==='Home', r.body);
r = await call('/me/addresses','POST',{label:'Office',addr:'Menara ABC, Jalan Sultan Ismail',lat:3.15,lng:101.70}, t1);
ok("create Office", r.status===201, r.body);
r = await call('/me/addresses','POST',{label:'Mak',addr:'Kg Baru',lat:3.17,lng:101.70}, t1);
ok("create custom label", r.status===201, r.body);
r = await call('/me/addresses','GET',null, t1);
ok("list returns 3", r.body.addresses.length===3, r.body);
ok("Home sorted first, Office second",
   r.body.addresses[0].label==='Home' && r.body.addresses[1].label==='Office',
   r.body.addresses.map(a=>a.label));

console.log("\n\u2014 Same label REPLACES, never accumulates \u2014");
r = await call('/me/addresses','POST',{label:'Home',addr:'88 Jalan Baru, PJ',lat:3.10,lng:101.64}, t1);
ok("re-save Home succeeds", r.status===201, r.body);
r = await call('/me/addresses','GET',null, t1);
ok("still 3 addresses (replaced, not added)", r.body.addresses.length===3, r.body.addresses.length);
ok("Home now points at the NEW place", r.body.addresses[0].addr.includes('Jalan Baru'), r.body.addresses[0]);
r = await call('/me/addresses','POST',{label:'home',addr:'case test',lat:3.1,lng:101.6}, t1);
ok("label match is case-insensitive (home == Home)", r.status===201, r.body);
r = await call('/me/addresses','GET',null, t1);
ok("count still 3", r.body.addresses.length===3, r.body.addresses.length);

console.log("\n\u2014 Validation \u2014");
r = await call('/me/addresses','POST',{label:'X',addr:'no pin here'}, t1);
ok("missing pin rejected", r.status===400 && r.body.error.code==='pin_required', r.body);
r = await call('/me/addresses','POST',{label:'',addr:'x',lat:3,lng:101}, t1);
ok("empty label rejected", r.status===400, r.status);
r = await call('/me/addresses','POST',{label:'Y',addr:'x',lat:999,lng:101}, t1);
ok("out-of-range lat rejected", r.status===400, r.status);

console.log("\n\u2014 The cap holds \u2014");
for (let i=0;i<8;i++) await call('/me/addresses','POST',{label:'P'+i,addr:'x '+i,lat:3+i/100,lng:101}, t1);
r = await call('/me/addresses','GET',null, t1);
ok("at the cap of 10", r.body.addresses.length===10, r.body.addresses.length);
r = await call('/me/addresses','POST',{label:'Eleventh',addr:'x',lat:3,lng:101}, t1);
ok("11th rejected with address_limit", r.status===409 && r.body.error.code==='address_limit', r.body);
r = await call('/me/addresses','POST',{label:'Home',addr:'replace still works at cap',lat:3,lng:101}, t1);
ok("replacing an existing label still allowed AT the cap", r.status===201, r.body);

console.log("\n\u2014 Ownership \u2014");
r = await call('/me/addresses','GET',null, t2);
ok("u2 sees none of u1's addresses", r.body.addresses.length===0, r.body);
const list1 = (await call('/me/addresses','GET',null, t1)).body.addresses;
r = await call('/me/addresses/'+list1[0].id,'DELETE',null, t2);
ok("u2 cannot delete u1's address (404, no oracle)", r.status===404, r.status);
r = await call('/me/addresses/'+list1[0].id,'DELETE',null, t1);
ok("u1 deletes own address", r.status===200, r.body);
r = await call('/me/addresses','GET',null, t1);
ok("count dropped to 9", r.body.addresses.length===9, r.body.addresses.length);
r = await call('/me/addresses','GET',null, 'rubbish');
ok("needs a session", r.status===401, r.status);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
