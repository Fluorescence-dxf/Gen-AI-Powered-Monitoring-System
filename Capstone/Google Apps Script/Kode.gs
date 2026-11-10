/**
 * ============================================================================
 * CAMP-AI: Smart Greenhouse Monitoring System - Backend Serverless
 * Departemen Teknik Mesin dan Biosistem, Fakultas Teknologi Pertanian
 * Institut Pertanian Bogor (IPB University)
 * ============================================================================
 * Arsitektur:
 * 1. doPost(e)          : Menerima payload JSON dari modul ESP32, melakukan 
 *                         agregasi data horizontal 3 modul ke Google Sheets.
 * 2. getDashboardData() : Menyediakan API data sensor terkini & riwayat tren 
 *                         untuk visualisasi Chart.js pada Web Dashboard.
 * 3. askGemini()        : Integrasi Gemini 1.5 Flash dengan agronomic context 
 *                         engineering untuk konsultasi cerdas kondisi greenhouse.
 * 4. doGet()            : Web App renderer untuk antarmuka dashboard responsif.
 * ============================================================================
 */

const CONFIG = {
  SHEET_RAW: "RawData",
  SHEET_CHAT: "ChatHistory",
  EMAIL_TARGET: Session.getEffectiveUser().getEmail(), 
  TEMP_MAX: 35.0, 
  TEMP_MIN: 18.0,
  RH_MAX: 85.0, 
  RH_MIN: 40.0,
  AGGREGATION_WINDOW_MS: 180000 // 3 Menit jendela waktu pengelompokan baris horizontal
};

// ============================================================================
// 1. SETUP & INISIALISASI DATABASE SPREADSHEET
// ============================================================================
function setup() {
  let ss;
  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty("SPREADSHEET_ID");
  
  if (existingId) {
    try { 
      ss = SpreadsheetApp.openById(existingId); 
    } catch(e) { 
      ss = null; 
    }
  }
  
  if (!ss) {
    ss = SpreadsheetApp.create("Data Sensor CampAI");
    props.setProperty("SPREADSHEET_ID", ss.getId());
  }

  // Set default Gemini model jika belum ada (gunakan gemini-1.5-flash yang memiliki kuota kapasitas stabil)
  const currentModel = props.getProperty("GEMINI_MODEL");
  if (!currentModel) {
    props.setProperty("GEMINI_MODEL", "gemini-1.5-flash");
  }

  // Setup Sheet RawData jika belum ada (Skema Standar 3 Modul + Dukungan N-Modul Dinamis)
  if (!ss.getSheetByName(CONFIG.SHEET_RAW)) {
    const sheet = ss.insertSheet(CONFIG.SHEET_RAW);
    sheet.appendRow(["Module1", "", "", "", "Module2", "", "", "Module3", "", "", "Timestamp", "Average", "", ""]);
    sheet.appendRow(["Lux", "DryTemp1", "WetTemp1", "RH1", "DryTemp2", "WetTemp2", "RH2", "DryTemp3", "WetTemp3", "RH3", "Timestamp", "DryTemp", "WetTemp", "RH"]);
    
    sheet.getRange("A1:D1").mergeAcross();
    sheet.getRange("E1:G1").mergeAcross();
    sheet.getRange("H1:J1").mergeAcross();
    sheet.getRange("L1:N1").mergeAcross();
    sheet.getRange("A1:N2").setHorizontalAlignment("center").setFontWeight("bold").setBackground("#FF9900");
    sheet.setFrozenRows(2);
  }
  
  // Setup Sheet ChatHistory jika belum ada
  if (!ss.getSheetByName(CONFIG.SHEET_CHAT)) {
    const chatSheet = ss.insertSheet(CONFIG.SHEET_CHAT);
    chatSheet.appendRow(["Timestamp", "Role", "Message"]);
    chatSheet.getRange("A1:C1").setFontWeight("bold").setBackground("#D9E1F2");
    chatSheet.setFrozenRows(1);
  }
  
  // Hapus sheet default bawaan 'Sheet1'
  const defaultSheet = ss.getSheetByName("Sheet1");
  if (defaultSheet) {
    try { ss.deleteSheet(defaultSheet); } catch(e) {}
  }

  Logger.log("Setup Berhasil!");
  Logger.log("Spreadsheet ID: " + ss.getId());
  Logger.log("Spreadsheet URL: " + ss.getUrl());
  return "Setup Berhasil! ID: " + ss.getId();
}

// ============================================================================
// 2. REGISTRI KOLOM & SKALABILITAS DINAMIS MULTI-MODUL (1 s.d. N Modul)
// ============================================================================

/**
 * Memetakan seluruh kolom sheet RawData secara dinamis berdasarkan baris header
 * Mendukung skema legacy (14 kolom) maupun penambahan kolom modul tak terbatas (N-modul).
 */
function getHeaderMap(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 14);
  const r1 = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const r2 = sheet.getRange(2, 1, 1, lastCol).getValues()[0];
  
  const map = {
    timestampCol: -1,
    avgCols: { dry: -1, wet: -1, rh: -1, lux: -1 },
    modules: {}, // moduleId -> { dryCol, wetCol, rhCol, luxCol }
    lastCol: sheet.getLastColumn()
  };
  
  // 1. Temukan kolom Timestamp
  for (let c = 0; c < lastCol; c++) {
    const h2 = String(r2[c] || "").trim().toLowerCase();
    const h1 = String(r1[c] || "").trim().toLowerCase();
    if (h2.includes("timestamp") || h1.includes("timestamp") || h2.includes("waktu") || h1.includes("waktu")) {
      map.timestampCol = c + 1; // 1-indexed
      break;
    }
  }
  if (map.timestampCol === -1) map.timestampCol = 11; // Fallback legacy Col K
  
  // 2. Temukan kolom Rata-rata Spasial (Average)
  let inAverageSection = false;
  for (let c = 0; c < lastCol; c++) {
    const h1 = String(r1[c] || "").trim().toLowerCase();
    const h2 = String(r2[c] || "").trim().toLowerCase();
    if (h1.includes("average") || h1.includes("avg") || h1.includes("rata")) {
      inAverageSection = true;
    }
    if (inAverageSection || c + 1 > map.timestampCol) {
      if (h2.includes("dry") || h2.includes("kering") || h2.includes("td")) map.avgCols.dry = c + 1;
      else if (h2.includes("wet") || h2.includes("basah") || h2.includes("tw")) map.avgCols.wet = c + 1;
      else if (h2.includes("rh") || h2.includes("hum") || h2.includes("kelembaban") || h2.includes("kelembapan") || h2.includes("lembab") || h2.includes("lembap")) map.avgCols.rh = c + 1;
      else if (h2.includes("lux") || h2.includes("cahaya") || h2.includes("light")) map.avgCols.lux = c + 1;
    }
  }
  // Fallback nilai default average jika belum terpetakan (layout standar: 12=Dry, 13=Wet, 14=RH)
  if (map.avgCols.dry === -1) map.avgCols.dry = 12;
  if (map.avgCols.wet === -1) map.avgCols.wet = 13;
  if (map.avgCols.rh === -1) map.avgCols.rh = 14;

  // 3. Petakan modul-modul yang terdaftar di sheet
  let currentModule = "";
  for (let c = 0; c < lastCol; c++) {
    const colIndex = c + 1;
    if (colIndex === map.timestampCol || 
        colIndex === map.avgCols.dry || 
        colIndex === map.avgCols.wet || 
        colIndex === map.avgCols.rh || 
        colIndex === map.avgCols.lux) {
      continue;
    }

    const h1 = String(r1[c] || "").trim();
    if (h1 && !h1.toLowerCase().includes("average") && !h1.toLowerCase().includes("timestamp")) {
      currentModule = h1;
    }

    const h2 = String(r2[c] || "").trim();
    let modKey = currentModule;
    if (!modKey) {
      const match = h2.match(/(Module\s*\d+|Node\s*\w+)/i);
      if (match) modKey = match[1];
    }
    // Fallback kompatibilitas sheet legacy 3-modul
    if (!modKey) {
      if (colIndex >= 1 && colIndex <= 4) modKey = "Module1";
      else if (colIndex >= 5 && colIndex <= 7) modKey = "Module2";
      else if (colIndex >= 8 && colIndex <= 10) modKey = "Module3";
    }

    if (modKey) {
      if (!map.modules[modKey]) {
        map.modules[modKey] = { dryCol: -1, wetCol: -1, rhCol: -1, luxCol: -1 };
      }
      const h2Lower = h2.toLowerCase();
      if (h2Lower.includes("dry") || h2Lower.includes("kering") || h2Lower.includes("td")) {
        map.modules[modKey].dryCol = colIndex;
      } else if (h2Lower.includes("wet") || h2Lower.includes("basah") || h2Lower.includes("tw")) {
        map.modules[modKey].wetCol = colIndex;
      } else if (h2Lower.includes("rh") || h2Lower.includes("hum") || h2Lower.includes("kelembaban") || h2Lower.includes("kelembapan") || h2Lower.includes("lembab") || h2Lower.includes("lembap")) {
        map.modules[modKey].rhCol = colIndex;
      } else if (h2Lower.includes("lux") || h2Lower.includes("cahaya") || h2Lower.includes("light")) {
        map.modules[modKey].luxCol = colIndex;
      }
    }
  }

  // 4. Pastikan 3 modul bawaan selalu terdaftar dengan fallback kolom default (anti-gagal)
  if (!map.modules["Module1"]) map.modules["Module1"] = { luxCol: 1, dryCol: 2, wetCol: 3, rhCol: 4 };
  if (!map.modules["Module2"]) map.modules["Module2"] = { luxCol: -1, dryCol: 5, wetCol: 6, rhCol: 7 };
  if (!map.modules["Module3"]) map.modules["Module3"] = { luxCol: -1, dryCol: 8, wetCol: 9, rhCol: 10 };

  if (map.modules["Module1"].luxCol === -1) map.modules["Module1"].luxCol = 1;
  if (map.modules["Module1"].dryCol === -1) map.modules["Module1"].dryCol = 2;
  if (map.modules["Module1"].wetCol === -1) map.modules["Module1"].wetCol = 3;
  if (map.modules["Module1"].rhCol === -1)  map.modules["Module1"].rhCol = 4;

  if (map.modules["Module2"].dryCol === -1) map.modules["Module2"].dryCol = 5;
  if (map.modules["Module2"].wetCol === -1) map.modules["Module2"].wetCol = 6;
  if (map.modules["Module2"].rhCol === -1)  map.modules["Module2"].rhCol = 7;

  if (map.modules["Module3"].dryCol === -1) map.modules["Module3"].dryCol = 8;
  if (map.modules["Module3"].wetCol === -1) map.modules["Module3"].wetCol = 9;
  if (map.modules["Module3"].rhCol === -1)  map.modules["Module3"].rhCol = 10;

  // Pasangkan juga alias dengan spasi agar pencarian 'Module 1' cocok dengan 'Module1'
  map.modules["Module 1"] = map.modules["Module1"];
  map.modules["Module 2"] = map.modules["Module2"];
  map.modules["Module 3"] = map.modules["Module3"];

  return map;
}

/**
 * Mendaftarkan modul baru secara dinamis ke header sheet tanpa merusak kolom yang ada
 */
function ensureModuleColumns(sheet, headerMap, moduleId) {
  if (headerMap.modules[moduleId]) {
    return headerMap.modules[moduleId];
  }

  // Modul baru terdeteksi: Sisipkan 4 kolom tepat sebelum Timestamp
  const insertPos = headerMap.timestampCol;
  sheet.insertColumnsBefore(insertPos, 4);

  // Set Header Baris 1: Nama Modul di-merge across 4 kolom
  sheet.getRange(1, insertPos, 1, 4).mergeAcross().setValue(moduleId)
    .setHorizontalAlignment("center").setFontWeight("bold").setBackground("#FF9900");

  // Set Header Baris 2: Sub-parameter
  sheet.getRange(2, insertPos, 1, 4).setValues([["Lux", moduleId + "_DryTemp", moduleId + "_WetTemp", moduleId + "_RH"]])
    .setHorizontalAlignment("center").setFontWeight("bold").setBackground("#FF9900");

  // Muat ulang header map setelah kolom baru terbentuk
  return getHeaderMap(sheet).modules[moduleId];
}

// ============================================================================
// 3. INGESTION DATA & LOGIKA PENGELOMPOKAN HORIZONTAL (ESP32 -> GAS)
// ============================================================================
function doPost(e) {
  // Gunakan batas maksimal LockService (30 detik) untuk menangani lonjakan konkurensi N node
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return ContentService.createTextOutput("Error: Server Busy").setMimeType(ContentService.MimeType.TEXT);
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const ssId = props.getProperty("SPREADSHEET_ID");
    if (!ssId) {
      throw new Error("SPREADSHEET_ID belum dikonfigurasi. Jalankan fungsi setup() terlebih dahulu.");
    }

    const ss = SpreadsheetApp.openById(ssId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_RAW);
    const dataRow = JSON.parse(e.postData.contents);
    
    processHorizontalData(sheet, dataRow);
    
    return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    Logger.log("doPost Error: " + err.message);
    return ContentService.createTextOutput("Error: " + err.message).setMimeType(ContentService.MimeType.TEXT);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Menempatkan data modul ke baris yang sama bila berada dalam jendela waktu 3 menit
 * Mendukung sembarang Module ID secara dinamis dengan penulisan batch atomik
 */
function processHorizontalData(sheet, dataRow) {
  const now = new Date();
  let headerMap = getHeaderMap(sheet);
  
  // 1. Registrasi modul jika ID modul belum terdaftar di kolom sheet (toleran spasi dan huruf besar/kecil)
  const rawModId = String(dataRow.module || "").trim();
  const cleanModId = rawModId.replace(/\s+/g, "");
  let modCols = headerMap.modules[rawModId] || headerMap.modules[cleanModId];
  if (!modCols) {
    for (const key of Object.keys(headerMap.modules)) {
      if (key.toLowerCase().replace(/\s+/g, "") === cleanModId.toLowerCase()) {
        modCols = headerMap.modules[key];
        break;
      }
    }
  }
  if (!modCols) {
    modCols = ensureModuleColumns(sheet, headerMap, rawModId);
    headerMap = getHeaderMap(sheet); // Segarkan peta kolom setelah pergeseran
  }

  // 2. Cari baris target secara instan via getLastRow() tanpa scan kolom K:K
  const lastRow = sheet.getLastRow();
  let targetRowIndex = -1;
  
  if (lastRow > 2) {
    const lastTimestamp = sheet.getRange(lastRow, headerMap.timestampCol).getValue();
    let tsDate = null;
    if (lastTimestamp instanceof Date) {
      tsDate = lastTimestamp;
    } else if (lastTimestamp) {
      const parsed = new Date(lastTimestamp);
      if (!isNaN(parsed.getTime())) tsDate = parsed;
    }

    if (tsDate) {
      const diffMs = Math.abs(now.getTime() - tsDate.getTime());
      // Gabungkan modul ke baris yang sama bila selisih waktu < 3 menit
      if (diffMs < CONFIG.AGGREGATION_WINDOW_MS) { 
        targetRowIndex = lastRow; 
      }
    }
  }
  
  // 3. Jika di luar jendela agregasi, alokasikan baris baru
  if (targetRowIndex === -1) {
    targetRowIndex = Math.max(lastRow + 1, 3);
  }

  // Hitung jumlah kolom minimum yang diperlukan agar array mencakup seluruh parameter
  let maxColNeeded = Math.max(sheet.getLastColumn(), 14, headerMap.timestampCol, headerMap.avgCols.rh);
  Object.values(headerMap.modules).forEach(m => {
    if (m.dryCol > maxColNeeded) maxColNeeded = m.dryCol;
    if (m.wetCol > maxColNeeded) maxColNeeded = m.wetCol;
    if (m.rhCol > maxColNeeded) maxColNeeded = m.rhCol;
    if (m.luxCol > maxColNeeded) maxColNeeded = m.luxCol;
  });

  // Baca seluruh nilai baris target ke memori
  let rowVals = sheet.getRange(targetRowIndex, 1, 1, maxColNeeded).getValues()[0];
  while (rowVals.length < maxColNeeded) {
    rowVals.push("");
  }
  
  // Set Timestamp pada kolom timestamp
  rowVals[headerMap.timestampCol - 1] = now;

  // 4. Masukkan data sensor modul ke array rowVals secara numerik
  if (modCols.dryCol > 0 && dataRow.dryTemp !== undefined && dataRow.dryTemp !== null && String(dataRow.dryTemp).trim() !== "") {
    rowVals[modCols.dryCol - 1] = Number(dataRow.dryTemp);
  }
  if (modCols.wetCol > 0 && dataRow.wetTemp !== undefined && dataRow.wetTemp !== null && String(dataRow.wetTemp).trim() !== "") {
    rowVals[modCols.wetCol - 1] = Number(dataRow.wetTemp);
  }
  if (modCols.rhCol > 0 && dataRow.rh !== undefined && dataRow.rh !== null && String(dataRow.rh).trim() !== "") {
    rowVals[modCols.rhCol - 1] = Number(dataRow.rh);
  }
  if (modCols.luxCol > 0 && dataRow.lux !== undefined && dataRow.lux !== null && String(dataRow.lux).trim() !== "") {
    rowVals[modCols.luxCol - 1] = Number(dataRow.lux);
  }

  // 5. Hitung rata-rata spasial greenhouse secara langsung di memori
  let sumDry = 0, countDry = 0;
  let sumWet = 0, countWet = 0;
  let sumRh = 0, countRh = 0;
  let sumLux = 0, countLux = 0;

  // Kumpulkan modul unik berdasarkan posisi kolom fisik untuk mencegah duplikasi hitung akibat alias nama
  const seenModuleColumns = new Set();
  Object.keys(headerMap.modules).forEach(modId => {
    const m = headerMap.modules[modId];
    const signature = `${m.dryCol}_${m.wetCol}_${m.rhCol}`;
    if (seenModuleColumns.has(signature)) return;
    seenModuleColumns.add(signature);

    if (m.dryCol > 0 && m.dryCol <= rowVals.length) {
      const val = parseFloat(rowVals[m.dryCol - 1]);
      if (!isNaN(val) && val !== 0) { sumDry += val; countDry++; }
    }
    if (m.wetCol > 0 && m.wetCol <= rowVals.length) {
      const val = parseFloat(rowVals[m.wetCol - 1]);
      if (!isNaN(val) && val !== 0) { sumWet += val; countWet++; }
    }
    if (m.rhCol > 0 && m.rhCol <= rowVals.length) {
      const val = parseFloat(rowVals[m.rhCol - 1]);
      if (!isNaN(val) && val !== 0) { sumRh += val; countRh++; }
    }
    if (m.luxCol > 0 && m.luxCol <= rowVals.length) {
      const val = parseFloat(rowVals[m.luxCol - 1]);
      if (!isNaN(val) && val > 0) { sumLux += val; countLux++; }
    }
  });

  const avgDry = countDry > 0 ? Number((sumDry / countDry).toFixed(1)) : "";
  const avgWet = countWet > 0 ? Number((sumWet / countWet).toFixed(1)) : "";
  const avgRh  = countRh  > 0 ? Number((sumRh  / countRh).toFixed(1))  : "";
  const avgLux = countLux > 0 ? Number((sumLux / countLux).toFixed(0)) : "";

  if (headerMap.avgCols.dry > 0) rowVals[headerMap.avgCols.dry - 1] = avgDry;
  if (headerMap.avgCols.wet > 0) rowVals[headerMap.avgCols.wet - 1] = avgWet;
  if (headerMap.avgCols.rh > 0)  rowVals[headerMap.avgCols.rh - 1]  = avgRh;
  if (headerMap.avgCols.lux > 0 && avgLux !== "") rowVals[headerMap.avgCols.lux - 1] = avgLux;

  // 6. Tulis seluruh baris sekaligus dalam 1 kali operasi API (Atomik, Cepat & Pasti Masuk)
  sheet.getRange(targetRowIndex, 1, 1, rowVals.length).setValues([rowVals]);
  SpreadsheetApp.flush();

  // 7. Evaluasi ambang batas anomali mikroklimat
  checkAnomaly(dataRow);
}

// ============================================================================
// 4. DETEKSI ANOMALI & NOTIFIKASI EMAIL
// ============================================================================
function checkAnomaly(dataRow) {
  const props = PropertiesService.getScriptProperties();
  const lastEmailTime = parseInt(props.getProperty("LAST_EMAIL_TIME")) || 0;
  const now = new Date().getTime();
  let alerts = [];
  
  if (dataRow.dryTemp > CONFIG.TEMP_MAX) alerts.push(`Suhu terlalu panas: ${dataRow.dryTemp}°C (Maks: ${CONFIG.TEMP_MAX}°C)`);
  if (dataRow.dryTemp < CONFIG.TEMP_MIN) alerts.push(`Suhu terlalu dingin: ${dataRow.dryTemp}°C (Min: ${CONFIG.TEMP_MIN}°C)`);
  if (dataRow.rh > CONFIG.RH_MAX) alerts.push(`Kelembapan udara terlalu tinggi: ${dataRow.rh}% (Maks: ${CONFIG.RH_MAX}%)`);
  if (dataRow.rh < CONFIG.RH_MIN) alerts.push(`Kelembapan udara terlalu rendah: ${dataRow.rh}% (Min: ${CONFIG.RH_MIN}%)`);

  // Throttling notifikasi email: maksimal 1 email per jam
  if (alerts.length > 0 && (now - lastEmailTime > 3600000)) {
    MailApp.sendEmail({
      to: CONFIG.EMAIL_TARGET,
      subject: "⚠️ PERINGATAN ANOMALI: Greenhouse CAMP-AI Monitor",
      htmlBody: `
        <h2>Peringatan Mikroklimat Greenhouse</h2>
        <p><strong>Sumber Modul:</strong> ${dataRow.module}</p>
        <p><strong>Waktu Terdeteksi:</strong> ${new Date().toLocaleString("id-ID")}</p>
        <ul>
          <li>${alerts.join("</li><li>")}</li>
        </ul>
        <p>Silakan periksa ventilasi, naungan, atau sistem irigasi greenhouse Anda.</p>
      `
    });
    props.setProperty("LAST_EMAIL_TIME", now.toString());
  }
}

// ============================================================================
// 5. DATA PROVIDER UNTUK DASHBOARD UI (Dinamis N-Modul)
// ============================================================================
function getDashboardData() {
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty("SPREADSHEET_ID");
  if (!ssId) return { latest: null, status: "Spreadsheet ID not set" };

  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_RAW);
  const rows = sheet.getDataRange().getValues();
  
  if (rows.length <= 2) return { latest: null, status: "No Data" };
  
  const headerMap = getHeaderMap(sheet);
  const tsIdx = headerMap.timestampCol - 1;
  const dryIdx = headerMap.avgCols.dry - 1;
  const wetIdx = headerMap.avgCols.wet - 1;
  const rhIdx = headerMap.avgCols.rh - 1;
  
  // Dapatkan nilai lux rata-rata atau dari modul pertama yang memiliki sensor lux
  let luxIdx = headerMap.avgCols.lux > 0 ? (headerMap.avgCols.lux - 1) : -1;
  if (luxIdx === -1) {
    for (const m of Object.values(headerMap.modules)) {
      if (m.luxCol > 0) { luxIdx = m.luxCol - 1; break; }
    }
  }
  if (luxIdx === -1) luxIdx = 0; // Fallback legacy
  
  const recentData = rows.slice(2).slice(-12);
  const latest = recentData[recentData.length - 1];
  const safeDate = (dateObj) => (dateObj instanceof Date) ? dateObj.toISOString() : String(dateObj);
  
  const activeModules = Object.keys(headerMap.modules);
  
  return {
    moduleCount: activeModules.length,
    activeModules: activeModules,
    latest: {
      timestamp: safeDate(latest[tsIdx]), 
      lux: (luxIdx >= 0 ? latest[luxIdx] : 0) || 0, 
      dry: (dryIdx >= 0 ? latest[dryIdx] : 0) || 0, 
      wet: (wetIdx >= 0 ? latest[wetIdx] : 0) || 0, 
      rh: (rhIdx >= 0 ? latest[rhIdx] : 0) || 0 
    },
    trend: recentData.map(r => ({ 
      ts: safeDate(r[tsIdx]),             
      lux: (luxIdx >= 0 ? r[luxIdx] : 0) || 0, 
      dry: (dryIdx >= 0 ? r[dryIdx] : 0) || 0, 
      wet: (wetIdx >= 0 ? r[wetIdx] : 0) || 0, 
      rh: (rhIdx >= 0 ? r[rhIdx] : 0) || 0 
    }))
  };
}

// ============================================================================
// 5. ASISTEN AGRONOMI GEMINI AI (Generative Language API)
// ============================================================================

/**
 * Mengambil daftar model AI aktif yang mendukung 'generateContent' secara dinamis dari Google AI
 * Menyaring model yang benar-benar tersedia untuk API Key pengguna.
 */
function getAvailableGeminiModels(apiKey) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("ACTIVE_GEMINI_MODELS");
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }

  // Daftar fallback urutan prioritas jika ListModels tidak dapat diakses
  const fallbackList = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-exp",
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash-002",
    "gemini-1.5-flash-001",
    "gemini-1.5-flash-8b",
    "gemini-flash-latest",
    "gemini-pro"
  ];

  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = UrlFetchApp.fetch(listUrl, {
      method: "get",
      muteHttpExceptions: true
    });
    
    if (res.getResponseCode() === 200) {
      const data = JSON.parse(res.getContentText());
      if (data.models && Array.isArray(data.models)) {
        // Ambil hanya model yang mendukung generateContent
        const supported = data.models
          .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
          .map(m => m.name.replace(/^models\//, ""));
        
        // Urutkan model Flash di posisi paling atas karena paling cepat dan efisien
        supported.sort((a, b) => {
          const aFlash = a.toLowerCase().includes("flash") ? 1 : 0;
          const bFlash = b.toLowerCase().includes("flash") ? 1 : 0;
          return bFlash - aFlash;
        });

        if (supported.length > 0) {
          cache.put("ACTIVE_GEMINI_MODELS", JSON.stringify(supported), 21600); // Simpan di cache selama 6 jam
          return supported;
        }
      }
    }
  } catch(e) {
    Logger.log("Gagal memanggil ModelService.ListModels: " + e.message);
  }

  return fallbackList;
}

function askGemini(userMsg, plantType) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty("GEMINI_API_KEY");
  const configuredModel = (props.getProperty("GEMINI_MODEL") || "").trim();
  const ssId = props.getProperty("SPREADSHEET_ID");
  
  if (!apiKey) {
    return "⚠️ Kunci API Gemini belum dikonfigurasi. Silakan atur 'GEMINI_API_KEY' di Script Properties Google Apps Script (Project Settings).";
  }

  if (!ssId) {
    return "⚠️ Database Spreadsheet belum diatur. Silakan jalankan fungsi setup() terlebih dahulu.";
  }

  const ss = SpreadsheetApp.openById(ssId);
  let chatSheet = ss.getSheetByName(CONFIG.SHEET_CHAT);
  if (!chatSheet) {
    chatSheet = ss.insertSheet(CONFIG.SHEET_CHAT);
    chatSheet.appendRow(["Timestamp", "Role", "Message"]);
  }
  
  // 1. Simpan pesan user saat ini ke database obrolan
  chatSheet.appendRow([new Date(), "User", userMsg]);

  // 2. Baca riwayat obrolan terdahulu
  const allRows = chatSheet.getDataRange().getValues().slice(1);
  const priorRows = allRows.slice(0, -1).filter(c => {
    const role = c[1];
    const text = c[2];
    return (role === "User" || role === "AI") && text && String(text).trim().length > 0;
  });

  const recentHistory = priorRows.slice(-16);

  // 3. Susun histori dengan rotasi role yang valid (user <-> model)
  const contents = [];
  let lastRole = null;
  for (let i = 0; i < recentHistory.length; i++) {
    const currentRole = (recentHistory[i][1] === "User") ? "user" : "model";
    if (currentRole !== lastRole) {
      contents.push({
        role: currentRole,
        parts: [{ text: String(recentHistory[i][2]) }]
      });
      lastRole = currentRole;
    }
  }

  if (contents.length > 0 && contents[contents.length - 1].role === "user") {
    contents.pop();
  }

  // 4. Ambil konteks mikroklimat terkini dari greenhouse
  const data = getDashboardData();
  let context = "Belum ada data sensor terkini.";
  if (data && data.trend && data.trend.length > 0) {
    context = JSON.stringify(data.trend);
  }

  // 5. System Prompt Spesialis Agronomi
  const systemPrompt = `Kamu adalah CAMP-AI, asisten ahli agronomi dan iklim mikro untuk Smart Greenhouse IPB University yang membantu petani / pengelola greenhouse mengambil keputusan praktis berbasis data real-time.

Panduan respons:
- Jelaskan kondisi mikroklimat saat ini secara ringkas (1–2 kalimat, langsung ke inti, mudah dipahami).
- Berikan rekomendasi tindakan operasional yang spesifik dan langsung bisa diterapkan di greenhouse (ventilasi, evaporative cooling, paranet/naungan, sirkulasi udara, atau irigasi).
- Fokus pada maksimal 3 tindakan paling penting, urut dari yang paling berdampak.
- Gunakan bahasa Indonesia yang santun, profesional, aplikatif, dan mudah dieksekusi di lapangan.

Batasan:
- Data sensor yang tersedia mencakup: Suhu Bola Basah (°C), Suhu Bola Kering (°C), Kelembapan Relatif / RH (%), dan Intensitas Cahaya (lux).
- Jika terjadi kondisi stres panas atau kelembapan ekstrem:
  • Jelaskan indikasi penyebab utama
  • Dampak fisiologis pada tanaman
  • Solusi mitigasi cepat`;

  // 6. Masukkan pesan user terkini yang diperkaya konteks greenhouse
  const enrichedUserMsg = `[KONTEKS GREENHOUSE -> Komoditas Tanaman: ${plantType || "Umum"} | Data Tren Sensor (Rata-rata Spasial): ${context}]\nPertanyaan Pengguna: ${userMsg}`;
  contents.push({ 
    role: "user", 
    parts: [{ text: enrichedUserMsg }] 
  });

  // 7. Request ke Gemini REST API dengan Multi-Model Failover Otomatis
  // Ambil daftar model aktif yang tersedia di akun Google AI pengguna secara real-time
  const liveModels = getAvailableGeminiModels(apiKey);
  const candidateModels = [];
  if (configuredModel) candidateModels.push(configuredModel);
  liveModels.forEach(m => {
    if (!candidateModels.includes(m)) candidateModels.push(m);
  });

  const payload = {
    system_instruction: { 
      parts: [{ text: systemPrompt }] 
    },
    contents: contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 800
    }
  };

  let lastErrorText = "";
  let lastErrorCode = 0;

  for (let i = 0; i < candidateModels.length; i++) {
    const targetModel = candidateModels[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

    try {
      Logger.log(`[Gemini API] Mengirim request ke model: ${targetModel} (Kandidat ${i + 1}/${candidateModels.length})...`);
      
      const res = UrlFetchApp.fetch(endpoint, {
        method: "post", 
        contentType: "application/json", 
        muteHttpExceptions: true, 
        payload: JSON.stringify(payload)
      });
      
      const responseCode = res.getResponseCode();
      const responseText = res.getContentText();
      lastErrorCode = responseCode;
      lastErrorText = responseText;

      if (responseCode === 200) {
        const responseData = JSON.parse(responseText);
        if (responseData.candidates && responseData.candidates.length > 0) {
          const aiReply = responseData.candidates[0].content.parts[0].text;
          chatSheet.appendRow([new Date(), "AI", aiReply]);
          if (i > 0) {
            Logger.log(`[Failover Sukses] Model '${targetModel}' berhasil menjawab setelah model sebelumnya tidak tersedia.`);
          }
          return aiReply;
        }
      } else if (responseCode === 503 || responseCode === 429 || responseCode === 404) {
        // 503: High Demand (Server Sibuk), 429: Rate Limit, 404: Model Not Found pada versi API ini
        Logger.log(`[Gemini Warning] Model '${targetModel}' tidak dapat digunakan saat ini (HTTP ${responseCode}). Otomatis beralih ke model berikutnya...`);
        Utilities.sleep(500); // Jeda singkat 500ms sebelum mencoba model cadangan
        continue;
      } else {
        // Error otentikasi fatal (misal HTTP 400 Invalid Argument atau HTTP 403 API Key salah)
        Logger.log(`[Gemini Fatal Error] Model '${targetModel}' gagal (HTTP ${responseCode}): ${responseText}`);
        break;
      }
    } catch (e) {
      Logger.log(`[Gemini Exception] Error pada model '${targetModel}': ${e.message}`);
    }
  }

  // Jika seluruh model cadangan mengalami kendala:
  chatSheet.appendRow([new Date(), "SYSTEM_ERROR", `HTTP ${lastErrorCode}: ${lastErrorText}`]);
  Logger.log(`[Gemini Fatal] Seluruh kandidat model AI gagal dipanggil. Terakhir: HTTP ${lastErrorCode} - ${lastErrorText}`);

  return "Mohon maaf, layanan Google AI saat ini sedang mengalami lonjakan beban trafik (High Demand). Silakan coba kembali dalam beberapa saat.";
}

/**
 * Fungsi Diagnostik untuk Memeriksa Semua Model yang Aktif & Didukung pada Kunci API Anda
 * Jalankan fungsi ini dari dropdown Run di editor Google Apps Script.
 */
function checkAvailableModels() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty("GEMINI_API_KEY");
  if (!apiKey) {
    Logger.log("⚠️ API Key belum disetel di Script Properties (GEMINI_API_KEY)!");
    return;
  }
  
  Logger.log("Memeriksa daftar model yang aktif dan didukung langsung dari Google AI API...");
  // Hapus cache agar mendapatkan data segar langsung dari Google
  CacheService.getScriptCache().remove("ACTIVE_GEMINI_MODELS");
  
  const models = getAvailableGeminiModels(apiKey);
  Logger.log("==================================================");
  Logger.log(`DITEMUKAN ${models.length} MODEL YANG AKTIF & MENDUKUNG generateContent:`);
  models.forEach((m, idx) => {
    Logger.log(` ${idx + 1}. ${m}`);
  });
  Logger.log("==================================================");
}

/**
 * Fungsi Pengujian Mandiri untuk Memverifikasi Koneksi API Gemini dengan Auto-Failover
 * Jalankan fungsi ini dari dropdown Run di Google Apps Script editor.
 */
function testGeminiApi() {
  Logger.log("Memulai pengujian Gemini API (dengan Auto-Failover Dinamis)...");
  const testMsg = "Halo! Ini adalah tes konektivitas CAMP-AI. Berikan status ringkas kesiapan sistem.";
  const result = askGemini(testMsg, "Melon Inthanon");
  Logger.log("==================================================");
  Logger.log("RESPONS DARI GEMINI AI:");
  Logger.log(result);
  Logger.log("==================================================");
  return result;
}

/**
 * Fungsi Pengujian Mandiri untuk Memverifikasi Ingestion Batch 3 Modul (Termasuk Nilai RH)
 * Jalankan fungsi ini dari dropdown Run di Google Apps Script editor untuk memverifikasi penulisan sel secara langsung.
 */
function testBatchSimulation() {
  Logger.log("Memulai simulasi penulisan 3 modul langsung ke sheet...");
  const ssId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!ssId) {
    Logger.log("⚠️ SPREADSHEET_ID belum diatur. Jalankan setup() terlebih dahulu.");
    return "Error: SPREADSHEET_ID belum diatur";
  }
  
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_RAW);
  const headerMap = getHeaderMap(sheet);
  
  Logger.log("Peta Kolom Modul: " + JSON.stringify(headerMap.modules));
  Logger.log("Peta Kolom Rata-rata: " + JSON.stringify(headerMap.avgCols));
  
  const p1 = { module: "Module1", dryTemp: 29.5, wetTemp: 24.5, rh: 65.2, lux: 28000 };
  const p2 = { module: "Module2", dryTemp: 29.0, wetTemp: 24.2, rh: 66.8 };
  const p3 = { module: "Module3", dryTemp: 29.8, wetTemp: 24.6, rh: 64.5 };
  
  Logger.log("1. Mengirim Module1 (Td=29.5, Tw=24.5, RH=65.2)...");
  processHorizontalData(sheet, p1);
  Logger.log("2. Mengirim Module2 (Td=29.0, Tw=24.2, RH=66.8)...");
  processHorizontalData(sheet, p2);
  Logger.log("3. Mengirim Module3 (Td=29.8, Tw=24.6, RH=64.5)...");
  processHorizontalData(sheet, p3);
  
  SpreadsheetApp.flush();
  
  const lastRow = sheet.getLastRow();
  const maxCol = Math.max(sheet.getLastColumn(), 14);
  const resultRow = sheet.getRange(lastRow, 1, 1, maxCol).getValues()[0];
  
  const rh1 = headerMap.modules["Module1"] ? resultRow[headerMap.modules["Module1"].rhCol - 1] : "N/A";
  const rh2 = headerMap.modules["Module2"] ? resultRow[headerMap.modules["Module2"].rhCol - 1] : "N/A";
  const rh3 = headerMap.modules["Module3"] ? resultRow[headerMap.modules["Module3"].rhCol - 1] : "N/A";
  const avgRh = headerMap.avgCols.rh > 0 ? resultRow[headerMap.avgCols.rh - 1] : "N/A";

  Logger.log("==================================================");
  Logger.log(`HASIL VERIFIKASI PADA BARIS ${lastRow}:`);
  Logger.log(` - RH Module 1 : ${rh1} %`);
  Logger.log(` - RH Module 2 : ${rh2} %`);
  Logger.log(` - RH Module 3 : ${rh3} %`);
  Logger.log(` - Average RH  : ${avgRh} %`);
  Logger.log("Seluruh baris: " + JSON.stringify(resultRow));
  Logger.log("==================================================");

  return {
    row: lastRow,
    rh1: rh1,
    rh2: rh2,
    rh3: rh3,
    avgRh: avgRh,
    fullRow: resultRow
  };
}

// ============================================================================
// 6. WEB APPLICATION HANDLER
// ============================================================================
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('CAMP-AI: Smart Greenhouse Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
