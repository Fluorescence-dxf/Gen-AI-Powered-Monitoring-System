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

  // Set default Gemini model jika belum ada
  if (!props.getProperty("GEMINI_MODEL")) {
    props.setProperty("GEMINI_MODEL", "gemini-1.5-flash");
  }

  // Setup Sheet RawData jika belum ada
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
// 2. INGESTION DATA & LOGIKA PENGELOMPOKAN HORIZONTAL (ESP32 -> GAS)
// ============================================================================
function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
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
 */
function processHorizontalData(sheet, dataRow) {
  const now = new Date();
  
  // Cari baris terakhir berdasarkan kolom Timestamp (Kolom K / 11)
  const timestamps = sheet.getRange("K:K").getValues();
  let lastRow = 0;
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i][0] !== "") {
      lastRow = i + 1;
      break;
    }
  }

  let targetRowIndex = -1;
  
  // Jika baris terakhir bukan header, periksa selisih waktu
  if (lastRow > 2) {
    const lastTimestamp = sheet.getRange(lastRow, 11).getValue();
    if (lastTimestamp instanceof Date) {
      const diffMs = now.getTime() - lastTimestamp.getTime();
      // Gabungkan modul ke baris yang sama bila selisih waktu < 3 menit
      if (diffMs < CONFIG.AGGREGATION_WINDOW_MS) { 
        targetRowIndex = lastRow; 
      }
    }
  }
  
  // Jika di luar jendela waktu agregasi, buat baris baru
  if (targetRowIndex === -1) {
    targetRowIndex = lastRow + 1;
    sheet.getRange(targetRowIndex, 11).setValue(now); 
  }
  
  // Masukkan data modul ke kolom masing-masing
  if (dataRow.module === "Module1") {
    sheet.getRange(targetRowIndex, 1, 1, 4).setValues([
      [dataRow.lux !== null ? dataRow.lux : 0, dataRow.dryTemp, dataRow.wetTemp, dataRow.rh]
    ]);
  } else if (dataRow.module === "Module2") {
    sheet.getRange(targetRowIndex, 5, 1, 3).setValues([
      [dataRow.dryTemp, dataRow.wetTemp, dataRow.rh]
    ]);
  } else if (dataRow.module === "Module3") {
    sheet.getRange(targetRowIndex, 8, 1, 3).setValues([
      [dataRow.dryTemp, dataRow.wetTemp, dataRow.rh]
    ]);
  }
  
  // Hitung rata-rata spasial greenhouse secara otomatis di kolom L, M, N
  updateAverages(sheet, targetRowIndex);
  
  // Periksa ambang batas anomali dan kirim notifikasi jika diperlukan
  checkAnomaly(dataRow);
}

/**
 * Menghitung rata-rata spasial parameter lingkungan di greenhouse
 */
function updateAverages(sheet, rowIdx) {
  const rowData = sheet.getRange(rowIdx, 1, 1, 10).getValues()[0];
  const calc = (indices) => {
    let sum = 0, count = 0;
    indices.forEach(i => {
      let val = parseFloat(rowData[i]);
      if (!isNaN(val) && val !== 0) { 
        sum += val; 
        count++; 
      }
    });
    return count > 0 ? (sum / count).toFixed(1) : "";
  };
  
  const avgDry = calc([1, 4, 7]); // DryTemp Modul 1, 2, 3
  const avgWet = calc([2, 5, 8]); // WetTemp Modul 1, 2, 3
  const avgRh  = calc([3, 6, 9]); // RH Modul 1, 2, 3
  
  sheet.getRange(rowIdx, 12, 1, 3).setValues([[avgDry, avgWet, avgRh]]);
}

// ============================================================================
// 3. DETEKSI ANOMALI & NOTIFIKASI EMAIL
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
// 4. DATA PROVIDER UNTUK DASHBOARD UI
// ============================================================================
function getDashboardData() {
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty("SPREADSHEET_ID");
  if (!ssId) return { latest: null, status: "Spreadsheet ID not set" };

  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_RAW);
  const rows = sheet.getDataRange().getValues();
  
  if (rows.length <= 2) return { latest: null, status: "No Data" };
  
  const recentData = rows.slice(2).slice(-12);
  const latest = recentData[recentData.length - 1];
  const safeDate = (dateObj) => (dateObj instanceof Date) ? dateObj.toISOString() : String(dateObj);
  
  return {
    latest: {
      timestamp: safeDate(latest[10]), 
      lux: latest[0] || 0, 
      dry: latest[11] || 0, 
      wet: latest[12] || 0, 
      rh: latest[13] || 0 
    },
    trend: recentData.map(r => ({ 
      ts: safeDate(r[10]),             
      lux: r[0] || 0, 
      dry: r[11] || 0, 
      wet: r[12] || 0, 
      rh: r[13] || 0 
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

  // 7. Request ke Gemini REST API
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
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

    const res = UrlFetchApp.fetch(endpoint, {
      method: "post", 
      contentType: "application/json", 
      muteHttpExceptions: true, 
      payload: JSON.stringify(payload)
    });
    
    const responseCode = res.getResponseCode();
    const responseData = JSON.parse(res.getContentText());

    if (responseCode === 200 && responseData.candidates && responseData.candidates.length > 0) {
      const aiReply = responseData.candidates[0].content.parts[0].text;
      chatSheet.appendRow([new Date(), "AI", aiReply]);
      return aiReply;
    } else {
      // Catat raw error ke chatSheet untuk kebutuhan audit
      const rawError = res.getContentText();
      chatSheet.appendRow([new Date(), "SYSTEM_ERROR", rawError]);
      Logger.log("Gemini API Error (" + responseCode + "): " + rawError);

      return "Mohon maaf, sistem AI CAMP-AI saat ini sedang mengalami kendala komunikasi dengan layanan pemrosesan bahasa alami. Silakan coba kembali beberapa saat lagi.";
    }
  } catch (e) {
    chatSheet.appendRow([new Date(), "SYSTEM_CRASH", e.message]);
    Logger.log("Exception in askGemini: " + e.message);

    return "Terjadi kendala pada server saat memproses jawaban AI (" + e.message + "). Silakan muat ulang halaman atau coba beberapa saat lagi.";
  }
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
