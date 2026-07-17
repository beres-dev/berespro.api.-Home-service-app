// src/lib/geo.js — Malaysia states + districts, with approximate centroids.
//
// Used for COVERAGE CONTROL: the admin switches districts on/off, and a new
// task is resolved to a district from its pin (lat/lng) before it is accepted.
//
// WHY CENTROIDS AND NOT BOUNDARIES: real district polygons are megabytes of
// GeoJSON and would have to be shipped in the Worker bundle and point-in-polygon
// tested per request. For an on/off business rule, nearest-centroid is accurate
// enough in practice: it only goes wrong for a pin almost exactly between two
// district centres, and both of those districts are usually either both on or
// both off. It is NOT accurate enough for anything legal or financial, so do not
// reuse this for tax, jurisdiction, or pricing.
//
// Centroids are approximate (town centre of the district capital, generally).
// If a district resolves wrongly in practice, correct its lat/lng here — that is
// the only fix needed, no other code changes.

export const MALAYSIA = [
  { state: "Johor", districts: [
    ["Johor Bahru", 1.4927, 103.7414], ["Iskandar Puteri", 1.4256, 103.6295],
    ["Kulai", 1.6636, 103.6031], ["Kluang", 2.0250, 103.3185],
    ["Batu Pahat", 1.8548, 102.9325], ["Muar", 2.0442, 102.5689],
    ["Segamat", 2.5148, 102.8158], ["Kota Tinggi", 1.7381, 103.9000],
    ["Pontian", 1.4869, 103.3900], ["Mersing", 2.4312, 103.8405],
    ["Tangkak", 2.2667, 102.5450],
  ]},
  { state: "Kedah", districts: [
    ["Kota Setar", 6.1264, 100.3673], ["Kubang Pasu", 6.3667, 100.4667],
    ["Kuala Muda", 5.6500, 100.4833], ["Kulim", 5.3650, 100.5613],
    ["Baling", 5.6742, 100.9167], ["Sik", 5.8167, 100.7333],
    ["Yan", 5.8000, 100.3833], ["Pendang", 5.9833, 100.4833],
    ["Padang Terap", 6.2500, 100.6667], ["Langkawi", 6.3500, 99.8000],
    ["Bandar Baharu", 5.1833, 100.5000], ["Pokok Sena", 6.1833, 100.4667],
  ]},
  { state: "Kelantan", districts: [
    ["Kota Bharu", 6.1248, 102.2381], ["Pasir Mas", 6.0500, 102.1333],
    ["Tumpat", 6.1972, 102.1708], ["Bachok", 6.0667, 102.4000],
    ["Machang", 5.7667, 102.2167], ["Tanah Merah", 5.8000, 102.1500],
    ["Kuala Krai", 5.5333, 102.2000], ["Gua Musang", 4.8833, 101.9667],
    ["Pasir Puteh", 5.8333, 102.4000], ["Jeli", 5.7000, 101.8333],
  ]},
  { state: "Melaka", districts: [
    ["Melaka Tengah", 2.1896, 102.2501], ["Alor Gajah", 2.3800, 102.2087],
    ["Jasin", 2.3083, 102.4292],
  ]},
  { state: "Negeri Sembilan", districts: [
    ["Seremban", 2.7258, 101.9424], ["Port Dickson", 2.5228, 101.7959],
    ["Nilai", 2.8148, 101.7972], ["Jempol", 2.8500, 102.4167],
    ["Kuala Pilah", 2.7375, 102.2500], ["Rembau", 2.5917, 102.0917],
    ["Tampin", 2.4694, 102.2306], ["Jelebu", 3.0167, 102.0667],
  ]},
  { state: "Pahang", districts: [
    ["Kuantan", 3.8077, 103.3260], ["Temerloh", 3.4500, 102.4167],
    ["Bentong", 3.5222, 101.9089], ["Raub", 3.7944, 101.8569],
    ["Pekan", 3.4917, 103.3903], ["Bera", 3.1667, 102.5167],
    ["Jerantut", 3.9361, 102.3625], ["Lipis", 4.1833, 101.9667],
    ["Maran", 3.5833, 102.7667], ["Rompin", 2.8000, 103.4667],
    ["Cameron Highlands", 4.4708, 101.3775],
  ]},
  { state: "Perak", districts: [
    ["Kinta (Ipoh)", 4.5975, 101.0901], ["Larut Matang (Taiping)", 4.8500, 100.7333],
    ["Manjung", 4.2167, 100.7000], ["Kerian", 5.0833, 100.6167],
    ["Hilir Perak (Teluk Intan)", 4.0231, 101.0206], ["Batang Padang", 4.1833, 101.2500],
    ["Kuala Kangsar", 4.7667, 100.9333], ["Perak Tengah", 4.3000, 100.9667],
    ["Kampar", 4.3000, 101.1500], ["Muallim", 3.9333, 101.5167],
    ["Hulu Perak", 5.4333, 101.1000], ["Bagan Datuk", 3.9833, 100.7833],
  ]},
  { state: "Perlis", districts: [
    ["Kangar", 6.4414, 100.1986],
  ]},
  { state: "Pulau Pinang", districts: [
    ["Timur Laut (George Town)", 5.4141, 100.3288], ["Barat Daya", 5.3333, 100.2333],
    ["Seberang Perai Utara", 5.4000, 100.4000], ["Seberang Perai Tengah", 5.3333, 100.4667],
    ["Seberang Perai Selatan", 5.2000, 100.4833],
  ]},
  { state: "Sabah", districts: [
    ["Kota Kinabalu", 5.9804, 116.0735], ["Penampang", 5.9167, 116.1000],
    ["Papar", 5.7333, 115.9333], ["Tuaran", 6.1833, 116.2333],
    ["Kota Belud", 6.3500, 116.4333], ["Kudat", 6.8833, 116.8333],
    ["Sandakan", 5.8402, 118.1179], ["Tawau", 4.2448, 117.8911],
    ["Lahad Datu", 5.0264, 118.3269], ["Semporna", 4.4833, 118.6000],
    ["Keningau", 5.3378, 116.1608], ["Beaufort", 5.3500, 115.7500],
    ["Ranau", 5.9500, 116.6667], ["Sipitang", 5.0833, 115.5500],
    ["Kunak", 4.6833, 118.2500], ["Kinabatangan", 5.5167, 118.1167],
  ]},
  { state: "Sarawak", districts: [
    ["Kuching", 1.5533, 110.3592], ["Samarahan", 1.4667, 110.5000],
    ["Serian", 1.1667, 110.5667], ["Sri Aman", 1.2333, 111.4667],
    ["Betong", 1.4000, 111.5333], ["Sarikei", 2.1167, 111.5167],
    ["Sibu", 2.2870, 111.8306], ["Mukah", 2.8833, 112.0833],
    ["Bintulu", 3.1667, 113.0333], ["Miri", 4.3995, 113.9914],
    ["Limbang", 4.7500, 115.0000], ["Kapit", 2.0167, 112.9333],
  ]},
  { state: "Selangor", districts: [
    ["Petaling", 3.0800, 101.5800], ["Hulu Langat", 3.0333, 101.7833],
    ["Klang", 3.0449, 101.4455], ["Gombak", 3.2500, 101.7000],
    ["Kuala Langat", 2.8000, 101.5000], ["Kuala Selangor", 3.3333, 101.2500],
    ["Sepang", 2.7000, 101.7167], ["Hulu Selangor", 3.5500, 101.6500],
    ["Sabak Bernam", 3.7667, 100.9833],
  ]},
  { state: "Terengganu", districts: [
    ["Kuala Terengganu", 5.3302, 103.1408], ["Kuala Nerus", 5.3667, 103.0833],
    ["Kemaman", 4.2333, 103.4167], ["Dungun", 4.7833, 103.4167],
    ["Besut", 5.7500, 102.5333], ["Marang", 5.2000, 103.2000],
    ["Hulu Terengganu", 5.0667, 102.8667], ["Setiu", 5.5167, 102.7167],
  ]},
  { state: "WP Kuala Lumpur", districts: [
    ["Kuala Lumpur", 3.1390, 101.6869],
  ]},
  { state: "WP Putrajaya", districts: [
    ["Putrajaya", 2.9264, 101.6964],
  ]},
  { state: "WP Labuan", districts: [
    ["Labuan", 5.2831, 115.2308],
  ]},
];

// Flat list: [{ state, district, lat, lng }]
export const DISTRICTS = MALAYSIA.flatMap((s) =>
  s.districts.map(([district, lat, lng]) => ({ state: s.state, district, lat, lng }))
);

function km(aLat, aLng, bLat, bLng) {
  const R = 6371, dLa = ((bLat - aLat) * Math.PI) / 180, dLo = ((bLng - aLng) * Math.PI) / 180;
  const h = Math.sin(dLa / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Nearest district centre to a pin. Returns null when the pin is nowhere near
// Malaysia (so a bad/absent pin can't silently resolve to a random district).
const MAX_MATCH_KM = 150;
export function resolveDistrict(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  let best = null, bestKm = Infinity;
  for (const d of DISTRICTS) {
    const dist = km(lat, lng, d.lat, d.lng);
    if (dist < bestKm) { bestKm = dist; best = d; }
  }
  if (!best || bestKm > MAX_MATCH_KM) return null;
  return { state: best.state, district: best.district, km: +bestKm.toFixed(1) };
}
