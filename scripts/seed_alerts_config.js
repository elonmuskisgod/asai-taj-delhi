#!/usr/bin/env node
/**
 * Seed /ASAITajDelhi/alerts_config in RTDB.
 *
 * Usage:
 *   node scripts/seed_alerts_config.js
 *   PM_PHONE=+9198XXXXXXXX PM_NAME="Melroy" node scripts/seed_alerts_config.js
 *
 * Edit managers/thresholds below or via Firebase console after seeding.
 */
const https = require("https");

const RTDB =
  process.env.FIREBASE_DB_URL ||
  "https://asai-taj-delhi-default-rtdb.asia-southeast1.firebasedatabase.app";

const config = {
  enabled: true,
  cooldown_ms: Number(process.env.COOLDOWN_MS) || 10000,
  thresholds: {
    aqi: 200,
    iaq: 200,
    noise_level: 90,
    temperature_high: 40,
    temperature_low: 15,
  },
  managers: [
    {
      name: process.env.PM_NAME || "Melroy",
      phone: process.env.PM_PHONE || "+919833020332",
      enabled: true,
    },
  ],
};

function putJson(path, body) {
  const url = new URL(`${RTDB}${path}.json`);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(raw);
          else reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

putJson("/ASAITajDelhi/alerts_config", config)
  .then(() => {
    console.log("Seeded /ASAITajDelhi/alerts_config");
    console.log(JSON.stringify(config, null, 2));
    if (String(config.managers[0].phone).includes("X")) {
      console.log("\nReplace phone: PM_PHONE=+91... PM_NAME='Name' node scripts/seed_alerts_config.js");
    }
  })
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
