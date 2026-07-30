# Step 2 — Deploy Cloud Function (Twilio WhatsApp alerts)

Function code lives in `functions/index.js` → **`onLiveWriteAlert`**.  
It runs on every write to `/ASAITajDelhi/live`, checks thresholds, and sends WhatsApp via Twilio.

## Requirements

1. Firebase project **asai-taj-delhi** on **Blaze** (pay-as-you-go)  
   Spark cannot call Twilio from Cloud Functions.  
   Console → project settings → Usage and billing → Modify plan → Blaze  
   (free tier still covers light use; card required)

2. Twilio sandbox joined from the PM phone (you said step 1 is done)

3. Firebase CLI logged in on this Mac

## Commands (run in Terminal)

```bash
cd /Users/melroydmello/Documents/Arduino/asai-taj-delhi

# 1) Re-auth if needed
firebase login --reauth
firebase use asai-taj-delhi

# 2) Install function deps
cd functions && npm install && cd ..

# 3) Store Twilio secrets (paste when prompted — don't put these in git)
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_WHATSAPP_FROM
# For FROM use exactly:  whatsapp:+14155238886
# (or whatever sandbox number Twilio shows)

# 4) Seed PM + thresholds in RTDB (live defaults already match Melroy + current thresholds)
PM_PHONE=+919833020332 PM_NAME="Melroy" node scripts/seed_alerts_config.js

# 5) Deploy
firebase deploy --only functions
```

Expected output includes: `Function URL` / `onLiveWriteAlert` deployed in `asia-southeast1`.

## Verify

```bash
firebase functions:log --only onLiveWriteAlert
```

Then either wait for a real live write from the ESP32, or temporarily lower a threshold:

Firebase console → Realtime Database → `/ASAITajDelhi/alerts_config/thresholds/noise_level` → set `40` → save.  
Next ESP publish should trigger (if noise ≥ 40) and WhatsApp the PM.  
Restore to `90` after the test (live threshold).

## If deploy fails

| Error | Fix |
|-------|-----|
| Billing / Blaze required | Upgrade project to Blaze |
| Permission denied / credentials | `firebase login --reauth` |
| Secret not found | Re-run `functions:secrets:set` for all three |
| No managers configured | Run `seed_alerts_config.js` with real `PM_PHONE` |

## Without Blaze yet?

Use the local watcher (same logic, runs on your Mac):

```bash
cp scripts/twilio.env.example scripts/twilio.env   # fill SID, token, FROM
cd scripts && npm install && cd ..
PM_PHONE=+91... node scripts/seed_alerts_config.js
node scripts/whatsapp_watch.js
```
