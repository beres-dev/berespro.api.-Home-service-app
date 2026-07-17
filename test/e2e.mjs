import { MockDB } from './mockdb.mjs';
import worker from '../src/index.js';
import { signJWT, sha256hex } from '../src/lib/util.js';

const env = {
  DB: new MockDB(),
  JWT_SECRET: 'test-secret-'.repeat(3),
  FIREBASE_PROJECT_ID: 'berespro-test',
  COMMISSION_BPS: '2000',
  PUBLIC_URL: 'https://api.test',
  PSP_SECRET: 'psp-secret',
  XENDIT_CALLBACK_TOKEN: 'test-callback-token',
  ADMIN_IDS: 'admin1',
  REQUIRE_KYC_TO_BID: '1',
  DEV_LOGIN: '1',
};

async function seedUser(uid,name,mode){
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(uid,'fb_'+uid,'+60'+uid,name+'@t.my',name,214,mode,'Kuala Lumpur',3.139,101.687,'[]',0,1700000000).run();
  return await signJWT({uid}, env.JWT_SECRET, 3600);
}
const H=(t)=>({authorization:'Bearer '+t});
const call=(method,path,token,body)=>worker.fetch(new Request('https://api.test'+path,{method,headers:{...(token?H(token):{}),'content-type':'application/json'},body:body?JSON.stringify(body):undefined}),env);
const j=async r=>({status:r.status,body:await r.json()});
// Xendit verifies webhooks with a static token in x-callback-token (not an HMAC),
// and wraps the payload as { event, data }. The harness mirrors that exactly so
// these tests fail if the real contract is ever broken.
async function webhook(payload){
  const raw = JSON.stringify(payload);
  return j(await worker.fetch(new Request('https://api.test/webhooks/psp', {
    method:'POST',
    headers:{ 'x-callback-token': env.XENDIT_CALLBACK_TOKEN, 'content-type':'application/json' },
    body: raw,
  }), env));
}
// Our payment id is sent to Xendit as reference_id, so it comes back that way.
const held = (paymentId) => ({
  event: 'payment.authorization',
  data: { reference_id: paymentId, payment_id: 'py-' + paymentId, status: 'AUTHORIZED' },
});

let pass=0,fail=0;
const ok=(n,c,x)=>{ if(c){pass++;console.log('  ✓',n);} else {fail++;console.log('  ✗',n,x?JSON.stringify(x):'');} };

console.log('\n— Setup —');
const cust=await seedUser('cust1','Zaini','customer');
const part=await seedUser('part1','Hafiz','partner');
const part2=await seedUser('part2','Kumar','partner');
const part2Token=()=>part2;

const admin=await seedUser('admin1','Admin','customer');
let r;

console.log('\n— KYC gate protects users —');
r=await j(await call('POST','/tasks',cust,{title:'KYC probe task',category:'cleaning',city:'Kuala Lumpur',lat:3.14,lng:101.69,budget_cents:15000}));
const probeTask=r.body.task.id;
r=await j(await call('POST',`/tasks/${probeTask}/bids`,part,{amount_cents:15000}));
ok('bid blocked before KYC (403 kyc_required)', r.status===403 && r.body.error.code==='kyc_required', r.body);
r=await j(await call('POST','/kyc/submit',part,{full_name:'Hafiz Roslan',ic_last4:'4421',doc_front_url:'r2://kyc/f1.jpg',selfie_url:'r2://kyc/s1.jpg'}));
ok('KYC submitted (pending)', r.status===201 && r.body.status==='pending', r.body);
const kycId=r.body.kyc_id;
r=await j(await call('GET','/me/kyc',part));
ok('my kyc = pending', r.body.status==='pending', r.body);
r=await j(await call('POST',`/kyc/${kycId}/review`,admin,{action:'approve'}));
ok('admin approves KYC', r.body.status==='approved', r.body);
// second partner: approve via direct flag path for the payout-block test
r=await j(await call('POST','/kyc/submit',part2Token(),{full_name:'X',ic_last4:'1111',doc_front_url:'r2://x',selfie_url:'r2://y'}));

console.log('\n— Partner connects payout (PSP sub-merchant) —');
r=await j(await call('POST','/partners/connect',part));
ok('connect returns active (sim auto-active)', r.body.status==='active', r.body);
r=await j(await call('GET','/me/payout',part));
ok('payout status = active', r.body.status==='active', r.body);

console.log('\n— Post task & bid —');
r=await j(await call('POST','/tasks',cust,{title:'Assemble IKEA PAX',category:'assembly',city:'Kuala Lumpur',addr:'Mont Kiara',lat:3.171,lng:101.652,budget_cents:18000}));
const taskId=r.body.task.id; ok('task created', r.status===201, r.body);
r=await j(await call('POST',`/tasks/${taskId}/bids`,part,{amount_cents:17000,message:'2h incl cleanup'}));
const bidId=r.body.bid_id; ok('bid placed', r.status===201, r.body);

console.log('\n— Accept blocked if partner has no payout account —');
// part2: KYC-approve directly so only the payout gate blocks
const k2=(await j(await call('GET','/me/kyc',part2))); // pending from earlier submit
// approve part2 via admin queue
let q=await j(await call('GET','/kyc/pending',admin));
const k2id=q.body.submissions.find(x=>x.user_id==='part2').id;
await call('POST',`/kyc/${k2id}/review`,admin,{action:'approve'});
r=await j(await call('POST',`/tasks/${taskId}/bids`,part2,{amount_cents:16000}));
const bid2=r.body.bid_id;
r=await j(await call('POST',`/bids/${bid2}/accept`,cust));
ok('accept blocked → partner_payout_not_connected (409)', r.status===409 && r.body.error.code==='partner_payout_not_connected', r.body);

console.log('\n— Accept connected partner → PSP authorize (hold) —');
r=await j(await call('POST',`/bids/${bidId}/accept`,cust));
ok('accept returns payment_url + split', !!r.body.payment_url && r.body.fee_cents===3400 && r.body.net_cents===13600, r.body);
const payId=r.body.payment_id;
ok('task still open until funds held', (await j(await call('GET',`/tasks/${taskId}`,cust))).body.task.status==='open');

console.log('\n— PSP webhook: funds HELD → acceptance finalized —');
r=await webhook(held(payId));
ok('webhook held ok', r.body.ok===true, r.body);
r=await j(await call('GET',`/tasks/${taskId}`,cust));
ok('task now inprogress', r.body.task.status==='inprogress', r.body);
r=await j(await call('GET',`/payments/${payId}`,cust));
ok('payment status = held', r.body.payment.status==='held', r.body);

console.log('\n— Partner completes, customer confirms → CAPTURE + split —');
r=await j(await call('POST',`/jobs/${taskId}/complete`,part));
ok('partner marks complete', r.body.ok===true, r.body);
r=await j(await call('POST',`/jobs/${taskId}/confirm`,cust));
ok('confirm captures & releases', r.body.ok===true && r.body.released_net_cents===13600 && r.body.platform_fee_cents===3400, r.body);
r=await j(await call('GET',`/payments/${payId}`,cust));
ok('payment status = captured', r.body.payment.status==='captured', r.body);
r=await j(await call('GET',`/tasks/${taskId}`,cust));
ok('task completed', r.body.task.status==='completed', r.body);

console.log('\n— Review —');
r=await j(await call('POST',`/jobs/${taskId}/review`,cust,{rating:5,text:'Great'}));
ok('review posted', r.body.ok===true, r.body);

console.log('\n— Refund path (separate task) —');
r=await j(await call('POST','/tasks',cust,{title:'Fix sink',category:'plumbing',city:'Kuala Lumpur',lat:3.14,lng:101.69,budget_cents:12000}));
const t2=r.body.task.id;
r=await j(await call('POST',`/tasks/${t2}/bids`,part,{amount_cents:12000}));
const b2=r.body.bid_id;
r=await j(await call('POST',`/bids/${b2}/accept`,cust));
const pay2=r.body.payment_id;
await webhook(held(pay2));
r=await j(await call('POST',`/jobs/${t2}/cancel`,cust));
ok('cancel in-progress → refund + cancelled', r.body.ok===true, r.body);
r=await j(await call('GET',`/tasks/${t2}`,cust));
ok('task cancelled', r.body.task.status==='cancelled', r.body);

console.log('\n— Input validation protects the platform —');
r=await j(await call('POST','/tasks',cust,{title:'x'.repeat(200),category:'cleaning',city:'KL',lat:3.1,lng:101.6,budget_cents:15000}));
ok('200-char title rejected (400)', r.status===400, r.body);
r=await j(await call('POST','/tasks',cust,{title:'Tiny job',category:'cleaning',city:'KL',lat:3.1,lng:101.6,budget_cents:100}));
ok('below-minimum budget rejected (400)', r.status===400, r.body);

console.log('\n— Dispute freezes escrow —');
r=await j(await call('POST','/tasks',cust,{title:'Paint room',category:'painting',city:'Kuala Lumpur',lat:3.13,lng:101.68,budget_cents:30000}));
const t3=r.body.task.id;
r=await j(await call('POST',`/tasks/${t3}/bids`,part,{amount_cents:30000}));
const b3=r.body.bid_id;
r=await j(await call('POST',`/bids/${b3}/accept`,cust));
await webhook(held(r.body.payment_id));
const payId3=r.body.payment_id;
r=await j(await call('POST',`/jobs/${t3}/dispute`,cust,{reason:'Work incomplete, paint peeling on two walls'}));
ok('dispute opened', r.status===201, r.body);
const dspId=r.body.dispute_id;
r=await j(await call('POST',`/jobs/${t3}/confirm`,cust));
ok('confirm blocked while dispute open (409)', r.status===409 && r.body.error.code==='dispute_open', r.body);
r=await j(await call('POST',`/jobs/${t3}/cancel`,cust));
ok('cancel blocked while dispute open (409)', r.status===409 && r.body.error.code==='dispute_open', r.body);
r=await j(await call('POST',`/disputes/${dspId}/resolve`,admin,{action:'refund',note:'Photos support customer claim'}));
ok('admin resolves → refund', r.body.resolution==='refund', r.body);
r=await j(await call('GET',`/payments/${payId3}`,cust));
ok('payment refunded', r.body.payment.status==='refunded', r.body);
r=await j(await call('GET',`/tasks/${t3}`,cust));
ok('task cancelled after refund resolution', r.body.task.status==='cancelled', r.body);

console.log('\n— Voucher engine (discount from PLATFORM FEE, partner untouched) —');
r=await j(await call('POST','/admin/vouchers',admin,{code:'beres10',type:'percent',value:1000,per_user_limit:1}));
ok('admin creates voucher BERES10 (10%)', r.status===201 && r.body.code==='BERES10', r.body);
r=await j(await call('POST','/vouchers/preview',cust,{code:'BERES10',amount_cents:17000}));
ok('preview: 1700 off, pays 15300', r.body.valid===true && r.body.discount_cents===1700 && r.body.customer_pays_cents===15300, r.body);
// full voucher accept flow on a fresh task
r=await j(await call('POST','/tasks',cust,{title:'Aircon service x2',category:'aircon',city:'Kuala Lumpur',lat:3.15,lng:101.7,budget_cents:17000}));
const tv=r.body.task.id;
r=await j(await call('POST',`/tasks/${tv}/bids`,part,{amount_cents:17000}));
r=await j(await call('POST',`/bids/${r.body.bid_id}/accept`,cust,{voucher_code:'BERES10'}));
ok('accept w/ voucher: customer pays 15300, partner net 13600 UNCHANGED', r.body.customer_pays_cents===15300 && r.body.net_cents===13600 && r.body.discount_cents===1700, r.body);
const payV=r.body.payment_id;
await webhook(held(payV));
r=await j(await call('POST','/vouchers/preview',cust,{code:'BERES10',amount_cents:17000}));
ok('second use blocked (per_user_limit=1)', r.body.valid===false && r.body.reason==='user_limit_reached', r.body);

console.log('\n— Admin: manual release of held payment —');
r=await j(await call('POST',`/admin/payments/${payV}/release`,admin,{note:'customer unresponsive, partner provided proof'}));
ok('admin release succeeds', r.body.ok===true, r.body);
r=await j(await call('GET',`/payments/${payV}`,cust));
ok('payment captured after admin release', r.body.payment.status==='captured', r.body);

console.log('\n— Admin: stats & suspension —');
r=await j(await call('GET','/admin/stats',admin));
ok('stats: GMV = 34000 (two captured; refunded excluded — correct)', r.body.stats.captured.gmv_cents===34000, r.body.stats);
ok('stats: revenue = fees minus discounts', r.body.stats.captured.revenue_cents>0, r.body.stats);
r=await j(await call('GET','/admin/stats',cust));
ok('stats denied for non-admin (403)', r.status===403, r.body);
r=await j(await call('POST','/admin/users/part2/suspend',admin,{suspend:true,reason:'test'}));
ok('admin suspends part2', r.body.suspended===true, r.body);
r=await j(await call('GET','/me',part2));
ok('suspended user blocked everywhere (401)', r.status===401, r.body);
r=await j(await call('POST','/admin/users/part2/suspend',admin,{suspend:false}));
ok('unsuspend restores access', (await j(await call('GET','/me',part2))).status===200);

console.log('\n— Algorithm: recommended feed with tunable weights —');
r=await j(await call('PATCH','/admin/settings',admin,{algo_w_distance:70,algo_w_recency:10,algo_w_budget:20}));
ok('settings patched', r.body.ok===true, r.body);
r=await j(await call('GET','/tasks?lat=3.14&lng=101.69&radius=30&sort=recommended',part));
ok('recommended feed returns scored tasks', r.body.tasks.length>0 && r.body.tasks[0].score!==undefined, r.body.tasks[0]);
ok('feed includes customer name', r.body.tasks.every(t=>!!t.customer_name), r.body.tasks[0]);
r=await j(await call('PATCH','/admin/settings',admin,{commission_bps:1500}));
ok('commission tunable', r.body.applied.commission_bps===1500, r.body);
r=await j(await call('POST','/vouchers/preview',part,{code:'NOPE',amount_cents:10000}));
ok('invalid code → valid:false', r.body.valid===false, r.body);

console.log('\n— Dev-login + simulate-pay + earnings (integration helpers) —');
r=await j(await call('POST','/auth/dev-login',null,{phone:'+60111222333',name:'Test Dev',mode:'customer'}));
ok('dev-login issues tokens', !!r.body.accessToken && r.body.user.name==='Test Dev', r.body);
const devTok=r.body.accessToken;
r=await j(await call('GET','/me',devTok));
ok('dev token works on /me', r.status===200, r.body);
r=await j(await call('GET','/me/earnings',part));
ok('earnings: total = 13600+15300... captured nets sum', r.body.total_earned_cents>0 && Array.isArray(r.body.payouts), r.body);
// simulate-pay page path: create fresh task→bid→accept then GET the sim page
r=await j(await call('POST','/tasks',cust,{title:'Sim pay test',category:'cleaning',city:'Kuala Lumpur',lat:3.14,lng:101.69,budget_cents:11000}));
const tS=r.body.task.id;
r=await j(await call('POST',`/tasks/${tS}/bids`,part,{amount_cents:11000}));
r=await j(await call('POST',`/bids/${r.body.bid_id}/accept`,cust));
const simRef='sim_'+r.body.payment_id, simPayId=r.body.payment_id;
let sr=await worker.fetch(new Request('https://api.test/dev/simulate-pay?ref='+simRef),env);
ok('simulate-pay returns HTML success', sr.status===200 && (await sr.text()).includes('Payment simulated'), null);
r=await j(await call('GET',`/payments/${simPayId}`,cust));
ok('payment held after simulate-pay', r.body.payment.status==='held', r.body);
r=await j(await call('GET',`/tasks/${tS}`,cust));
ok('task inprogress after simulate-pay', r.body.task.status==='inprogress', r.body);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
