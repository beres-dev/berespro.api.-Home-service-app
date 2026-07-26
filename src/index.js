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
import * as ACC from "./routes/account.js";
import * as ADDR from "./routes/addresses.js";
import * as TIMG from "./routes/taskimg.js";
import * as MED from "./routes/media.js";
import * as TIP from "./routes/tips.js";
import * as PR from "./routes/payreturn.js";
import * as D from "./routes/disputes.js";
import * as ADM from "./routes/admin.js";
import * as MSG from "./routes/messages.js";

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
  ["GET",  "/tasks/:taskId/messages", MSG.listMessages],
  ["POST", "/tasks/:taskId/messages", MSG.sendMessage],
  ["POST", "/tasks/:taskId/messages/read", MSG.markThreadRead],
  ["GET",  "/me/threads", MSG.listThreads],
  ["GET",  "/admin/threads/:taskId", MSG.adminGetThread],
  ["GET",  "/admin/coverage", ADM.getAdminCoverage],
  ["PATCH","/admin/coverage", ADM.patchAdminCoverage],
  ["GET",  "/admin/audit", ADM.listAudit],

  ["GET",  "/pay/return", PR.payReturn],
  ["GET",  "/jobs/:taskId/tip", TIP.getTip],
  ["POST", "/jobs/:taskId/tip", TIP.createTip],
  ["POST", "/me/licence", MED.uploadLicence],
  ["POST", "/me/avatar", MED.uploadAvatar],
  ["GET",  "/avatar/:userId", MED.serveAvatar],
  ["GET",  "/admin/licence/:userId", MED.adminGetLicence],
  ["POST", "/tasks/photo-upload", TIMG.uploadTaskPhoto],
  ["GET",  "/timg/:uid/:file", TIMG.serveTaskPhoto],
  ["GET",  "/me/addresses", ADDR.listAddresses],
  ["POST", "/me/addresses", ADDR.createAddress],
  ["DELETE","/me/addresses/:id", ADDR.deleteAddress],
  ["GET",  "/account/closure-check", ACC.closureCheck],
  ["POST", "/account/deactivate", ACC.deactivateAccount],
  ["POST", "/account/reactivate", ACC.reactivateAccount],
  ["DELETE","/account", ACC.deleteAccount],
  ["POST", "/kyc/upload", K.uploadKycDoc],
  ["GET",  "/kyc/doc/:kycId/:kind", K.getKycDoc],
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

    // Diagnostic: list the routes this deployment is really serving.
    // A deploy can succeed while one file is stale, and a 404 alone cannot tell
    // you whether the route is missing or its handler is. Open /routes in a
    // browser (plain GET, no console needed) to see both.
    if (path === "/routes") {
      return json({
        ok: true,
        count: ROUTES.length,
        // handler "MISSING" = route registered, but its module did not export the
        // function. That is the signature of a half-uploaded file.
        routes: ROUTES.map(([m, p, h]) => ({
          method: m,
          path: p,
          handler: typeof h === "function" ? "ok" : "MISSING",
        })),
      });
    }

    // ── production readiness check. Visit /health/config?key=<SETUP_KEY>.
    // Switching to production means four Clerk settings, an R2 bucket, a KV
    // namespace and the PSP keys all lining up at once; getting one wrong
    // produces a login failure that is near-impossible to diagnose from a
    // browser. This reports WHAT IS CONFIGURED, never a secret's value.
    if (path === "/health/config") {
      const key = url.searchParams.get("key") || "";
      if (!env.SETUP_KEY || key !== env.SETUP_KEY)
        return err("forbidden — pass ?key=<SETUP_KEY>", 403);

      const issuer = env.CLERK_ISSUER || null;   // public (appears in every JWT)
      const isDevClerk = !!issuer && /\.clerk\.accounts\.dev$/.test(issuer.replace(/^https?:\/\//, ""));
      const blockers = [];
      if (!issuer) blockers.push("CLERK_ISSUER not set — nobody can sign in");
      if (isDevClerk) blockers.push("CLERK_ISSUER is a Clerk DEV instance, not production");
      if (env.DEV_LOGIN === "1") blockers.push("DEV_LOGIN is ON — dev backdoors are reachable");
      if (!env.ADMIN_IDS) blockers.push("ADMIN_IDS not set — control panel is locked");
      if (!env.KYC_DOCS) blockers.push("R2 bucket KYC_DOCS not bound — KYC returns 503");
      if (!env.XENDIT_SECRET_KEY) blockers.push("XENDIT_SECRET_KEY not set — payments are SIMULATED, no real money moves");
      if (!env.XENDIT_CALLBACK_TOKEN) blockers.push("XENDIT_CALLBACK_TOKEN not set — real webhooks would be rejected");

      return json({
        production_ready: blockers.length === 0,
        blockers,
        auth:     { clerk_issuer: issuer, clerk_instance: isDevClerk ? "development" : (issuer ? "production" : null),
                    jwt_secret_set: !!env.JWT_SECRET, dev_login_enabled: env.DEV_LOGIN === "1" },
        storage:  { d1_bound: !!env.DB, kyc_r2_bound: !!env.KYC_DOCS, rate_limit_kv_bound: !!env.RL_KV },
        payments: { xendit_secret_set: !!env.XENDIT_SECRET_KEY, xendit_callback_token_set: !!env.XENDIT_CALLBACK_TOKEN,
                    split_rule_set: !!env.XENDIT_SPLIT_RULE_ID, mode: env.XENDIT_SECRET_KEY ? "live" : "simulation" },
        admin:    { admin_ids_set: !!env.ADMIN_IDS, admin_count: env.ADMIN_IDS ? env.ADMIN_IDS.split(",").filter(Boolean).length : 0 },
        policy:   { require_kyc_to_bid: env.REQUIRE_KYC_TO_BID === "1", commission_bps: env.COMMISSION_BPS || null },
      });
    }

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

    // Deactivated accounts: default DENY, explicit allow. An allowlist fails
    // safe — a new route is blocked until someone deliberately opens it —
    // whereas a per-route check fails open the first time one is forgotten.
    const DEACTIVATED_OK = new Set([
      "GET /me", "GET /account/closure-check",
      "POST /account/reactivate", "DELETE /account",
      "POST /auth/session", "POST /auth/refresh",
    ]);
    if (!DEACTIVATED_OK.has(`${req.method} ${path}`)) {
      const { requireUser } = await import("./lib/auth.js");
      const u = await requireUser(req, env).catch(() => null);
      if (u && u.deactivated_at) {
        return err("your account is deactivated — reactivate it to continue", 403, "account_deactivated");
      }
    }
    try { return await m.handler(req, env, m.params); }
    catch (e) {
      // Never leak internal exception text to the client (it can reveal table
      // names, SQL, or config). Log it for `wrangler tail`; return an opaque id.
      const ref = (crypto.randomUUID && crypto.randomUUID().slice(0, 8)) || String(Date.now());
      console.error("unhandled", ref, req.method, path, e && (e.stack || e.message));
      return err("internal error (ref " + ref + ")", 500);
    }
  },
};
