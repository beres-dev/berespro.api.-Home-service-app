// src/routes/addresses.js — saved places (Grab-style Home / Office / custom).
//
// Design choices:
// - SAME LABEL REPLACES. Saving a new "Home" replaces the old "Home" instead of
//   accumulating five of them; that is what "set as Home" means to a person.
// - Capped at 10 per user. Nobody has 11 homes; a row cap keeps a hostile
//   client from filling the table.
// - Coordinates required. An address without a pin cannot drive the coverage
//   gate or partner distances, so it would be a lie waiting to surface later.

import { json, err, now, readBody, id } from "../lib/util.js";
import { requireUser } from "../lib/auth.js";
import { vstr, vnum } from "../lib/guard.js";

const MAX_ADDRESSES = 10;

export async function listAddresses(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const { results } = await env.DB.prepare(
    "SELECT id, label, addr, lat, lng, created_at FROM addresses WHERE user_id=?"
  ).bind(user.id).all();
  // Stable, human order: Home first, Office second, the rest by age.
  const rank = (l) => l === "Home" ? 0 : l === "Office" ? 1 : 2;
  results.sort((a, b) => rank(a.label) - rank(b.label) || a.created_at - b.created_at);
  return json({ addresses: results });
}

export async function createAddress(req, env) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const b = await readBody(req);

  const label = vstr(b.label, 24);
  const addr = vstr(b.addr, 200);
  const lat = vnum(b.lat, -90, 90);
  const lng = vnum(b.lng, -180, 180);
  if (!label) return err("label required (e.g. Home, Office)", 400);
  if (!addr) return err("address text required", 400);
  if (lat === undefined || lng === undefined || lat === null || lng === null)
    return err("map pin required — set the location first", 400, "pin_required");

  const { results: mine } = await env.DB.prepare(
    "SELECT id, label FROM addresses WHERE user_id=?").bind(user.id).all();

  // Same label = replace, not accumulate. Delete-then-insert instead of UPDATE
  // keeps the SQL trivially simple for both D1 and the test MockDB.
  const existing = mine.find((a) => a.label.toLowerCase() === label.toLowerCase());
  if (existing) {
    await env.DB.prepare("DELETE FROM addresses WHERE id=?").bind(existing.id).run();
  } else if (mine.length >= MAX_ADDRESSES) {
    return err(`you can save up to ${MAX_ADDRESSES} addresses — delete one first`, 409, "address_limit");
  }

  const aid = id("adr");
  await env.DB.prepare(
    "INSERT INTO addresses (id,user_id,label,addr,lat,lng,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(aid, user.id, label, addr, lat, lng, now()).run();
  const row = await env.DB.prepare(
    "SELECT id, label, addr, lat, lng, created_at FROM addresses WHERE id=?").bind(aid).first();
  return json({ address: row }, 201);
}

export async function deleteAddress(req, env, params) {
  const user = await requireUser(req, env);
  if (!user) return err("unauthorized", 401);
  const row = await env.DB.prepare("SELECT id, user_id FROM addresses WHERE id=?")
    .bind(params.id).first();
  if (!row) return err("address not found", 404);
  if (row.user_id !== user.id) return err("address not found", 404); // no existence oracle
  await env.DB.prepare("DELETE FROM addresses WHERE id=?").bind(row.id).run();
  return json({ ok: true });
}
