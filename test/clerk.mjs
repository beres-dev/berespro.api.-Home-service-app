// Verify the Clerk session path end-to-end with a locally-generated RSA key acting
// as Clerk's JWKS. Proves verifyClerkToken accepts valid tokens and rejects bad ones.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';

// generate an RSA keypair, expose as JWKS, sign a Clerk-style token
const kp = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: "SHA-256" },
  true, ["sign","verify"]);
const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
jwk.kid = "test-kid"; jwk.use = "sig"; jwk.alg = "RS256";
const JWKS = JSON.stringify({ keys: [jwk] });

const b64url = (obj) => btoa(typeof obj==="string"?obj:JSON.stringify(obj))
  .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
async function clerkToken(claims){
  const h = b64url({ alg:"RS256", typ:"JWT", kid:"test-kid" });
  const p = b64url({ iss:"https://berespro-x.clerk.accounts.dev",
                     exp: Math.floor(Date.now()/1000)+3600, iat: Math.floor(Date.now()/1000), ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey,
    new TextEncoder().encode(`${h}.${p}`));
  const s = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  return `${h}.${p}.${s}`;
}

const realFetch = globalThis.fetch;
const env = {
  DB: new MockDB(), JWT_SECRET: "clerk-test-".repeat(3),
  CLERK_ISSUER: "https://berespro-x.clerk.accounts.dev",
  CLERK_JWKS_URL: "https://berespro-x.clerk.accounts.dev/.well-known/jwks.json",
  COMMISSION_BPS: "2000", PUBLIC_URL: "https://t.dev", PSP_SECRET: "psp",
};
// intercept the JWKS fetch; everything else is in-process
globalThis.fetch = async (url, init) => {
  if (String(url).includes("/.well-known/jwks.json"))
    return new Response(JWKS, { headers:{"content-type":"application/json"} });
  return worker.fetch(new Request(url, init), env);
};
const call = (path,body) => worker.fetch(new Request("https://t.dev"+path,
  {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),env);
const j = async r => ({status:r.status, body: await r.json()});

let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c){pass++;console.log("  \u2713",n);} else {fail++;console.log("  \u2717",n,x?JSON.stringify(x):"");} };

console.log("\n— Clerk session verification —");
// valid token (phone sign-in) creates a user
let tok = await clerkToken({ sub:"clerk_user_1", phone_number:"+60123456789", name:"Zaini" });
let r = await j(await call("/auth/session", { clerkToken: tok }));
ok("valid Clerk token → session issued", r.status===200 && !!r.body.accessToken && r.body.user.name==="Zaini", r.body);
const uid = r.body.user.id;

// same Clerk user signs in again → same app user (no duplicate)
r = await j(await call("/auth/session", { clerkToken: await clerkToken({ sub:"clerk_user_1" }) }));
ok("returning Clerk user maps to same account", r.body.user.id===uid, r.body.user);

// tampered signature rejected
const bad = tok.slice(0, -4) + "AAAA";
r = await j(await call("/auth/session", { clerkToken: bad }));
ok("tampered token rejected (401)", r.status===401 && r.body.error.code==="bad_token", r.body);

// wrong issuer rejected
const wrongIss = await (async()=>{
  const h=b64url({alg:"RS256",typ:"JWT",kid:"test-kid"});
  const p=b64url({iss:"https://evil.clerk.accounts.dev",sub:"x",exp:Math.floor(Date.now()/1000)+3600});
  const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",kp.privateKey,new TextEncoder().encode(`${h}.${p}`));
  const s=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  return `${h}.${p}.${s}`;
})();
r = await j(await call("/auth/session", { clerkToken: wrongIss }));
ok("wrong-issuer token rejected (401)", r.status===401, r.body);

// expired token rejected
const expired = await (async()=>{
  const h=b64url({alg:"RS256",typ:"JWT",kid:"test-kid"});
  const p=b64url({iss:env.CLERK_ISSUER,sub:"y",exp:Math.floor(Date.now()/1000)-10});
  const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",kp.privateKey,new TextEncoder().encode(`${h}.${p}`));
  const s=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  return `${h}.${p}.${s}`;
})();
r = await j(await call("/auth/session", { clerkToken: expired }));
ok("expired token rejected (401)", r.status===401, r.body);

globalThis.fetch = realFetch;
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
