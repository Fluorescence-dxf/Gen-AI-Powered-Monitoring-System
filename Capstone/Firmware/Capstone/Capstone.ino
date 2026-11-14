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
#include <esp_system.h>
#if __has_include(<esp_mac.h>)
  #include <esp_mac.h>
#endif
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// ─── TIPE DATA STRUKTUR SENSOR (Didefinisikan di atas agar dikenali compiler) ─
typedef struct { 
  float lux; 
  float dryTemp; 
  float wetTemp; 
  float rh; 
  bool valid; 
} SensorData;

// Forward declaration fungsi untuk kepatuhan C++ Arduino IDE
SensorData readSensors();
bool sendData(SensorData data, struct tm* t);

// ─── USER CONFIGURATION ─────────────────────────────────────────────────────
// Ganti dengan URL Google Apps Script Web App Deployment Anda:
const char* SCRIPT_URL        = "https://script.google.com/macros/s/AKfycbxYMh0M774TuxeMufAD4C-5Wti5IuoTMD6YSQ3JU6XIkiiZ0qvd9qbY33PQJ__b4fV2wA/exec";

// ============================================================================
// IDENTITAS MODUL & SKALABILITAS DINAMIS (1 s.d. N Modul)
// - MODULE_ID: Berikan nama modul spesifik (misal "Module1", "Module4", "Zona_Utara")
//              atau biarkan "AUTO" agar ID digenerate otomatis dari MAC Address ESP32.
// - Sensor Cahaya (BH1750) kini DIDETEKSI SECARA OTOMATIS via I2C bus saat booting.
//   Tidak perlu lagi flag manual HAS_LUX_SENSOR.
// ============================================================================
const char* MODULE_ID_CONFIG  = "AUTO"; // Ubah ke nama kustom atau biarkan "AUTO"
String      currentModuleId   = "";
bool        hasLuxSensor      = false; 

// ─── PIN ASSIGNMENT (ESP32) ────────────────────────────────────────────────
#define DRY_BULB_PIN  25   // Pin OneWire Sensor Suhu Bola Kering (DS18B20)
#define WET_BULB_PIN  33   // Pin OneWire Sensor Suhu Bola Basah (DS18B20)
#define FAN_PIN       19   // Pin Kontrol Relay Kipas Aspirasi Psikrometer

// ─── LOGIKA TRIGGER RELAY ──────────────────────────────────────────────────
// Mayoritas modul relay 5V untuk Arduino/ESP32 adalah ACTIVE LOW (LOW = Relay ON).
// Jika relay Anda tipe Active HIGH (atau jumper disetel ke HIGH), ubah nilai ini ke false.
#define RELAY_ACTIVE_LOW  false

inline void turnFanOn() {
  digitalWrite(FAN_PIN, RELAY_ACTIVE_LOW ? LOW : HIGH);
}

inline void turnFanOff() {
  digitalWrite(FAN_PIN, RELAY_ACTIVE_LOW ? HIGH : LOW);
}

// ─── WAKTU & JADWAL PENGIRIMAN ─────────────────────────────────────────────
const char* NTP_SERVER       = "pool.ntp.org";
const long  GMT_OFFSET       = 7 * 3600;   // UTC+7 (WIB)
const int   DST_OFFSET       = 0;
const int   SAMPLING_SECONDS = 60;         // Durasi sampling kipas aktif (detik)
const int   START_HOUR       = 0;          // Jam mulai pengiriman (0 - 24 untuk 24 jam)
const int   END_HOUR         = 24;         // Jam henti pengiriman
const int   INTERVAL_MIN     = 2;         // Siklus pengiriman (menit). Ubah ke 2 untuk testing cepat.
// ────────────────────────────────────────────────────────────────────────────

BH1750 lightMeter;
OneWire dryWire(DRY_BULB_PIN);
OneWire wetWire(WET_BULB_PIN);
DallasTemperature drySensor(&dryWire);
DallasTemperature wetSensor(&wetWire);

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
  turnFanOn();
  Serial.println("\n[Sistem] Menyalakan Kipas Aspirasi, stabilisasi 5 detik...");
  delay(5000);

  float sumLux = 0, sumDry = 0, sumWet = 0, sumRH = 0;
  int count = 0;
  int countLux = 0;
  unsigned long startMs = millis();
  unsigned long windowMs = (unsigned long)SAMPLING_SECONDS * 1000UL;

  Serial.println("[Sistem] Mulai membaca sensor selama 60 detik sampling window...");

  while (millis() - startMs < windowMs) {
    float lux = 0;
    if (hasLuxSensor) {
      lux = lightMeter.readLightLevel();
      if (lux >= 0) {
        sumLux += lux;
        countLux++;
      }
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
  turnFanOff();
  Serial.println("[Sistem] Periode sampling selesai, kipas dimatikan.");

  if (count > 0) {
    result.lux     = (hasLuxSensor && countLux > 0) ? (sumLux / countLux) : -1.0;
    result.dryTemp = sumDry / count;
    result.wetTemp = sumWet / count;
    result.rh      = sumRH / count;
    result.valid   = true;
    
    Serial.println("=====================================");
    Serial.printf(" HASIL RATA-RATA PENGUKURAN (%s)\n", currentModuleId.c_str());
    if (hasLuxSensor && result.lux >= 0) {
      Serial.printf(" - Intensitas Cahaya : %.2f lux\n", result.lux);
    } else {
      Serial.println(" - Intensitas Cahaya : Tidak Terpasang / Non-aktif");
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
 * Mendapatkan MAC Address perangkat langsung dari eFuse hardware
 * Aman dipanggil kapan saja tanpa memerlukan inisialisasi driver WiFi
 */
String getDeviceMac() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char buf[20];
  snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

/**
 * Menghasilkan Module ID dinamis berbasis MAC jika disetel ke "AUTO"
 */
String resolveModuleId() {
  if (String(MODULE_ID_CONFIG) != "AUTO" && strlen(MODULE_ID_CONFIG) > 0) {
    return String(MODULE_ID_CONFIG);
  }
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char buf[20];
  snprintf(buf, sizeof(buf), "Module_%02X%02X", mac[4], mac[5]);
  return String(buf);
}

/**
 * Mengirim data sensor ke Google Apps Script endpoint via HTTP POST JSON
 * Dilengkapi Anti-Collision Staggering Delay dan retry dengan backoff
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

  // ─── ANTI-COLLISION STAGGER (JITTER) ────────────────────────────────────
  // Mencegah N node menabrak LockService Google Apps Script di detik yang persis sama.
  // Delay dihitung semi-deterministik berdasarkan byte MAC address (0 - 25 detik).
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  int staggerMs = ((mac[5] + mac[4]) % 25) * 1000 + random(200, 1500);
  Serial.printf("[Stagger] Menunda pengiriman selama %d ms untuk mencegah tabrakan konkurensi...\n", staggerMs);
  delay(staggerMs);

  String payload = "{";
  payload += "\"module\":\"" + currentModuleId + "\",";
  payload += "\"mac\":\"" + getDeviceMac() + "\",";
  if (hasLuxSensor && data.lux >= 0) { 
    payload += "\"lux\":" + String(data.lux, 2) + ","; 
  } else { 
    payload += "\"lux\":null,"; 
  }
  payload += "\"dryTemp\":" + String(data.dryTemp, 2) + ",";
  payload += "\"wetTemp\":" + String(data.wetTemp, 2) + ",";
  payload += "\"rh\":" + String(data.rh, 2) + ",";
  payload += "\"rssi\":" + String(WiFi.RSSI());
  payload += "}";

  const int MAX_RETRIES = 3;
  for (int attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    HTTPClient http;
    http.begin(SCRIPT_URL);
    http.addHeader("Content-Type", "application/json");
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    http.setTimeout(15000); // Timeout HTTP client 15 detik

    Serial.printf("[HTTP] Mengirim data ke Google Apps Script (Percobaan %d/%d)...\n", attempt, MAX_RETRIES);
    int code = http.POST(payload);
    
    if (code > 0) { 
      String response = http.getString();
      if (response.indexOf("Error: Server Busy") != -1) {
        Serial.printf("[HTTP Warning] LockService Backend sibuk (Server Busy). Menunggu backoff acak...\n");
        http.end();
        delay(random(2000, 6000));
        continue;
      }
      
      Serial.printf("[HTTP] Berhasil! Kode: %d | Respons: %s\n\n", code, response.c_str()); 
      http.end(); 
      return true; 
    } else { 
      Serial.printf("[HTTP] Gagal Mengirim: %s\n", http.errorToString(code).c_str()); 
      http.end(); 
      if (attempt < MAX_RETRIES) {
        delay(random(1500, 4000));
      }
    }
  }

  Serial.println("[HTTP Error] Seluruh percobaan pengiriman gagal.");
  return false;
}

void setup() {
  // 1. Matikan Brownout Detector hardware agar lonjakan arus USB komputer tidak memicu reboot berulang
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  // 2. Segera kunci pin relay dalam kondisi MATI (OFF) di awal booting sebelum komponen lain aktif
  pinMode(FAN_PIN, OUTPUT); 
  turnFanOff();

  Serial.begin(115200);
  delay(1000);

  // Inisialisasi Wire & Deteksi Otomatis Sensor Cahaya BH1750
  Wire.begin(); 
  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) {
    hasLuxSensor = true;
    Serial.println("[BH1750] Sensor Lux terdeteksi otomatis dan aktif pada bus I2C.");
  } else {
    hasLuxSensor = false;
    Serial.println("[BH1750] Sensor Lux tidak ditemukan. Modul beroperasi dalam mode Td-Tw saja.");
  }

  // Tentukan Identitas Modul Dinamis
  currentModuleId = resolveModuleId();

  Serial.println("\n\n==========================================");
  Serial.printf(" Inisialisasi CAMP-AI Node: %s\n", currentModuleId.c_str());
  Serial.printf(" MAC Address ESP32: %s\n", getDeviceMac().c_str());
  Serial.printf(" Fitur Sensor Lux : %s\n", hasLuxSensor ? "Aktif" : "Non-aktif");
  Serial.println("==========================================");

  drySensor.begin(); 
  wetSensor.begin();

  // Inisialisasi WiFiManager dengan SSID AP unik per modul
  WiFiManager wm;
  wm.setDebugOutput(true);        // Tampilkan seluruh proses pencarian & AP di Serial Monitor
  wm.setConnectTimeout(10);       // Maksimal 10 detik coba hubungkan ke WiFi lama (agar cepat buka AP)
  wm.setConfigPortalTimeout(180); // Timeout portal 3 menit jika tidak ada konfigurasi

  String apName = "CAMP-AI_" + currentModuleId;
  Serial.printf("[WiFi] Memeriksa WiFi tersimpan atau membuka AP Portal: %s\n", apName.c_str());

  // Callback penanda saat Access Point benar-benar mulai memancar di udara
  wm.setAPCallback([](WiFiManager *myWM) {
    Serial.println("\n**************************************************");
    Serial.println(">> [AP PORTAL AKTIF] ESP32 Sedang Memancarkan WiFi!");
    Serial.printf(">> Nama WiFi (SSID) : %s\n", myWM->getConfigPortalSSID().c_str());
    Serial.println(">> Kata Sandi (PW)  : campai123");
    Serial.println(">> IP Konfigurasi   : 192.168.4.1");
    Serial.println(">> Tips: Matikan lalu nyalakan kembali WiFi di HP/Laptop agar daftar SSID ter-refresh!");
    Serial.println("**************************************************\n");
  });

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
