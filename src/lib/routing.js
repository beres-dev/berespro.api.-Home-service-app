// src/lib/routing.js — how far the rider actually has to ride.
//
// Straight-line distance underpays every single delivery. A pickup and a
// drop-off 5 km apart as the crow flies is routinely 7-9 km of real road once
// you account for rivers, one-ways, highways and the fact that Malaysian
// housing areas rarely connect directly. The partner burns that fuel and that
// time; pricing on the crow-flight number quietly transfers the difference from
// them to the customer.
//
// So: ask a real router. OSRM's public API is free, needs no key, and returns
// driving distance along actual roads.
//
// When it can't answer — down, slow, or the coordinates are somewhere it has no
// road data — we do NOT fall back to the raw straight line, because that is the
// unfair number we are trying to stop using. We apply a circuity factor
// instead: the well-documented ratio between road distance and straight-line
// distance in built-up areas, ~1.3-1.4. Using 1.35 keeps the estimate close to
// reality and, crucially, errs slightly in the partner's favour rather than the
// platform's.
//
// The result says which method was used, so nothing downstream has to guess.

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving/";
const CIRCUITY = 1.35;
const TIMEOUT_MS = 3500;   // task creation must not hang on a third party

export function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// points: [[lat,lng], [lat,lng], ...] in travel order
export function straightLineKm(points) {
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    km += haversineKm(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return km;
}

/**
 * Real road distance for a multi-stop route.
 * Returns { km, method: "road" | "estimated", minutes }
 *   road      — measured along actual roads by OSRM
 *   estimated — OSRM unavailable; straight line scaled by the circuity factor
 */
export async function routeDistanceKm(points) {
  if (!Array.isArray(points) || points.length < 2) return { km: 0, method: "road", minutes: 0 };

  const straight = straightLineKm(points);

  // OSRM takes lng,lat — the reverse of the order used everywhere else here,
  // which is exactly the kind of thing that silently halves a fare if missed.
  const coords = points.map((p) => `${p[1]},${p[0]}`).join(";");

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const res = await fetch(`${OSRM_BASE}${coords}?overview=false&alternatives=false`, {
      signal: ctl.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (res.ok) {
      const j = await res.json();
      const r = j && j.code === "Ok" && Array.isArray(j.routes) && j.routes[0];
      if (r && isFinite(r.distance)) {
        const km = r.distance / 1000;
        // Sanity guard: a road route is never shorter than the straight line.
        // If it comes back shorter, something is wrong with the answer, not
        // with geometry — don't trust it.
        if (km >= straight * 0.95) {
          return {
            km: Math.round(km * 10) / 10,
            method: "road",
            minutes: isFinite(r.duration) ? Math.round(r.duration / 60) : null,
          };
        }
      }
    }
  } catch (_) {
    // network error, timeout, or malformed reply — fall through to the estimate
  }

  return {
    km: Math.round(straight * CIRCUITY * 10) / 10,
    method: "estimated",
    minutes: null,
  };
}
