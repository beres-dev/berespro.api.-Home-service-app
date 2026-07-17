// One card funding many accounts is the cheapest way to farm fake customers.
// The bank already KYC'd the cardholder, so a card is strong identity — but only
// if we notice when the same card appears behind several accounts.
import { MockDB } from './mockdb.mjs';
import { id, now } from '../src/lib/util.js';
import { onHeld } from '../src/routes/payments.js';

const env = { DB:new MockDB(), JWT_SECRET:'x'.repeat(20), COMMISSION_BPS:'2000', PSP_SECRET:'p' };
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

const mkUser = async () => { const uid=id('usr');
  await env.DB.prepare("INSERT INTO users (id,firebase_uid,phone,email,name,avatar_hue,mode,city,lat,lng,skills,id_verified,suspended,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?)")
    .bind(uid,'fb_'+uid,'+60'+Math.random().toString().slice(2,10),uid+'@t.my','U',214,'customer','KL',3.1,101.6,'[]',now()).run();
  return uid; };

const mkPaidTask = async (customerId, partnerId, cardFp) => {
  const tid=id('tsk'), bid=id('bid'), pid=id('pay');
  await env.DB.prepare("INSERT INTO tasks (id,customer_id,title,category,city,addr,lat,lng,budget_cents,date_label,time_slot,description,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?)")
    .bind(tid,customerId,'Job','cleaning','KL','x',3.1,101.6,10000,null,null,null,now()).run();
  await env.DB.prepare("INSERT INTO bids (id,task_id,partner_id,amount_cents,message,status,created_at) VALUES (?,?,?,?,?,'pending',?)")
    .bind(bid,tid,partnerId,10000,null,now()).run();
  await env.DB.prepare("INSERT INTO payments (id,task_id,bid_id,customer_id,partner_id,amount_cents,fee_cents,net_cents,psp_ref,card_fp,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)")
    .bind(pid,tid,bid,customerId,partnerId,10000,2000,8000,'ref_'+pid,cardFp,now(),now()).run();
  return await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(pid).first();
};

const flags = async () => {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE action=?").bind("card_reuse_flagged").all();
  return results;
};

const partner = await mkUser();
const CARD_A = "fp_card_aaa";

console.log("\n\u2014 Same card across accounts \u2014");
const u1 = await mkUser(); await onHeld(env, await mkPaidTask(u1, partner, CARD_A));
ok("1 account on the card: no flag", (await flags()).length===0);

const u2 = await mkUser(); await onHeld(env, await mkPaidTask(u2, partner, CARD_A));
ok("2 accounts (a couple sharing): still no flag", (await flags()).length===0);

const u3 = await mkUser(); await onHeld(env, await mkPaidTask(u3, partner, CARD_A));
const f = await flags();
ok("3 accounts on one card: FLAGGED", f.length===1, f.length);
ok("flag records how many accounts", f[0] && JSON.parse(f[0].meta).account_count===3, f[0]&&f[0].meta);
ok("flag lists the accounts for the admin", f[0] && JSON.parse(f[0].meta).accounts.length===3);

console.log("\n\u2014 Normal behaviour is untouched \u2014");
const u4 = await mkUser(); await onHeld(env, await mkPaidTask(u4, partner, "fp_card_bbb"));
ok("different card: no new flag", (await flags()).length===1);

const u5 = await mkUser(); await onHeld(env, await mkPaidTask(u5, partner, null));
ok("PSP gave no fingerprint: no crash, no flag", (await flags()).length===1);

// repeat customer on their own card must never be flagged
await onHeld(env, await mkPaidTask(u4, partner, "fp_card_bbb"));
await onHeld(env, await mkPaidTask(u4, partner, "fp_card_bbb"));
ok("same customer paying repeatedly: never flagged", (await flags()).length===1);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
