#!/usr/bin/env node
/**
 * Push a remote OTA / reboot command to the Delhi ASAI device from anywhere.
 *
 * Prerequisites (one-time, USB at the device):
 *   1. Flash firmware >= v5.2 with Partition Scheme that includes OTA
 *      (Arduino IDE → Tools → Partition Scheme → "Default 4MB with spiffs"
 *       often works on S3; if OTA fails, use an explicit "OTA" scheme).
 *   2. Confirm live.fw shows v5.2+ and ota_status updates.
 *
 * Publish a .bin (from Mumbai):
 *   Arduino IDE → Sketch → Export Compiled Binary
 *   Copy the .bin to public/firmware/asai_vX.Y.bin
 *   firebase deploy --only hosting
 *
 * Then request update:
 *   node scripts/ota_push.js --fw v5.3 --url https://asai-taj-delhi.web.app/firmware/asai_v5.3.bin
 *
 * Or reboot only:
 *   node scripts/ota_push.js --reboot
 *
 * Watch:
 *   Firebase RTDB → /ASAITajDelhi/ota_status  and  live.fw
 */

const DB =
  process.env.FIREBASE_DB_URL ||
  "https://asai-taj-delhi-default-rtdb.asia-southeast1.firebasedatabase.app";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function has(flag) {
  return process.argv.includes(flag);
}

async function put(path, obj) {
  const url = `${DB}${path}.json`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text;
}

async function main() {
  const reboot = has("--reboot");
  const fw = arg("--fw");
  const url = arg("--url");
  const id =
    arg("--id") ||
    `ota-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  let cmd;
  if (reboot) {
    cmd = {
      cmd: "reboot",
      id,
      requested_at: Date.now(),
      requested_from: "ota_push.js",
    };
  } else {
    if (!fw || !url) {
      console.error(
        "Usage:\n" +
          "  node scripts/ota_push.js --fw v5.3 --url https://asai-taj-delhi.web.app/firmware/asai_v5.3.bin\n" +
          "  node scripts/ota_push.js --reboot"
      );
      process.exit(1);
    }
    cmd = {
      cmd: "update",
      fw,
      url,
      id,
      requested_at: Date.now(),
      requested_from: "ota_push.js",
    };
  }

  console.log("Writing /ASAITajDelhi/ota …");
  console.log(JSON.stringify(cmd, null, 2));
  await put("/ASAITajDelhi/ota", cmd);
  console.log("OK. Device polls every ~60s.");
  console.log("Watch /ASAITajDelhi/ota_status and live.fw");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
