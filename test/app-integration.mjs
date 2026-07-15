// INTEGRATION TEST: the app's real API layer driving the real backend worker.
import { MockDB } from '/home/claude/berespro-api/test/mockdb.mjs';
import worker from '/home/claude/berespro-api/src/index.js';
import { signJWT, now, id as mkid } from '/home/claude/berespro-api/src/lib/util.js';
import fs from 'fs';

const env = {
  DB: new MockDB(), JWT_SECRET: 'x'.repeat(40), FIREBASE_PROJECT_ID: 'x',
  COMMISSION_BPS: '2000', PUBLIC_URL: 'https://api.test', PSP_SECRET: 'ps',
  ADMIN_IDS: 'admin1', REQUIRE_KYC_TO_BID: '1', DEV_LOGIN: '1',
};
// seed admin
await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?)")
  .bind('admin1','fb_a','+60999','a@t.my','Admin',210,'customer','KL',3.1,101.6,'[]',now()).run();
const adminTok = await signJWT({uid:'admin1'}, env.JWT_SECRET, 3600);

// ---- browser stubs ----
global.fetch = (url, opts) => worker.fetch(new Request(url, opts), env);
const store = {};
global.localStorage = { getItem:k=>store[k]||null, setItem:(k,v)=>store[k]=String(v), removeItem:k=>delete store[k] };
global.window = { open: (u)=>{ window._opened = u; } };

// ---- extract app core + API layer ----
const src = fs.readFileSync('/home/claude/berespro/berespro-app.html','utf8');
const core = src.split('/*__CORE_START__*/')[1].split('/*__CORE_END__*/')[0];
const apiL = src.split('/*__API_START__*/')[1].split('/*__API_END__*/')[0];
let lastToast = '';
const boot = 'function render(){}\nfunction toast(m){ lastToast = m; }\nfunction go(){}\n';
eval(boot + core + apiL + `
Object.assign(globalThis,{CFG,TOK,saveTok,state,PARTNERS,CITIES,screenHTML,
  liveLogin,livePostTask,syncFeed,livePlaceBid,liveKycSubmit,syncKyc,liveConnectPayout,
  syncMyTasks,syncTask,liveAccept,livePollPayment,livePartnerComplete,liveConfirm,
  liveReview,syncEarnings,syncNotifs});`);
CFG.base = 'https://api.test';

let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c){pass++;console.log('  ✓',n);} else{fail++;console.log('  ✗',n, x!==undefined?JSON.stringify(x):'');} };
const asCustomer = t => { saveTok(t.a,t.r); state.liveUid = t.uid; };

console.log('\n— App layer: customer signs in & posts task —');
let cu = await liveLogin('+60121111111','customer');
const custTok = { a:TOK.a, r:TOK.r, uid: cu.id };
ok('liveLogin returns user + stores tokens', !!cu.id && !!TOK.a);
const posted = await livePostTask({ title:'Assemble PAX wardrobe', category:'assembly', city:'Kuala Lumpur',
  addr:'Mont Kiara', lat:3.171, lng:101.652, budget_cents:18000, date_label:'15 Jul 2026', time_slot:'Morning', description:'12th floor' });
ok('livePostTask maps to app shape (RM 180, numeric id)', posted.budget===180 && typeof posted.id==='number' && posted.mine===true, posted);

console.log('\n— Partner: KYC gate → verify → connect payout → bid —');
let pu = await liveLogin('+60132222222','partner');
const partTok = { a:TOK.a, r:TOK.r, uid: pu.id };
state.user.city = 'Kuala Lumpur';
await syncFeed();
const feedTask = state.tasks.find(t=>!t.mine && t.title.includes('PAX'));
ok('syncFeed shows customer task with distance + customer name', !!feedTask && feedTask.distance!==undefined && feedTask.customer.length>0, feedTask&&{d:feedTask.distance,c:feedTask.customer});

let kycBlocked=false;
try { await livePlaceBid(feedTask.id, 170, '2 hours incl cleanup'); }
catch(e){ kycBlocked = e.code==='kyc_required'; }
ok('bid blocked by KYC gate', kycBlocked);

await liveKycSubmit({ full_name:'Hafiz Roslan', ic_last4:'4421', doc_front_url:'upload://f.jpg', selfie_url:'upload://s.jpg' });
await syncKyc();
ok('syncKyc → pending', state.live.kyc.status==='pending', state.live.kyc);
// admin approves
const q = await (await fetch('https://api.test/kyc/pending',{headers:{authorization:'Bearer '+adminTok}})).json();
await fetch('https://api.test/kyc/'+q.submissions[0].id+'/review',{method:'POST',headers:{authorization:'Bearer '+adminTok,'content-type':'application/json'},body:JSON.stringify({action:'approve'})});
const cp = await liveConnectPayout();
ok('connect payout → active (sim)', cp.status==='active');
await livePlaceBid(feedTask.id, 170, '2 hours incl cleanup');
ok('bid placed after KYC + payout', feedTask.myBid && feedTask.myBid.amount===170, feedTask.myBid);

console.log('\n— Customer: sees bid, accepts, pays (simulated PSP) —');
asCustomer(custTok);
await syncMyTasks();
let myTask = state.tasks.find(t=>t.srv===posted.srv);
await syncTask(myTask.id);
myTask = state.tasks.find(t=>t.srv===posted.srv);  // re-fetch: upsert replaces the object
ok('owner sees live bid; partner registered with verified badge', myTask.bids.length===1 && PARTNERS[myTask.bids[0].p].elite===true && PARTNERS[myTask.bids[0].p].name.length>0, myTask.bids[0]);
const acc = await liveAccept(myTask.id, 0, null);
ok('liveAccept opens payment_url + returns split', window._opened.includes('simulate-pay') && acc.net_cents===13600, acc);
await fetch(acc.payment_url);            // customer "pays" on PSP page
const st = await livePollPayment(acc.payment_id, myTask.id, 2);
ok('poll → held; task inprogress with accepted bid', st==='held' && myTask.status==='inprogress' || state.tasks.find(t=>t.srv===posted.srv).status==='inprogress');

console.log('\n— Complete → confirm → review → earnings —');
saveTok(partTok.a, partTok.r); state.liveUid = partTok.uid;
await livePartnerComplete(myTask.id);
asCustomer(custTok);
const conf = await liveConfirm(myTask.id);
ok('liveConfirm releases 13600 net / 3400 fee', conf.released_net_cents===13600 && conf.platform_fee_cents===3400, conf);
await liveReview(myTask.id, 5, 'Kerja kemas');
ok('liveReview posts', state.tasks.find(t=>t.srv===posted.srv).reviewed===true);

saveTok(partTok.a, partTok.r); state.liveUid = partTok.uid;
await syncEarnings();
ok('syncEarnings: RM 136 paid, escrow variant data ready', state.live.earn.total===136 && state.live.earn.payouts.length===1, state.live.earn);
await syncNotifs();
ok('syncNotifs maps unread notifications', state.notifs.length>0 && state.notifs.some(n=>n.unread), state.notifs.slice(0,2));

// live pearn template renders with real data
state.screen='pearn'; state.mode='partner';
const html = screenHTML();
ok('pearn renders live escrow card (no withdraw button)', html.includes('Paid to your bank') && !html.includes('Withdraw to bank'));
state.screen='pkyc';
ok('pkyc renders approved state', (await syncKyc(), screenHTML().includes("You're verified")));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
