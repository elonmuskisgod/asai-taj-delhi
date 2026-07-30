#!/usr/bin/env node
/**
 * Local Twilio WhatsApp watcher (no Blaze plan required).
 * Polls Taj RTDB live data and sends WhatsApp on threshold breach.
 *
 * Setup:
 *   1. cp scripts/twilio.env.example scripts/twilio.env  # fill in
 *   2. npm install twilio dotenv   (from repo root or scripts/)
 *   3. Seed managers: node scripts/seed_alerts_config.js
 *   4. Join Twilio WhatsApp sandbox from the PM phone
 *   5. node scripts/whatsapp_watch.js
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(__dirname, "twilio.env");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnvFile(ENV_FILE);

const RTDB =
  process.env.FIREBASE_DB_URL ||
  "https://asai-taj-delhi-default-rtdb.asia-southeast1.firebasedatabase.app";
const POLL_MS = Number(process.env.POLL_MS || 10000);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 30 * 60 * 1000);

const DEFAULT_THRESHOLDS = {
  aqi: 201,
  iaq: 150,
  noise_level: 70,
  temperature_high: 30,
  temperature_low: 18,
};

function getJson(urlPath) {
  const url = `${RTDB}${urlPath}.json`;
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw || "null"));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function putJson(urlPath, body) {
  const url = new URL(`${RTDB}${urlPath}.json`);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function postJson(urlPath, body) {
  const url = new URL(`${RTDB}${urlPath}.json`);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function evaluate(live, thresholds) {
  const hits = [];
  const aqi = num(live.aqi);
  const iaq = num(live.iaq);
  const noise = num(live.noise_level);
  const temp = num(live.temperature);

  if (aqi != null && aqi >= thresholds.aqi) {
    hits.push({ key: "aqi", label: "CPCB AQI", value: aqi, limit: thresholds.aqi, detail: live.aqi_category || "" });
  }
  if (iaq != null && iaq >= thresholds.iaq) {
    hits.push({ key: "iaq", label: "BSEC IAQ", value: Math.round(iaq), limit: thresholds.iaq, detail: "" });
  }
  if (noise != null && noise >= thresholds.noise_level) {
    hits.push({ key: "noise", label: "Noise", value: Math.round(noise), limit: thresholds.noise_level, detail: "dBA" });
  }
  if (temp != null && temp >= thresholds.temperature_high) {
    hits.push({ key: "temp_high", label: "Temp high", value: Number(temp.toFixed(1)), limit: thresholds.temperature_high, detail: "°C" });
  }
  if (temp != null && temp <= thresholds.temperature_low) {
    hits.push({ key: "temp_low", label: "Temp low", value: Number(temp.toFixed(1)), limit: thresholds.temperature_low, detail: "°C" });
  }
  return hits;
}

function formatMessage(hit, live) {
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return [
    `ASAI Taj Delhi alert`,
    `${hit.label}: ${hit.value}${hit.detail ? " " + hit.detail : ""} (limit ${hit.limit})`,
    `Temp ${num(live.temperature)?.toFixed?.(1) ?? "—"}°C · Lux ${num(live.light_intensity) ?? "—"} · dB ${num(live.noise_level)?.toFixed?.(0) ?? "—"}`,
    when,
  ].join("\n");
}

function normalizeWhatsAppTo(phone) {
  const p = String(phone || "").trim();
  if (!p) return null;
  if (p.startsWith("whatsapp:")) return p;
  return p.startsWith("+") ? `whatsapp:${p}` : `whatsapp:+${p.replace(/\D/g, "")}`;
}

async function main() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) {
    console.error("Missing Twilio env. Copy scripts/twilio.env.example → scripts/twilio.env");
    process.exit(1);
  }

  const twilio = require("twilio")(sid, token);
  console.log("ASAI Taj WhatsApp watcher");
  console.log("  RTDB", RTDB);
  console.log("  from", from);
  console.log("  poll", POLL_MS, "ms · cooldown", COOLDOWN_MS, "ms");
  console.log("Ctrl+C to stop\n");

  const localState = {};

  async function tick() {
    try {
      const [live, cfg, remoteState] = await Promise.all([
        getJson("/ASAITajDelhi/live"),
        getJson("/ASAITajDelhi/alerts_config"),
        getJson("/ASAITajDelhi/alerts_state"),
      ]);
      if (!live) {
        console.log(new Date().toISOString(), "no live data");
        return;
      }
      if (cfg && cfg.enabled === false) {
        console.log("alerts disabled in RTDB config");
        return;
      }

      const thresholds = { ...DEFAULT_THRESHOLDS, ...(cfg?.thresholds || {}) };
      const managers = Array.isArray(cfg?.managers) ? cfg.managers : [];
      const cooldown = num(cfg?.cooldown_ms, COOLDOWN_MS);
      const state = { ...(remoteState || {}), ...localState };

      if (!managers.length) {
        console.log("No managers in /ASAITajDelhi/alerts_config — run seed_alerts_config.js");
        return;
      }

      const hits = evaluate(live, thresholds);
      const now = Date.now();
      const due = hits.filter((h) => now - (num(state[h.key]?.last_sent_ms, 0) || 0) >= cooldown);

      console.log(
        new Date().toLocaleTimeString("en-IN"),
        `AQI=${live.aqi ?? "—"} IAQ=${live.iaq != null ? Math.round(live.iaq) : "—"} dB=${live.noise_level != null ? Math.round(live.noise_level) : "—"} T=${live.temperature != null ? Number(live.temperature).toFixed(1) : "—"}`,
        due.length ? `→ alert ${due.map((d) => d.key).join(",")}` : hits.length ? "(cooldown)" : "ok"
      );

      for (const hit of due) {
        const body = formatMessage(hit, live);
        const results = [];
        for (const mgr of managers) {
          if (mgr.enabled === false) continue;
          const to = normalizeWhatsAppTo(mgr.phone);
          if (!to) continue;
          try {
            const msg = await twilio.messages.create({ from, to, body });
            results.push({ to, sid: msg.sid, ok: true });
            console.log("  sent", hit.key, "→", mgr.name || to, msg.sid);
          } catch (err) {
            results.push({ to, ok: false, error: String(err.message || err) });
            console.error("  fail", to, err.message || err);
          }
        }
        localState[hit.key] = { last_sent_ms: now, last_value: hit.value };
        await putJson(`/ASAITajDelhi/alerts_state/${hit.key}`, localState[hit.key]);
        await postJson("/ASAITajDelhi/alerts_log", {
          at: now,
          alert: hit,
          results,
          source: "whatsapp_watch.js",
        });
      }
    } catch (err) {
      console.error("tick error", err.message || err);
    }
  }

  await tick();
  setInterval(tick, POLL_MS);
}

main();
