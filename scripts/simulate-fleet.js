#!/usr/bin/env node
/**
 * ASAI Taj Delhi — 9-node fleet simulator (N02–N10).
 * Does NOT write /ASAITajDelhi/live (reserved for real ESP32 = N01 Lobby).
 *
 * Usage: node scripts/simulate-fleet.js
 * Stop with Ctrl+C. Do not run simulate-live.js alongside a real ESP32.
 */
const URL =
  "https://asai-taj-delhi-default-rtdb.asia-southeast1.firebasedatabase.app";

const INTERVAL_MS = 5000;
const STALE_LIVE_MS = 60000;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function aqiCategory(v) {
  if (v <= 50) return "Good";
  if (v <= 100) return "Satisfactory";
  if (v <= 200) return "Moderate";
  if (v <= 300) return "Poor";
  if (v <= 400) return "Very Poor";
  return "Severe";
}

function subIndexPM25(c) {
  const bp = [
    [0, 30, 0, 50], [31, 60, 51, 100], [61, 90, 101, 200],
    [91, 120, 201, 300], [121, 250, 301, 400], [251, 500, 401, 500],
  ];
  for (const [lo, hi, ilo, ihi] of bp) {
    if (c <= hi) return Math.round(ilo + ((c - lo) * (ihi - ilo)) / Math.max(1, hi - lo));
  }
  return 500;
}

function subIndexPM10(c) {
  const bp = [
    [0, 50, 0, 50], [51, 100, 51, 100], [101, 250, 101, 200],
    [251, 350, 201, 300], [351, 430, 301, 400], [431, 600, 401, 500],
  ];
  for (const [lo, hi, ilo, ihi] of bp) {
    if (c <= hi) return Math.round(ilo + ((c - lo) * (ihi - ilo)) / Math.max(1, hi - lo));
  }
  return 500;
}

/** CPCB Indian NAQI from PM — same breakpoints as ESP32 firmware */
function cpcbFromPm(pm25, pm10) {
  return Math.max(subIndexPM25(pm25), subIndexPM10(pm10));
}

function lightType(cct, nir) {
  if (nir > 0.35) return "incand/sun";
  if (cct < 3300) return "warm LED";
  if (cct < 5300) return "neutral LED";
  return "cool LED";
}

/**
 * Zone baselines tuned to merged mockup.
 * pmScale: fraction of lobby PM that bleeds in (ingress coupling).
 * cctBrief: brand target CCT.
 */
const NODES = {
  N02: {
    zone: "Grand Staircase",
    floor: "GROUND",
    base: {
      temperature: 23.2, humidity: 48, iaq: 38, eCO2: 580, voc: 0.28,
      noise_level: 52, light_intensity: 160, cct: 2910, nir_ratio: 0.11,
      pm25: 18, pm10: 32, f: [380, 620, 860, 1180, 1400, 1280, 940, 580],
    },
    pmScale: 0.72, noiseJitter: 1.8, cctBrief: 2900, cctDrift: 0,
  },
  N03: {
    zone: "Dining · Machan",
    floor: "GROUND",
    base: {
      temperature: 23.5, humidity: 50, iaq: 44, eCO2: 720, voc: 0.4,
      noise_level: 61, light_intensity: 95, cct: 2705, nir_ratio: 0.09,
      pm25: 12, pm10: 22, f: [300, 520, 780, 1100, 1380, 1480, 1320, 720],
    },
    pmScale: 0.45, noiseJitter: 2.2, cctBrief: 2700, cctDrift: 0,
  },
  N04: {
    zone: "Dining · Varq",
    floor: "L1",
    base: {
      temperature: 23.3, humidity: 49, iaq: 36, eCO2: 680, voc: 0.32,
      noise_level: 57, light_intensity: 90, cct: 2688, nir_ratio: 0.09,
      pm25: 11, pm10: 20, f: [295, 510, 770, 1090, 1370, 1470, 1310, 710],
    },
    pmScale: 0.4, noiseJitter: 2.0, cctBrief: 2700, cctDrift: 0,
  },
  N05: {
    zone: "Bar · Emperor Lounge",
    floor: "GROUND",
    base: {
      temperature: 22.8, humidity: 52, iaq: 47, eCO2: 750, voc: 0.55,
      noise_level: 63, light_intensity: 45, cct: 2582, nir_ratio: 0.18,
      pm25: 13, pm10: 24, f: [260, 450, 700, 1000, 1280, 1420, 1550, 980],
    },
    pmScale: 0.42, noiseJitter: 2.5, cctBrief: 2400, cctDrift: 182,
  },
  N06: {
    zone: "Spa & Wellness",
    floor: "L1",
    base: {
      temperature: 22.1, humidity: 47, iaq: 29, eCO2: 520, voc: 0.18,
      noise_level: 39, light_intensity: 55, cct: 2604, nir_ratio: 0.08,
      pm25: 9, pm10: 16, f: [280, 480, 720, 1050, 1320, 1400, 1250, 680],
    },
    pmScale: 0.22, noiseJitter: 1.2, cctBrief: 2600, cctDrift: 0,
  },
  N07: {
    zone: "Corridor East",
    floor: "L2",
    base: {
      temperature: 23.6, humidity: 48, iaq: 35, eCO2: 540, voc: 0.25,
      noise_level: 44, light_intensity: 110, cct: 2988, nir_ratio: 0.13,
      pm25: 14, pm10: 26, f: [400, 650, 900, 1220, 1420, 1300, 980, 600],
    },
    pmScale: 0.58, noiseJitter: 1.5, cctBrief: 3000, cctDrift: 0,
  },
  N08: {
    zone: "Corridor West",
    floor: "L4",
    base: {
      temperature: 23.8, humidity: 49, iaq: 39, eCO2: 560, voc: 0.28,
      noise_level: 45, light_intensity: 108, cct: 3011, nir_ratio: 0.13,
      pm25: 17, pm10: 30, f: [405, 655, 905, 1225, 1425, 1305, 985, 605],
    },
    pmScale: 0.68, noiseJitter: 1.5, cctBrief: 3000, cctDrift: 0,
  },
  N09: {
    zone: "Ballroom · Durbar",
    floor: "GROUND",
    base: {
      temperature: 22.9, humidity: 46, iaq: 33, eCO2: 620, voc: 0.3,
      noise_level: 48, light_intensity: 280, cct: 3120, nir_ratio: 0.14,
      pm25: 11, pm10: 20, f: [420, 700, 980, 1300, 1480, 1350, 1000, 620],
    },
    pmScale: 0.35, noiseJitter: 2.0, cctBrief: 3100, cctDrift: 0,
  },
  N10: {
    zone: "Kitchen-adjacent",
    floor: "SERVICE",
    base: {
      temperature: 26.4, humidity: 55, iaq: 88, eCO2: 920, voc: 1.2,
      noise_level: 66, light_intensity: 320, cct: 4005, nir_ratio: 0.15,
      pm25: 28, pm10: 48, f: [450, 750, 1050, 1400, 1550, 1400, 1050, 650],
    },
    pmScale: 0.55, noiseJitter: 3.0, cctBrief: 4000, cctDrift: 0,
  },
};

/** Mutable sim state per node */
const state = {};
for (const [id, cfg] of Object.entries(NODES)) {
  state[id] = {
    ...cfg.base,
    f1: cfg.base.f[0], f2: cfg.base.f[1], f3: cfg.base.f[2], f4: cfg.base.f[3],
    f5: cfg.base.f[4], f6: cfg.base.f[5], f7: cfg.base.f[6], f8: cfg.base.f[7],
  };
}

let lobbyPm25 = 24; // default until /live is read
let lobbyNoise = 58;
let tickCount = 0;

async function fetchLobbyLive() {
  try {
    const res = await fetch(`${URL}/ASAITajDelhi/live.json`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data) return;
    const age = Date.now() - Number(data.timestamp || 0);
    if (age > STALE_LIVE_MS) return;
    if (data.pm25 != null) lobbyPm25 = Number(data.pm25);
    if (data.noise_level != null) lobbyNoise = Number(data.noise_level);
  } catch (e) {
    // keep last lobbyPm25
  }
}

function stepNode(id) {
  const cfg = NODES[id];
  const s = state[id];

  s.temperature = clamp(s.temperature + (Math.random() - 0.5) * 0.2, cfg.base.temperature - 1.5, cfg.base.temperature + 1.5);
  s.humidity = clamp(s.humidity + (Math.random() - 0.5) * 1.0, 35, 65);
  s.iaq = clamp(s.iaq + (Math.random() - 0.5) * 3, Math.max(15, cfg.base.iaq - 20), cfg.base.iaq + 25);
  s.eCO2 = clamp(s.eCO2 + (Math.random() - 0.5) * 30, 420, 1200);
  s.voc = clamp(s.voc + (Math.random() - 0.5) * 0.04, 0.1, 2.5);
  s.noise_level = clamp(
    s.noise_level + (Math.random() - 0.5) * cfg.noiseJitter,
    cfg.base.noise_level - 8,
    cfg.base.noise_level + 10
  );
  s.light_intensity = clamp(s.light_intensity + (Math.random() - 0.5) * 12, 20, 450);

  // CCT: brief + configured drift (Bar) + small jitter
  const targetCct = cfg.cctBrief + cfg.cctDrift;
  s.cct = clamp(s.cct + (Math.random() - 0.5) * 25 + (targetCct - s.cct) * 0.05, targetCct - 80, targetCct + 80);
  s.nir_ratio = clamp(s.nir_ratio + (Math.random() - 0.5) * 0.015, 0.05, 0.4);

  for (let i = 1; i <= 8; i++) {
    const k = `f${i}`;
    s[k] = Math.round(clamp(s[k] + (Math.random() - 0.5) * 40, 80, 4000));
  }

  // Ingress coupling: blend zone base PM with lobby PM × scale
  const coupled = cfg.base.pm25 * 0.55 + lobbyPm25 * cfg.pmScale * 0.45;
  s.pm25 = Math.round(clamp(coupled + (Math.random() - 0.5) * 3, 5, 120));
  // Corridor West runs hotter than East
  if (id === "N08") s.pm25 = Math.round(clamp(s.pm25 + 3 + Math.random() * 2, 8, 120));
  s.pm10 = Math.round(clamp(s.pm25 * 1.7 + (Math.random() - 0.5) * 4, 10, 200));

  const si25 = subIndexPM25(s.pm25);
  const si10 = subIndexPM10(s.pm10);
  const aqi = Math.max(si25, si10);

  return {
    node_id: id,
    zone: cfg.zone,
    floor: cfg.floor,
    source: "sim",
    temperature: +s.temperature.toFixed(1),
    humidity: +s.humidity.toFixed(1),
    iaq: +s.iaq.toFixed(1),
    iaq_accuracy: 2,
    eCO2: Math.round(s.eCO2),
    voc: +s.voc.toFixed(2),
    noise_level: +s.noise_level.toFixed(1),
    light_intensity: Math.round(s.light_intensity),
    cct: Math.round(s.cct),
    cct_brief: cfg.cctBrief,
    nir_ratio: +s.nir_ratio.toFixed(3),
    light_type: lightType(s.cct, s.nir_ratio),
    f1: s.f1, f2: s.f2, f3: s.f3, f4: s.f4,
    f5: s.f5, f6: s.f6, f7: s.f7, f8: s.f8,
    bands: [s.f1, s.f2, s.f3, s.f4, s.f5, s.f6, s.f7, s.f8],
    pm25: s.pm25,
    pm10: s.pm10,
    si25,
    si10,
    aqi,
    aqi_category: aqiCategory(aqi),
    aqi_cat: aqiCategory(aqi),
    aqi_dominant: si25 >= si10 ? "PM2.5" : "PM10",
    cpcb_aqi: aqi,
    timestamp: Date.now(),
  };
}

async function putNode(id, payload) {
  const res = await fetch(`${URL}/ASAITajDelhi/fleet/nodes/${id}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`PUT ${id} ${res.status}`);
}

async function pushFleetLog(digest) {
  // Every ~6 ticks (~30s) to keep volume low
  if (tickCount % 6 !== 0) return;
  const res = await fetch(`${URL}/ASAITajDelhi/fleet/log.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(digest),
  });
  if (!res.ok) throw new Error(`fleet log POST ${res.status}`);
}

async function tick() {
  tickCount += 1;
  await fetchLobbyLive();

  const summaries = [];
  for (const id of Object.keys(NODES)) {
    const payload = stepNode(id);
    await putNode(id, payload);
    summaries.push(`${id}:${payload.pm25}µg/${payload.noise_level}dB/${payload.cct}K`);
  }

  await pushFleetLog({
    kind: "fleet_rollup",
    source: "sim",
    lobby_pm25: lobbyPm25,
    lobby_noise: lobbyNoise,
    nodes: Object.keys(NODES),
    timestamp: Date.now(),
  });

  console.log(
    new Date().toLocaleTimeString("en-IN"),
    `lobbyPM ${lobbyPm25}`,
    summaries.join(" · ")
  );
}

console.log("ASAI Taj Delhi fleet simulator → N02–N10 every 5s");
console.log("Does NOT write /ASAITajDelhi/live (N01 Lobby = real ESP32)");
console.log(`RTDB: ${URL}`);
tick().catch(console.error);
setInterval(() => tick().catch(console.error), INTERVAL_MS);
