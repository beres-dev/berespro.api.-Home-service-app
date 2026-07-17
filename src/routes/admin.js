// src/routes/admin.js — control panel backend: stats, users, payments, vouchers, settings, audit.
import { json, err, id, now, readBody } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { vstr, vint, audit } from "../lib/guard.js";
import { getSettings, setSetting, invalidateSettingsCache } from "../lib/settings.js";
import { MALAYSIA } from "../lib/geo.js";
import { getCoverageMap, isActiveIn, setCoverage, clearCoverage, KEY_STATE, KEY_DISTRICT } from "../lib/coverage.js";
import { captureForTask, refundForTask } from "./payments.js";
import { createNotif } from "./bids.js";

export async function requireAdmin(req, env) {
  const u = await requireUser(req, env);
  if (!u) return null;
  if (!env.ADMIN_IDS || !env.ADMIN_IDS.split(",").includes(u.id)) return null;
  return u;
}
const deny = () => err("admin only", 403);

// GET /admin/stats — KPI overview
export async function stats(req, env) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const q1 = await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE mode='customer'").first();
  const q2 = await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE mode='partner'").first();
  const tOpen = await env.DB.prepare("SELECT COUNT(*) n FROM tasks WHERE status='open'").first();
  const tProg = await env.DB.prepare("SELECT COUNT(*) n FROM tasks WHERE status='inprogress'").first();
  const tDone = await env.DB.prepare("SELECT COUNT(*) n FROM tasks WHERE status='completed'").first();
  const held = await env.DB.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount_cents-discount_cents),0) s FROM payments WHERE status='held'").first();
  const cap  = await env.DB.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) gmv, COALESCE(SUM(fee_cents-discount_cents),0) rev, COALESCE(SUM(discount_cents),0) disc FROM payments WHERE status='captured'").first();
  const kyc = await env.DB.prepare("SELECT COUNT(*) n FROM kyc_submissions WHERE status='pending'").first();
  const dsp = await env.DB.prepare("SELECT COUNT(*) n FROM disputes WHERE status='open'").first();
  return json({ stats: {
    customers: q1.n, partners: q2.n,
    tasks: { open: tOpen.n, inprogress: tProg.n, completed: tDone.n },
    held: { count: held.n, sum_cents: held.s },
    captured: { count: cap.n, gmv_cents: cap.gmv, revenue_cents: cap.rev, discounts_cents: cap.disc },
    kyc_pending: kyc.n, disputes_open: dsp.n,
  }});
}

// GET /admin/users?mode=&q=
export async function listUsers(req, env) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const u = new URL(req.url);
  const mode = u.searchParams.get("mode");
  let sql = "SELECT id,name,phone,email,mode,city,id_verified,suspended,created_at FROM users";
  const args = [];
  if (mode === "customer" || mode === "partner") { sql += " WHERE mode=?"; args.push(mode); }
  sql += " ORDER BY created_at DESC LIMIT 200";
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  const q = (u.searchParams.get("q") || "").toLowerCase();
  const users = q ? results.filter(r =>
    (r.name||"").toLowerCase().includes(q) || (r.phone||"").includes(q) || (r.email||"").toLowerCase().includes(q)
  ) : results;
  return json({ users });
}

// POST /admin/users/:id/suspend  body: { suspend: true|false, reason? }
export async function suspendUser(req, env, params) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const target = await env.DB.prepare("SELECT id,name FROM users WHERE id=?").bind(params.id).first();
  if (!target) return err("not found", 404);
  const b = await readBody(req);
  const flag = b.suspend ? 1 : 0;
  await env.DB.prepare("UPDATE users SET suspended=? WHERE id=?").bind(flag, target.id).run();
  await audit(env, admin.id, flag ? "user.suspend" : "user.unsuspend", target.id,
              { reason: vstr(b.reason || "", 300) || null });
  if (flag) await createNotif(env, target.id, "job", "Account suspended",
    b.reason || "Contact support for details.");
  return json({ ok: true, suspended: !!flag });
}

// GET /admin/tasks?status=   (includes lat/lng for the map)
export async function listTasks(req, env) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const st = new URL(req.url).searchParams.get("status");
  let sql = "SELECT t.*, u.name customer_name FROM tasks t JOIN users u ON u.id=t.customer_id";
  const args = [];
  if (st) { sql += " WHERE t.status=?"; args.push(st); }
  sql += " ORDER BY t.created_at DESC LIMIT 300";
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json({ tasks: results });
}

// GET /admin/payments?status=
export async function listPayments(req, env) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const st = new URL(req.url).searchParams.get("status");
  let sql = "SELECT p.*, t.title FROM payments p JOIN tasks t ON t.id=p.task_id";
  const args = [];
  if (st) { sql += " WHERE p.status=?"; args.push(st); }
  sql += " ORDER BY p.created_at DESC LIMIT 300";
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json({ payments: results });
}

// POST /admin/payments/:id/release  — manual capture (e.g. customer unresponsive after job done)
export async function adminRelease(req, env, params) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const p = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(params.id).first();
  if (!p) return err("not found", 404);
  if (p.status !== "held") return err("payment is not held", 409);
  const open = await env.DB.prepare("SELECT id FROM disputes WHERE task_id=? AND status='open'").bind(p.task_id).first();
  if (open) return err("resolve the open dispute instead", 409, "dispute_open");
  const cap = await captureForTask(env, p.task_id);
  if (!cap.ok) return err("release failed: " + cap.reason, 409);
  await env.DB.prepare("UPDATE tasks SET status='completed' WHERE id=?").bind(p.task_id).run();
  await audit(env, admin.id, "admin.payment.release", p.id, { task: p.task_id, note: (await readBody(req)).note || null });
  return json({ ok: true });
}

// POST /admin/payments/:id/refund — manual refund of a held payment
export async function adminRefund(req, env, params) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const p = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(params.id).first();
  if (!p) return err("not found", 404);
  if (p.status !== "held") return err("payment is not held", 409);
  const open = await env.DB.prepare("SELECT id FROM disputes WHERE task_id=? AND status='open'").bind(p.task_id).first();
  if (open) return err("resolve the open dispute instead", 409, "dispute_open");
  await refundForTask(env, p.task_id);
  await env.DB.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").bind(p.task_id).run();
  await audit(env, admin.id, "admin.payment.refund", p.id, { task: p.task_id, note: (await readBody(req)).note || null });
  return json({ ok: true });
}

// ---------- vouchers ----------
// GET /admin/vouchers
export async function listVouchers(req, env) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const { results } = await env.DB.prepare("SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 200").all();
  for (const v of results) {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) n, COALESCE(SUM(discount_cents),0) s FROM voucher_redemptions WHERE voucher_id=?"
    ).bind(v.id).first();
    v.redemptions = r.n; v.discount_total_cents = r.s;
  }
  return json({ vouchers: results });
}

// POST /admin/vouchers  body: { code, type, value, min_amount_cents?, max_discount_cents?, usage_limit?, per_user_limit?, expires_at? }
export async function createVoucher(req, env) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const b = await readBody(req);
  const code = vstr((b.code || "").toUpperCase(), 20, 3);
  if (!code || !/^[A-Z0-9]+$/.test(code)) return err("code: 3-20 chars A-Z 0-9", 400);
  if (b.type !== "percent" && b.type !== "fixed") return err("type: percent|fixed", 400);
  const value = b.type === "percent" ? vint(b.value, 100, 10000) : vint(b.value, 100, 1_000_000);
  if (!value) return err("value out of range (percent: 100-10000 bps, fixed: 100-1000000 cents)", 400);
  const vid = id("vch");
  try {
    await env.DB.prepare(
      "INSERT INTO vouchers (id,code,type,value,min_amount_cents,max_discount_cents,usage_limit,per_user_limit,expires_at,active,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,1,?)"
    ).bind(vid, code, b.type, value,
           vint(b.min_amount_cents, 0, 10_000_000) || 0,
           b.max_discount_cents != null ? vint(b.max_discount_cents, 100, 1_000_000) : null,
           b.usage_limit != null ? vint(b.usage_limit, 1, 1_000_000) : null,
           vint(b.per_user_limit, 1, 100) || 1,
           b.expires_at != null ? vint(b.expires_at, now(), now() + 5 * 365 * 86400) : null,
           now()).run();
  } catch { return err("code already exists", 409); }
  await audit(env, admin.id, "voucher.create", vid, { code, type: b.type, value });
  return json({ voucher_id: vid, code }, 201);
}

// PATCH /admin/vouchers/:id  body: { active }
export async function patchVoucher(req, env, params) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const v = await env.DB.prepare("SELECT id FROM vouchers WHERE id=?").bind(params.id).first();
  if (!v) return err("not found", 404);
  const b = await readBody(req);
  await env.DB.prepare("UPDATE vouchers SET active=? WHERE id=?").bind(b.active ? 1 : 0, v.id).run();
  await audit(env, admin.id, "voucher.toggle", v.id, { active: !!b.active });
  return json({ ok: true });
}

// ---------- settings (algorithm & commission) ----------
export async function getAdminSettings(req, env) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  return json({ settings: await getSettings(env) });
}
export async function patchAdminSettings(req, env) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const b = await readBody(req);
  const ALLOWED = ["algo_w_distance", "algo_w_recency", "algo_w_budget", "commission_bps",
                   "cancel_grace_min", "cancel_fee_bps"];
  const CAPS = { commission_bps: 5000, cancel_fee_bps: 5000, cancel_grace_min: 1440 };
  const applied = {};
  for (const k of ALLOWED) {
    if (b[k] === undefined) continue;
    const v = vint(b[k], 0, CAPS[k] || 100);
    if (v === null) return err(`${k} out of range`, 400);
    await setSetting(env, k, v);
    applied[k] = v;
  }
  // Dynamic override keys: commission_partner_<userId> / commission_cat_<category>.
  // Value null/"" clears an override. Capped like the default; whitelisted by
  // PREFIX so an admin cannot write arbitrary settings keys through this route.
  for (const k of Object.keys(b)) {
    if (!k.startsWith("commission_partner_") && !k.startsWith("commission_cat_")) continue;
    if (k.length > 80) return err("override key too long", 400);
    if (b[k] === null || b[k] === "") {
      await env.DB.prepare("DELETE FROM settings WHERE s_key=?").bind(k).run();
      invalidateSettingsCache();
      applied[k] = null;
      continue;
    }
    const v = vint(b[k], 0, 5000);
    if (v === null) return err(`${k} out of range (0-5000 bps)`, 400);
    if (k.startsWith("commission_partner_")) {
      const uid = k.slice("commission_partner_".length);
      const u = await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(uid).first();
      if (!u) return err("no such partner: " + uid, 404);
    }
    await setSetting(env, k, v);
    applied[k] = v;
  }
  await audit(env, admin.id, "settings.update", null, applied);
  return json({ ok: true, applied });
}

// ---------- coverage (which states/districts are open) ----------
// GET /admin/coverage -> full Malaysia tree with the effective on/off state,
// plus a live task count per district so the admin can see what closing an area
// would affect. Exceptions only are stored; everything else is active.
export async function getAdminCoverage(req, env) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const map = await getCoverageMap(env);
  const { results: counts } = await env.DB.prepare(
    "SELECT state, district, COUNT(*) n FROM tasks WHERE status IN ('open','inprogress') " +
    "AND state IS NOT NULL GROUP BY state, district").all();
  const byKey = {};
  for (const c of counts) byKey[`${c.state}|${c.district}`] = c.n;

  const states = MALAYSIA.map((s) => {
    const districts = s.districts.map(([district]) => ({
      district,
      active: isActiveIn(map, s.state, district),
      explicit: map[KEY_DISTRICT(s.state, district)] !== undefined,
      live_tasks: byKey[`${s.state}|${district}`] || 0,
    }));
    return {
      state: s.state,
      active: map[KEY_STATE(s.state)] !== undefined ? map[KEY_STATE(s.state)] : true,
      explicit: map[KEY_STATE(s.state)] !== undefined,
      districts,
      live_tasks: districts.reduce((n, d) => n + d.live_tasks, 0),
    };
  });
  return json({ states });
}

// PATCH /admin/coverage  body: { scope, active }  scope: "state:X" | "district:X|Y"
//   active: true | false | null (null clears the exception -> back to default)
export async function patchAdminCoverage(req, env) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const b = await readBody(req);
  const scope = vstr(b.scope || "", 120);
  if (!scope) return err("scope required", 400);

  // Validate the scope against the real geography: an admin must not be able to
  // write rows for places that do not exist (they would be invisible dead data).
  const mState = scope.match(/^state:(.+)$/);
  const mDist = scope.match(/^district:([^|]+)\|(.+)$/);
  if (mState) {
    if (!MALAYSIA.some((s) => s.state === mState[1])) return err("unknown state", 404);
  } else if (mDist) {
    const st = MALAYSIA.find((s) => s.state === mDist[1]);
    if (!st || !st.districts.some(([d]) => d === mDist[2])) return err("unknown district", 404);
  } else {
    return err("scope must be state:<State> or district:<State>|<District>", 400);
  }

  if (b.active === null) {
    await clearCoverage(env, scope);
    await audit(env, admin.id, "coverage.clear", scope, {});
    return json({ ok: true, scope, active: null });
  }
  if (typeof b.active !== "boolean") return err("active must be true, false, or null", 400);
  await setCoverage(env, scope, b.active);
  await audit(env, admin.id, "coverage.update", scope, { active: b.active });
  return json({ ok: true, scope, active: b.active });
}

// GET /admin/audit?limit=
export async function listAudit(req, env) {
  const admin = await requireAdmin(req, env); if (!admin) return deny();
  const lim = Math.min(parseInt(new URL(req.url).searchParams.get("limit") || "100", 10) || 100, 500);
  const { results } = await env.DB.prepare(
    "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT " + lim).all();
  return json({ audit: results });
}
