// src/index.js — Berespro API (Cloudflare Worker). Escrow model (PSP-held funds).
import { json, err, cors } from "./lib/util.js";
import SCHEMA_SQL from "./schema_sql.js";
import * as A from "./routes/auth.js";
import * as T from "./routes/tasks.js";
import * as B from "./routes/bids.js";
import * as J from "./routes/jobs.js";
import * as PAY from "./routes/payments.js";
import * as P from "./routes/partners.js";
import * as N from "./routes/notifications.js";
import * as K from "./routes/kyc.js";
import * as D from "./routes/disputes.js";
import * as ADM from "./routes/admin.js";

const ROUTES = [
  ["POST", "/auth/session", A.postSession],
  ["POST", "/auth/dev-login", A.devLogin],
  ["POST", "/auth/refresh", A.postRefresh],
  ["GET",  "/me", A.getMe],
  ["PATCH","/me", A.patchMe],

  ["POST", "/tasks", T.createTask],
  ["GET",  "/tasks", T.feedTasks],
  ["GET",  "/me/tasks", T.myTasks],
  ["GET",  "/tasks/:id", T.getTask],
  ["PATCH","/tasks/:id", T.patchTask],
  ["POST", "/tasks/:id/bids", B.placeBid],

  ["POST", "/bids/:id/accept", B.acceptBid],
  ["POST", "/bids/:id/decline", B.declineBid],
  ["GET",  "/me/bids", B.myBids],
  ["POST", "/vouchers/preview", B.previewVoucher],

  ["POST", "/jobs/:taskId/complete", J.markComplete],
  ["POST", "/jobs/:taskId/confirm", J.confirmComplete],
  ["POST", "/jobs/:taskId/cancel", J.cancelJob],
  ["POST", "/tasks/:id/cancel", J.cancelOpenTask],
  ["POST", "/jobs/:taskId/partner-cancel", J.partnerCancelJob],
  ["DELETE", "/bids/:id", J.withdrawBid],
  ["POST", "/jobs/:taskId/review", J.postReview],

  ["GET",  "/payments/:id", PAY.getPayment],
  ["GET",  "/me/earnings", PAY.myEarnings],
  ["GET",  "/dev/simulate-pay", PAY.devSimulatePay],
  ["POST", "/webhooks/psp", PAY.pspWebhook],

  ["POST", "/partners/connect", P.connectPayout],
  ["GET",  "/me/payout", P.payoutStatus],
  ["GET",  "/partners/:id", P.getPartner],
  ["POST", "/partners/:id/verify", P.verifyPartner],

  ["GET",  "/admin/stats", ADM.stats],
  ["GET",  "/admin/users", ADM.listUsers],
  ["POST", "/admin/users/:id/suspend", ADM.suspendUser],
  ["GET",  "/admin/tasks", ADM.listTasks],
  ["GET",  "/admin/payments", ADM.listPayments],
  ["POST", "/admin/payments/:id/release", ADM.adminRelease],
  ["POST", "/admin/payments/:id/refund", ADM.adminRefund],
  ["GET",  "/admin/vouchers", ADM.listVouchers],
  ["POST", "/admin/vouchers", ADM.createVoucher],
  ["PATCH","/admin/vouchers/:id", ADM.patchVoucher],
  ["GET",  "/admin/settings", ADM.getAdminSettings],
  ["PATCH","/admin/settings", ADM.patchAdminSettings],
  ["GET",  "/admin/audit", ADM.listAudit],

  ["POST", "/kyc/submit", K.submitKyc],
  ["GET",  "/me/kyc", K.myKyc],
  ["GET",  "/kyc/pending", K.pendingKyc],
  ["POST", "/kyc/:id/review", K.reviewKyc],

  ["POST", "/jobs/:taskId/dispute", D.openDispute],
  ["GET",  "/disputes/open", D.openDisputes],
  ["POST", "/disputes/:id/resolve", D.resolveDispute],

  ["POST", "/me/devices", N.registerDevice],
  ["GET",  "/me/notifications", N.listNotifs],
  ["POST", "/notifications/read", N.markRead],
];

function match(method, path) {
  for (const [m, pattern, handler] of ROUTES) {
    if (m !== method) continue;
    const pk = pattern.split("/"), pp = path.split("/");
    if (pk.length !== pp.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < pk.length; i++) {
      if (pk[i].startsWith(":")) params[pk[i].slice(1)] = decodeURIComponent(pp[i]);
      else if (pk[i] !== pp[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || path === "/health") return json({ ok: true, service: "berespro-api" });

    // ── one-time DB setup: initialise all tables. Safe to run again (IF NOT EXISTS).
    // Visit https://<worker-url>/setup?key=<SETUP_KEY> once after first deploy.
    if (path === "/setup") {
      const key = url.searchParams.get("key") || "";
      if (!env.SETUP_KEY || key !== env.SETUP_KEY) return err("forbidden — set SETUP_KEY and pass ?key=", 403);
      const stmts = SCHEMA_SQL.split(/;\s*\n/).map(x=>x.trim())
        // drop empty chunks AND chunks that are comment-only (no real SQL keyword left
        // after stripping "-- ..." lines), e.g. trailing notes at the end of schema.sql.
        .filter(x => x && x.replace(/^--.*$/gm, "").trim().length > 0);
      let applied = 0, skipped = 0;
      const errors = [];
      for (const st of stmts) {
        try { await env.DB.prepare(st).run(); applied++; }
        catch (e) {
          const msg = (e && e.message) || "";
          // Re-running /setup after adding a column or table is expected and safe.
          // "duplicate column" (ALTER TABLE ADD COLUMN) and "already exists" (CREATE
          // TABLE/INDEX phrasing variants) mean the schema is already at this
          // statement — skip it, don't fail the whole run.
          if (/duplicate column|already exists/i.test(msg)) { skipped++; }
          else { errors.push({ statement: st.slice(0, 80), error: msg }); }
        }
      }
      if (errors.length) return err("setup had real failures: " + JSON.stringify(errors), 500);
      return json({ ok: true, applied, skipped, total: stmts.length });
    }

    // ── whoami: returns your user id so you can set yourself as ADMIN_IDS.
    // Call with your session token (Authorization: Bearer <token>) after signing in.
    if (path === "/whoami") {
      const { requireUser } = await import("./lib/auth.js");
      const u = await requireUser(req, env);
      if (!u) return err("sign in first, then call /whoami with your token", 401);
      return json({ user_id: u.id, name: u.name, email: u.email, is_admin: !!(env.ADMIN_IDS && env.ADMIN_IDS.split(",").includes(u.id)) });
    }

    const m = match(req.method, path);
    if (!m) return err("not found", 404);
    try { return await m.handler(req, env, m.params); }
    catch (e) { return err("internal error: " + (e && e.message), 500); }
  },
};
