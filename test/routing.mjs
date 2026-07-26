// ROAD DISTANCE: the number a partner is paid on must reflect roads, not
// crow-flight. fetch is stubbed so these are deterministic AND so the OSRM
// parsing path is genuinely exercised — relying on the live router would mean
// CI silently only ever tested the fallback.
import { haversineKm, straightLineKm, routeDistanceKm } from '../src/lib/routing.js';
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n,JSON.stringify(x))); };

const KL=[3.1390,101.6870], CHE=[3.0850,101.7450], KAJ=[2.9930,101.7870];
const realFetch = globalThis.fetch;
const stub = (fn) => { globalThis.fetch = fn; };
const restore = () => { globalThis.fetch = realFetch; };

console.log("\n\u2014 Geometry \u2014");
ok("haversine is symmetric", Math.abs(haversineKm(...KL,...CHE)-haversineKm(...CHE,...KL))<1e-9);
ok("same point is zero", haversineKm(...KL,...KL)===0);
const multi = straightLineKm([KL,CHE,KAJ]);
ok("multi-leg sums its legs",
   Math.abs(multi-(haversineKm(...KL,...CHE)+haversineKm(...CHE,...KAJ)))<1e-9, multi);

console.log("\n\u2014 Real router answers \u2014");
let seenUrl = "";
stub(async (url)=>{ seenUrl = url;
  return { ok:true, json: async()=>({ code:"Ok", routes:[{ distance: 31200, duration: 2400 }] }) }; });
let r = await routeDistanceKm([KL,CHE,KAJ]);
ok("uses the measured road distance", r.km===31.2 && r.method==="road", r);
ok("reports travel time too", r.minutes===40, r);
ok("coordinates sent as lng,lat (reversing them would halve fares silently)",
   seenUrl.includes("101.687,3.139"), seenUrl.slice(0,90));
ok("all stops included in order", (seenUrl.match(/;/g)||[]).length===2, seenUrl.slice(0,110));

console.log("\n\u2014 THE FAIRNESS PROPERTY \u2014");
stub(async ()=>{ throw new Error("offline"); });
r = await routeDistanceKm([KL,CHE,KAJ]);
ok("router down -> still answers", r.km>0 && r.method==="estimated", r);
ok("NEVER falls back to the raw straight line", r.km > multi, {est:r.km, straight:multi});
ok("uplift is the documented circuity factor, not a guess",
   Math.abs(r.km - Math.round(multi*1.35*10)/10) < 0.05, {est:r.km, expect:multi*1.35});
ok("uplift stays sane (doesn't inflate the fare)", r.km < multi*1.6, r);

console.log("\n\u2014 Bad answers are refused, not trusted \u2014");
stub(async ()=>({ ok:true, json: async()=>({ code:"Ok", routes:[{ distance: 100 }] }) }));
r = await routeDistanceKm([KL,CHE,KAJ]);
ok("a road route SHORTER than the straight line is rejected", r.method==="estimated", r);
stub(async ()=>({ ok:true, json: async()=>({ code:"NoRoute", routes:[] }) }));
r = await routeDistanceKm([KL,CHE]);
ok("NoRoute falls back cleanly", r.method==="estimated" && r.km>0, r);
stub(async ()=>({ ok:false, json: async()=>({}) }));
r = await routeDistanceKm([KL,CHE]);
ok("HTTP error falls back cleanly", r.method==="estimated", r);
stub(async ()=>({ ok:true, json: async()=>{ throw new Error("bad json"); } }));
r = await routeDistanceKm([KL,CHE]);
ok("malformed reply falls back cleanly", r.method==="estimated", r);

console.log("\n\u2014 Edges \u2014");
stub(async ()=>({ ok:true, json: async()=>({ code:"Ok", routes:[{ distance: 9000 }] }) }));
ok("one point -> zero, no call", (await routeDistanceKm([KL])).km===0);
ok("empty -> zero, no call", (await routeDistanceKm([])).km===0);
r = await routeDistanceKm([KL,CHE]);
ok("distance rounded to 0.1 km", Math.abs(r.km*10-Math.round(r.km*10))<1e-9, r.km);
restore();

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
