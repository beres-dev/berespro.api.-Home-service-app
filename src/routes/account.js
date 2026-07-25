// src/routes/account.js — the user's own exit door.
//
// WHY THIS EXISTS: PDPA gives people rights over their personal data, and we
// hold their name, phone, email, location and IC photographs. Without this,
// there is no lawful way for them to leave. (App stores also require in-app
// account deletion once you allow in-app sign-up.)
//
// WHY IT IS NOT "DELETE FROM users": this is a marketplace holding money.
//   - a partner may have RM800 sitting in escrow on an unfinished job
//   - a customer may have an open dispute
//   - payment rows are ACCOUNTING records (Malaysia: keep 7 years)
//   - reviews they wrote are part of another person's reputation
// So closure is two tiers, and both are REFUSED while money or a dispute is
// live — otherwise "delete my account" becomes the way to escape a dispute.
//
//   DEACTIVATE  reversible. Hidden from feeds, cannot bid/post/message,
//               sessions killed. Nothing is destroyed.
//   DELETE      irreversible. Identity is ANONYMISED and IC photos are purged
//               from R2. Financial rows survive, pointing at a nameless user.

import { json, err, now, readBody } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { vstr, audit } from "../lib/guard.js";
import { createNotif } from "./bids.js";
import { deleteDocs } from "../lib/docs.js";

// What is stopping this account from closing right now? Returns [] when clear.
// Two queries per side rather than one with OR: an OR across columns makes
// SQLite drop the index, and it keeps each check independently testable.
export async function closureBlockers(env, userId) {
  const blockers = [];

  const asCustomer = await env.DB.prepare(
    "SELECT id, task_id FROM payments WHERE status='held' AND customer_id=?").bind(userId).all();
  const asPartner = await env.DB.prepare(
    "SELECT id, task_id FROM payments WHERE status='held' AND partner_id=?").bind(userId).all();
  const held = [...(asCustomer.results || []), ...(asPartner.results || [])];
  if (held.length) {
    blockers.push({
      code: "money_in_escrow",
      message: `${held.length} job${held.length > 1 ? "s have" : " has"} money still held. ` +
               `Finish or cancel ${held.length > 1 ? "them" : "it"} first.`,
      tasks: held.map((h) => h.task_id),
    });
  }

  // Open disputes on any task this person is a party to.
  const { results: openD } = await env.DB.prepare(
    "SELECT id, task_id FROM disputes WHERE status='open' LIMIT 200").all();
  if (openD.length) {
    const mine = [];
    for (const d of openD) {
      const t = await env.DB.prepare(
        "SELECT customer_id, accepted_bid_id FROM tasks WHERE id=?").bind(d.task_id).first();
      if (!t) continue;
      if (t.customer_id === userId) { mine.push(d.task_id); continue; }
      if (t.accepted_bid_id) {
        const b = await env.DB.prepare("SELECT partner_id FROM bids WHERE id=?")
          .bind(t.accepted_bid_id).first();
        if (b && b.partner_id === userId) mine.push(d.task_id);
      }
    }
    if (mine.length) {
      blockers.push({
        code: "open_dispute",
        message: `You have ${mine.length} open dispute${mine.length > 1 ? "s" : ""}. ` +
                 `Support must resolve ${mine.length > 1 ? "them" : "it"} before you can close your account.`,
        tasks: mine,
      });
    }
  }
  return blockers;
}

// Tidy up what would otherwise be left hanging for OTHER people: partners
// waiting on your open tasks, customers waiting on your bids.
async function releaseOthers(env, userId) {
  const { results: openTasks } = await env.DB.prepare(
    "SELECT id, title FROM tasks WHERE customer_id=? AND status='open'").bind(userId).all();
  for (const t of openTasks) {
    const { results: bidders } = await env.DB.prepare(
      "SELECT partner_id FROM bids WHERE task_id=? AND status='pending'").bind(t.id).all();
    await env.DB.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").bind(t.id).run();
    for (const b of bidders) {
      try {
        await createNotif(env, b.partner_id, "job", "Task withdrawn",
          `${t.title} — the customer closed their account.`);
      } catch (_) {}
    }
  }
  // Their own pending bids simply go away; nobody is left waiting on them.
  await env.DB.prepare("UPDATE bids SET status='withdrawn' WHERE partner_id=? AND status='pending'")
    .bind(userId).run();
  return openTasks.length;
}

async function killSessions(env, userId) {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId).run();
  await env.DB.prepare("DELETE FROM devices WHERE user_id=?").bind(userId).run();
}

// GET /account/closure-check — let the app show the real reason BEFORE the user
// commits to anything, instead of a refusal after they have typed DELETE.
export async function closureCheck(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const blockers = await closureBlockers(env, user.id);
  return json({ can_close: blockers.length === 0, blockers });
}

// POST /account/deactivate  body: { reason? }
export async function deactivateAccount(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (user.deactivated_at) return json({ ok: true, status: "deactivated" });

  const blockers = await closureBlockers(env, user.id);
  if (blockers.length) return err(blockers[0].message, 409, blockers[0].code);

  const b = await readBody(req).catch(() => ({}));
  const cancelled = await releaseOthers(env, user.id);
  await env.DB.prepare("UPDATE users SET deactivated_at=? WHERE id=?").bind(now(), user.id).run();
  await killSessions(env, user.id);
  await audit(env, user.id, "account.deactivate", user.id,
    { reason: vstr(b.reason || "", 300) || null, tasks_cancelled: cancelled });
  return json({ ok: true, status: "deactivated", tasks_cancelled: cancelled });
}

// POST /account/reactivate — the whole point of deactivation being reversible.
export async function reactivateAccount(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (user.deleted_at) return err("this account was deleted and cannot be restored", 410, "account_deleted");
  await env.DB.prepare("UPDATE users SET deactivated_at=NULL WHERE id=?").bind(user.id).run();
  await audit(env, user.id, "account.reactivate", user.id, {});
  return json({ ok: true, status: "active" });
}

// DELETE /account   body: { confirm: "DELETE" }
// Irreversible. Anonymises the person; keeps the money trail.
export async function deleteAccount(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const b = await readBody(req).catch(() => ({}));
  // Deliberate friction: this cannot be reached by a stray tap.
  if (b.confirm !== "DELETE")
    return err('send confirm:"DELETE" to permanently delete your account', 400, "confirm_required");

  const blockers = await closureBlockers(env, user.id);
  if (blockers.length) return err(blockers[0].message, 409, blockers[0].code);

  await releaseOthers(env, user.id);

  // Purge the most sensitive thing we hold: the identity documents.
  const { results: subs } = await env.DB.prepare(
    "SELECT id, doc_front_url, doc_back_url, selfie_url FROM kyc_submissions WHERE user_id=?"
  ).bind(user.id).all();
  for (const s of subs) {
    await deleteDocs(env, [s.doc_front_url, s.doc_back_url, s.selfie_url]);
  }
  // The KYC rows themselves carry a name and IC last-4 — strip them too. The
  // row stays so the approval decision remains auditable.
  await env.DB.prepare(
    "UPDATE kyc_submissions SET full_name='Deleted user', ic_last4='0000', " +
    "doc_front_url='', doc_back_url=NULL, selfie_url='' WHERE user_id=?"
  ).bind(user.id).run();

  // Anonymise the identity. firebase_uid is cleared so that signing in with the
  // same Google account creates a FRESH user rather than resurrecting this one.
  // suspended=1 is belt-and-braces: any token still in flight stops working.
  const ts = now();
  await env.DB.prepare(
    "UPDATE users SET name='Deleted user', phone=NULL, email=NULL, firebase_uid=?, " +
    "skills='[]', lat=NULL, lng=NULL, city=NULL, id_verified=0, suspended=1, " +
    "deleted_at=?, deactivated_at=? WHERE id=?"
  ).bind("deleted_" + user.id, ts, ts, user.id).run();
  await killSessions(env, user.id);

  // The audit entry must not re-record what we just erased.
  await audit(env, user.id, "account.delete", user.id, { kyc_docs_purged: subs.length });
  return json({ ok: true, status: "deleted" });
}
