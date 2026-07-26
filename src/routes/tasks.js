// src/routes/tasks.js
import { json, err, id, now, haversineKm, readBody } from "../lib/util.js";
import { routeDistanceKm } from "../lib/routing.js";
import { resolveDistrict } from "../lib/geo.js";
import { isCovered } from "../lib/coverage.js";
import { requireUser } from "../lib/auth.js";
import { rateLimit, vint, vstr, vnum, LIMITS } from "../lib/guard.js";
import { getSettings } from "../lib/settings.js";
import { createNotif } from "./bids.js";
import { pushNotify } from "../lib/notify.js";

// POST /tasks  (customer)
// Delivery is about parcels and errands; moving is about furniture and a lorry.
// Keeping the lists separate stops someone booking a lorry to send documents,
// or a motorbike to shift a wardrobe.
export const VEHICLES_DELIVERY = ["motor", "car", "4x4", "van"];
export const VEHICLES_MOVING = ["lorry"];

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

  // ---- delivery stops (Moving/Delivery multi-drop, like Lalamove) ----
  // Each stop is a real place: address text AND a pin. route_km is computed
  // HERE, never trusted from the client — the price suggestion and what the
  // partner sees must come from the same arithmetic.
  // Vehicle only means anything on a delivery-style task; storing it on a
  // cleaning job would be noise that later code might wrongly price on.
  let vehicle = null;
  const cat = (b.category || "").toLowerCase();
  const isDelivery = cat === "delivery", isMoving = cat === "moving";
  if (isDelivery || isMoving) {
    const allowed = isMoving ? VEHICLES_MOVING : VEHICLES_DELIVERY;
    vehicle = (b.vehicle || allowed[0]).toLowerCase();
    if (!allowed.includes(vehicle))
      return err(`vehicle for ${cat} must be one of: ${allowed.join(", ")}`, 400, "bad_vehicle");
  }

  let stops = null, routeKm = null, routeMethod = null;
  if (Array.isArray(b.stops) && b.stops.length) {
    if (b.stops.length > 5) return err("maximum 5 delivery stops", 400);
    stops = [];
    for (const s of b.stops) {
      const sAddr = vstr(s && s.addr, 200);
      const sLat = vnum(s && s.lat, -90, 90);
      const sLng = vnum(s && s.lng, -180, 180);
      if (!sAddr || sLat == null || sLng == null)
        return err("each delivery stop needs an address and a map pin", 400, "bad_stop");
      stops.push({ addr: sAddr, lat: sLat, lng: sLng });
    }
    // Measured along real roads, not crow-flight — the partner rides roads and
    // is paid for roads. Falls back to a circuity estimate if the router is
    // unreachable; never to the raw straight line.
    const rd = await routeDistanceKm([[b.lat, b.lng], ...stops.map(s => [s.lat, s.lng])]);
    routeKm = rd.km; routeMethod = rd.method;
    if (routeKm > 400) return err("route is over 400 km — split this into separate tasks", 400);
  }

  // ---- photos (max 4). Keys must sit under the uploader's own prefix: the
  // upload route is what put them there, so a key outside taskimg/<me>/ is a
  // forgery attempt, not a mistake. ----
  let photos = null;
  if (Array.isArray(b.photo_keys) && b.photo_keys.length) {
    if (b.photo_keys.length > 4) return err("maximum 4 photos", 400);
    for (const k of b.photo_keys) {
      if (typeof k !== "string" || !k.startsWith(`taskimg/${user.id}/`) || k.includes(".."))
        return err("invalid photo reference", 400);
    }
    photos = b.photo_keys;
  }
  for (const f of ["title", "category", "city", "lat", "lng", "budget_cents"]) {
    if (b[f] === undefined || b[f] === null || b[f] === "") return err(`${f} invalid or missing`, 400);
  }
  // COVERAGE GATE: resolve the pin to a district and refuse to open new work
  // where we are not operating. This deliberately only blocks NEW tasks —
  // jobs already in progress are never touched by a coverage change.
  const area = resolveDistrict(b.lat, b.lng);
  if (!area) {
    return err("we don't operate at that location yet", 403, "area_not_covered");
  }
  if (!(await isCovered(env, area.state, area.district))) {
    return err(`Berespro is not open in ${area.district}, ${area.state} yet`, 403, "area_not_covered");
  }

  const tid = id("tsk");
  await env.DB.prepare(
    "INSERT INTO tasks (id,customer_id,title,category,city,addr,lat,lng,budget_cents,date_label,time_slot,description,status,created_at,state,district,stops,route_km,photos,vehicle,route_method) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?,?,?,?,?,?,?,?)"
  ).bind(tid, user.id, b.title, b.category, b.city, b.addr || null, b.lat, b.lng,
         b.budget_cents, b.date_label || null, b.time_slot || null, b.description || null, now(),
         area.state, area.district,
         stops ? JSON.stringify(stops) : null, routeKm, photos ? JSON.stringify(photos) : null,
         vehicle, routeMethod).run();
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(tid).first();

  // Tell nearby partners a job just appeared. Without this, partners have to keep
  // opening the app and checking, which is the difference between a marketplace
  // that moves and one that sits still. Best-effort: never fails the post.
  try { await notifyNearbyPartners(env, task, user.id); } catch (_) {}

  return json({ task: shapeTask(task) }, 201);
}

// Notify partners whose saved position is within NOTIFY_RADIUS_KM of a new task.
// Bounding-box prefilter in SQL (indexed), exact haversine in JS, hard cap on fan-out.
const NOTIFY_RADIUS_KM = 15;
const NOTIFY_MAX = 50;
async function notifyNearbyPartners(env, task, posterId) {
  const dLat = NOTIFY_RADIUS_KM / 111;
  const dLng = NOTIFY_RADIUS_KM / (111 * Math.cos((task.lat * Math.PI) / 180) || 1);
  const { results } = await env.DB.prepare(
    "SELECT id, lat, lng FROM users WHERE mode='partner' AND suspended=0 AND id != ? " +
    "AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? LIMIT 300"
  ).bind(posterId, task.lat - dLat, task.lat + dLat, task.lng - dLng, task.lng + dLng).all();

  const near = results
    .map((p) => ({ ...p, km: haversineKm(task.lat, task.lng, p.lat, p.lng) }))
    .filter((p) => p.km <= NOTIFY_RADIUS_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, NOTIFY_MAX);

  if (!near.length) return;
  const rm = (task.budget_cents / 100).toFixed(2);
  // One batched write for every nearby partner instead of a sequential loop.
  // In a dense area this turns up-to-NOTIFY_MAX round-trips into a single D1
  // call, and the customer's POST no longer waits on the whole fanout.
  const stmt = env.DB.prepare(
    "INSERT INTO notifications (id,user_id,type,title,body,read,created_at) VALUES (?,?,?,?,?,0,?)");
  const t = now();
  await env.DB.batch(near.map((p) => stmt.bind(
    id("ntf"), p.id, "job",
    `New job ${p.km < 1 ? "under 1" : p.km.toFixed(1)} km away`,
    `${task.title} \u00b7 RM ${rm}`, t)));
  // Push is best-effort and must never delay or fail the post.
  for (const p of near) { try { pushNotify(env, p.id, "New job near you", `${task.title} \u00b7 RM ${rm}`); } catch (_) {} }
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

  // attach bid counts + my-bid flags + customer names in THREE queries total,
  // not three per task. With 25 tasks the old loop was 75 sequential D1
  // round-trips per feed refresh; this is 3 regardless of feed size.
  if (tasks.length) {
    const ids = tasks.map(t => t.id);
    const ph = ids.map(() => "?").join(",");
    const counts = (await env.DB.prepare(
      `SELECT task_id, COUNT(*) n FROM bids WHERE task_id IN (${ph}) GROUP BY task_id`)
      .bind(...ids).all()).results;
    const mine = (await env.DB.prepare(
      `SELECT task_id FROM bids WHERE partner_id=? AND task_id IN (${ph})`)
      .bind(user.id, ...ids).all()).results;
    const custIds = [...new Set(tasks.map(t => t.customer_id))];
    const cph = custIds.map(() => "?").join(",");
    const custs = (await env.DB.prepare(
      `SELECT id, name FROM users WHERE id IN (${cph})`).bind(...custIds).all()).results;
    const nBy = Object.fromEntries(counts.map(r => [r.task_id, r.n]));
    const mineBy = new Set(mine.map(r => r.task_id));
    const nameBy = Object.fromEntries(custs.map(r => [r.id, r.name]));
    for (const t of tasks) {
      t.bid_count = nBy[t.id] || 0;
      t.my_bid = mineBy.has(t.id);
      t.customer_name = nameBy[t.customer_id] || "Customer";
    }
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
    stops: t.stops ? JSON.parse(t.stops) : [],
    route_km: t.route_km ?? null,
    photos: t.photos ? JSON.parse(t.photos) : [],
    vehicle: t.vehicle || null,
    route_method: t.route_method || null,
  };
}
export function shapeBidRow(b) {
  return {
    id: b.id, task_id: b.task_id, amount_cents: b.amount_cents, message: b.message,
    status: b.status, created_at: b.created_at,
    partner: { id: b.partner_id, name: b.pname, avatar_hue: b.phue, id_verified: !!b.pverified },
  };
}
