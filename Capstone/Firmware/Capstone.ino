/**
 * ============================================================================
 * CAMP-AI: Smart Greenhouse Monitoring System - ESP32 Firmware
 * Departemen Teknik Mesin dan Biosistem, Fakultas Teknologi Pertanian
 * Institut Pertanian Bogor (IPB University)
 * ============================================================================
 * Fitur:
 * - Pengukuran Suhu Bola Kering & Bola Basah (DS18B20 Psychrometer)
 * - Aspirasi Kipas Otomatis (5 detik stabilisasi + 60 detik sampling)
 * - Perhitungan Kelembapan Relatif (RH) BMKG Standar (Perka BMKG No. 04/2026)
 * - Pengukuran Intensitas Cahaya (BH1750 Lux Meter - khusus Modul 1)
 * - Captive Portal WiFiManager untuk provisioning WiFi dinamis tanpa hardcode
 * - Sinkronisasi Waktu Presisi via NTP Server (WIB UTC+7)
 * - Agregasi Data Horizontal ke Google Apps Script & Google Sheets
 * ============================================================================
 */

#include <Wire.h>
#include <BH1750.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <time.h>
#include <WiFiManager.h>

// ─── USER CONFIGURATION ─────────────────────────────────────────────────────
// Ganti dengan URL Google Apps Script Web App Deployment Anda:
const char* SCRIPT_URL    = "SCRIPT_URL";

// ============================================================================
// IDENTITAS MODUL
// Konfigurasi per modul yang di-flash:
// - Module1: HAS_LUX_SENSOR = true  (Modul Master / Titik Depan dengan BH1750)
// - Module2: HAS_LUX_SENSOR = false (Modul Titik Tengah)
// - Module3: HAS_LUX_SENSOR = false (Modul Titik Belakang)
// ============================================================================
const char* MODULE_ID     = "Module1"; 
const bool HAS_LUX_SENSOR = true; 

// ─── PIN ASSIGNMENT (ESP32) ────────────────────────────────────────────────
#define DRY_BULB_PIN  19   // Pin OneWire Sensor Suhu Bola Kering (DS18B20)
#define WET_BULB_PIN  16   // Pin OneWire Sensor Suhu Bola Basah (DS18B20)
#define FAN_PIN       26   // Pin Kontrol Relay Kipas Aspirasi Psikrometer

// ─── WAKTU & JADWAL PENGIRIMAN ─────────────────────────────────────────────
const char* NTP_SERVER       = "pool.ntp.org";
const long  GMT_OFFSET       = 7 * 3600;   // UTC+7 (WIB)
const int   DST_OFFSET       = 0;
const int   SAMPLING_SECONDS = 60;         // Durasi sampling kipas aktif (detik)
const int   START_HOUR       = 0;          // Jam mulai pengiriman (0 - 24 untuk 24 jam)
const int   END_HOUR         = 24;         // Jam henti pengiriman
const int   INTERVAL_MIN     = 15;         // Siklus pengiriman (menit). Ubah ke 2 untuk testing cepat.
// ────────────────────────────────────────────────────────────────────────────

BH1750 lightMeter;
OneWire dryWire(DRY_BULB_PIN);
OneWire wetWire(WET_BULB_PIN);
DallasTemperature drySensor(&dryWire);
DallasTemperature wetSensor(&wetWire);

struct SensorData { 
  float lux; 
  float dryTemp; 
  float wetTemp; 
  float rh; 
  bool valid; 
};

/**
 * Mengambil waktu lokal terkini dalam bentuk struct tm
 */
struct tm getCurrentLocalTime() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 5000)) {
    memset(&timeinfo, 0, sizeof(timeinfo));
  }
  return timeinfo;
}

/**
 * Menghitung Kelembapan Relatif (RH) menggunakan Formula Psikrometer BMKG
 * Sumber: Perka BMKG No. 04 Tahun 2026 (Assmann Psychrometer dengan Aspirasi Kipas Buatan)
 *
 * Rumus:
 *   es(T) = 0.6108 * exp((17.27 * T) / (T + 237.3)) [kPa]
 *   P     = 101.325 kPa (Tekanan atmosfer standar)
 *   A     = 0.0007947 °C^-1 (Konstanta psikrometrik dengan aerasi konstan kipas)
 *   ea    = es(Tw) - A * P * (Td - Tw)
 *   RH    = (ea / es(Td)) * 100%
 */
float computeRH(float Td, float Tw) {
  if (Tw >= Td) return 100.0; // Saturasi atau anomali pembacaan Tw > Td

  const float A = 0.0007947; 
  const float P = 101.325; // Tekanan standar atmosfer (kPa)

  float es_d = 0.6108 * exp((17.27 * Td) / (Td + 237.3));
  float es_w = 0.6108 * exp((17.27 * Tw) / (Tw + 237.3));
  float ea   = es_w - (A * P * (Td - Tw));

  if (ea <= 0.0) return 0.0;
  float rh = (ea / es_d) * 100.0;
  return constrain(rh, 0.0, 100.0);
}

/**
 * Membaca data dari sensor selama window SAMPLING_SECONDS dengan kipas aktif
 */
SensorData readSensors() {
  SensorData result = {0, 0, 0, 0, false};
  
  // 1. Nyalakan kipas aspirasi untuk sirkulasi udara di kain basah
  digitalWrite(FAN_PIN, HIGH);
  Serial.println("\n[Sistem] Menyalakan Kipas Aspirasi, stabilisasi 5 detik...");
  delay(5000);

  float sumLux = 0, sumDry = 0, sumWet = 0, sumRH = 0;
  int count = 0;
  unsigned long startMs = millis();
  unsigned long windowMs = (unsigned long)SAMPLING_SECONDS * 1000UL;

  Serial.println("[Sistem] Mulai membaca sensor selama 60 detik sampling window...");

  while (millis() - startMs < windowMs) {
    float lux = 0;
    if (HAS_LUX_SENSOR) {
      lux = lightMeter.readLightLevel();
    }
    
    drySensor.requestTemperatures(); 
    wetSensor.requestTemperatures();
    float dryT = drySensor.getTempCByIndex(0);
    float wetT = wetSensor.getTempCByIndex(0);

    // Validasi pembacaan DS18B20:
    // Singkirkan -127°C (DEVICE_DISCONNECTED_C) dan 85°C (Power-on Reset)
    if (dryT != DEVICE_DISCONNECTED_C && wetT != DEVICE_DISCONNECTED_C &&
        dryT != 85.0 && wetT != 85.0 &&
        dryT > -40.0 && dryT < 80.0 && wetT > -40.0 && wetT < 80.0) {
      
      float rh = computeRH(dryT, wetT);
      sumLux += lux; 
      sumDry += dryT; 
      sumWet += wetT; 
      sumRH  += rh; 
      count++;
    } else {
      Serial.println("[Warning] Sensor membaca nilai tidak valid (-127 / 85 C), abaikan sampel ini.");
    }
    
    delay(5000); // Sampling setiap 5 detik
  }
  
  // 2. Matikan kipas setelah periode sampling selesai
  digitalWrite(FAN_PIN, LOW);
  Serial.println("[Sistem] Periode sampling selesai, kipas dimatikan.");

  if (count > 0) {
    result.lux     = HAS_LUX_SENSOR ? (sumLux / count) : 0;
    result.dryTemp = sumDry / count;
    result.wetTemp = sumWet / count;
    result.rh      = sumRH / count;
    result.valid   = true;
    
    Serial.println("=====================================");
    Serial.printf(" HASIL RATA-RATA PENGUKURAN (%s)\n", MODULE_ID);
    if (HAS_LUX_SENSOR) {
      Serial.printf(" - Intensitas Cahaya : %.2f lux\n", result.lux);
    }
    Serial.printf(" - Suhu Bola Kering  : %.2f °C\n", result.dryTemp);
    Serial.printf(" - Suhu Bola Basah   : %.2f °C\n", result.wetTemp);
    Serial.printf(" - Kelembapan (RH)   : %.2f %%\n", result.rh);
    Serial.printf(" - Jumlah Sampel     : %d\n", count);
    Serial.println("=====================================");
  } else {
    Serial.println("[Error] Gagal mendapatkan pembacaan sensor DS18B20 yang valid!");
  }
  return result;
}

/**
 * Mengirim data sensor ke Google Apps Script endpoint via HTTP POST JSON
 */
bool sendData(SensorData data, struct tm* t) {
  // Reconnect WiFi jika koneksi sempat terputus
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Terputus! Mencoba reconnect ke jaringan tersimpan...");
    WiFi.reconnect();
    
    unsigned long startM = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startM < 5000) {
      delay(500);
      Serial.print(".");
    }
    
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("\n[WiFi] Gagal Reconnect, lewati siklus transmisi kali ini.");
      return false; 
    }
    Serial.println("\n[WiFi] Berhasil Reconnect!");
  }

  HTTPClient http;
  http.begin(SCRIPT_URL);
  http.addHeader("Content-Type", "application/json");
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  String payload = "{";
  payload += "\"module\":\"" + String(MODULE_ID) + "\",";
  if (HAS_LUX_SENSOR) { 
    payload += "\"lux\":" + String(data.lux, 2) + ","; 
  } else { 
    payload += "\"lux\":null,"; 
  }
  payload += "\"dryTemp\":" + String(data.dryTemp, 2) + ",";
  payload += "\"wetTemp\":" + String(data.wetTemp, 2) + ",";
  payload += "\"rh\":" + String(data.rh, 2);
  payload += "}";

  Serial.println("[HTTP] Mengirim data ke Google Apps Script...");
  int code = http.POST(payload);
  
  if (code > 0) { 
    Serial.printf("[HTTP] Berhasil! Kode Respons: %d\n\n", code); 
    http.end(); 
    return true; 
  } else { 
    Serial.printf("[HTTP] Gagal Mengirim: %s\n\n", http.errorToString(code).c_str()); 
    http.end(); 
    return false; 
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n\n==========================================");
  Serial.printf(" Inisialisasi CAMP-AI Node: %s\n", MODULE_ID);
  Serial.println("==========================================");

  pinMode(FAN_PIN, OUTPUT); 
  digitalWrite(FAN_PIN, LOW);

  if (HAS_LUX_SENSOR) {
    Wire.begin(); 
    if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) {
      Serial.println("[BH1750] Sensor Lux terdeteksi dan aktif.");
    } else {
      Serial.println("[BH1750] Gagal menginisialisasi BH1750!");
    }
  }

  drySensor.begin(); 
  wetSensor.begin();
  
  // Inisialisasi WiFiManager (Captive Portal jika belum ada WiFi tersimpan)
  WiFiManager wm;
  wm.setConfigPortalTimeout(180); // Timeout 3 menit jika tidak ada input pengguna

  String apName = "CAMP-AI_" + String(MODULE_ID);
  Serial.printf("[WiFi] Memeriksa WiFi tersimpan atau membuka AP Portal: %s\n", apName.c_str());
  
  if (!wm.autoConnect(apName.c_str(), "campai123")) {
    Serial.println("[WiFi] Gagal terhubung dan batas waktu timeout tercapai.");
    Serial.println("[Sistem] Merestart ESP32...");
    delay(3000);
    ESP.restart();
  }

  Serial.printf("\n[WiFi] Berhasil Terhubung! IP Address: %s\n", WiFi.localIP().toString().c_str());
  
  // Sinkronisasi Waktu via NTP
  configTime(GMT_OFFSET, DST_OFFSET, NTP_SERVER);
  Serial.print("[NTP] Menunggu sinkronisasi waktu internet");
  struct tm ti;
  while (!getLocalTime(&ti, 5000)) {
    Serial.print(".");
    delay(500);
  }
  Serial.printf("\n[NTP] Waktu tersinkronkan: %02d:%02d:%02d WIB\n", ti.tm_hour, ti.tm_min, ti.tm_sec);
}

void loop() {
  struct tm now = getCurrentLocalTime();
  
  static int lastPrintSec = -1;
  static int lastSentMin = -1;

  // Status detak jantung sistem setiap 10 detik di Serial Monitor
  if (now.tm_sec != lastPrintSec && now.tm_sec % 10 == 0) {
    Serial.printf("[Standby] Menunggu jadwal... Waktu: %02d:%02d:%02d WIB\n", now.tm_hour, now.tm_min, now.tm_sec);
    lastPrintSec = now.tm_sec;
  }
  
  // Pemeriksaan jendela waktu operasional
  if (now.tm_hour >= START_HOUR && now.tm_hour < END_HOUR) {
    if (now.tm_min % INTERVAL_MIN == 0 && now.tm_min != lastSentMin) {
      lastSentMin = now.tm_min; 
      
      Serial.printf("\n[Siklus] Memulai siklus transmisi data menit ke-%d\n", now.tm_min);
      SensorData data = readSensors();
      if (data.valid) {
        sendData(data, &now);
      }
    }
  }
  
  delay(500); 
}
