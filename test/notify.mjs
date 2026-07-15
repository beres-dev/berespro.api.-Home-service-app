// Verifies a new task notifies nearby partners, and only the right ones.
import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, id, now } from '../src/lib/util.js';

const env = { DB:new MockDB(), JWT_SECRET:'x'.repeat(20), COMMISSION_BPS:'2000',
              PUBLIC_URL:'https://t.dev', PSP_SECRET:'p', CLERK_ISSUER:'https://x.clerk.accounts.dev' };

const mkUser = async (name, mode, lat, lng, suspended=0) => {
  const uid = id('usr');
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)")
    .bind(uid,'fb_'+uid,'+60'+Math.random().toString().slice(2,10),name+'@t.my',name,214,mode,'KL',lat,lng,'[]',suspended,now()).run();
  return uid;
};
const tok = async uid => await signJWT({uid}, env.JWT_SECRET, 3600);
const call = async (path, method, body, t) => worker.fetch(new Request('https://t.dev'+path,
  {method, headers:{authorization:'Bearer '+t,'content-type':'application/json'},
   body: body?JSON.stringify(body):undefined}), env);

let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

// KL city centre task location
const KL = [3.1390, 101.6869];

const customer = await mkUser('Cust','customer', KL[0], KL[1]);
const pNear    = await mkUser('Near','partner',   3.1450, 101.6900);   // ~0.8 km
const pMid     = await mkUser('Mid','partner',    3.2100, 101.7300);   // ~9 km
const pFar     = await mkUser('Far','partner',    3.5500, 101.9000);   // ~50 km
const pSusp    = await mkUser('Susp','partner',   3.1400, 101.6870, 1); // near but suspended
const cNear    = await mkUser('CustNear','customer', 3.1440, 101.6890); // near but NOT a partner

console.log("\n\u2014 New task notifies nearby partners \u2014");
const r = await call('/tasks','POST',{
  title:'Fix leaking sink', category:'plumbing', city:'Kuala Lumpur', addr:'KLCC',
  lat:KL[0], lng:KL[1], budget_cents:12000 }, await tok(customer));
ok("task created", r.status===201, r.status);

const notifsFor = async uid => {
  const { results } = await env.DB.prepare("SELECT * FROM notifications WHERE user_id=?").bind(uid).all();
  return results;
};

const nNear = await notifsFor(pNear), nMid = await notifsFor(pMid),
      nFar  = await notifsFor(pFar),  nSusp = await notifsFor(pSusp),
      nCust = await notifsFor(cNear), nSelf = await notifsFor(customer);

ok("partner 0.8 km away notified", nNear.length===1, nNear);
ok("partner 9 km away notified",   nMid.length===1, nMid);
ok("partner 50 km away NOT notified (outside radius)", nFar.length===0, nFar);
ok("suspended partner NOT notified", nSusp.length===0, nSusp);
ok("nearby CUSTOMER not notified (partners only)", nCust.length===0, nCust);
ok("poster does not notify themselves", nSelf.length===0, nSelf);
ok("notification says the distance", /km away/.test(nNear[0]?.title||""), nNear[0]?.title);
ok("notification carries title + price", /Fix leaking sink/.test(nNear[0]?.body||"") && /120\.00/.test(nNear[0]?.body||""), nNear[0]?.body);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
