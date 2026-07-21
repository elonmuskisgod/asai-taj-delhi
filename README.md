# ASAI Taj Delhi

Live indoor-environment dashboard for Taj Delhi (lighting, sound, IAQ, CPCB AQI).

- **Hosting:** https://asai-taj-delhi.web.app
- **Firebase:** `asai-taj-delhi` (RTDB `asia-southeast1`)
- **Firmware:** `asai_dashboard/` (ESP32-S3 → `/ASAITajDelhi/live`)
- **Fallback bridge:** `scripts/serial_to_taj.py`

Copy `asai_dashboard/secrets.h.example` → `secrets.h` and set WiFi credentials before flashing.
