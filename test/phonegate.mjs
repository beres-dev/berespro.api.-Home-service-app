import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, id, now } from '../src/lib/util.js';

const env = { DB:new MockDB(), JWT_SECRET:"x".repeat(20), COMMISSION_BPS:"2000",
  PUBLIC_URL:"https://t.dev", PSP_SECRET:"p", DEV_LOGIN:"1" };

// simulate a Google sign-in: user created WITHOUT phone (like Clerk Google gives)
const uid = id("usr");
await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?)")
  .bind(uid,"clerk_g1",null,"amir@gmail.com","Amir",214,"customer","KL",3.1,101.6,"[]",now()).run();
const tok = await signJWT({uid}, env.JWT_SECRET, 3600);
const H = {authorization:"Bearer "+tok,"content-type":"application/json"};
const call=(p,m="GET",b)=>worker.fetch(new Request("https://t.dev"+p,{method:m,headers:H,body:b?JSON.stringify(b):undefined}),env);
const j=async r=>({status:r.status,body:await r.json()});
let pass=0,fail=0; const ok=(n,c,x)=>{c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x)));};

console.log("\n— Phone gate after Google sign-in —");
let r=await j(await call("/me"));
ok("Google user has needs_phone=true", r.body.user.needs_phone===true && !r.body.user.phone, r.body.user);

r=await j(await call("/me","PATCH",{phone:"+60 12-345 6789"}));
ok("phone saved & normalized", r.body.user.phone==="+60123456789", r.body.user);
ok("needs_phone now false", r.body.user.needs_phone===false, r.body.user);

r=await j(await call("/me","PATCH",{phone:"abc"}));
ok("bad phone rejected (400)", r.status===400 && r.body.error.code==="bad_phone", r.body);

// second user tries to take the same phone
const u2=id("usr");
await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?)")
  .bind(u2,"clerk_g2",null,"b@gmail.com","B",214,"customer","KL",3.1,101.6,"[]",now()).run();
const tok2=await signJWT({uid:u2},env.JWT_SECRET,3600);
r=await j(await worker.fetch(new Request("https://t.dev/me",{method:"PATCH",headers:{authorization:"Bearer "+tok2,"content-type":"application/json"},body:JSON.stringify({phone:"+60123456789"})}),env));
ok("duplicate phone rejected (409)", r.status===409 && r.body.error.code==="phone_taken", r.body);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
