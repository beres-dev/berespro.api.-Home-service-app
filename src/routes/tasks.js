// src/routes/tasks.js
import { json, err, id, now, haversineKm, readBody } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { rateLimit, vint, vstr, vnum, LIMITS } from "../lib/guard.js";
import { getSettings } from "../lib/settings.js";

// POST /tasks  (customer)
export async function createTask(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  if (!(await rateLimit(env, `tasks:${user.id}:day`, LIMITS.TASKS_PER_DAY, 86400)))
    return err("daily task limit reached", 429);
  const openCount = await env.DB.prepare(
    "SELECT COUNT(*) n FROM tasks WHERE customer_id=? AND status='open'").bind(user.id).first();
  if (openCount.n >= LIMITS.OPEN_TASKS_MAX)
    return err(`maximum ${LIMITS.OPEN_TASKS_MAX} open tasks`, 429);

  const b = await readBody(req);
  b.title = vstr(b.title, LIMITS.TITLE_MAX);
  b.category = vstr(b.category, 30);
  b.city = vstr(b.city, 60);
  b.lat = vnum(b.lat, -90, 90); b.lng = vnum(b.lng, -180, 180);
  b.budget_cents = vint(b.budget_cents, LIMITS.BUDGET_MIN, LIMITS.BUDGET_MAX);
  if (b.description) b.description = vstr(b.description, LIMITS.DESC_MAX);
  for (const f of ["title", "category", "city", "lat", "lng", "budget_cents"]) {
    if (b[f] === undefined || b[f] === null || b[f] === "") return err(`${f} invalid or missing`, 400);
  }
  const tid = id("tsk");
  await env.DB.prepare(
    "INSERT INTO tasks (id,customer_id,title,category,city,addr,lat,lng,budget_cents,date_label,time_slot,description,status,created_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?)"
  ).bind(tid, user.id, b.title, b.category, b.city, b.addr || null, b.lat, b.lng,
         b.budget_cents, b.date_label || null, b.time_slot || null, b.description || null, now()).run();
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(tid).first();
  return json({ task: shapeTask(task) }, 201);
}

// GET /tasks?lat=&lng=&radius=&cat=&sort=   (partner feed, open tasks only)
export async function feedTasks(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const u = new URL(req.url);
  const lat = parseFloat(u.searchParams.get("lat")) || user.lat;
  const lng = parseFloat(u.searchParams.get("lng")) || user.lng;
  const radius = Math.min(parseFloat(u.searchParams.get("radius")) || 15, 50);
  const cat = u.searchParams.get("cat");
  const sort = u.searchParams.get("sort") || "nearest";

  // bounding-box prefilter in SQL (fast, uses index), exact haversine in JS
  const dLat = radius / 111;
  const dLng = radius / (111 * Math.cos((lat * Math.PI) / 180) || 1);
  let sql = "SELECT * FROM tasks WHERE status='open' AND customer_id != ? " +
            "AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?";
  const args = [user.id, lat - dLat, lat + dLat, lng - dLng, lng + dLng];
  if (cat && cat !== "all") { sql += " AND category = ?"; args.push(cat); }
  sql += " LIMIT 300";
  const { results } = await env.DB.prepare(sql).bind(...args).all();

  let tasks = results
    .map((t) => ({ ...shapeTask(t), distance_km: +haversineKm(lat, lng, t.lat, t.lng).toFixed(1) }))
    .filter((t) => t.distance_km <= radius);
  if (sort === "recommended") {
    // tunable score: closeness + freshness + budget attractiveness (weights from admin settings)
    const S = await getSettings(env);
    const wD = +S.algo_w_distance || 50, wR = +S.algo_w_recency || 30, wB = +S.algo_w_budget || 20;
    const tNow = Math.floor(Date.now() / 1000);
    const maxBudget = Math.max(...tasks.map(t => t.budget_cents), 1);
    for (const t of tasks) {
      const closeness = 1 - Math.min(t.distance_km / radius, 1);          // 1 near .. 0 edge
      const freshness = Math.max(0, 1 - (tNow - t.created_at) / (7 * 86400)); // decays over 7d
      const budgetAtt = t.budget_cents / maxBudget;
      t.score = +(wD * closeness + wR * freshness + wB * budgetAtt).toFixed(2);
    }
    tasks.sort((a, b) => b.score - a.score);
  } else {
    tasks.sort((a, b) => sort === "budget" ? b.budget_cents - a.budget_cents : a.distance_km - b.distance_km);
  }

  // attach bid counts + customer display name
  for (const t of tasks) {
    const c = await env.DB.prepare("SELECT COUNT(*) n FROM bids WHERE task_id = ?").bind(t.id).first();
    t.bid_count = c.n;
    const mine = await env.DB.prepare("SELECT id FROM bids WHERE task_id=? AND partner_id=?")
      .bind(t.id, user.id).first();
    t.my_bid = !!mine;
    const cu = await env.DB.prepare("SELECT name FROM users WHERE id=?").bind(t.customer_id).first();
    t.customer_name = cu ? cu.name : "Customer";
  }
  return json({ tasks });
}

// GET /tasks/:id
export async function getTask(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(params.id).first();
  if (!task) return err("not found", 404);
  const shaped = shapeTask(task);
  // include bids if the caller is the owner
  if (task.customer_id === user.id) {
    const { results } = await env.DB.prepare(
      "SELECT b.*, u.name pname, u.avatar_hue phue, u.id_verified pverified " +
      "FROM bids b JOIN users u ON u.id=b.partner_id WHERE b.task_id=? ORDER BY b.created_at"
    ).bind(task.id).all();
    shaped.bids = results.map(shapeBidRow);
  }
  return json({ task: shaped });
}

// PATCH /tasks/:id  (owner: cancel or edit while open)
export async function patchTask(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(params.id).first();
  if (!task) return err("not found", 404);
  if (task.customer_id !== user.id) return err("forbidden", 403);
  const b = await readBody(req);
  if (b.status === "cancelled" && task.status === "open") {
    await env.DB.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").bind(task.id).run();
    return json({ ok: true });
  }
  return err("no editable change", 400);
}

// GET /me/tasks  (customer's own)
export async function myTasks(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const { results } = await env.DB.prepare(
    "SELECT * FROM tasks WHERE customer_id=? ORDER BY created_at DESC"
  ).bind(user.id).all();
  const tasks = [];
  for (const t of results) {
    const s = shapeTask(t);
    const c = await env.DB.prepare("SELECT COUNT(*) n FROM bids WHERE task_id=?").bind(t.id).first();
    s.bid_count = c.n;
    tasks.push(s);
  }
  return json({ tasks });
}

// ---------- shapers ----------
export function shapeTask(t) {
  return {
    id: t.id, customer_id: t.customer_id, title: t.title, category: t.category,
    city: t.city, addr: t.addr, lat: t.lat, lng: t.lng,
    budget_cents: t.budget_cents, date_label: t.date_label, time_slot: t.time_slot,
    description: t.description, status: t.status, accepted_bid_id: t.accepted_bid_id,
    created_at: t.created_at,
  };
}
export function shapeBidRow(b) {
  return {
    id: b.id, task_id: b.task_id, amount_cents: b.amount_cents, message: b.message,
    status: b.status, created_at: b.created_at,
    partner: { id: b.partner_id, name: b.pname, avatar_hue: b.phue, id_verified: !!b.pverified },
  };
}
