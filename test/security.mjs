// SECURITY SUITE: each test is an actual exploit attempt against the worker.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, id, now, verifyJWT } from '../src/lib/util.js';
import { verifyClerkToken } from '../src/lib/auth.js';

// Stub the network so no real Clerk JWKS call happens. Return one dummy RS256
// key under kid 'test-kid'; forged tokens still fail because the SIGNATURE is
// bogus, which is exactly what we are testing.
const _realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('jwks')) {
    return new Response(JSON.stringify({ keys: [{ kty:'RSA', kid:'test-kid', n:'sXchDaQ', e:'AQAB', alg:'RS256', use:'sig' }] }), { status:200 });
  }
  return _realFetch ? _realFetch(url, opts) : new Response('{}',{status:200});
};

const env = { DB:new MockDB(), JWT_SECRET:'s'.repeat(40), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', CLERK_ISSUER:'https://good.clerk.accounts.dev',
              REQUIRE_KYC_TO_BID:'0', ADMIN_IDS:'admin1', XENDIT_CALLBACK_TOKEN:'super-secret-token' };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

const mkUser = async (uid, mode='customer') => {
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?)")
    .bind(uid,'fb_'+uid,'+60'+Math.random().toString().slice(2,11),uid+'@t.my',uid,1,mode,'KL',3.1,101.6,'[]',now()).run();
};
await mkUser('admin1'); await mkUser('victim'); await mkUser('attacker'); await mkUser('p1','partner');
const call = async (p,m,b,tok) => { const h={'content-type':'application/json'}; if(tok)h.authorization='Bearer '+tok;
  const r = await worker.fetch(new Request('https://t.dev'+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}),env);
  return {status:r.status, body:await r.json().catch(()=>({})), headers:r.headers}; };

console.log("\n\u2014 JWT ALGORITHM CONFUSION (Clerk front door) \u2014");
// alg:none forged token
let noneTok = b64u({alg:'none',typ:'JWT'})+'.'+b64u({sub:'attacker',iss:env.CLERK_ISSUER,exp:now()+3600})+'.';
ok("alg:none token rejected", (await verifyClerkToken(noneTok, env))===null);
// alg:HS256 signed with a guessed secret (RSA-confusion class)
const hsTok = b64u({alg:'HS256',typ:'JWT'})+'.'+b64u({sub:'attacker',iss:env.CLERK_ISSUER,exp:now()+3600})+'.AAAA';
ok("alg:HS256 token rejected (no RS256)", (await verifyClerkToken(hsTok, env))===null);
// missing kid → must not fall back to keys[0]
const noKid = b64u({alg:'RS256',typ:'JWT'})+'.'+b64u({sub:'attacker',iss:env.CLERK_ISSUER,exp:now()+3600})+'.AAAA';
ok("RS256 with no matching kid rejected", (await verifyClerkToken(noKid, env))===null);
// wrong issuer
const wrongIss = b64u({alg:'RS256',typ:'JWT',kid:'x'})+'.'+b64u({sub:'attacker',iss:'https://evil.clerk.accounts.dev',exp:now()+3600})+'.AAAA';
ok("wrong issuer rejected", (await verifyClerkToken(wrongIss, env))===null);

console.log("\n\u2014 SESSION JWT FORGERY \u2014");
const good = await signJWT({uid:'victim'}, env.JWT_SECRET, 3600);
ok("valid session token verifies", (await verifyJWT(good, env.JWT_SECRET))?.uid==='victim');
// tamper the payload, keep the signature
const [h,p,s] = good.split('.');
const forged = h+'.'+b64u({uid:'admin1',iat:now(),exp:now()+3600})+'.'+s;
ok("tampered payload rejected", (await verifyJWT(forged, env.JWT_SECRET))===null);
// signed with wrong secret
const wrongKey = await signJWT({uid:'admin1'}, 'wrong'.repeat(8), 3600);
ok("token signed with wrong secret rejected", (await verifyJWT(wrongKey, env.JWT_SECRET))===null);
// expired
const expired = await signJWT({uid:'victim'}, env.JWT_SECRET, -10);
ok("expired token rejected", (await verifyJWT(expired, env.JWT_SECRET))===null);

console.log("\n\u2014 PRIVILEGE ESCALATION \u2014");
const attackerTok = await signJWT({uid:'attacker'}, env.JWT_SECRET, 3600);
for (const [name,path] of [["stats","/admin/stats"],["users","/admin/users"],["payments","/admin/payments"],["settings","/admin/settings"],["audit","/admin/audit"]]){
  const r = await call(path,'GET',null,attackerTok);
  ok(`non-admin blocked from /admin/${name}`, r.status===403, r.status);
}
let r = await call('/admin/settings','PATCH',{commission_bps:0},attackerTok);
ok("non-admin cannot change commission", r.status===403, r.status);
r = await call('/admin/users/victim/suspend','POST',{suspend:true},attackerTok);
ok("non-admin cannot suspend others", r.status===403, r.status);
r = await call('/partners/victim/verify','POST',{},attackerTok);
ok("non-admin cannot grant verified badge", r.status===403, r.status);

console.log("\n\u2014 IDOR (accessing others' resources) \u2014");
// create a payment owned by victim, attacker tries to read it
const tid = id('tsk');
await env.DB.prepare("INSERT INTO tasks (id,customer_id,title,category,city,addr,lat,lng,budget_cents,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(tid,'victim','x','cleaning','KL','a',3.1,101.6,10000,'inprogress',now()).run();
const pid = id('pay');
await env.DB.prepare("INSERT INTO payments (id,task_id,bid_id,customer_id,partner_id,amount_cents,fee_cents,net_cents,discount_cents,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(pid,tid,'b','victim','p1',10000,2000,8000,0,'held',now(),now()).run();
r = await call('/payments/'+pid,'GET',null,attackerTok);
ok("attacker cannot read victim's payment", r.status===403, r.status);
r = await call('/payments/'+pid,'GET',null,good);
ok("owner CAN read own payment", r.status===200, r.status);

console.log("\n\u2014 WEBHOOK FORGERY (moves money) \u2014");
r = await call('/webhooks/psp','POST',{event:'payment.captured',data:{reference_id:pid}},null);
ok("webhook with no token rejected", r.status===401, r.status);
let req = new Request('https://t.dev/webhooks/psp',{method:'POST',headers:{'content-type':'application/json','x-callback-token':'wrong'},body:'{}'});
r = { status:(await worker.fetch(req,env)).status };
ok("webhook with wrong token rejected", r.status===401, r.status);
req = new Request('https://t.dev/webhooks/psp',{method:'POST',headers:{'content-type':'application/json','x-callback-token':'super-secret-token'},body:JSON.stringify({event:'x',data:{}})});
r = { status:(await worker.fetch(req,env)).status };
ok("webhook with correct token accepted", r.status===200, r.status);

console.log("\n\u2014 DEV BACKDOORS OFF IN PROD \u2014");
r = await call('/auth/dev-login','POST',{phone:'+60123',mode:'customer'},null);
ok("dev-login 404 when DEV_LOGIN unset", r.status===404, r.status);
r = await call('/dev/simulate-pay','GET',null,null);
ok("dev simulate-pay 404 when DEV_LOGIN unset", r.status===404, r.status);

console.log("\n\u2014 INFO LEAKAGE & HEADERS \u2014");
r = await call('/me','GET',null,good);
ok("HSTS header present", r.headers.get('strict-transport-security')?.includes('max-age'), r.headers.get('strict-transport-security'));
ok("frame-options DENY", r.headers.get('x-frame-options')==='DENY');
ok("nosniff present", r.headers.get('x-content-type-options')==='nosniff');
ok("CSP present", !!r.headers.get('content-security-policy'));
// public partner profile must not leak contact PII
r = await call('/partners/p1','GET',null,null);
ok("partner profile has no phone", !JSON.stringify(r.body).includes('+60') || !r.body.partner || r.body.partner.phone===undefined, 'phone leak');
ok("partner profile has no email", !(r.body.partner && r.body.partner.email), 'email leak');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
