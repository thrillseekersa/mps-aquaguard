// AquaFloat Telemetry Companion App
// Supports:
//   1. ThingSpeak Cloud History (Wi-Fi when available -> 2G GPRS daily batch)
//   2. Web Bluetooth (BLE) Live STEM Demo + Wi-Fi Hotspot Pairing + Radio Power Controls
//   3. Built-in 7-Day Offline Demo Mode

const STORAGE_KEY = "mps_aquaguard_v1";

const BLE_SERVICE_UUID    = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const BLE_CHAR_TELEM_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
const BLE_CHAR_CMD_UUID   = "cba1d466-344c-4be3-ab3f-189f80dd7518";

const DEFAULT_SETTINGS = {
  useDemo: false,
  channelId: "3593739",
  readApiKey: "G2XF4XTAAWTQUM22",
  stationName: "MPS Aquaguard — Dam Station"
};

let settings = loadSettings();
let activeMetric = "ph";
let records = [];
let bleLiveRecord = null;

// Web Bluetooth state
let bleDevice = null;
let bleTelemChar = null;
let bleCmdChar = null;
let bleConnected = false;

// ---- Evaluation Thresholds ----
function evaluatePH(ph, ok) {
  if (!ok || ph === null) return { label: "Disconnected", cls: "q-warn" };
  if (ph >= 6.5 && ph <= 8.5) return { label: "Good", cls: "q-good" };
  if ((ph >= 6.0 && ph < 6.5) || (ph > 8.5 && ph <= 9.0)) return { label: "Caution", cls: "q-warn" };
  return { label: "Alert", cls: "q-bad" };
}

function evaluateTDS(tds, ok) {
  if (!ok || tds === null) return { label: "Disconnected", cls: "q-warn" };
  if (tds <= 500) return { label: "Good", cls: "q-good" };
  if (tds <= 1000) return { label: "Fair / High", cls: "q-warn" };
  return { label: "Poor / Saline", cls: "q-bad" };
}

function evaluateTemp(tempC, ok) {
  if (!ok || tempC === null) return { label: "Optional / Off", cls: "q-warn" };
  if (tempC >= 10 && tempC <= 28) return { label: "Normal", cls: "q-good" };
  if ((tempC >= 5 && tempC < 10) || (tempC > 28 && tempC <= 33)) return { label: "Warm/Cool", cls: "q-warn" };
  return { label: "Extreme", cls: "q-bad" };
}

function evaluateBattery(pct, volts) {
  if (volts === null || pct === null || volts <= 0) return { label: "Optional / Off", cls: "q-warn" };
  if (pct >= 35) return { label: "Healthy", cls: "q-good" };
  if (pct >= 15) return { label: "Low", cls: "q-warn" };
  return { label: "Critical", cls: "q-bad" };
}

function classifyWater(tds) {
  if (tds === null) return "TDS probe disconnected";
  if (tds < 300) return "Excellent Freshwater (<300 ppm)";
  if (tds < 600) return "Good Freshwater (300–600 ppm)";
  if (tds < 1000) return "Fair / Mineral-Rich (600–1000 ppm)";
  return "Brackish / High Dissolved Solids (>1000 ppm)";
}

function formatSignal(sig) {
  if (sig === null || Number.isNaN(sig)) return bleConnected ? "Bluetooth LE Direct" : "--";
  if (sig < 0) {
    const q = sig >= -65 ? "Strong" : sig >= -78 ? "Fair" : "Weak";
    return `${sig} dBm (${q} Wi-Fi)`;
  }
  if (sig === 99 || sig === 0) return "CSQ Unknown";
  const approxDbm = -113 + sig * 2;
  const q = sig >= 18 ? "Strong" : sig >= 10 ? "Fair" : "Weak";
  return `CSQ ${sig}/31 (~${approxDbm} dBm, ${q} 2G GPRS)`;
}

function linkShort(rec) {
  if (rec.bleSource) return "Bluetooth";
  if (rec.signal === null || Number.isNaN(rec.signal)) return "2G GPRS";
  return rec.signal < 0 ? "Wi-Fi" : "2G GPRS";
}

// ---- Settings Persistence ----
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  settings = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

// ---- Demo Generator: 7 Days of 3-Hour Readings ----
function generateDemoData(count = 56) {
  const now = Date.now();
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = new Date(now - i * 3 * 60 * 60 * 1000);
    const hour = t.getHours();
    const sunCycle = Math.sin(((hour - 6) / 24) * Math.PI * 2);

    const tempC = +(20.4 + 2.3 * sunCycle + Math.sin(i * 0.35) * 0.35).toFixed(2);
    const ph = +(7.24 + 0.16 * sunCycle + Math.cos(i * 0.4) * 0.05).toFixed(2);
    const tdsPpm = Math.round(240 + Math.sin(i * 0.18) * 20 + ((count - i) % 8) * 1.5);
    const ecUsCm = +(tdsPpm * 2.0).toFixed(1);

    const battPct = Math.max(58, Math.min(99, Math.round(78 + 18 * sunCycle)));
    const battVolts = +(3.2 + (battPct / 100) * 1.0).toFixed(2);

    out.push({
      timestamp: t,
      phOk: true,
      ph,
      tdsOk: true,
      tdsPpm,
      ecUsCm,
      tempOk: true,
      tempC,
      battOk: true,
      battVolts,
      battPct,
      manualBtn: i === 0 || i === 19,
      signal: i % 4 === 0 ? -61 : 18 + (i % 6),
      bleSource: false
    });
  }
  return out;
}

// ---- ThingSpeak Live Fetch ----
async function fetchThingSpeakData(resultsCount = 200) {
  const cid = settings.channelId.trim();
  if (!cid) throw new Error("Missing ThingSpeak Channel ID");

  let url = `https://api.thingspeak.com/channels/${encodeURIComponent(cid)}/feeds.json?results=${resultsCount}`;
  if (settings.readApiKey.trim()) {
    url += `&api_key=${encodeURIComponent(settings.readApiKey.trim())}`;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`ThingSpeak HTTP ${res.status}`);
  const json = await res.json();

  if (!json.feeds || json.feeds.length === 0) {
    throw new Error("Channel has no uploaded readings yet.");
  }

  return json.feeds
    .map(f => {
      const mask = f.field7 !== null && f.field7 !== undefined ? parseInt(f.field7, 10) : null;
      const phRaw = f.field1 !== null ? parseFloat(f.field1) : null;
      const tdsRaw = f.field2 !== null ? parseFloat(f.field2) : null;
      const ecRaw = f.field3 !== null ? parseFloat(f.field3) : null;
      const tempRaw = f.field4 !== null ? parseFloat(f.field4) : null;
      const battVRaw = f.field5 !== null ? parseFloat(f.field5) : null;
      const battPctRaw = f.field6 !== null ? parseInt(f.field6, 10) : null;
      const sigRaw = f.field8 !== null ? parseInt(f.field8, 10) : null;

      const phOk = mask !== null ? (mask & 1) !== 0 : phRaw !== null;
      const tdsOk = mask !== null ? (mask & 2) !== 0 : tdsRaw !== null;
      const tempOk = mask !== null ? (mask & 4) !== 0 : tempRaw !== null;
      const manualBtn = mask !== null ? (mask & 8) !== 0 : false;

      return {
        timestamp: new Date(f.created_at),
        phOk,
        ph: phOk && phRaw !== null && !Number.isNaN(phRaw) ? phRaw : null,
        tdsOk,
        tdsPpm: tdsOk && tdsRaw !== null && !Number.isNaN(tdsRaw) ? tdsRaw : null,
        ecUsCm: tdsOk && ecRaw !== null && !Number.isNaN(ecRaw) ? ecRaw : null,
        tempOk,
        tempC: tempOk && tempRaw !== null && !Number.isNaN(tempRaw) ? tempRaw : null,
        battOk: battVRaw !== null && !Number.isNaN(battVRaw) && battVRaw > 0,
        battVolts: battVRaw !== null && !Number.isNaN(battVRaw) ? battVRaw : null,
        battPct: battPctRaw !== null && !Number.isNaN(battPctRaw) ? battPctRaw : null,
        manualBtn,
        signal: sigRaw !== null && !Number.isNaN(sigRaw) ? sigRaw : null,
        bleSource: false
      };
    })
    .filter(r => !Number.isNaN(r.timestamp.getTime()));
}

// ---- Bluetooth (Web Bluetooth OR Native Android Bridge) ----
window.onNativeBleStatus = function (status, detail) {
  const btn = document.getElementById("bleConnectBtn");
  if (status === "scanning" || status === "connecting") {
    btn.textContent = "🔵 " + (detail || "Connecting...");
  } else if (status === "connected") {
    bleConnected = true;
    document.getElementById("blePanel").classList.remove("hidden");
    btn.textContent = "🔵 BLE Connected";
  } else if (status === "error") {
    btn.textContent = "🔵 Connect Bluetooth";
    alert(detail || "Bluetooth connection failed.");
  }
};

window.onNativeBleTelemetry = function (jsonStr) {
  if (!bleConnected) {
    bleConnected = true;
    document.getElementById("blePanel").classList.remove("hidden");
    document.getElementById("bleConnectBtn").textContent = "🔵 BLE Connected";
  }
  handleBleTelemetryPayload(jsonStr);
};

window.onNativeBleDisconnected = function () {
  onBleDisconnected();
};

async function connectBluetooth() {
  if (window.AndroidBridge) {
    window.AndroidBridge.connectBle();
    return;
  }

  if (!navigator.bluetooth) {
    alert("Web Bluetooth is unavailable here. Open this app via START_APP.bat (http://localhost:8765) in Chrome or Edge, or host on HTTPS.");
    return;
  }

  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ name: "AquaFloat-Station" }],
      optionalServices: [BLE_SERVICE_UUID]
    });
    bleDevice.addEventListener("gattserverdisconnected", onBleDisconnected);

    const server = await bleDevice.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    bleTelemChar = await service.getCharacteristic(BLE_CHAR_TELEM_UUID);
    bleCmdChar = await service.getCharacteristic(BLE_CHAR_CMD_UUID);

    await bleTelemChar.startNotifications();
    bleTelemChar.addEventListener("characteristicvaluechanged", e => {
      handleBleTelemetryPayload(new TextDecoder().decode(e.target.value));
    });

    const initialVal = await bleTelemChar.readValue();
    bleConnected = true;
    document.getElementById("blePanel").classList.remove("hidden");
    document.getElementById("bleConnectBtn").textContent = "🔵 BLE Connected";
    handleBleTelemetryPayload(new TextDecoder().decode(initialVal));
  } catch (err) {
    if (err.name !== "NotFoundError") {
      alert("Bluetooth connection failed: " + err.message);
    }
  }
}

function onBleDisconnected() {
  bleConnected = false;
  bleLiveRecord = null;
  document.getElementById("blePanel").classList.add("hidden");
  document.getElementById("bleConnectBtn").textContent = "🔵 Connect Bluetooth";
  renderDashboard();
}

async function sendBleCommand(cmdText) {
  if (window.AndroidBridge) {
    if (!bleConnected) {
      alert("Connect via Bluetooth first.");
      return;
    }
    window.AndroidBridge.sendBleCommand(cmdText);
    return;
  }
  if (!bleConnected || !bleCmdChar) {
    alert("Connect via Bluetooth first.");
    return;
  }
  const encoded = new TextEncoder().encode(cmdText);
  await bleCmdChar.writeValue(encoded);
}

function handleBleTelemetryPayload(jsonStr) {
  try {
    const d = JSON.parse(jsonStr);
    const mask = d.m || 0;

    // Update BLE control panel state
    document.getElementById("bleQueueCount").textContent = d.q ?? 0;
    document.getElementById("togWifi").checked = d.w === 1;
    document.getElementById("togBle").checked = d.b === 1;
    document.getElementById("togCell").checked = d.c === 1;
    document.getElementById("togDemo").checked = d.d === 1;

    if (d.ssid) {
      document.getElementById("hotspotSsid").value = d.ssid;
    }
    const pairStatus = document.getElementById("wifiPairStatus");
    if (d.wu === 1) {
      pairStatus.textContent = `Connected to "${d.ssid}" (IP: ${d.ip} • ${d.rssi} dBm)`;
      pairStatus.style.background = "#dcfce7";
      pairStatus.style.color = "#166534";
    } else if (d.ssid) {
      pairStatus.textContent = d.w === 1 ? `Paired to "${d.ssid}" (connecting/out of range)` : `Paired to "${d.ssid}" (Wi-Fi radio OFF)`;
      pairStatus.style.background = "#fef3c7";
      pairStatus.style.color = "#92400e";
    } else {
      pairStatus.textContent = "Wi-Fi: Not paired to any hotspot";
      pairStatus.style.background = "#f1f5f9";
      pairStatus.style.color = "#334155";
    }

    bleLiveRecord = {
      timestamp: new Date(),
      phOk: (mask & 1) !== 0 && d.ph !== null,
      ph: d.ph,
      tdsOk: (mask & 2) !== 0 && d.tds !== null,
      tdsPpm: d.tds,
      ecUsCm: d.ec,
      tempOk: (mask & 4) !== 0 && d.t !== null,
      tempC: d.t,
      battOk: d.bv !== null && d.bv > 0,
      battVolts: d.bv,
      battPct: d.bp,
      manualBtn: true,
      signal: d.wu === 1 ? d.rssi : null,
      bleSource: true
    };

    // Append live demo point for smooth live chart streaming (cap in-memory growth)
    records.push(bleLiveRecord);
    if (records.length > 240) records.shift();

    renderDashboard();
  } catch (e) {
    console.warn("BLE parse error:", e);
  }
}

// ---- Render UI ----
function renderDashboard() {
  const modeBadge = document.getElementById("modeBadge");
  if (bleConnected) {
    modeBadge.textContent = "LIVE • BLUETOOTH";
    modeBadge.className = "pill pill-ble";
  } else if (settings.useDemo) {
    modeBadge.textContent = "DEMO DATA (7D)";
    modeBadge.className = "pill pill-demo";
  } else {
    modeBadge.textContent = `LIVE • CH ${settings.channelId}`;
    modeBadge.className = "pill pill-live";
  }

  const latest = bleLiveRecord || (records.length ? records[records.length - 1] : null);
  if (!latest) return;

  const phEval = evaluatePH(latest.ph, latest.phOk);
  const tdsEval = evaluateTDS(latest.tdsPpm, latest.tdsOk);
  const tempEval = evaluateTemp(latest.tempC, latest.tempOk);
  const battEval = evaluateBattery(latest.battPct, latest.battVolts);

  const banner = document.getElementById("overallBanner");
  const title = document.getElementById("overallTitle");
  const summary = document.getElementById("overallSummary");

  const hasAlert = (latest.phOk && phEval.cls === "q-bad") || (latest.tdsOk && tdsEval.cls === "q-bad");
  const hasWarn = (latest.phOk && phEval.cls === "q-warn") || (latest.tdsOk && tdsEval.cls === "q-warn");

  if (!latest.phOk && !latest.tdsOk) {
    banner.className = "status-banner status-warn";
    title.textContent = "Probes Disconnected — Station Online";
    summary.textContent = `${settings.stationName}: Station connected, but pH & TDS probes are currently unplugged.`;
  } else if (hasAlert) {
    banner.className = "status-banner status-bad";
    title.textContent = "Alert — Water Quality Out of Safe Range";
    summary.textContent = `${settings.stationName}: Check dam water (${latest.phOk ? `pH ${latest.ph.toFixed(2)}` : "pH off"}, ${latest.tdsOk ? `TDS ${Math.round(latest.tdsPpm)} ppm` : "TDS off"}).`;
  } else if (hasWarn) {
    banner.className = "status-banner status-warn";
    title.textContent = "Caution — Minor Parameter Drift";
    summary.textContent = `${settings.stationName}: Values slightly outside ideal freshwater targets.`;
  } else {
    banner.className = "status-banner status-good";
    title.textContent = "Good — Dam Water Parameters Healthy";
    const phTxt = latest.phOk ? `pH ${latest.ph.toFixed(2)}` : "pH off";
    const tdsTxt = latest.tdsOk ? `TDS ${Math.round(latest.tdsPpm)} ppm` : "TDS off";
    const tempTxt = latest.tempOk ? `Temp ${latest.tempC.toFixed(1)} °C` : "Temp optional/off";
    summary.textContent = `${settings.stationName}: ${phTxt} • ${tdsTxt} • ${tempTxt}.`;
  }

  document.getElementById("lastSync").textContent = latest.timestamp.toLocaleString();
  document.getElementById("sampleCount").textContent = `${records.length} pts`;
  document.getElementById("commsBadge").textContent = `Link: ${linkShort(latest)}`;

  document.getElementById("phVal").textContent = latest.phOk && latest.ph !== null ? latest.ph.toFixed(2) : "--";
  setBadge("phBadge", phEval);
  document.getElementById("phMarker").style.left = `${latest.phOk && latest.ph !== null ? clamp((latest.ph / 14) * 100, 2, 98) : 50}%`;

  document.getElementById("tdsVal").textContent = latest.tdsOk && latest.tdsPpm !== null ? Math.round(latest.tdsPpm) : "--";
  setBadge("tdsBadge", tdsEval);
  document.getElementById("tdsSub").textContent =
    latest.tdsOk && latest.ecUsCm !== null
      ? `EC: ${latest.ecUsCm.toFixed(0)} µS/cm • WHO Good: < 500 ppm`
      : "TDS probe unplugged • Other probes unaffected";
  document.getElementById("tdsMarker").style.left = `${latest.tdsOk && latest.tdsPpm !== null ? clamp((latest.tdsPpm / 1000) * 100, 2, 98) : 0}%`;

  const tempF = latest.tempOk && latest.tempC !== null ? (latest.tempC * 9) / 5 + 32 : null;
  document.getElementById("tempVal").textContent = latest.tempOk && latest.tempC !== null ? latest.tempC.toFixed(1) : "--";
  setBadge("tempBadge", tempEval);
  document.getElementById("tempSub").textContent =
    tempF !== null ? `${tempF.toFixed(1)} °F • Active TDS compensation` : "Unplugged — using 25.0 °C fallback";
  document.getElementById("tempMarker").style.left = `${latest.tempOk && latest.tempC !== null ? clamp((latest.tempC / 40) * 100, 2, 98) : 62}%`;

  document.getElementById("battPctVal").textContent = latest.battOk && latest.battPct !== null ? latest.battPct : "--";
  setBadge("battBadge", battEval);
  document.getElementById("battSub").textContent =
    latest.battOk ? `Voltage: ${latest.battVolts.toFixed(2)} V • 1× 18650 Li-ion + Solar` : "Optional VN voltage divider not wired";
  document.getElementById("battMarker").style.left = `${latest.battOk ? clamp(latest.battPct, 2, 98) : 50}%`;

  if (latest.phOk && latest.ph !== null) {
    const deltaPh = latest.ph - 7.0;
    const acidBase = Math.abs(deltaPh) < 0.2 ? "Neutral" : deltaPh > 0 ? "Slightly Alkaline" : "Slightly Acidic";
    document.getElementById("specPh").textContent = `${latest.ph.toFixed(2)} pH (${acidBase})`;
    document.getElementById("specPhDelta").textContent = `${deltaPh >= 0 ? "+" : ""}${deltaPh.toFixed(2)} pH`;
  } else {
    document.getElementById("specPh").textContent = "Disconnected";
    document.getElementById("specPhDelta").textContent = "--";
  }

  document.getElementById("specTds").textContent = latest.tdsOk && latest.tdsPpm !== null ? `${latest.tdsPpm.toFixed(1)} mg/L (ppm)` : "Disconnected";
  document.getElementById("specEc").textContent = latest.tdsOk && latest.ecUsCm !== null ? `${latest.ecUsCm.toFixed(1)} µS/cm (${(latest.ecUsCm / 1000).toFixed(3)} mS/cm)` : "--";
  document.getElementById("specWaterClass").textContent = classifyWater(latest.tdsOk ? latest.tdsPpm : null);
  document.getElementById("specTemp").textContent = latest.tempOk && latest.tempC !== null ? `${latest.tempC.toFixed(2)} °C (${tempF.toFixed(1)} °F)` : "Not connected (25.0 °C fallback)";
  document.getElementById("specProbes").textContent =
    `pH: ${latest.phOk ? "OK" : "Off"} | TDS: ${latest.tdsOk ? "OK" : "Off"} | Temp: ${latest.tempOk ? "OK" : "Off"}`;

  document.getElementById("specBatt").textContent = latest.battOk ? `${latest.battVolts.toFixed(2)} V (${latest.battPct}%)` : "Not wired (optional VN pin)";
  document.getElementById("specTrigger").textContent =
    latest.bleSource ? "Live Bluetooth Demo Stream" : latest.manualBtn ? "Manual Push Button (GPIO 35)" : "Scheduled 3-Hour Deep Sleep";
  document.getElementById("specSignal").textContent = formatSignal(latest.signal);

  renderChart();
  renderLogTable();
}

function setBadge(id, evalObj) {
  const el = document.getElementById(id);
  el.textContent = evalObj.label;
  el.className = `quality-badge ${evalObj.cls}`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ---- Custom Interactive SVG Trend Chart ----
function renderChart() {
  const limit = parseInt(document.getElementById("rangeSelect").value, 10) || 56;
  const slice = records.slice(-limit);
  const svg = document.getElementById("historyChart");
  const tooltip = document.getElementById("chartTooltip");
  tooltip.classList.add("hidden");

  const meta = {
    ph:   { key: "ph",        unit: "pH",  min: 4,   max: 10,  safeMin: 6.5, safeMax: 8.5, color: "#6d28d9", bandLabel: "6.5 – 8.5 pH" },
    tds:  { key: "tdsPpm",    unit: "ppm", min: 0,   max: 700, safeMin: 0,   safeMax: 500, color: "#0284c7", bandLabel: "0 – 500 ppm" },
    temp: { key: "tempC",     unit: "°C",  min: 0,   max: 35,  safeMin: 10,  safeMax: 28,  color: "#ea580c", bandLabel: "10 – 28 °C" },
    batt: { key: "battVolts", unit: "V",   min: 3.0, max: 4.3, safeMin: 3.4, safeMax: 4.2, color: "#15803d", bandLabel: "3.4 – 4.2 V" }
  }[activeMetric];

  const validPairs = slice
    .map((r, idx) => ({ r, idx, val: r[meta.key] }))
    .filter(p => p.val !== null && !Number.isNaN(p.val));

  if (validPairs.length === 0) {
    document.getElementById("statMin").textContent = "--";
    document.getElementById("statAvg").textContent = "--";
    document.getElementById("statMax").textContent = "--";
    document.getElementById("statBand").textContent = meta.bandLabel;
    svg.innerHTML = `<text x="440" y="145" text-anchor="middle" font-size="14" fill="#64748b">No readings yet — connect via Bluetooth for instant demo or wait for first upload.</text>`;
    return;
  }

  const vals = validPairs.map(p => p.val);
  const vMin = Math.min(...vals);
  const vMax = Math.max(...vals);
  const vAvg = vals.reduce((a, b) => a + b, 0) / vals.length;

  document.getElementById("statMin").textContent = `${vMin.toFixed(activeMetric === "tds" ? 0 : 2)} ${meta.unit}`;
  document.getElementById("statAvg").textContent = `${vAvg.toFixed(activeMetric === "tds" ? 0 : 2)} ${meta.unit}`;
  document.getElementById("statMax").textContent = `${vMax.toFixed(activeMetric === "tds" ? 0 : 2)} ${meta.unit}`;
  document.getElementById("statBand").textContent = meta.bandLabel;

  let yLow = Math.min(meta.min, vMin);
  let yHigh = Math.max(meta.max, vMax);
  if (activeMetric === "tds") { yLow = 0; yHigh = Math.max(600, Math.ceil(vMax / 100) * 100); }
  if (activeMetric === "ph")  { yLow = 4; yHigh = 10; if (vMin < 4 || vMax > 10) { yLow = 0; yHigh = 14; } }

  const W = 880, H = 280;
  const pad = { top: 20, right: 24, bottom: 36, left: 54 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const xOf = idx => pad.left + (slice.length === 1 ? plotW / 2 : (idx / (slice.length - 1)) * plotW);
  const yOf = val => pad.top + plotH - ((clamp(val, yLow, yHigh) - yLow) / (yHigh - yLow)) * plotH;

  const safeTop = yOf(Math.min(meta.safeMax, yHigh));
  const safeBot = yOf(Math.max(meta.safeMin, yLow));

  let html = "";
  if (safeBot > safeTop) {
    html += `<rect x="${pad.left}" y="${safeTop}" width="${plotW}" height="${safeBot - safeTop}" fill="#bbf7d0" opacity="0.45" />`;
  }

  for (let i = 0; i <= 4; i++) {
    const val = yLow + ((yHigh - yLow) * i) / 4;
    const y = yOf(val);
    html += `<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="#cbd5e1" stroke-dasharray="4 4" />`;
    html += `<text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#475569">${val.toFixed(activeMetric === "tds" ? 0 : 1)}</text>`;
  }

  const pts = validPairs.map(p => ({ x: xOf(p.idx), y: yOf(p.val), rec: p.r }));
  const lineD = pts.map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaD = `${lineD} L${pts[pts.length - 1].x.toFixed(1)},${pad.top + plotH} L${pts[0].x.toFixed(1)},${pad.top + plotH} Z`;

  html += `<path d="${areaD}" fill="${meta.color}" opacity="0.10" />`;
  html += `<path d="${lineD}" fill="none" stroke="${meta.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />`;

  const labelIdxs = [...new Set([0, Math.floor((slice.length - 1) / 2), slice.length - 1])];
  labelIdxs.forEach(idx => {
    const r = slice[idx];
    const x = xOf(idx);
    const label = r.timestamp.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
                  r.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    html += `<text x="${x}" y="${H - 10}" text-anchor="middle" font-size="10.5" fill="#475569">${label}</text>`;
  });

  pts.forEach((p, i) => {
    const strokeClr = p.rec.bleSource ? "#2563eb" : p.rec.manualBtn ? "#ca8a04" : meta.color;
    html += `<circle cx="${p.x}" cy="${p.y}" r="${p.rec.manualBtn ? 4.8 : 3.5}" fill="#fff" stroke="${strokeClr}" stroke-width="2.2" />`;
    html += `<circle class="hit-dot" data-vidx="${i}" cx="${p.x}" cy="${p.y}" r="12" fill="transparent" style="cursor:pointer" />`;
  });

  svg.innerHTML = html;

  svg.querySelectorAll(".hit-dot").forEach(dot => {
    const rec = pts[+dot.dataset.vidx].rec;
    dot.addEventListener("mouseenter", e => showTooltip(e, rec));
    dot.addEventListener("click", e => showTooltip(e, rec));
    dot.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
  });
}

function showTooltip(event, rec) {
  const container = document.querySelector(".chart-container");
  const tooltip = document.getElementById("chartTooltip");
  const rect = container.getBoundingClientRect();

  const phStr = rec.phOk && rec.ph !== null ? rec.ph.toFixed(2) : "Off";
  const tdsStr = rec.tdsOk && rec.tdsPpm !== null ? `${Math.round(rec.tdsPpm)} ppm` : "Off";
  const tempStr = rec.tempOk && rec.tempC !== null ? `${rec.tempC.toFixed(1)} °C` : "Off";
  const battStr = rec.battOk ? `${rec.battVolts.toFixed(2)} V` : "--";

  tooltip.innerHTML = `
    <strong>${rec.timestamp.toLocaleString()}</strong> (${linkShort(rec)})<br/>
    pH: <b>${phStr}</b> • TDS: <b>${tdsStr}</b><br/>
    Temp: <b>${tempStr}</b> • Batt: <b>${battStr}</b>
  `;
  tooltip.classList.remove("hidden");

  const x = Math.min(rect.width - 240, Math.max(10, event.clientX - rect.left + 12));
  const y = Math.max(10, event.clientY - rect.top - 66);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

// ---- Table & CSV Export ----
function renderLogTable() {
  const tbody = document.getElementById("logTableBody");
  const recent = records.slice(-30).reverse();

  tbody.innerHTML = recent.map(r => {
    const phOk = evaluatePH(r.ph, r.phOk);
    const tdsOk = evaluateTDS(r.tdsPpm, r.tdsOk);

    let overall = { label: "Good", cls: "q-good" };
    if ((r.phOk && phOk.cls === "q-bad") || (r.tdsOk && tdsOk.cls === "q-bad")) {
      overall = { label: "Alert", cls: "q-bad" };
    } else if ((r.phOk && phOk.cls === "q-warn") || (r.tdsOk && tdsOk.cls === "q-warn")) {
      overall = { label: "Caution", cls: "q-warn" };
    } else if (!r.phOk && !r.tdsOk) {
      overall = { label: "Probes Off", cls: "q-warn" };
    }

    const battText = r.battOk ? `${r.battVolts.toFixed(2)} V (${r.battPct}%)` : "--";
    const trigText = `${r.bleSource ? "BLE" : r.manualBtn ? "Btn" : "3h"} • ${linkShort(r)}`;

    return `
      <tr>
        <td>${r.timestamp.toLocaleString()}</td>
        <td><strong>${r.phOk && r.ph !== null ? r.ph.toFixed(2) : "Off"}</strong></td>
        <td>${r.tdsOk && r.tdsPpm !== null ? Math.round(r.tdsPpm) : "Off"}</td>
        <td>${r.tdsOk && r.ecUsCm !== null ? Math.round(r.ecUsCm) : "--"}</td>
        <td>${r.tempOk && r.tempC !== null ? r.tempC.toFixed(1) : "Off"}</td>
        <td>${battText}</td>
        <td>${trigText}</td>
        <td><span class="quality-badge ${overall.cls}">${overall.label}</span></td>
      </tr>
    `;
  }).join("");
}

function exportCSV() {
  if (!records.length) return;
  const header = "Timestamp,pH,TDS_ppm,EC_uScm,Temp_C,Battery_V,Battery_Pct,Link,Signal\n";
  const rows = records.map(r =>
    [
      r.timestamp.toISOString(),
      r.phOk && r.ph !== null ? r.ph.toFixed(2) : "",
      r.tdsOk && r.tdsPpm !== null ? r.tdsPpm.toFixed(1) : "",
      r.tdsOk && r.ecUsCm !== null ? r.ecUsCm.toFixed(1) : "",
      r.tempOk && r.tempC !== null ? r.tempC.toFixed(2) : "",
      r.battOk ? r.battVolts.toFixed(2) : "",
      r.battOk ? r.battPct : "",
      linkShort(r),
      r.signal ?? ""
    ].join(",")
  ).join("\n");

  const csvString = header + rows;
  const filename = `aquafloat-dam-trends-${new Date().toISOString().slice(0, 10)}.csv`;

  if (window.AndroidBridge) {
    window.AndroidBridge.saveCsv(filename, csvString);
    return;
  }

  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ---- Load & Refresh ----
async function refreshData() {
  if (settings.useDemo) {
    records = generateDemoData(56);
    renderDashboard();
    return;
  }

  try {
    records = await fetchThingSpeakData(200);
    renderDashboard();
  } catch (err) {
    if (!bleConnected) {
      document.getElementById("overallBanner").className = "status-banner status-warn";
      document.getElementById("overallTitle").textContent = "Waiting for First Cloud Upload";
      document.getElementById("overallSummary").textContent =
        `${err.message} — Click "Connect Bluetooth" for instant live demo/hotspot pairing, or switch to Demo Data.`;
    }
    renderChart();
    renderLogTable();
  }
}

// ---- Events ----
if (window.AndroidBridge) {
  const dlBtn = document.getElementById("downloadApkBtn");
  if (dlBtn) dlBtn.classList.add("hidden");
}
if (!window.AndroidBridge && !window.isSecureContext && location.protocol === "file:") {
  document.getElementById("fileProtoBanner").classList.remove("hidden");
}

document.getElementById("bleConnectBtn").addEventListener("click", () => {
  if (bleConnected) {
    if (window.AndroidBridge) {
      window.AndroidBridge.disconnectBle();
    } else if (bleDevice?.gatt?.connected) {
      bleDevice.gatt.disconnect();
    }
  } else {
    connectBluetooth();
  }
});

document.getElementById("bleDisconnectBtn").addEventListener("click", () => {
  if (window.AndroidBridge) {
    window.AndroidBridge.disconnectBle();
  } else if (bleDevice?.gatt?.connected) {
    bleDevice.gatt.disconnect();
  }
});

document.getElementById("bleSampleBtn").addEventListener("click", () => sendBleCommand("SAMPLE"));

document.getElementById("wifiPairForm").addEventListener("submit", async e => {
  e.preventDefault();
  const ssid = document.getElementById("hotspotSsid").value.trim();
  const pass = document.getElementById("hotspotPass").value;
  if (!ssid) return;
  await sendBleCommand(`WIFI|${ssid}|${pass}`);
});

document.getElementById("clearWifiBtn").addEventListener("click", async () => {
  document.getElementById("hotspotSsid").value = "";
  document.getElementById("hotspotPass").value = "";
  await sendBleCommand("CLEAR_WIFI");
});

document.getElementById("applyRadiosBtn").addEventListener("click", async () => {
  const w = document.getElementById("togWifi").checked ? 1 : 0;
  const b = document.getElementById("togBle").checked ? 1 : 0;
  const c = document.getElementById("togCell").checked ? 1 : 0;
  const d = document.getElementById("togDemo").checked ? 1 : 0;
  await sendBleCommand(`RADIOS|${w}|${b}|${c}|${d}`);
});

document.getElementById("damModeBtn").addEventListener("click", async () => {
  if (!confirm("Turn OFF Wi-Fi & Bluetooth and enter 3-hour Deep Sleep (Cellular Daily Only)?\n\nHold the physical button for 2 seconds later to wake Bluetooth back up.")) {
    return;
  }
  await sendBleCommand("RADIOS|0|0|1|0");
});

document.querySelectorAll(".seg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeMetric = btn.dataset.metric;
    renderChart();
  });
});

document.getElementById("rangeSelect").addEventListener("change", renderChart);
document.getElementById("refreshBtn").addEventListener("click", refreshData);
document.getElementById("exportCsvBtn").addEventListener("click", exportCSV);

const modal = document.getElementById("settingsModal");
document.getElementById("settingsBtn").addEventListener("click", () => {
  document.getElementById("useDemoInput").checked = settings.useDemo;
  document.getElementById("channelIdInput").value = settings.channelId;
  document.getElementById("readKeyInput").value = settings.readApiKey;
  document.getElementById("stationNameInput").value = settings.stationName;
  modal.classList.remove("hidden");
});
document.getElementById("closeModalBtn").addEventListener("click", () => modal.classList.add("hidden"));
document.getElementById("cancelModalBtn").addEventListener("click", () => modal.classList.add("hidden"));

document.getElementById("settingsForm").addEventListener("submit", e => {
  e.preventDefault();
  saveSettings({
    useDemo: document.getElementById("useDemoInput").checked,
    channelId: document.getElementById("channelIdInput").value.trim(),
    readApiKey: document.getElementById("readKeyInput").value.trim(),
    stationName: document.getElementById("stationNameInput").value.trim() || "MPS Aquaguard — Dam Station"
  });
  modal.classList.add("hidden");
  refreshData();
});

refreshData();
setInterval(() => {
  if (!bleConnected) refreshData();
}, 60000);
