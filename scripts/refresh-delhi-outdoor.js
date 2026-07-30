#!/usr/bin/env node
/**
 * Refresh /ASAITajDelhi/delhi_outdoor with Indian CPCB AQI.
 *
 * Sources (in order):
 *  1) data.gov.in CPCB real-time resource — set DATA_GOV_IN_API_KEY
 *  2) CLI overrides: --pm25=53 --pm10=88 [--cpcb=88] [--station=connaught-place]
 *  3) Recompute CPCB from existing RTDB pm25/pm10 and bump timestamp
 *
 * Usage:
 *   DATA_GOV_IN_API_KEY=xxx node scripts/refresh-delhi-outdoor.js
 *   node scripts/refresh-delhi-outdoor.js --pm25=53 --pm10=88
 *   node scripts/refresh-delhi-outdoor.js   # refresh from last RTDB PM
 *
 * CPCB math matches ESP32 firmware / fleet UI (Indian NAQI).
 */
const URL =
  "https://asai-taj-delhi-default-rtdb.asia-southeast1.firebasedatabase.app";

const DATA_GOV_RESOURCE =
  "https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69";

const BP_PM25 = [
  [0, 30, 0, 50], [31, 60, 51, 100], [61, 90, 101, 200],
  [91, 120, 201, 300], [121, 250, 301, 400], [251, 500, 401, 500],
];
const BP_PM10 = [
  [0, 50, 0, 50], [51, 100, 51, 100], [101, 250, 101, 200],
  [251, 350, 201, 300], [351, 430, 301, 400], [431, 600, 401, 500],
];

function subIndex(c, bp) {
  if (c == null || isNaN(c) || c < 0) return 0;
  for (const [lo, hi, ilo, ihi] of bp) {
    if (c <= hi) return Math.round(ilo + ((c - lo) * (ihi - ilo)) / Math.max(1, hi - lo));
  }
  return 500;
}

function cpcbFromPm(pm25, pm10) {
  return Math.max(subIndex(Number(pm25 || 0), BP_PM25), subIndex(Number(pm10 || 0), BP_PM10));
}

function cpcbCat(a) {
  if (a <= 50) return "Good";
  if (a <= 100) return "Satisfactory";
  if (a <= 200) return "Moderate";
  if (a <= 300) return "Poor";
  if (a <= 400) return "Very Poor";
  return "Severe";
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function fromDataGov(apiKey) {
  // Prefer a central Delhi station name; fall back to city=Delhi averages of PM
  const stationTries = [
    "Income Tax Office, Delhi - CPCB",
    "ITO, Delhi - CPCB",
    "Mandir Marg, Delhi - DPCC",
    "RK Puram, Delhi - DPCC",
  ];
  for (const station of stationTries) {
    const url =
      `${DATA_GOV_RESOURCE}?api-key=${encodeURIComponent(apiKey)}` +
      `&format=json&limit=20&filters[station]=${encodeURIComponent(station)}`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = await res.json();
    const records = data.records || [];
    if (!records.length) continue;
    let pm25 = null, pm10 = null;
    for (const r of records) {
      const id = (r.pollutant_id || r["Pollutant Id"] || "").toLowerCase();
      const avg = Number(r.avg_value ?? r["Pollutant Avg"] ?? r.avg);
      if (id.includes("pm2") && !isNaN(avg)) pm25 = avg;
      if (id.includes("pm10") && !isNaN(avg)) pm10 = avg;
    }
    if (pm25 != null || pm10 != null) {
      return {
        pm25: pm25 ?? 0,
        pm10: pm10 ?? 0,
        station,
        source: "data.gov.in",
      };
    }
  }

  // City-wide: take latest PM2.5 / PM10 rows for Delhi
  const url =
    `${DATA_GOV_RESOURCE}?api-key=${encodeURIComponent(apiKey)}` +
    `&format=json&limit=100&filters[city]=Delhi`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`data.gov.in HTTP ${res.status}`);
  const data = await res.json();
  const records = data.records || [];
  const pm25s = [], pm10s = [];
  for (const r of records) {
    const id = (r.pollutant_id || r["Pollutant Id"] || "").toLowerCase();
    const avg = Number(r.avg_value ?? r["Pollutant Avg"] ?? r.avg);
    if (isNaN(avg)) continue;
    if (id.includes("pm2")) pm25s.push(avg);
    if (id.includes("pm10")) pm10s.push(avg);
  }
  if (!pm25s.length && !pm10s.length) throw new Error("No Delhi PM rows from data.gov.in");
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  return {
    pm25: pm25s.length ? mean(pm25s) : 0,
    pm10: pm10s.length ? mean(pm10s) : 0,
    station: "Delhi-city-mean",
    source: "data.gov.in",
  };
}

async function readExisting() {
  const res = await fetch(`${URL}/ASAITajDelhi/delhi_outdoor.json`);
  if (!res.ok) return null;
  return res.json();
}

async function writeOutdoor(payload) {
  const res = await fetch(`${URL}/ASAITajDelhi/delhi_outdoor.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`RTDB PUT ${res.status}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const key = process.env.DATA_GOV_IN_API_KEY || process.env.DATA_GOV_API_KEY;
  let pm25, pm10, station, source, cpcbOverride;

  if (args.pm25 != null || args.pm10 != null) {
    pm25 = Number(args.pm25 || 0);
    pm10 = Number(args.pm10 || 0);
    station = args.station || "manual";
    source = "cli";
    if (args.cpcb != null) cpcbOverride = Number(args.cpcb);
  } else if (key) {
    console.log("Fetching data.gov.in CPCB resource…");
    const g = await fromDataGov(key);
    pm25 = g.pm25;
    pm10 = g.pm10;
    station = g.station;
    source = g.source;
  } else {
    const prev = await readExisting();
    if (!prev || (prev.pm25 == null && prev.pm10 == null)) {
      console.error(
        "No DATA_GOV_IN_API_KEY and no existing RTDB PM.\n" +
          "Either set the key, or pass --pm25= --pm10= from aqi.in (Indian AQI / CPCB mode)."
      );
      process.exit(1);
    }
    pm25 = Number(prev.pm25 || 0);
    pm10 = Number(prev.pm10 || 0);
    station = prev.station || "connaught-place";
    source = prev.source || "aqi.in";
    console.log("No API key — recomputing CPCB from existing RTDB PM and refreshing timestamp.");
  }

  const cpcb_aqi = cpcbOverride != null ? cpcbOverride : cpcbFromPm(pm25, pm10);
  const payload = {
    pm25: Math.round(pm25 * 10) / 10,
    pm10: Math.round(pm10 * 10) / 10,
    cpcb_aqi,
    cpcb_category: cpcbCat(cpcb_aqi),
    station,
    source,
    // keep US field for legacy node.html if present, but fleet uses CPCB
    us_aqi: null,
    timestamp: Date.now(),
  };

  await writeOutdoor(payload);
  console.log("Wrote /ASAITajDelhi/delhi_outdoor:", payload);
  console.log(`CPCB AQI ${cpcb_aqi} (${cpcbCat(cpcb_aqi)}) · PM2.5 ${payload.pm25} · PM10 ${payload.pm10}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
