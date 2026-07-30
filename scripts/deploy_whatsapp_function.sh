#!/usr/bin/env bash
# Load scripts/twilio.env → Firebase secrets → deploy onLiveWriteAlert
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/scripts/twilio.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Create $ENV_FILE from twilio.env.example first."
  exit 1
fi

# shellcheck disable=SC1090
set -a
# strip comments / blank
eval "$(grep -v '^#' "$ENV_FILE" | grep -v '^$' | sed 's/\r$//')"
set +a

: "${TWILIO_ACCOUNT_SID:?missing TWILIO_ACCOUNT_SID}"
: "${TWILIO_AUTH_TOKEN:?missing TWILIO_AUTH_TOKEN}"
: "${TWILIO_WHATSAPP_FROM:?missing TWILIO_WHATSAPP_FROM}"

cd "$ROOT"
firebase use asai-taj-delhi

echo "Setting secrets…"
printf '%s' "$TWILIO_ACCOUNT_SID" | firebase functions:secrets:set TWILIO_ACCOUNT_SID --data-file=- --force
printf '%s' "$TWILIO_AUTH_TOKEN" | firebase functions:secrets:set TWILIO_AUTH_TOKEN --data-file=- --force
printf '%s' "$TWILIO_WHATSAPP_FROM" | firebase functions:secrets:set TWILIO_WHATSAPP_FROM --data-file=- --force

echo "Deploying functions…"
firebase deploy --only functions

echo "Done. Seed PM if needed:"
echo "  PM_PHONE=+91... PM_NAME='Name' node scripts/seed_alerts_config.js"
