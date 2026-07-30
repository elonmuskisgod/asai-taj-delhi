# ASAI Taj Delhi

Live indoor-environment dashboard for Taj Delhi (lighting, sound, IAQ, CPCB AQI).

- **Hosting:** https://asai-taj-delhi.web.app — **fleet view** (1 real + 9 sim)
- **Single-node:** https://asai-taj-delhi.web.app/node.html (N01 Lobby deep dive)
- **Firebase:** `asai-taj-delhi` (RTDB `asia-southeast1`)
- **Firmware:** `asai_dashboard/` (ESP32-S3 → `/ASAITajDelhi/live` = **N01 Lobby**)
- **Fleet sims:** `scripts/simulate-fleet.js` → `/ASAITajDelhi/fleet/nodes/N02…N10`
- **Outdoor CPCB:** `scripts/refresh-delhi-outdoor.js` → `/ASAITajDelhi/delhi_outdoor` (aqi.in / data.gov.in)
- **AQI scale:** **CPCB / Indian NAQI** everywhere (matches ESP32 serial). Not US EPA.
- **Fallback bridge:** `scripts/serial_to_taj.py`
- **WhatsApp PM alerts:** Twilio — see [`docs/TWILIO_WHATSAPP_ALERTS.md`](docs/TWILIO_WHATSAPP_ALERTS.md)

Copy `asai_dashboard/secrets.h.example` → `secrets.h` and set WiFi credentials before flashing.

### Remote OTA (Mumbai → Delhi)

1. **One-time USB** at the device: flash firmware **≥ v5.2** (includes OTA poller). Use a partition scheme with an OTA slot.
2. Export a new `.bin` (Sketch → Export Compiled Binary), copy to `public/firmware/asai_vX.Y.bin`, deploy Hosting.
3. From anywhere: `node scripts/ota_push.js --fw vX.Y --url https://asai-taj-delhi.web.app/firmware/asai_vX.Y.bin`
4. Confirm `/ASAITajDelhi/ota_status` and `live.fw`. Reboot only: `node scripts/ota_push.js --reboot`

### Fleet hybrid (1 LIVE + 9 SIM)

Keep the ESP32 publishing to `/ASAITajDelhi/live`. In another terminal:

```bash
node scripts/simulate-fleet.js
```

**Do not** run `scripts/simulate-live.js` while the real ESP32 is live — it overwrites `/live`.

### Refresh outdoor CPCB (Indian ground)

```bash
# From aqi.in Connaught Place (switch site to Indian AQI / use PM values):
node scripts/refresh-delhi-outdoor.js --pm25=53 --pm10=88

# Or data.gov.in CPCB API:
DATA_GOV_IN_API_KEY=your_key node scripts/refresh-delhi-outdoor.js

# Or recompute CPCB from last RTDB PM + bump timestamp:
node scripts/refresh-delhi-outdoor.js
```

### Quick WhatsApp test (local)

```bash
cp scripts/twilio.env.example scripts/twilio.env   # add Twilio SID/token
PM_PHONE=+91XXXXXXXXXX PM_NAME="PM" node scripts/seed_alerts_config.js
cd scripts && npm install && cd ..
node scripts/whatsapp_watch.js
```
