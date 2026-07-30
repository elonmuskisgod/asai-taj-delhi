# ASAI Taj Delhi — Twilio WhatsApp alerts

Send Project Manager alerts when live sensor thresholds are crossed.

## Fast path (local watcher — works on Spark / free Firebase)

No Blaze plan needed. Your Mac watches RTDB and calls Twilio.

### 1. Twilio WhatsApp Sandbox

1. Sign up at [twilio.com](https://www.twilio.com)
2. Console → **Messaging** → **Try it out** → **Send a WhatsApp message**
3. Note the sandbox number (often `+1 415 523 8886`)
4. On the **PM phone**, open WhatsApp and send the join code shown (e.g. `join <word-pair>`) to that number
5. Copy **Account SID** and **Auth Token** from the Twilio console home

### 2. Env file

```bash
cd /path/to/asai-taj-delhi
cp scripts/twilio.env.example scripts/twilio.env
# edit scripts/twilio.env with SID, token, from number
```

### 3. Seed PM list + thresholds

```bash
PM_PHONE=+919833020332 PM_NAME="Melroy" node scripts/seed_alerts_config.js
```

Or edit in Firebase console:

`/ASAITajDelhi/alerts_config`

Live config (as of 2026-07-22):

```json
{
  "enabled": true,
  "cooldown_ms": 10000,
  "thresholds": {
    "aqi": 200,
    "iaq": 200,
    "noise_level": 90,
    "temperature_high": 40,
    "temperature_low": 15
  },
  "managers": [
    { "name": "Melroy", "phone": "+919833020332", "enabled": true }
  ]
}
```

`cooldown_ms: 10000` is for testing; for the Taj pilot prefer `1800000` (30 min) so PMs are not spammed.

### 4. Install + run watcher

```bash
npm install twilio --prefix scripts
# or from repo root: npm init -y && npm install twilio
node scripts/whatsapp_watch.js
```

Leave it running. When live AQI/IAQ/noise/temp crosses a limit (and cooldown allows), WhatsApp fires.

### 5. Force a test alert

Temporarily set a low threshold in RTDB, e.g. `"noise_level": 40`, wait one poll, then restore.

---

## Production path (Cloud Functions — needs Blaze)

Firebase **Spark** cannot run outbound Twilio calls from Cloud Functions. Upgrade project `asai-taj-delhi` to **Blaze**, then:

```bash
cd functions
npm install
firebase login
firebase use asai-taj-delhi

# Set secrets (CLI prompts)
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_WHATSAPP_FROM

firebase deploy --only functions
```

Function: `onLiveWriteAlert` — triggers on every `/ASAITajDelhi/live` write, same thresholds/cooldown/managers.

Region: `asia-southeast1` (matches RTDB).

---

## RTDB paths

| Path | Role |
|------|------|
| `/ASAITajDelhi/live` | Sensor feed (existing) |
| `/ASAITajDelhi/alerts_config` | Thresholds + PM phones |
| `/ASAITajDelhi/alerts_state` | Last-sent timestamps (debounce) |
| `/ASAITajDelhi/alerts_log` | Send history |

## Sandbox limits

- Only numbers that **joined the sandbox** receive messages
- For real customer traffic later: Twilio WhatsApp Sender / Meta Business verification + templates

## Security

- Never commit `scripts/twilio.env` or Twilio tokens
- Lock RTDB rules before production (open test rules are fine for lab only)
