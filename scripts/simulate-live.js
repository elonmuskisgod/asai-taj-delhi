#!/usr/bin/env node
/**
 * Temporary live feed for ASAI Taj Delhi until ESP32 firmware publishes.
 * Includes AS7341 spectral + PMS CPCB AQI fields from asai_dashboard.ino.
 * Stop with Ctrl+C.
 */
const URL =
  "https://asai-taj-delhi-default-rtdb.asia-southeast1.firebasedatabase.app";

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

// Rough CPCB sub-index for sim
function subIndexPM25(c) {
  const bp = [
    [0, 30, 0, 50], [31, 60, 51, 100], [61, 90, 101, 200],
    [91, 120, 201, 300], [121, 250, 301, 400], [251, 500, 401, 500],
  ];
  for (const [lo, hi, ilo, ihi] of bp) {
    if (c <= hi) return Math.round(ilo + ((c - lo) * (ihi - ilo)) / (hi - lo));
  }
  return 500;
}
function subIndexPM10(c) {
  const bp = [
    [0, 50, 0, 50], [51, 100, 51, 100], [101, 250, 101, 200],
    [251, 350, 201, 300], [351, 430, 301, 400], [431, 600, 401, 500],
  ];
  for (const [lo, hi, ilo, ihi] of bp) {
    if (c <= hi) return Math.round(ilo + ((c - lo) * (ihi - ilo)) / (hi - lo));
  }
  return 500;
}

let state = {
  temperature: 23.4,
  humidity: 48,
  iaq: 32,
  iaq_accuracy: 2,
  eCO2: 620,
  voc: 0.35,
  noise_level: 58.5,
  light_intensity: 185,
  raw_gas_non_bsec: 180,
  cct: 3200,
  nir_ratio: 0.12,
  light_type: "warm LED",
  f1: 420, f2: 680, f3: 910, f4: 1200,
  f5: 1450, f6: 1320, f7: 980, f8: 610,
  pm25: 28,
  pm10: 52,
};

function step() {
  state.temperature = clamp(state.temperature + (Math.random() - 0.5) * 0.25, 21.5, 26.5);
  state.humidity = clamp(state.humidity + (Math.random() - 0.5) * 1.2, 35, 65);
  state.iaq = clamp(state.iaq + (Math.random() - 0.5) * 4, 15, 120);
  state.eCO2 = clamp(state.eCO2 + (Math.random() - 0.5) * 35, 420, 1100);
  state.voc = clamp(state.voc + (Math.random() - 0.5) * 0.05, 0.1, 2.5);
  state.noise_level = clamp(state.noise_level + (Math.random() - 0.5) * 2.5, 42, 78);
  state.light_intensity = clamp(state.light_intensity + (Math.random() - 0.5) * 18, 40, 420);
  state.raw_gas_non_bsec = clamp(state.raw_gas_non_bsec + (Math.random() - 0.5) * 8, 80, 250);

  // Spectral drift
  state.cct = clamp(state.cct + (Math.random() - 0.5) * 80, 2700, 6500);
  state.nir_ratio = clamp(state.nir_ratio + (Math.random() - 0.5) * 0.02, 0.05, 0.45);
  state.light_type =
    state.nir_ratio > 0.35 ? "incand/sun" :
    state.cct < 3300 ? "warm LED" :
    state.cct < 5300 ? "neutral LED" : "cool LED";

  for (const k of ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"]) {
    state[k] = Math.round(clamp(state[k] + (Math.random() - 0.5) * 60, 80, 4000));
  }
  state.bands = [state.f1, state.f2, state.f3, state.f4, state.f5, state.f6, state.f7, state.f8];

  // PMS / CPCB
  state.pm25 = Math.round(clamp(state.pm25 + (Math.random() - 0.5) * 4, 8, 180));
  state.pm10 = Math.round(clamp(state.pm10 + (Math.random() - 0.5) * 6, 15, 260));
  state.si25 = subIndexPM25(state.pm25);
  state.si10 = subIndexPM10(state.pm10);
  state.aqi = Math.max(state.si25, state.si10);
  state.aqi_category = aqiCategory(state.aqi);
  state.aqi_dominant = state.si25 >= state.si10 ? "PM2.5" : "PM10";

  state.raw_temp_non_bsec = state.temperature + 0.2;
  state.raw_hum_non_bsec = state.humidity + 0.5;
  state.timestamp = Date.now();
  return { ...state };
}

async function putLive(payload) {
  const res = await fetch(`${URL}/ASAITajDelhi/live.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`live PUT ${res.status}`);
}

async function pushLog(payload) {
  const res = await fetch(`${URL}/ASAITajDelhi/log.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`log POST ${res.status}`);
}

async function tick() {
  const payload = step();
  await putLive(payload);
  await pushLog(payload);
  console.log(
    new Date().toLocaleTimeString("en-IN"),
    `lx ${Math.round(payload.light_intensity)}`,
    `CCT ${Math.round(payload.cct)}K`,
    `dB ${payload.noise_level.toFixed(1)}`,
    `AQI ${payload.aqi}`,
    `PM2.5 ${payload.pm25}`
  );
}

console.log("ASAI Taj Delhi live simulator (spectral + AQI) → RTDB every 5s");
tick().catch(console.error);
setInterval(() => tick().catch(console.error), 5000);
