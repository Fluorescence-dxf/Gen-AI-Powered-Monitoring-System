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

  // Setup Sheet RawData jika belum ada (Skema Dinamis: Modul 1..N dapat teregistrasi otomatis)
  if (!ss.getSheetByName(CONFIG.SHEET_RAW)) {
    const sheet = ss.insertSheet(CONFIG.SHEET_RAW);
    sheet.appendRow(["Module1", "", "", "", "Timestamp", "Average", "", "", ""]);
    sheet.appendRow(["Lux", "DryTemp1", "WetTemp1", "RH1", "Timestamp", "DryTemp", "WetTemp", "RH", "Lux"]);
    
    sheet.getRange("A1:D1").mergeAcross();
    sheet.getRange("F1:I1").mergeAcross();
    sheet.getRange("A1:I2").setHorizontalAlignment("center").setFontWeight("bold").setBackground("#FF9900");
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
    if (h2 === "timestamp" || h1 === "timestamp") {
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
      if (h2.includes("dry")) map.avgCols.dry = c + 1;
      else if (h2.includes("wet")) map.avgCols.wet = c + 1;
      else if (h2.includes("rh")) map.avgCols.rh = c + 1;
      else if (h2.includes("lux")) map.avgCols.lux = c + 1;
    }
  }
  // Fallback nilai default average jika belum terpetakan
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
      const match = h2.match(/(Module\d+|Node\w+)/i);
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
      if (h2Lower.includes("dry")) map.modules[modKey].dryCol = colIndex;
      else if (h2Lower.includes("wet")) map.modules[modKey].wetCol = colIndex;
      else if (h2Lower.includes("rh")) map.modules[modKey].rhCol = colIndex;
      else if (h2Lower.includes("lux")) map.modules[modKey].luxCol = colIndex;
    }
  }

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
 * Mendukung sembarang Module ID secara dinamis tanpa hardcode.
 */
function processHorizontalData(sheet, dataRow) {
  const now = new Date();
  let headerMap = getHeaderMap(sheet);
  
  // 1. Registrasi modul jika ID modul belum terdaftar di kolom sheet
  let modCols = headerMap.modules[dataRow.module];
  if (!modCols) {
    modCols = ensureModuleColumns(sheet, headerMap, dataRow.module);
    headerMap = getHeaderMap(sheet); // Segarkan peta kolom setelah pergeseran
  }

  // 2. Cari baris target secara instan via getLastRow() tanpa full-column scan K:K
  const lastRow = sheet.getLastRow();
  let targetRowIndex = -1;
  
  if (lastRow > 2) {
    const lastTimestamp = sheet.getRange(lastRow, headerMap.timestampCol).getValue();
    if (lastTimestamp instanceof Date) {
      const diffMs = now.getTime() - lastTimestamp.getTime();
      // Gabungkan modul ke baris yang sama bila selisih waktu < 3 menit
      if (diffMs < CONFIG.AGGREGATION_WINDOW_MS) { 
        targetRowIndex = lastRow; 
      }
    }
  }
  
  // 3. Jika di luar jendela agregasi, alokasikan baris baru
  if (targetRowIndex === -1) {
    targetRowIndex = Math.max(lastRow + 1, 3);
    sheet.getRange(targetRowIndex, headerMap.timestampCol).setValue(now); 
  }
  
  // 4. Masukkan data sensor ke kolom modul yang telah dipetakan
  if (modCols.dryCol > 0 && dataRow.dryTemp !== undefined && dataRow.dryTemp !== null) {
    sheet.getRange(targetRowIndex, modCols.dryCol).setValue(dataRow.dryTemp);
  }
  if (modCols.wetCol > 0 && dataRow.wetTemp !== undefined && dataRow.wetTemp !== null) {
    sheet.getRange(targetRowIndex, modCols.wetCol).setValue(dataRow.wetTemp);
  }
  if (modCols.rh > 0 && dataRow.rh !== undefined && dataRow.rh !== null) {
    sheet.getRange(targetRowIndex, modCols.rh).setValue(dataRow.rh);
  }
  if (modCols.luxCol > 0 && dataRow.lux !== undefined && dataRow.lux !== null) {
    sheet.getRange(targetRowIndex, modCols.luxCol).setValue(dataRow.lux);
  }
  
  // 5. Perbarui rata-rata spasial greenhouse secara dinamis lintas seluruh modul aktif
  updateAverages(sheet, headerMap, targetRowIndex);
  
  // 6. Evaluasi ambang batas anomali mikroklimat
  checkAnomaly(dataRow);
}

/**
 * Menghitung rata-rata spasial secara dinamis untuk seluruh modul yang terdaftar
 */
function updateAverages(sheet, headerMap, rowIdx) {
  const lastCol = sheet.getLastColumn();
  const rowVals = sheet.getRange(rowIdx, 1, 1, lastCol).getValues()[0];
  
  let sumDry = 0, countDry = 0;
  let sumWet = 0, countWet = 0;
  let sumRh = 0, countRh = 0;
  let sumLux = 0, countLux = 0;
  
  Object.keys(headerMap.modules).forEach(modId => {
    const m = headerMap.modules[modId];
    if (m.dryCol > 0) {
      const val = parseFloat(rowVals[m.dryCol - 1]);
      if (!isNaN(val) && val !== 0) { sumDry += val; countDry++; }
    }
    if (m.wetCol > 0) {
      const val = parseFloat(rowVals[m.wetCol - 1]);
      if (!isNaN(val) && val !== 0) { sumWet += val; countWet++; }
    }
    if (m.rhCol > 0) {
      const val = parseFloat(rowVals[m.rhCol - 1]);
      if (!isNaN(val) && val !== 0) { sumRh += val; countRh++; }
    }
    if (m.luxCol > 0) {
      const val = parseFloat(rowVals[m.luxCol - 1]);
      if (!isNaN(val) && val > 0) { sumLux += val; countLux++; }
    }
  });
  
  const avgDry = countDry > 0 ? (sumDry / countDry).toFixed(1) : "";
  const avgWet = countWet > 0 ? (sumWet / countWet).toFixed(1) : "";
  const avgRh  = countRh  > 0 ? (sumRh  / countRh).toFixed(1)  : "";
  const avgLux = countLux > 0 ? (sumLux / countLux).toFixed(0) : "";
  
  if (headerMap.avgCols.dry > 0) sheet.getRange(rowIdx, headerMap.avgCols.dry).setValue(avgDry);
  if (headerMap.avgCols.wet > 0) sheet.getRange(rowIdx, headerMap.avgCols.wet).setValue(avgWet);
  if (headerMap.avgCols.rh > 0)  sheet.getRange(rowIdx, headerMap.avgCols.rh).setValue(avgRh);
  if (headerMap.avgCols.lux > 0 && avgLux !== "") sheet.getRange(rowIdx, headerMap.avgCols.lux).setValue(avgLux);
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
function askGemini(userMsg, plantType) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty("GEMINI_API_KEY");
  const modelName = props.getProperty("GEMINI_MODEL") || "gemini-1.5-flash";
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

  // 2. Baca riwayat obrolan terdahulu (sebelum baris yang baru saja ditambahkan)
  const allRows = chatSheet.getDataRange().getValues().slice(1);
  const priorRows = allRows.slice(0, -1).filter(c => {
    const role = c[1];
    const text = c[2];
    // Hanya masukkan percakapan valid User atau AI, abaikan log error sistem
    return (role === "User" || role === "AI") && text && String(text).trim().length > 0;
  });

  // Ambil maksimal 16 riwayat terakhir untuk efisiensi token & latensi cepat
  const recentHistory = priorRows.slice(-16);

  // 3. Susun histori dengan rotasi role yang valid (user <-> model)
  const contents = [];
  let lastRole = null;
  for (let i = 0; i < recentHistory.length; i++) {
    const currentRole = (recentHistory[i][1] === "User") ? "user" : "model";
    // Cegah dua peran identik berturut-turut yang ditolak oleh Gemini API
    if (currentRole !== lastRole) {
      contents.push({
        role: currentRole,
        parts: [{ text: String(recentHistory[i][2]) }]
      });
      lastRole = currentRole;
    }
  }

  // Jika pesan histori terakhir adalah 'user', hapus agar tidak bentrok dengan pesan saat ini
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

  // 7. Request ke Gemini REST API dengan Multi-Model Failover (Mencegah Error 503 / High Demand)
  // Urutan fallback otomatis jika Google AI mengalami lonjakan trafik pada satu model:
  const candidateModels = [modelName];
  ["gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-flash-latest"].forEach(m => {
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
      Logger.log(`[Gemini API] Mengirim request ke model: ${targetModel} (Percobaan ${i + 1}/${candidateModels.length})...`);
      
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
            Logger.log(`[Failover Sukses] Berhasil menggunakan model alternatif: ${targetModel}`);
          }
          return aiReply;
        }
      } else if (responseCode === 503 || responseCode === 429) {
        // HTTP 503: Model High Demand (Server Google sedang sibuk) atau 429: Rate limit
        Logger.log(`[Gemini Warning] Model ${targetModel} sibuk (HTTP ${responseCode}: High Demand). Beralih ke model cadangan berikutnya...`);
        Utilities.sleep(1000); // Tunggu 1 detik sebelum fallback ke model lain
        continue;
      } else {
        // Error fatal selain 503 (misal HTTP 400 invalid argument atau 403 API key salah)
        Logger.log(`[Gemini Error] Model ${targetModel} gagal (HTTP ${responseCode}): ${responseText}`);
        break;
      }
    } catch (e) {
      Logger.log(`[Gemini Exception] Error pada model ${targetModel}: ${e.message}`);
    }
  }

  // Jika seluruh model cadangan mengalami kendala:
  chatSheet.appendRow([new Date(), "SYSTEM_ERROR", `HTTP ${lastErrorCode}: ${lastErrorText}`]);
  Logger.log(`[Gemini Fatal] Seluruh model AI gagal dipanggil. Terakhir: HTTP ${lastErrorCode}`);

  return "Mohon maaf, server Google AI saat ini sedang mengalami lonjakan beban trafik (High Demand). Silakan coba kirim kembali pesan Anda dalam beberapa saat.";
}

/**
 * Fungsi Pengujian Mandiri untuk Memverifikasi Koneksi API Gemini Flash Latest
 * Jalankan fungsi ini dari dropdown Run di Google Apps Script editor.
 */
function testGeminiApi() {
  Logger.log("Memulai pengujian Gemini API (gemini-flash-latest)...");
  const testMsg = "Halo! Ini adalah tes konektivitas CAMP-AI. Berikan status ringkas kesiapan sistem.";
  const result = askGemini(testMsg, "Melon Inthanon");
  Logger.log("==================================================");
  Logger.log("RESPONS DARI GEMINI FLASH LATEST:");
  Logger.log(result);
  Logger.log("==================================================");
  return result;
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
