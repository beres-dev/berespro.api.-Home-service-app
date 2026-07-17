// src/lib/coverage.js — which parts of Malaysia Berespro is open for business in.
//
// DESIGN: we store only EXCEPTIONS, never the full list. A district is ACTIVE by
// default; a row exists only when an admin has explicitly switched something on
// or off. That means:
//   - deploying this feature changes nothing (everywhere stays open)
//   - adding new districts to geo.js needs no migration and no seeding
//   - the table stays tiny
//
// Resolution is the same "most specific wins" rule used for commission:
//   district row > state row > default ACTIVE
// so an admin can close a whole state but reopen one district inside it.

const KEY_STATE = (s) => `state:${s}`;
const KEY_DISTRICT = (s, d) => `district:${s}|${d}`;

// Read every exception once and cache briefly. Task posting hits this, so it
// must not add a D1 round-trip per post under load.
let _cache = null, _cacheAt = 0;
const CACHE_MS = 10_000;
export function invalidateCoverageCache() { _cache = null; _cacheAt = 0; }

export async function getCoverageMap(env) {
  const t = Date.now();
  if (_cache && t - _cacheAt < CACHE_MS) return _cache;
  const map = {};
  try {
    const { results } = await env.DB.prepare("SELECT scope, active FROM coverage").all();
    for (const r of results) map[r.scope] = !!r.active;
  } catch { /* table missing (pre-/setup): treat as all-active */ }
  _cache = map; _cacheAt = t;
  return map;
}

// Is this state+district open? Most specific wins; default open.
export function isActiveIn(map, state, district) {
  const d = map[KEY_DISTRICT(state, district)];
  if (d !== undefined) return d;
  const s = map[KEY_STATE(state)];
  if (s !== undefined) return s;
  return true;
}

export async function isCovered(env, state, district) {
  return isActiveIn(await getCoverageMap(env), state, district);
}

export async function setCoverage(env, scope, active) {
  invalidateCoverageCache();
  const exists = await env.DB.prepare("SELECT scope FROM coverage WHERE scope=?").bind(scope).first();
  if (exists) {
    await env.DB.prepare("UPDATE coverage SET active=?, updated_at=? WHERE scope=?")
      .bind(active ? 1 : 0, Math.floor(Date.now() / 1000), scope).run();
  } else {
    await env.DB.prepare("INSERT INTO coverage (scope, active, updated_at) VALUES (?,?,?)")
      .bind(scope, active ? 1 : 0, Math.floor(Date.now() / 1000)).run();
  }
}

// Remove an exception -> falls back to the default (state rule, else ACTIVE).
export async function clearCoverage(env, scope) {
  invalidateCoverageCache();
  await env.DB.prepare("DELETE FROM coverage WHERE scope=?").bind(scope).run();
}

export { KEY_STATE, KEY_DISTRICT };
