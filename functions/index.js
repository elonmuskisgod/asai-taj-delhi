/**
 * ASAI Taj Delhi — WhatsApp alerts via Twilio
 *
 * Trigger: RTDB /ASAITajDelhi/live writes
 * Sends WhatsApp when thresholds are crossed (debounced).
 *
 * Secrets (Firebase params / env):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM   e.g. whatsapp:+14155238886  (sandbox)
 *
 * Config in RTDB: /ASAITajDelhi/alerts_config
 * See docs/TWILIO_WHATSAPP_ALERTS.md
 */

const { onValueWritten } = require("firebase-functions/v2/database");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const twilio = require("twilio");

initializeApp();

const twilioSid = defineSecret("TWILIO_ACCOUNT_SID");
const twilioToken = defineSecret("TWILIO_AUTH_TOKEN");
const twilioFrom = defineSecret("TWILIO_WHATSAPP_FROM");

const LIVE_PATH = "/ASAITajDelhi/live";
const CONFIG_PATH = "/ASAITajDelhi/alerts_config";
const STATE_PATH = "/ASAITajDelhi/alerts_state";
const LOG_PATH = "/ASAITajDelhi/alerts_log";

const DEFAULTS = {
  enabled: true,
  cooldown_ms: 30 * 60 * 1000, // 30 min per alert type
  thresholds: {
    aqi: 201,          // CPCB Poor+
    iaq: 150,          // BSEC lightly polluted+
    noise_level: 70,   // dBA
    temperature_high: 30,
    temperature_low: 18,
  },
  managers: [
    // { name: "PM Name", phone: "+9198XXXXXXXX", enabled: true }
  ],
};

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
    hits.push({
      key: "aqi",
      label: "CPCB AQI",
      value: aqi,
      limit: thresholds.aqi,
      detail: live.aqi_category || live.aqi_cat || "",
    });
  }
  if (iaq != null && iaq >= thresholds.iaq) {
    hits.push({
      key: "iaq",
      label: "BSEC IAQ",
      value: Math.round(iaq),
      limit: thresholds.iaq,
      detail: "",
    });
  }
  if (noise != null && noise >= thresholds.noise_level) {
    hits.push({
      key: "noise",
      label: "Noise",
      value: Math.round(noise),
      limit: thresholds.noise_level,
      detail: "dBA",
    });
  }
  if (temp != null && temp >= thresholds.temperature_high) {
    hits.push({
      key: "temp_high",
      label: "Temp high",
      value: temp.toFixed(1),
      limit: thresholds.temperature_high,
      detail: "°C",
    });
  }
  if (temp != null && temp <= thresholds.temperature_low) {
    hits.push({
      key: "temp_low",
      label: "Temp low",
      value: temp.toFixed(1),
      limit: thresholds.temperature_low,
      detail: "°C",
    });
  }
  return hits;
}

function formatMessage(hit, live) {
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const lux = num(live.light_intensity);
  const lines = [
    `ASAI Taj Delhi alert`,
    `${hit.label}: ${hit.value}${hit.detail ? " " + hit.detail : ""} (limit ${hit.limit})`,
    hit.detail && hit.key === "aqi" ? `Category: ${hit.detail}` : null,
    `Temp ${num(live.temperature)?.toFixed?.(1) ?? "—"}°C · Lux ${lux ?? "—"} · dB ${num(live.noise_level)?.toFixed?.(0) ?? "—"}`,
    when,
  ].filter(Boolean);
  return lines.join("\n");
}

async function loadConfig(db) {
  const snap = await db.ref(CONFIG_PATH).get();
  const cfg = snap.val() || {};
  return {
    enabled: cfg.enabled !== false,
    cooldown_ms: num(cfg.cooldown_ms, DEFAULTS.cooldown_ms),
    thresholds: { ...DEFAULTS.thresholds, ...(cfg.thresholds || {}) },
    managers: Array.isArray(cfg.managers) ? cfg.managers : DEFAULTS.managers,
  };
}

function normalizeWhatsAppTo(phone) {
  const p = String(phone || "").trim();
  if (!p) return null;
  if (p.startsWith("whatsapp:")) return p;
  const digits = p.startsWith("+") ? p : `+${p.replace(/\D/g, "")}`;
  return `whatsapp:${digits}`;
}

exports.onLiveWriteAlert = onValueWritten(
  {
    ref: LIVE_PATH,
    instance: "asai-taj-delhi-default-rtdb",
    region: "asia-southeast1",
    secrets: [twilioSid, twilioToken, twilioFrom],
  },
  async (event) => {
    const live = event.data.after.val();
    if (!live) return;

    const db = getDatabase();
    const config = await loadConfig(db);
    if (!config.enabled) {
      console.log("alerts disabled");
      return;
    }
    if (!config.managers.length) {
      console.log("no managers configured at", CONFIG_PATH);
      return;
    }

    const hits = evaluate(live, config.thresholds);
    if (!hits.length) return;

    const stateSnap = await db.ref(STATE_PATH).get();
    const state = stateSnap.val() || {};
    const now = Date.now();

    const due = hits.filter((h) => {
      const last = num(state[h.key]?.last_sent_ms, 0) || 0;
      return now - last >= config.cooldown_ms;
    });
    if (!due.length) {
      console.log("all hits in cooldown");
      return;
    }

    const client = twilio(twilioSid.value(), twilioToken.value());
    const from = twilioFrom.value();

    for (const hit of due) {
      const body = formatMessage(hit, live);
      const results = [];

      for (const mgr of config.managers) {
        if (mgr.enabled === false) continue;
        const to = normalizeWhatsAppTo(mgr.phone);
        if (!to) continue;
        try {
          const msg = await client.messages.create({ from, to, body });
          results.push({ to, sid: msg.sid, status: msg.status, ok: true });
          console.log("sent", hit.key, "→", to, msg.sid);
        } catch (err) {
          results.push({ to, ok: false, error: String(err.message || err) });
          console.error("twilio fail", to, err.message || err);
        }
      }

      await db.ref(`${STATE_PATH}/${hit.key}`).update({
        last_sent_ms: now,
        last_value: hit.value,
        last_label: hit.label,
      });
      await db.ref(LOG_PATH).push({
        at: now,
        alert: hit,
        results,
        sample: {
          aqi: live.aqi,
          iaq: live.iaq,
          noise_level: live.noise_level,
          temperature: live.temperature,
        },
      });
    }
  }
);
