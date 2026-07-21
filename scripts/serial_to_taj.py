#!/usr/bin/env python3
"""
Bridge: asai_dashboard Serial → asai-taj-delhi RTDB
Does NOT touch Social. Reads USB serial from ESP32, POSTs to Taj Firebase.

Prefer firmware WiFi publish (asai_dashboard v4+) when available — stop this
bridge if the ESP32 is already writing /ASAITajDelhi/live itself (avoid double writes).

Usage:
  python3 scripts/serial_to_taj.py
  # Close Arduino Serial Monitor first if port is busy.
"""
from __future__ import annotations

import json
import re
import time
import urllib.request
from typing import Any, Dict, Optional

try:
    import serial
except ImportError:
    raise SystemExit("pip3 install pyserial  (or: python3 -m pip install pyserial)")

PORT = "/dev/cu.usbmodem2101"
BAUD = 115200
RTDB = "https://asai-taj-delhi-default-rtdb.asia-southeast1.firebasedatabase.app"
LIVE = f"{RTDB}/ASAITajDelhi/live.json"
LOG = f"{RTDB}/ASAITajDelhi/log.json"
PUSH_EVERY_SEC = 5.0

# Parsed state (latest)
state: Dict[str, Any] = {}


def put_json(url: str, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="PUT"
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def post_json(url: str, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def parse_line(line: str) -> None:
    global state
    line = line.strip()
    if not line or line.startswith("---"):
        return

    m = re.match(r"^Lux\s+([\d.]+)", line)
    if m:
        state["light_intensity"] = float(m.group(1))
        return

    # "415 violet |###...|  1234" (band labels may have trailing spaces)
    m = re.match(r"^(\d{3})\s+(\S+)\s+\|.*\|\s+(\d+)\s*$", line)
    if m:
        nm_map = {
            ("415", "violet"): "f1",
            ("445", "blue"): "f2",
            ("480", "cyan"): "f3",
            ("515", "green"): "f4",
            ("555", "yellow"): "f5",
            ("590", "orange"): "f6",
            ("630", "red"): "f7",
            ("680", "d.red"): "f8",
        }
        key = nm_map.get((m.group(1), m.group(2)))
        if key:
            state[key] = int(m.group(3))
            state["bands"] = [state.get(f"f{i}", 0) for i in range(1, 9)]
        return

    m = re.match(r"^nir/clear\s+([\d.]+)", line)
    if m:
        state["nir_ratio"] = float(m.group(1))
        return

    m = re.match(r"^CCT\s+~([\d.]+)K.*?->\s+(.+)$", line)
    if m:
        state["cct"] = float(m.group(1))
        state["light_type"] = m.group(2).strip()
        return

    # IAQ 32 (acc 2) Excellent | CO2eq 620ppm | VOC 0.35ppm | 23.4C 48%
    m = re.match(
        r"^IAQ\s+([\d.]+)\s+\(acc\s+(\d+)\).*?\|\s+CO2eq\s+([\d.]+)ppm\s+\|\s+VOC\s+([\d.]+)ppm\s+\|\s+([\d.]+)C\s+([\d.]+)%",
        line,
    )
    if m:
        state["iaq"] = float(m.group(1))
        state["iaq_accuracy"] = int(m.group(2))
        state["eCO2"] = float(m.group(3))
        state["voc"] = float(m.group(4))
        state["temperature"] = float(m.group(5))
        state["humidity"] = float(m.group(6))
        return

    # PM2.5 28 (SI 47) | PM10 52 (SI 51) -> AQI 51 [Satisfactory] driven by PM10
    m = re.match(
        r"^PM2\.5\s+(\d+)\s+\(SI\s+(\d+)\)\s+\|\s+PM10\s+(\d+)\s+\(SI\s+(\d+)\)\s+->\s+AQI\s+(\d+)\s+\[([^\]]+)\]\s+driven by\s+(\S+)",
        line,
    )
    if m:
        state["pm25"] = int(m.group(1))
        state["si25"] = int(m.group(2))
        state["pm10"] = int(m.group(3))
        state["si10"] = int(m.group(4))
        state["aqi"] = int(m.group(5))
        state["aqi_category"] = m.group(6).strip()
        state["aqi_dominant"] = m.group(7).strip()
        return

    # Mic -45.2 dBFS (~60 dBA)
    m = re.match(r"^Mic\s+([-\d.]+)\s+dBFS\s+\(~([\d.]+)\s+dBA\)", line)
    if m:
        state["dbfs"] = float(m.group(1))
        state["noise_level"] = float(m.group(2))
        return


def build_payload() -> Optional[dict]:
    if "temperature" not in state and "light_intensity" not in state and "noise_level" not in state:
        return None
    payload = dict(state)
    payload["timestamp"] = int(time.time() * 1000)
    # dashboard aliases
    if "aqi_category" in payload:
        payload["aqi_cat"] = payload["aqi_category"]
    return payload


def main() -> None:
    print(f"ASAI serial → Taj RTDB")
    print(f"  port {PORT} @ {BAUD}")
    print(f"  live {LIVE}")
    print("Close Serial Monitor if you see 'Resource busy'. Ctrl+C to stop.\n")

    ser = serial.Serial(PORT, BAUD, timeout=1)
    ser.reset_input_buffer()
    last_push = 0.0

    while True:
        raw = ser.readline()
        if raw:
            try:
                line = raw.decode("utf-8", "ignore").rstrip()
            except Exception:
                line = ""
            if line:
                parse_line(line)

        now = time.time()
        if now - last_push >= PUSH_EVERY_SEC:
            payload = build_payload()
            if payload:
                try:
                    put_json(LIVE, payload)
                    post_json(LOG, payload)
                    last_push = now
                    print(
                        time.strftime("%H:%M:%S"),
                        f"T={payload.get('temperature','—')}",
                        f"lx={payload.get('light_intensity','—')}",
                        f"dB={payload.get('noise_level','—')}",
                        f"AQI={payload.get('aqi','—')}",
                        f"CCT={payload.get('cct','—')}",
                        "→ Taj OK",
                    )
                except Exception as e:
                    print("push failed:", e)
            else:
                print("waiting for sensor lines…")
                last_push = now  # avoid spam


if __name__ == "__main__":
    main()
