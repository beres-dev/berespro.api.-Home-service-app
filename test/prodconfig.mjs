// PRODUCTION READINESS: /health/config and the switch-failure error codes.
// These exist because flipping to production means several settings must line
// up at once, and a mismatch previously gave one opaque 401.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

const base = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), SETUP_KEY:'topsecret', PUBLIC_URL:'https://t.dev' };
const get = async (path, env) => { const r = await worker.fetch(new Request('https://t.dev'+path), env);
  return { status:r.status, body: await r.json().catch(()=>({})) }; };

console.log("\n\u2014 The readiness endpoint is not public \u2014");
let r = await get('/health/config', base);
ok("no key -> 403", r.status===403, r.status);
r = await get('/health/config?key=wrong', base);
ok("wrong key -> 403", r.status===403, r.status);

console.log("\n\u2014 A dev setup is reported as NOT production ready \u2014");
const dev = { ...base, CLERK_ISSUER:'https://good-penguin-19.clerk.accounts.dev', DEV_LOGIN:'1' };
r = await get('/health/config?key=topsecret', dev);
ok("reachable with the right key", r.status===200, r.status);
ok("production_ready is false", r.body.production_ready===false, r.body.production_ready);
ok("names the dev Clerk instance", r.body.auth.clerk_instance==='development', r.body.auth);
ok("flags DEV_LOGIN being on", r.body.blockers.some(b=>/DEV_LOGIN/.test(b)), r.body.blockers);
ok("flags missing ADMIN_IDS", r.body.blockers.some(b=>/ADMIN_IDS/.test(b)), r.body.blockers);
ok("flags unbound R2", r.body.blockers.some(b=>/KYC_DOCS/.test(b)), r.body.blockers);
ok("says payments are simulated", r.body.payments.mode==='simulation', r.body.payments);

console.log("\n\u2014 NEVER leaks a secret's value \u2014");
const s = JSON.stringify(r.body);
ok("JWT_SECRET value absent", !s.includes('s'.repeat(40)), 'leaked');
ok("SETUP_KEY value absent", !s.includes('topsecret'), 'leaked');
ok("only reports that jwt secret is SET", r.body.auth.jwt_secret_set===true, r.body.auth);

console.log("\n\u2014 A fully configured production setup reports ready \u2014");
const prod = { ...base, CLERK_ISSUER:'https://clerk.berespro.my', ADMIN_IDS:'usr_1',
               KYC_DOCS:{}, RL_KV:{}, XENDIT_SECRET_KEY:'x', XENDIT_CALLBACK_TOKEN:'y' };
r = await get('/health/config?key=topsecret', prod);
ok("production_ready is true", r.body.production_ready===true, r.body.blockers);
ok("no blockers left", r.body.blockers.length===0, r.body.blockers);
ok("clerk reported as production", r.body.auth.clerk_instance==='production', r.body.auth);
ok("payments reported live", r.body.payments.mode==='live', r.body.payments);
ok("counts the admins", r.body.admin.admin_count===1, r.body.admin);

console.log("\n\u2014 The switch failure you will actually hit is now named \u2014");
const post = async (env, token) => { const r = await worker.fetch(new Request('https://t.dev/auth/session',
  {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({clerkToken:token})}), env);
  return { status:r.status, body: await r.json().catch(()=>({})) }; };
// app switched to a production Clerk key, backend still on the dev issuer
const tok = b64u({alg:'RS256',typ:'JWT',kid:'k'})+'.'+b64u({sub:'u1',iss:'https://clerk.berespro.my',exp:9999999999})+'.sig';
r = await post({ ...base, CLERK_ISSUER:'https://good-penguin-19.clerk.accounts.dev' }, tok);
ok("mismatch is called out, not a generic 401", r.body.error && r.body.error.code==='issuer_mismatch', r.body);
ok("still REJECTS the token (diagnosis never weakens the check)", r.status===401, r.status);
ok("does not echo the expected issuer to the client",
   !JSON.stringify(r.body).includes('good-penguin-19'), 'leaked config');
r = await post({ ...base }, tok);
ok("unset issuer is its own error", r.body.error && r.body.error.code==='issuer_not_set', r.body);
// matching issuer but a genuinely bad signature stays a plain bad_token
r = await post({ ...base, CLERK_ISSUER:'https://clerk.berespro.my' }, tok);
ok("matching issuer + bad signature stays bad_token", r.body.error && r.body.error.code==='bad_token', r.body);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
