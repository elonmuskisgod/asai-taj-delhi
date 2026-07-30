#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <Preferences.h>
#include <driver/i2s.h>
#include <Adafruit_AS7341.h>
#include <bsec2.h>
#include <math.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ArduinoJson.h>
#include <time.h>
#include "secrets.h"

// Set to 1 if your module is BME688; 0 for BME680
#define USE_BME688 0

#define FW_VERSION            "v5.2.1"

// Taj Delhi Firebase only — never Social (asaisocialproto2)
#define ENABLE_CLOUD          1
#define FIREBASE_DB_URL       "https://asai-taj-delhi-default-rtdb.asia-southeast1.firebasedatabase.app"
#define RTDB_LIVE_PATH        "/ASAITajDelhi/live.json"
#define RTDB_LOG_PATH         "/ASAITajDelhi/log.json"
#define RTDB_OTA_PATH         "/ASAITajDelhi/ota.json"
#define RTDB_OTA_STATUS_PATH  "/ASAITajDelhi/ota_status.json"
#define CLOUD_INTERVAL_MS     15000UL
#define OTA_CHECK_INTERVAL_MS 60000UL
#define WIFI_CONNECT_TIMEOUT_MS 20000UL
#define HTTP_TIMEOUT_MS       6000
#define OTA_HTTP_TIMEOUT_MS   120000
#define WIFI_RETRY_MS         8000UL
#define LOG_POST_GAP_MS       200UL   // brief pause between live PUT and log POST
#define OTA_MIN_HEAP          70000U


// ---------- I2C ----------
#define PIN_SDA      8
#define PIN_SCL      9
#define BH1750_ADDR  0x23
#define BME68X_ADDR  BME68X_I2C_ADDR_HIGH   // 0x77 — 7Semi board straps high

// ---------- I2S (INMP441) ----------
#define I2S_PORT    I2S_NUM_0
#define PIN_SCK     5
#define PIN_WS      4
#define PIN_SD      6
#define SAMPLE_RATE 16000
#define BUF_LEN     1024
// Calibrated vs NIOSH on steady speaker sound: approx dBA = dBFS + offset
#define MIC_DB_OFFSET 105.0f

// ---------- UART (PMS7003) ----------
#define PMS_RX_PIN 16   // ESP32 RX <- PMS TX
#define PMS_TX_PIN 15   // ESP32 TX -> PMS RX
HardwareSerial pmsSerial(1);

// NFP1315-61AY, 180° rotated
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R2, U8X8_PIN_NONE);
Adafruit_AS7341 as7341;
Bsec2 envSensor;
Preferences prefs;

int32_t rawBuf[BUF_LEN];

bool bhOK = false, asOK = false, bsecOK = false, micOK = false, oledOK = false;
bool pmsSeen = false;
bool bsecFresh = false;

// BH1750
float lux = -1;

// ---- AS7341 spectral, fixed 12-slot SMUX read ----
// Cycle A (F1-F4): indices 0-5; Cycle B (F5-F8): indices 6-11.
uint16_t fBand[8] = {0};
uint16_t clear0 = 0, clear1 = 0, nir0 = 0, nir1 = 0;
uint16_t clearCh = 0, nirCh = 0;
float cctK = 0, nirRatio = 0;
bool asSat = false;
bool clearAnomaly = false;
const char* lightLabel = "unknown";
const char* bandName[8] = {
  "415 violet", "445 blue  ", "480 cyan  ", "515 green ",
  "555 yellow", "590 orange", "630 red   ", "680 d.red "
};

// AS7341 flicker
uint16_t flickerHz = 0;
uint32_t lastFlickerMs = 0;
const uint32_t FLICKER_INTERVAL_MS = 4000;

// ---- CCT calibration: Philips WiZ tunable bulb, 50cm, fixed gain, 6-point sweep ----
struct CalPoint {
  float refCCT;
  float redBlueRatio;   // f[6] (630nm) / f[1] (445nm)
};
CalPoint calTable[] = {
  {2200, 17.61f},
  {3200,  6.76f},
  {4200,  3.99f},
  {5200,  3.38f},
  {6200,  2.68f},
  {6500,  2.40f},
};
const int calCount = sizeof(calTable) / sizeof(calTable[0]);

float calibratedCCT(uint16_t f[8]) {
  float ratio = (float)f[6] / (float)max((int)f[1], 1);
  float logR = log(ratio);
  for (int i = 0; i < calCount - 1; i++) {
    float r0 = calTable[i].redBlueRatio;
    float r1 = calTable[i + 1].redBlueRatio;
    if ((ratio <= r0 && ratio >= r1) || (ratio >= r0 && ratio <= r1)) {
      float t = (logR - log(r0)) / (log(r1) - log(r0));
      return calTable[i].refCCT + t * (calTable[i + 1].refCCT - calTable[i].refCCT);
    }
  }
  return (ratio > calTable[0].redBlueRatio) ? calTable[0].refCCT : calTable[calCount - 1].refCCT;
}

const char* lightType(float cct, float nirR) {
  if (nirR > 0.35f) return "incand/sun";
  if (cct <= 0)      return "unknown";
  if (cct < 3300)    return "warm LED";
  if (cct < 5300)    return "neutral LED";
  return "cool LED";
}

// BSEC
float iaq = 0, co2eq = 0, vocEq = 0, tComp = 0, rhComp = 0;
uint8_t iaqAccuracy = 0;
uint8_t bsecState[BSEC_MAX_STATE_BLOB_SIZE];
uint32_t lastStateSaveMs = 0;

// accuracy transition tracking
uint8_t lastLoggedAccuracy = 255;
uint32_t bootMillis = 0;

// PMS / CPCB AQI
uint16_t pm25 = 0, pm10 = 0;
uint32_t lastPmsMs = 0;
int aqi = 0, si25 = 0, si10 = 0;
const char* aqiCat = "—";
const char* aqiDominant = "—";

// Mic
float dbfs = -120.0f;
float approxDba = 0;

// OLED page rotate — 5 pages: IAQ, CPCB AQI, light+mic, spectrum, flicker
uint8_t oledPage = 0;
const uint8_t OLED_PAGE_COUNT = 5;
const uint32_t OLED_PAGE_INTERVAL_MS = 3000UL;  // was ~1s; triple for readability
uint32_t lastOledPageMs = 0;

// Cloud (WiFi → Taj RTDB via HTTPS REST — same as serial_to_taj.py)
#if ENABLE_CLOUD
uint32_t lastCloudMs = 0;
uint32_t lastOtaCheckMs = 0;
uint32_t lastWifiRetryMs = 0;
bool cloudReady = false;
bool ntpReady = false;
uint16_t publishCount = 0;
uint8_t httpFailStreak = 0;
String lastOtaIdHandled;
String otaState = "idle";
String otaMessage = "";
#endif

// LP @ 3.3V — must match BSEC_SAMPLE_RATE_LP
#if USE_BME688
const uint8_t bsec_config[] = {
  #include "config/bme688/bme688_sel_33v_3s_4d/bsec_selectivity.txt"
};
#else
const uint8_t bsec_config[] = {
  #include "config/bme680/bme680_iaq_33v_3s_4d/bsec_iaq.txt"
};
#endif

// ---------- Indian CPCB AQI ----------
const float bpPM25[6][4] = {
  {0, 30, 0, 50}, {31, 60, 51, 100}, {61, 90, 101, 200},
  {91, 120, 201, 300}, {121, 250, 301, 400}, {251, 500, 401, 500}
};
const float bpPM10[6][4] = {
  {0, 50, 0, 50}, {51, 100, 51, 100}, {101, 250, 101, 200},
  {251, 350, 201, 300}, {351, 430, 301, 400}, {431, 600, 401, 500}
};

int subIndex(float c, const float bp[6][4]) {
  if (c <= 0) return 0;
  for (int i = 0; i < 6; i++) {
    if (c <= bp[i][1]) {
      return (int)(bp[i][2] +
        (c - bp[i][0]) * (bp[i][3] - bp[i][2]) / (bp[i][1] - bp[i][0]));
    }
  }
  return 500;
}

const char* aqiCategory(int v) {
  if (v <= 50)  return "Good";
  if (v <= 100) return "Satisfactory";
  if (v <= 200) return "Moderate";
  if (v <= 300) return "Poor";
  if (v <= 400) return "Very Poor";
  return "Severe";
}

const char* iaqLabel(float v) {
  if (v <= 50)  return "Excellent";
  if (v <= 100) return "Good";
  if (v <= 150) return "Lightly poll.";
  if (v <= 200) return "Moderate";
  if (v <= 300) return "Heavily poll.";
  return "Severe";
}

bool ackAt(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

void formatElapsed(uint32_t ms, char* buf, size_t bufLen) {
  uint32_t totalSec = ms / 1000;
  uint32_t h = totalSec / 3600;
  uint32_t m = (totalSec % 3600) / 60;
  uint32_t s = totalSec % 60;
  snprintf(buf, bufLen, "%02lu:%02lu:%02lu", (unsigned long)h, (unsigned long)m, (unsigned long)s);
}

// ================= BH1750 =================
bool bh1750Init() {
  if (!ackAt(BH1750_ADDR)) return false;
  Wire.beginTransmission(BH1750_ADDR); Wire.write(0x01); Wire.endTransmission();
  Wire.beginTransmission(BH1750_ADDR); Wire.write(0x10); Wire.endTransmission();
  return true;
}

float bh1750Read() {
  if (Wire.requestFrom((uint8_t)BH1750_ADDR, (uint8_t)2) != 2) return -1;
  uint16_t raw = (Wire.read() << 8) | Wire.read();
  return raw / 1.2f;
}

// ================= INMP441 =================
bool inmp441Init() {
  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 256,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };
  i2s_pin_config_t pins = {
    .bck_io_num = PIN_SCK,
    .ws_io_num = PIN_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = PIN_SD
  };
  if (i2s_driver_install(I2S_PORT, &cfg, 0, NULL) != ESP_OK) return false;
  i2s_set_pin(I2S_PORT, &pins);
  i2s_zero_dma_buffer(I2S_PORT);
  size_t br;
  for (int i = 0; i < 5; i++)
    i2s_read(I2S_PORT, rawBuf, sizeof(rawBuf), &br, pdMS_TO_TICKS(200));
  return true;
}

float micDbfs() {
  size_t br;
  if (i2s_read(I2S_PORT, rawBuf, sizeof(rawBuf), &br, pdMS_TO_TICKS(200)) != ESP_OK)
    return -120.0f;
  int n = br / 4;
  if (n == 0) return -120.0f;
  int64_t sum = 0;
  for (int i = 0; i < n; i++) sum += (rawBuf[i] >> 8);
  int32_t mean = sum / n;
  int64_t sumSq = 0;
  for (int i = 0; i < n; i++) {
    int32_t s = (rawBuf[i] >> 8) - mean;
    sumSq += (int64_t)s * s;
  }
  float rms = sqrtf((float)(sumSq / n));
  return 20.0f * log10f(rms / 8388608.0f + 1e-12f);
}

// ================= AS7341 spectral (fixed 12-slot read) + flicker =================
void as7341Poll() {
  if (!asOK) return;

  uint16_t readings[12];
  if (!as7341.readAllChannels(readings)) return;

  fBand[0] = readings[0];   // F1 415
  fBand[1] = readings[1];   // F2 445
  fBand[2] = readings[2];   // F3 480
  fBand[3] = readings[3];   // F4 515
  clear0   = readings[4];
  nir0     = readings[5];
  fBand[4] = readings[6];   // F5 555
  fBand[5] = readings[7];   // F6 590
  fBand[6] = readings[8];   // F7 630
  fBand[7] = readings[9];   // F8 680
  clear1   = readings[10];
  nir1     = readings[11];

  // Use the brighter Clear cycle's matched Clear/NIR pair
  if (clear0 >= clear1) {
    clearCh = clear0;
    nirCh   = nir0;
  } else {
    clearCh = clear1;
    nirCh   = nir1;
  }

  uint16_t maxF = 1;
  uint32_t sumF = 0;
  for (int i = 0; i < 8; i++) {
    sumF += fBand[i];
    if (fBand[i] > maxF) maxF = fBand[i];
  }

  // Clear photodiodes are smaller than the dual-diode F channels, so Clear
  // can legitimately sit below a peaked F band. Floor the ratio denominator
  // so a weak Clear can't fake a sunlight/incandescent NIR signature.
  clearAnomaly = (clearCh * 2 < maxF);
  uint16_t clearForRatio = clearCh;
  if (clearAnomaly) {
    uint32_t visProxy32 = sumF / 4u;
    uint16_t visProxy = (visProxy32 > 65535u) ? 65535u : (uint16_t)visProxy32;
    if (visProxy > clearForRatio) clearForRatio = visProxy;
  }

  asSat = false;
  for (int i = 0; i < 8; i++) if (fBand[i] > 60000) asSat = true;
  if (clear0 > 60000 || clear1 > 60000) asSat = true;

  cctK = asSat ? 0 : calibratedCCT(fBand);
  nirRatio = clearForRatio ? (float)nirCh / clearForRatio : 0;
  lightLabel = lightType(cctK, nirRatio);
}

void flickerPoll() {
  if (!asOK) return;
  if (millis() - lastFlickerMs < FLICKER_INTERVAL_MS) return;
  lastFlickerMs = millis();
  flickerHz = as7341.detectFlickerHz();
}

const char* flickerVerdict() {
  if (!asOK)               return "n/a";
  if (flickerHz == 0)      return "clean (DC-driven)";
  if (flickerHz == 1)      return "flicker present, freq unclear";
  if (flickerHz == 100 || flickerHz == 120) return "mains flicker — driver quality issue";
  return "flicker detected";
}

// ================= PMS7003 =================
void pmsPoll() {
  static uint8_t buf[32];
  static int idx = 0;
  while (pmsSerial.available()) {
    uint8_t b = pmsSerial.read();
    if (idx == 0 && b != 0x42) continue;
    if (idx == 1 && b != 0x4D) { idx = 0; continue; }
    buf[idx++] = b;
    if (idx < 32) continue;
    idx = 0;
    uint16_t sum = 0;
    for (int i = 0; i < 30; i++) sum += buf[i];
    if (sum != ((buf[30] << 8) | buf[31])) continue;
    pm25 = (buf[12] << 8) | buf[13];
    pm10 = (buf[14] << 8) | buf[15];
    pmsSeen = true;
    lastPmsMs = millis();
  }
}

void updateAqi() {
  si25 = subIndex(pm25, bpPM25);
  si10 = subIndex(pm10, bpPM10);
  aqi = max(si25, si10);
  aqiDominant = (si25 >= si10) ? "PM2.5" : "PM10";
  aqiCat = aqiCategory(aqi);
}

// ================= BSEC state =================
void loadBsecState() {
  prefs.begin("bsec", false);
  size_t len = prefs.getBytesLength("state");
  if (len == BSEC_MAX_STATE_BLOB_SIZE) {
    prefs.getBytes("state", bsecState, len);
    if (envSensor.setState(bsecState))
      Serial.println("[BSEC] saved state restored");
    else
      Serial.println("[BSEC] saved state rejected, starting fresh");
  } else {
    Serial.println("[BSEC] no saved state (accuracy builds over hours)");
  }
  prefs.end();
}

void saveBsecState() {
  if (!envSensor.getState(bsecState)) return;
  prefs.begin("bsec", false);
  prefs.putBytes("state", bsecState, BSEC_MAX_STATE_BLOB_SIZE);
  prefs.end();
  Serial.println("[BSEC] state saved to flash");
}

void newDataCallback(const bme68xData data, const bsecOutputs outputs, Bsec2 bsec) {
  for (uint8_t i = 0; i < outputs.nOutputs; i++) {
    const bsecData &o = outputs.output[i];
    switch (o.sensor_id) {
      case BSEC_OUTPUT_IAQ:
        iaq = o.signal;
        iaqAccuracy = o.accuracy;
        break;
      case BSEC_OUTPUT_CO2_EQUIVALENT:
        co2eq = o.signal;
        break;
      case BSEC_OUTPUT_BREATH_VOC_EQUIVALENT:
        vocEq = o.signal;
        break;
      case BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_TEMPERATURE:
        tComp = o.signal;
        break;
      case BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_HUMIDITY:
        rhComp = o.signal;
        break;
    }
  }
  bsecFresh = true;

  if (iaqAccuracy != lastLoggedAccuracy) {
    char elapsed[12];
    formatElapsed(millis() - bootMillis, elapsed, sizeof(elapsed));
    const char* meaning;
    switch (iaqAccuracy) {
      case 0: meaning = "unreliable — heater still stabilizing, ignore IAQ number"; break;
      case 1: meaning = "low — IAQ moving but not yet calibrated"; break;
      case 2: meaning = "medium — calibration in progress"; break;
      case 3: meaning = "HIGH — fully calibrated, IAQ trustworthy"; break;
      default: meaning = "unknown"; break;
    }
    Serial.printf(">>> [ACCURACY CHANGE] t=%s  %u -> %u  (%s)\n",
                  elapsed, lastLoggedAccuracy == 255 ? 0 : lastLoggedAccuracy,
                  iaqAccuracy, meaning);
    lastLoggedAccuracy = iaqAccuracy;
  }

  if (iaqAccuracy == 3 &&
      (lastStateSaveMs == 0 || millis() - lastStateSaveMs > 6UL * 3600UL * 1000UL)) {
    saveBsecState();
    lastStateSaveMs = millis();
  }
}

bool bsecInit() {
  if (!envSensor.begin(BME68X_ADDR, Wire)) {
    Serial.printf("[BSEC] begin failed (bsec %d / bme68x %d)\n",
                  envSensor.status, envSensor.sensor.status);
    return false;
  }
  if (!envSensor.setConfig(bsec_config)) {
    Serial.printf("[BSEC] setConfig failed (%d)\n", envSensor.status);
    return false;
  }
  Serial.println("[BSEC] config loaded OK");

  bsecSensor sensorList[] = {
    BSEC_OUTPUT_IAQ,
    BSEC_OUTPUT_CO2_EQUIVALENT,
    BSEC_OUTPUT_BREATH_VOC_EQUIVALENT,
    BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_TEMPERATURE,
    BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_HUMIDITY
  };
  if (!envSensor.updateSubscription(sensorList,
        sizeof(sensorList) / sizeof(sensorList[0]), BSEC_SAMPLE_RATE_LP)) {
    if (envSensor.status < BSEC_OK) {
      Serial.printf("[BSEC] subscription failed (%d)\n", envSensor.status);
      return false;
    }
    Serial.printf("[BSEC] subscription warning (%d) — continuing\n", envSensor.status);
  }

  envSensor.setTemperatureOffset(TEMP_OFFSET_LP);
  Serial.printf("[BSEC] temp offset: %.2f\n", TEMP_OFFSET_LP);
  envSensor.attachCallback(newDataCallback);
  loadBsecState();
  Serial.println("[BSEC] running — LP mode ~3s");
  return true;
}

// ================= OLED =================
void drawOled(bool pmsFresh) {
  if (!oledOK) return;
  char l[28];
  u8g2.clearBuffer();

  if (oledPage == 0) {
    u8g2.setFont(u8g2_font_logisoso20_tr);
    if (bsecOK) snprintf(l, sizeof(l), "%.0f", iaq);
    else        snprintf(l, sizeof(l), "--");
    u8g2.drawStr(0, 22, l);
    u8g2.setFont(u8g2_font_6x10_tr);
    snprintf(l, sizeof(l), "IAQ acc:%u", iaqAccuracy);
    u8g2.drawStr(58, 10, l);
    u8g2.drawStr(58, 21, bsecOK ? iaqLabel(iaq) : "BSEC off");
    snprintf(l, sizeof(l), "CO2eq %.0f VOC %.2f", co2eq, vocEq);
    u8g2.drawStr(0, 36, l);
    snprintf(l, sizeof(l), "%.1fC  %.0f%%RH", tComp, rhComp);
    u8g2.drawStr(0, 48, l);
    u8g2.drawStr(0, 62, "1/5 IAQ");

  } else if (oledPage == 1) {
    if (pmsFresh) {
      u8g2.setFont(u8g2_font_logisoso24_tr);
      snprintf(l, sizeof(l), "%d", aqi);
      u8g2.drawStr(0, 28, l);
      u8g2.setFont(u8g2_font_7x14_tr);
      u8g2.drawStr(56, 24, "AQI");
      u8g2.drawStr(0, 46, aqiCat);
      u8g2.setFont(u8g2_font_6x10_tr);
      snprintf(l, sizeof(l), "PM2.5:%u PM10:%u", pm25, pm10);
      u8g2.drawStr(0, 62, l);
    } else {
      u8g2.setFont(u8g2_font_7x14_tr);
      u8g2.drawStr(0, 30, "AQI: waiting");
      u8g2.drawStr(0, 48, "for PMS data...");
    }

  } else if (oledPage == 2) {
    u8g2.setFont(u8g2_font_6x10_tr);
    snprintf(l, sizeof(l), bhOK ? "Lux %.0f" : "Lux ----", lux);
    u8g2.drawStr(0, 10, l);
    if (asOK) {
      if (asSat)     snprintf(l, sizeof(l), "AS7341 SATURATED");
      else if (cctK) snprintf(l, sizeof(l), "%.0fK %s", cctK, lightLabel);
      else           snprintf(l, sizeof(l), "CCT too dark");
      u8g2.drawStr(0, 22, l);
      snprintf(l, sizeof(l), "C%u N%u r%.2f", clearCh, nirCh, nirRatio);
      u8g2.drawStr(0, 34, l);
    } else {
      u8g2.drawStr(0, 22, "AS7341 ----");
    }
    if (micOK) snprintf(l, sizeof(l), "Mic ~%.0f dBA (%.0f FS)", approxDba, dbfs);
    else       snprintf(l, sizeof(l), "Mic ----");
    u8g2.drawStr(0, 48, l);
    u8g2.drawStr(0, 62, "3/5 light+mic");

  } else if (oledPage == 3) {
    uint16_t mx = 1;
    for (int i = 0; i < 8; i++) if (fBand[i] > mx) mx = fBand[i];
    for (int i = 0; i < 8; i++) {
      int h = asOK ? (int)((fBand[i] * 40UL) / mx) : 0;
      u8g2.drawBox(4 + i * 15, 44 - h, 10, h);
    }
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(0, 54, "415  480  555  630");
    if (!asOK)      snprintf(l, sizeof(l), "AS7341 ----");
    else if (asSat) snprintf(l, sizeof(l), "SATURATED");
    else if (cctK)  snprintf(l, sizeof(l), "%.0fK %s", cctK, lightLabel);
    else            snprintf(l, sizeof(l), "too dark");
    u8g2.drawStr(0, 64, l);

  } else {
    u8g2.setFont(u8g2_font_7x14_tr);
    u8g2.drawStr(0, 16, "Light flicker");
    u8g2.setFont(u8g2_font_logisoso20_tr);
    if (!asOK) snprintf(l, sizeof(l), "n/a");
    else if (flickerHz == 0) snprintf(l, sizeof(l), "clean");
    else if (flickerHz == 1) snprintf(l, sizeof(l), "flicker");
    else snprintf(l, sizeof(l), "%uHz", flickerHz);
    u8g2.drawStr(0, 40, l);
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(0, 54, flickerVerdict());
    u8g2.drawStr(0, 62, "5/5 flicker");
  }

  u8g2.sendBuffer();
}

#if ENABLE_CLOUD
// ================= WiFi + Taj RTDB (HTTPS REST) =================
void onWifiEvent(WiFiEvent_t event) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      Serial.println("WiFi: associated");
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      cloudReady = true;
      httpFailStreak = 0;
      Serial.printf("WiFi: got IP %s  RSSI %d\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
      if (!ntpReady) {
        // non-blocking nudge; initNtp may still be called from ensureWifi
      }
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      cloudReady = false;
      Serial.println("WiFi: dropped — will reconnect");
      break;
    default:
      break;
  }
}

void initNtp() {
  if (WiFi.status() != WL_CONNECTED) return;
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  for (int i = 0; i < 16; i++) {
    time_t now = time(nullptr);
    if (now > 1700000000) {
      ntpReady = true;
      Serial.printf("NTP OK — epoch %ld\n", (long)now);
      return;
    }
    delay(200);
  }
  Serial.println("NTP not ready yet — will retry");
}

void startWifi() {
  Serial.printf("WiFi: connecting to '%s'\n", WIFI_SSID);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(WIFI_PS_NONE);
  WiFi.disconnect(false, false);
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiRetryMs = millis();
}

void initWiFi() {
  WiFi.onEvent(onWifiEvent);
  startWifi();
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(300);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    cloudReady = true;
    Serial.printf("\nWiFi OK — IP %s  RSSI %d\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    cloudReady = false;
    Serial.printf("\nWiFi timeout (status=%d) — will keep retrying\n", (int)WiFi.status());
  }
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    cloudReady = true;
    if (!ntpReady) initNtp();
    return;
  }
  cloudReady = false;
  if (millis() - lastWifiRetryMs < WIFI_RETRY_MS) return;
  Serial.printf("WiFi: retry (status=%d)\n", (int)WiFi.status());
  startWifi();
}

uint64_t lastGoodWallMs = 0;
uint32_t lastGoodWallAtMs = 0;

uint64_t cloudTimestampMs() {
  time_t now = time(nullptr);
  if (now > 1700000000) {
    ntpReady = true;
    lastGoodWallMs = (uint64_t)now * 1000ULL;
    lastGoodWallAtMs = millis();
    return lastGoodWallMs;
  }
  ntpReady = false;
  // Extrapolate from last NTP sync — never send raw millis (breaks dashboard age)
  if (lastGoodWallMs > 0) {
    return lastGoodWallMs + (millis() - lastGoodWallAtMs);
  }
  return 0;  // dashboard will use receive time
}

String buildLiveJson() {
  JsonDocument doc;
  if (bhOK && lux >= 0) doc["light_intensity"] = lux;

  if (asOK) {
    for (int i = 0; i < 8; i++) {
      char key[4];
      snprintf(key, sizeof(key), "f%d", i + 1);
      doc[key] = fBand[i];
    }
    JsonArray bands = doc["bands"].to<JsonArray>();
    for (int i = 0; i < 8; i++) bands.add(fBand[i]);
    doc["nir_ratio"] = nirRatio;
    if (cctK > 0) {
      doc["cct"] = cctK;
      doc["light_type"] = lightLabel;
    }
    doc["flicker_hz"] = flickerHz;
    doc["flicker"] = flickerVerdict();
  }

  if (bsecOK) {
    doc["iaq"] = iaq;
    doc["iaq_accuracy"] = iaqAccuracy;
    doc["eCO2"] = co2eq;
    doc["voc"] = vocEq;
    doc["temperature"] = tComp;
    doc["humidity"] = rhComp;
  }

  bool pmsFresh = pmsSeen && (millis() - lastPmsMs < 5000);
  if (pmsFresh) {
    doc["pm25"] = pm25;
    doc["pm10"] = pm10;
    doc["si25"] = si25;
    doc["si10"] = si10;
    doc["aqi"] = aqi;
    doc["aqi_category"] = aqiCat;
    doc["aqi_cat"] = aqiCat;
    doc["aqi_dominant"] = aqiDominant;
  }

  if (micOK) {
    doc["dbfs"] = dbfs;
    doc["noise_level"] = approxDba;
  }

  doc["timestamp"] = (double)cloudTimestampMs();
  doc["source"] = "esp32_wifi";
  doc["fw"] = FW_VERSION;
  doc["ota_state"] = otaState;
  doc["wifi_rssi"] = WiFi.RSSI();

  String out;
  serializeJson(doc, out);
  return out;
}

int httpJson(const char* method, const char* path, const String& body) {
  if (WiFi.status() != WL_CONNECTED) return -100;

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(HTTP_TIMEOUT_MS / 1000);

  HTTPClient http;
  http.setReuse(false);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);

  String url = String(FIREBASE_DB_URL) + path;
  if (!http.begin(client, url)) return -1;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Connection", "close");

  int code = (strcmp(method, "POST") == 0) ? http.POST(body) : http.PUT(body);
  http.end();
  client.stop();
  return code;
}

String httpGetBody(const char* path, int* outCode) {
  *outCode = -1;
  if (WiFi.status() != WL_CONNECTED) {
    *outCode = -100;
    return "";
  }

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(HTTP_TIMEOUT_MS / 1000);

  HTTPClient http;
  http.setReuse(false);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);

  String url = String(FIREBASE_DB_URL) + path;
  if (!http.begin(client, url)) {
    *outCode = -1;
    return "";
  }
  http.addHeader("Connection", "close");
  *outCode = http.GET();
  String body = (*outCode > 0) ? http.getString() : String("");
  http.end();
  client.stop();
  return body;
}

void reportOtaStatus(const char* state, const char* message, const String& reqId) {
  otaState = state;
  otaMessage = message;
  JsonDocument doc;
  doc["fw"] = FW_VERSION;
  doc["state"] = state;
  doc["message"] = message;
  doc["id"] = reqId;
  doc["updated_at"] = (double)cloudTimestampMs();
  String body;
  serializeJson(doc, body);
  int code = httpJson("PUT", RTDB_OTA_STATUS_PATH, body);
  Serial.printf("ota: status -> %s (%s) HTTP %d\n", state, message, code);
}

void markOtaHandled(const String& reqId) {
  lastOtaIdHandled = reqId;
  prefs.begin("ota", false);
  prefs.putString("last_id", reqId);
  prefs.end();
}

void loadOtaHandledId() {
  prefs.begin("ota", true);
  lastOtaIdHandled = prefs.getString("last_id", "");
  prefs.end();
}

bool runHttpsOta(const String& url) {
  Serial.printf("ota: downloading %s\n", url.c_str());
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(OTA_HTTP_TIMEOUT_MS / 1000);

  httpUpdate.rebootOnUpdate(true);
  httpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  httpUpdate.setLedPin(-1, HIGH);

  t_httpUpdate_return ret = httpUpdate.update(client, url);
  switch (ret) {
    case HTTP_UPDATE_FAILED:
      Serial.printf("ota: FAILED (%d): %s\n",
                    httpUpdate.getLastError(),
                    httpUpdate.getLastErrorString().c_str());
      return false;
    case HTTP_UPDATE_NO_UPDATES:
      Serial.println("ota: no update (server said current)");
      return false;
    case HTTP_UPDATE_OK:
      Serial.println("ota: OK — rebooting");
      return true;
  }
  return false;
}

void checkOtaCommand() {
  if (WiFi.status() != WL_CONNECTED) return;

  uint32_t heap = ESP.getFreeHeap();
  int code = 0;
  String body = httpGetBody(RTDB_OTA_PATH, &code);
  if (code < 200 || code >= 300) {
    Serial.printf("ota: poll fail HTTP %d\n", code);
    return;
  }
  if (body.length() == 0 || body == "null") return;

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.printf("ota: bad JSON (%s)\n", err.c_str());
    return;
  }

  const char* cmd = doc["cmd"] | "idle";
  String reqId = doc["id"] | "";
  if (reqId.length() == 0) {
    // fall back to fw+url fingerprint so old commands still dedupe
    reqId = String(cmd) + "|" + String(doc["fw"] | "") + "|" + String(doc["url"] | "");
  }
  if (reqId == lastOtaIdHandled) return;

  if (strcmp(cmd, "idle") == 0 || strcmp(cmd, "none") == 0) return;

  if (strcmp(cmd, "reboot") == 0) {
    reportOtaStatus("rebooting", "remote reboot requested", reqId);
    markOtaHandled(reqId);
    delay(500);
    ESP.restart();
    return;
  }

  if (strcmp(cmd, "update") != 0) {
    Serial.printf("ota: ignore unknown cmd '%s'\n", cmd);
    return;
  }

  const char* targetFw = doc["fw"] | "";
  const char* url = doc["url"] | "";
  if (url[0] == '\0') {
    reportOtaStatus("failed", "update missing url", reqId);
    markOtaHandled(reqId);
    return;
  }
  if (targetFw[0] != '\0' && strcmp(targetFw, FW_VERSION) == 0) {
    reportOtaStatus("ok", "already on requested fw", reqId);
    markOtaHandled(reqId);
    return;
  }
  if (heap < OTA_MIN_HEAP) {
    Serial.printf("ota: defer — low heap %u\n", heap);
    reportOtaStatus("waiting", "low heap, will retry", reqId);
    return;  // do not mark handled — retry later
  }

  reportOtaStatus("downloading", url, reqId);
  bool ok = runHttpsOta(String(url));
  if (!ok) {
    char msg[96];
    snprintf(msg, sizeof(msg), "HTTPUpdate failed (%d)", httpUpdate.getLastError());
    reportOtaStatus("failed", msg, reqId);
    markOtaHandled(reqId);
  }
  // success path reboots inside HTTPUpdate
}

void forceWifiReconnect() {
  Serial.println("WiFi: force reconnect after HTTP failures");
  cloudReady = false;
  WiFi.disconnect(true, false);
  delay(300);
  startWifi();
}

void publishToTaj() {
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("cloud: skip — WiFi not up");
    return;
  }

  // Avoid TLS when heap is critically low (common cause of drop/crash)
  uint32_t heap = ESP.getFreeHeap();
  if (heap < 40000) {
    Serial.printf("cloud: skip — low heap %u\n", heap);
    return;
  }

  String body = buildLiveJson();
  int putCode = httpJson("PUT", RTDB_LIVE_PATH, body);
  if (putCode >= 200 && putCode < 300) {
    httpFailStreak = 0;
    publishCount++;

    // Every successful live sample is also appended to history
    delay(LOG_POST_GAP_MS);
    int postCode = httpJson("POST", RTDB_LOG_PATH, body);
    if (postCode < 200 || postCode >= 300) {
      Serial.printf("cloud: log POST fail HTTP %d — retrying once\n", postCode);
      delay(LOG_POST_GAP_MS);
      postCode = httpJson("POST", RTDB_LOG_PATH, body);
    }

    Serial.printf("cloud: Taj OK  live=%d log=%d  T=%.1f lx=%.0f dB=%.0f RSSI=%d\n",
                  putCode, postCode, tComp, lux, approxDba, WiFi.RSSI());
    if (postCode < 200 || postCode >= 300) {
      Serial.println("cloud: WARNING — live updated but history log failed");
    }
  } else {
    httpFailStreak++;
    Serial.printf("cloud: Taj fail — HTTP %d  streak=%u  WiFi=%d  heap=%u\n",
                  putCode, httpFailStreak, (int)WiFi.status(), ESP.getFreeHeap());
    // Soft recovery first; hard reconnect only if radio is actually down
    if (WiFi.status() != WL_CONNECTED) {
      forceWifiReconnect();
      httpFailStreak = 0;
    } else if (httpFailStreak >= 5) {
      forceWifiReconnect();
      httpFailStreak = 0;
    }
  }
}
#endif

// ================= MAIN =================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Wire.begin(PIN_SDA, PIN_SCL);
  pmsSerial.begin(9600, SERIAL_8N1, PMS_RX_PIN, PMS_TX_PIN);

  bootMillis = millis();

  Serial.printf("=== ASAI live dashboard %s (CCT + flicker + cloud + OTA) ===\n", FW_VERSION);
  Serial.println("Target: asai-taj-delhi /ASAITajDelhi — Social untouched");
  Serial.println("[ACCURACY] watching for acc 0->1->2->3 transitions...");
  Serial.println("[OTA] polls /ASAITajDelhi/ota every 60s");

  oledOK = (ackAt(0x3C) || ackAt(0x3D)) && u8g2.begin();
  bhOK   = bh1750Init();
  asOK   = as7341.begin(AS7341_I2CADDR_DEFAULT, &Wire);
  bsecOK = bsecInit();
  micOK  = inmp441Init();

  if (asOK) {
    // gain fixed to match the CCT calibration sweep — do not change without recalibrating
    as7341.setATIME(100);
    as7341.setASTEP(999);
    as7341.setGain(AS7341_GAIN_64X);
  }

  Serial.printf("OLED:%d BH:%d AS:%d BSEC:%d MIC:%d — PMS after first frame\n",
                oledOK, bhOK, asOK, bsecOK, micOK);

#if ENABLE_CLOUD
  loadOtaHandledId();
  initWiFi();
  if (WiFi.status() == WL_CONNECTED) initNtp();
  lastCloudMs = millis();
  lastOtaCheckMs = millis();
  reportOtaStatus("idle", "booted", lastOtaIdHandled);
#endif
}

void loop() {
  pmsPoll();

  if (bsecOK && !envSensor.run()) {
    if (envSensor.status < BSEC_OK)
      Serial.printf("[BSEC] error %d\n", envSensor.status);
  }

#if ENABLE_CLOUD
  // Keep radio up; publish on its own cadence
  ensureWifi();
  if (millis() - lastCloudMs >= CLOUD_INTERVAL_MS) {
    lastCloudMs = millis();
    publishToTaj();
  }
  if (millis() - lastOtaCheckMs >= OTA_CHECK_INTERVAL_MS) {
    lastOtaCheckMs = millis();
    checkOtaCommand();
  }
#endif

  static uint32_t lastSample = 0;
  if (millis() - lastSample < 1000) return;
  lastSample = millis();

  lux = bhOK ? bh1750Read() : -1;
  as7341Poll();
  flickerPoll();

  if (micOK) {
    dbfs = micDbfs();
    approxDba = dbfs + MIC_DB_OFFSET;
  }

  bool pmsFresh = pmsSeen && (millis() - lastPmsMs < 5000);
  if (pmsFresh) updateAqi();

  // ---- Serial ----
  Serial.println("--------------------------------------------");
  if (bhOK) Serial.printf("Lux %.0f\n", lux);

  if (asOK) {
    uint16_t mx = 1;
    for (int i = 0; i < 8; i++) if (fBand[i] > mx) mx = fBand[i];
    for (int i = 0; i < 8; i++) {
      int bar = (fBand[i] * 30) / mx;
      Serial.printf("%s |%.*s%.*s| %5u\n", bandName[i],
                    bar, "##############################",
                    30 - bar, "                              ", fBand[i]);
    }
    Serial.printf("Clear0 %u  Clear1 %u  -> used %u\n", clear0, clear1, clearCh);
    Serial.printf("NIR0 %u  NIR1 %u  -> used %u\n", nir0, nir1, nirCh);
    Serial.printf("nir/clear %.2f", nirRatio);
    if (clearAnomaly) Serial.print("  [Clear<maxF: ratio uses vis proxy]");
    Serial.println();
    if (asSat)     Serial.println("!! SATURATED — drop gain or move from bright light");
    else if (cctK) Serial.printf("CCT ~%.0fK (calibrated)  ->  %s\n", cctK, lightLabel);
    else           Serial.println("CCT: n/a (too dark)");
    Serial.printf("Flicker: %s\n", flickerVerdict());
  }

  if (bsecOK) {
    Serial.printf("IAQ %.0f (acc %u) %s | CO2eq %.0fppm | VOC %.2fppm | %.1fC %.0f%%\n",
                  iaq, iaqAccuracy, iaqLabel(iaq), co2eq, vocEq, tComp, rhComp);
  }

  if (pmsFresh) {
    Serial.printf("PM2.5 %u (SI %d) | PM10 %u (SI %d) -> AQI %d [%s] driven by %s\n",
                  pm25, si25, pm10, si10, aqi, aqiCat, aqiDominant);
  } else {
    Serial.println("AQI: waiting for PMS data...");
  }

  if (micOK) Serial.printf("Mic %.1f dBFS (~%.0f dBA)\n", dbfs, approxDba);

  drawOled(pmsFresh);
  if (millis() - lastOledPageMs >= OLED_PAGE_INTERVAL_MS) {
    lastOledPageMs = millis();
    oledPage = (oledPage + 1) % OLED_PAGE_COUNT;
  }
}
