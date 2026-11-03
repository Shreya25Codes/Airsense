/* =====================================================================
   AirSense – script.js

   How this file is organised:
     1. Settings you can tweak
     2. The decision-making rules (plain functions, easy to test)
     3. The app's memory and page elements
     4. The simulated sensor (with a filter and fault detection)
     5. The main update cycle and drawing the page
     6. Log, CSV download and saved settings
     7. The live chart
     8. Buttons and sliders
     9. Self-checks
    10. The 24-hour replay
    11. Start-up
   ===================================================================== */


/* ---------- 1. Settings you can tweak ---------- */

const TEMP_BANDS = [24, 28, 32, 35];     // °C where the level steps up (levels 1 to 5)
const BAND_WORDS = ["cool", "comfortably warm", "warm", "hot", "very hot"];
const HUMID_LIMIT = 70;                  // at this humidity (%) or above, the fan goes up one level
const HYST_TEMP = 1;                     // °C of breathing room before the level steps back down
const HYST_HUM = 3;                      // % of breathing room before the humidity boost switches off

const FAILSAFE_LEVEL = 3;                // the steady level used when the sensor can't be trusted
const FAILSAFE_DELAY_MS = 10000;         // how long to keep the last level before switching to safe mode

const FILTER_SIZE = 5;                   // the filter looks at the last 5 readings
const SPIKE_DELTA = 3;                   // a reading this many °C away from the middle one counts as a spike
const FROZEN_MS = 6000;                  // identical readings for this long = frozen sensor

const CHART_POINTS = 150;                // how many points the chart keeps
const SPIN_SECONDS = { 1: 3, 2: 2, 3: 1.3, 4: 0.8, 5: 0.5 };   // seconds per turn of the fan picture


/* ---------- 2. The decision-making rules ---------- */

// The level that the temperature alone suggests (1 to 5).
function baseLevel(t) {
  let level = 1;
  for (const limit of TEMP_BANDS) {
    if (t >= limit) level++;
  }
  return level;
}

// The level for a temperature and humidity.
// With `roomToBreathe` on, the readings are nudged in the fan's favour, which is
// how we hold a level a little longer when things are cooling down.
function levelAt(t, h, roomToBreathe) {
  const temp = t + (roomToBreathe ? HYST_TEMP : 0);
  const hum = h + (roomToBreathe ? HYST_HUM : 0);
  const humidityBoost = hum >= HUMID_LIMIT ? 1 : 0;
  return Math.min(5, baseLevel(temp) + humidityBoost);
}

// Is this reading believable? Returns { ok, message }.
function validateReading(t, h) {
  const isNumber = (x) => typeof x === "number" && !Number.isNaN(x);
  if (!isNumber(t) || !isNumber(h)) {
    return { ok: false, message: "The sensor isn't sending a usable reading." };
  }
  if (t < -10 || t > 60) {
    return { ok: false, message: `A temperature of ${t} °C looks wrong for this sensor (it should be between -10 and 60 °C).` };
  }
  if (h < 0 || h > 100) {
    return { ok: false, message: `A humidity of ${h}% isn't possible (it must be between 0 and 100%).` };
  }
  return { ok: true, message: "" };
}

// The main decision. `previous` is the last level (or null), used so the level
// doesn't keep flipping back and forth right at a boundary.
function getFanLevel(t, h, previous = null) {
  const wanted = levelAt(t, h, false);
  let level = wanted;
  let held = false;

  if (previous !== null && wanted < previous) {
    const stillOk = levelAt(t, h, true);
    level = Math.min(previous, Math.max(wanted, stillOk));
    held = level > wanted;
  }
  return { level, held, reason: buildReason(t, h, level, held) };
}

// A friendly one-paragraph explanation of the decision.
function buildReason(t, h, level, held) {
  const base = baseLevel(t);
  let text = `The sensor reads ${t} °C, which feels ${BAND_WORDS[base - 1]}.`;
  if (h >= HUMID_LIMIT) {
    text += base === 5
      ? ` It's also humid (${h}%), but the fan is already at its top level.`
      : ` It's also humid (${h}%), so the fan goes up one level.`;
  }
  text += ` Level ${level} fits best.`;
  if (held) text += " Holding this level for now so the fan doesn't keep flipping back and forth near a boundary.";
  return text;
}

// What to do when the sensor has gone quiet: keep the last level for a short
// while, then switch to a steady safe level.
function failSafeDecision(silentForMs, lastLevel) {
  if (lastLevel === null || silentForMs >= FAILSAFE_DELAY_MS) {
    return { level: FAILSAFE_LEVEL, active: true };
  }
  return { level: lastLevel, active: false };
}

// Which level is the fan really using? Manual wins over automatic.
function chooseActiveLevel(mode, manualLevel, autoLevel) {
  return mode === "manual" ? manualLevel : autoLevel;
}

// The middle value of a list of numbers.
function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A small random-number maker that gives the same numbers every time for the
// same seed, so test runs are repeatable.
function makeRng(seed) {
  let x = seed;
  return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

// A second, independently written version of the rules. The 100-case test
// checks the real code against this one.
function expectedLevel(t, h) {
  let level;
  if (t < 24) level = 1;
  else if (t < 28) level = 2;
  else if (t < 32) level = 3;
  else if (t < 35) level = 4;
  else level = 5;
  if (h >= 70) level += 1;
  return level > 5 ? 5 : level;
}

// Made-up days for the replay. `x` runs from -1 (coolest, about 03:00) to +1 (hottest, about 15:00).
const SCENARIOS = {
  summer:  { name: "Hot summer day",    temp: (x) => 30 + 7 * x, hum: (x) => 55 - 20 * x },
  monsoon: { name: "Humid monsoon day", temp: (x) => 29 + 3 * x, hum: (x) => 82 - 8 * x }
};

// 144 readings, one every 10 minutes, with a little repeatable noise.
function buildSeries(key, seed) {
  const random = makeRng(seed);
  const scenario = SCENARIOS[key];
  const series = [];
  for (let i = 0; i < 144; i++) {
    const hour = i / 6;
    const x = Math.sin(2 * Math.PI * (hour - 9) / 24);
    series.push({
      t: Math.round((scenario.temp(x) + (random() - 0.5) * 0.6) * 10) / 10,
      h: Math.max(0, Math.min(100, Math.round(scenario.hum(x) + (random() - 0.5) * 4)))
    });
  }
  return series;
}

// How many times the level changes over a series, with or without the "breathing room" rule.
function countChanges(series, useBreathingRoom) {
  let previous = null;
  let changes = 0;
  for (const point of series) {
    const level = getFanLevel(point.t, point.h, useBreathingRoom ? previous : null).level;
    if (previous !== null && level !== previous) changes++;
    previous = level;
  }
  return changes;
}

// Two minutes of readings wobbling around the 28 °C line (one reading per second).
// Counts how often the level changes with and without the breathing-room rule.
function simulateSteadiness() {
  const random = makeRng(7);
  let withRule = 0, withoutRule = 0, lastWith = null, lastWithout = null;
  for (let i = 0; i < 120; i++) {
    const t = 28 + 0.5 * Math.sin(i / 4) + (random() - 0.5) * 0.2;

    const a = getFanLevel(t, 55, lastWith).level;
    if (lastWith !== null && a !== lastWith) withRule++;
    lastWith = a;

    const b = getFanLevel(t, 55, null).level;
    if (lastWithout !== null && b !== lastWithout) withoutRule++;
    lastWithout = b;
  }
  return { withRule, withoutRule, samples: 120 };
}


/* ---------- 3. The app's memory and page elements ---------- */

const state = {
  temp: 29,               // the "real" room temperature (set by the slider)
  hum: 65,                // the "real" room humidity
  unplugged: false,       // is the sensor pretend-unplugged?
  mode: "auto",           // "auto" or "manual"
  manualLevel: 3,
  autoLevel: null,        // what automatic mode wants (also remembered between readings)
  activeLevel: null,      // what the fan is really doing
  reason: "",
  problem: "",            // text shown when something is wrong with the sensor
  invalidSince: null,     // when the sensor last stopped giving usable readings
  safeMode: false
};

const $ = (id) => document.getElementById(id);
const el = {
  temp: $("temp"), hum: $("hum"), tempOut: $("tempOut"), humOut: $("humOut"),
  unplug: $("disconnect"), latency: $("latency"),
  levelNum: $("levelNum"), reason: $("reason"), warning: $("warning"),
  badge: $("modeBadge"), blades: $("blades"), compare: $("compare"), chip: $("statusChip"),
  modeAuto: $("modeAuto"), modeManual: $("modeManual"), levels: $("levels"),
  sensorStatus: $("sensorStatus"), chart: $("chart"),
  simTime: $("simTime"), scenarioOut: $("scenarioOut"),
  log: $("log"), exportCsv: $("exportCsv"),
  runQuick: $("runQuick"), runBig: $("runBig"), runSteady: $("runSteady"),
  testSummary: $("testSummary"), testList: $("testList")
};

// Only touch the page when the text really changes. This keeps screen readers
// from repeating the same message every second.
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}


/* ---------- 4. The simulated sensor ---------- */

const faults = { noise: false, spike: false, frozen: false, frozenT: 0, frozenH: 0 };
const sensor = {
  recentT: [], recentH: [],        // the last few readings
  lastKey: "", lastChangeAt: Date.now(),
  spikesIgnored: 0,
  frozen: false,
  out: { t: NaN, h: NaN }          // what the controller gets to see
};

// What the sensor would report right now, including any fault we switched on.
function rawReading() {
  if (state.unplugged) return { t: NaN, h: NaN };
  if (faults.frozen) return { t: faults.frozenT, h: faults.frozenH };

  // A real sensor wobbles a tiny bit even in a still room.
  let t = state.temp + (Math.random() - 0.5) * 0.2;
  let h = state.hum + (Math.random() - 0.5) * 1;

  if (faults.noise) { t += (Math.random() - 0.5) * 3; h += (Math.random() - 0.5) * 8; }
  if (faults.spike && Math.random() < 0.15) t += 15;
  return { t, h: Math.min(100, Math.max(0, h)) };
}

// Cleans up the raw reading: takes the middle of the last few readings (so one
// wild value can't move the fan), counts spikes, and notices a frozen sensor.
function readSensor() {
  const raw = rawReading();

  if (Number.isNaN(raw.t) || Number.isNaN(raw.h)) {          // unplugged
    sensor.recentT.length = 0;
    sensor.recentH.length = 0;
    sensor.frozen = false;
    sensor.out = { t: NaN, h: NaN };
    return sensor.out;
  }

  const key = raw.t.toFixed(2) + "|" + raw.h.toFixed(2);
  if (key !== sensor.lastKey) { sensor.lastKey = key; sensor.lastChangeAt = Date.now(); }
  sensor.frozen = Date.now() - sensor.lastChangeAt > FROZEN_MS;
  if (sensor.frozen) {                                       // a frozen sensor can't be trusted
    sensor.out = { t: NaN, h: NaN };
    return sensor.out;
  }

  sensor.recentT.push(raw.t);
  sensor.recentH.push(raw.h);
  if (sensor.recentT.length > FILTER_SIZE) { sensor.recentT.shift(); sensor.recentH.shift(); }

  const middleT = median(sensor.recentT);
  if (Math.abs(raw.t - middleT) > SPIKE_DELTA) sensor.spikesIgnored++;

  sensor.out = { t: Math.round(middleT * 10) / 10, h: Math.round(median(sensor.recentH)) };
  return sensor.out;
}


/* ---------- 5. The main update cycle and drawing the page ---------- */

// Runs on every slider move, button press, and once per second.
function update() {
  const startedAt = performance.now();
  const wasSafeMode = state.safeMode;

  // 1. Read the sensor
  const reading = readSensor();
  const check = validateReading(reading.t, reading.h);
  if (sensor.frozen) {
    check.message = `The sensor looks frozen: its reading hasn't changed for ${FROZEN_MS / 1000} seconds.`;
  }

  // 2. Work out what automatic mode wants
  if (check.ok) {
    state.invalidSince = null;
    state.safeMode = false;
    state.problem = "";
    const result = getFanLevel(reading.t, reading.h, state.autoLevel);
    state.autoLevel = result.level;
    state.reason = result.reason;
  } else {
    if (state.invalidSince === null) state.invalidSince = Date.now();
    const decision = failSafeDecision(Date.now() - state.invalidSince, state.autoLevel);
    state.autoLevel = decision.level;
    state.safeMode = decision.active;
    state.reason = "";

    const seconds = FAILSAFE_DELAY_MS / 1000;
    if (state.mode === "manual") {
      state.problem = `${check.message} You're in manual mode, so the fan stays at your level ${state.manualLevel}.`;
    } else if (decision.active) {
      state.problem = `Safe mode: ${check.message} With no usable readings, the fan is set to a steady level ${FAILSAFE_LEVEL} until they return.`;
    } else {
      state.problem = `${check.message} Keeping the fan at level ${decision.level} for up to ${seconds} seconds before switching to safe mode.`;
    }
  }

  // 3. Decide what the fan is really doing
  const before = state.activeLevel;
  state.activeLevel = chooseActiveLevel(state.mode, state.manualLevel, state.autoLevel);
  if (state.activeLevel !== before && state.activeLevel !== null) logLevelChange(before, state.activeLevel);
  if (state.safeMode && !wasSafeMode) logEvent(`Safe mode switched on: fan set to level ${FAILSAFE_LEVEL}`);
  if (!state.safeMode && wasSafeMode) logEvent("Safe mode switched off: good readings are back");

  // 4. Show it
  render();
  saveSettings();
  updateChartAndStatus();
  setText(el.latency, (performance.now() - startedAt).toFixed(2) + " ms");
}

function render() {
  const manual = state.mode === "manual";
  const level = state.activeLevel;

  setText(el.levelNum, level === null ? "–" : String(level));
  setText(el.badge, manual ? "Manual – you're in control" : "Automatic");
  el.badge.classList.toggle("manual", manual);

  setText(el.reason, manual
    ? "You picked this level yourself, so automatic control is paused."
    : state.reason);

  el.warning.hidden = !state.problem;
  setText(el.warning, state.problem);

  // The fan picture spins faster at higher levels
  el.blades.classList.toggle("spin", level !== null);
  if (level !== null) el.blades.style.setProperty("--spin", SPIN_SECONDS[level] + "s");

  // Automatic / manual buttons
  el.modeAuto.classList.toggle("on", !manual);
  el.modeManual.classList.toggle("on", manual);
  el.modeManual.classList.toggle("manual", manual);
  el.modeAuto.setAttribute("aria-pressed", String(!manual));
  el.modeManual.setAttribute("aria-pressed", String(manual));

  // Level 1–5 buttons only work in manual mode
  for (const button of el.levels.children) {
    const n = Number(button.dataset.level);
    button.disabled = !manual || scenario.running;
    button.classList.toggle("sel", manual && n === state.manualLevel);
  }

  setText(el.compare, manual && state.autoLevel !== null
    ? `If you switch back to automatic, AirSense would choose level ${state.autoLevel} right now.`
    : "");

  // The status chip in the header
  let chipText = "Simulation – all good", chipClass = "chip";
  if (state.safeMode && !manual) { chipText = "SAFE MODE ACTIVE"; chipClass = "chip bad"; }
  else if (state.invalidSince !== null) { chipText = "Sensor problem"; chipClass = "chip warnchip"; }
  setText(el.chip, chipText);
  el.chip.className = chipClass;

  setText(el.tempOut, `${state.temp} °C`);
  setText(el.humOut, `${state.hum} %`);
}


/* ---------- 6. Log, CSV download and saved settings ---------- */

const csvRows = [];

function logEvent(text) {
  const now = new Date();
  const item = document.createElement("li");
  const clock = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.textContent = `${clock} – ${text}`;
  el.log.prepend(item);
  while (el.log.children.length > 20) el.log.lastChild.remove();

  csvRows.push([
    now.toISOString(),
    state.unplugged ? "" : state.temp,
    state.unplugged ? "" : state.hum,
    state.mode,
    state.activeLevel === null ? "" : state.activeLevel,
    text
  ]);
  if (csvRows.length > 5000) csvRows.shift();
}

function logLevelChange(from, to) {
  const how = state.mode === "manual" ? "manual" : "automatic";
  logEvent(from === null ? `Started at level ${to} (${how})` : `Level ${from} → ${to} (${how})`);
}

function downloadCsv() {
  const header = ["time", "temperature_C", "humidity_percent", "mode", "fan_level", "what_happened"];
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const lines = [header, ...csvRows].map((row) => row.map(quote).join(","));
  // The leading \ufeff helps Excel show symbols like ° and → correctly.
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "airsense_log.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

// Remember the mode and manual level, so reloading the page (like a power cut) picks up where you left off.
function saveSettings() {
  try {
    localStorage.setItem("airsense", JSON.stringify({ mode: state.mode, manualLevel: state.manualLevel }));
  } catch (error) { /* storage can be blocked; the app still works without it */ }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("airsense") || "null");
    const goodLevel = saved && Number.isInteger(saved.manualLevel) && saved.manualLevel >= 1 && saved.manualLevel <= 5;
    if (goodLevel && (saved.mode === "auto" || saved.mode === "manual")) {
      state.mode = saved.mode;
      state.manualLevel = saved.manualLevel;
    }
  } catch (error) { /* ignore damaged or blocked storage */ }
}


/* ---------- 7. The live chart ---------- */

const chart = { points: [], lastAdded: 0 };

function drawChart() {
  const canvas = el.chart;
  if (!canvas.clientWidth || !canvas.clientHeight) return;     // not visible

  // Match the drawing size to the screen so lines stay sharp
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }

  const ctx = canvas.getContext("2d");
  const colours = getComputedStyle(document.documentElement);
  const pad = 10 * ratio;
  const count = chart.points.length;
  ctx.clearRect(0, 0, width, height);

  // Faint grid lines
  ctx.strokeStyle = colours.getPropertyValue("--line");
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (height - 2 * pad) * i / 4;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }

  if (count < 2) {
    ctx.fillStyle = colours.getPropertyValue("--muted");
    ctx.font = `${14 * ratio}px sans-serif`;
    ctx.fillText("Collecting readings…", pad, height / 2);
    return;
  }

  const stepX = width / (CHART_POINTS - 1);
  const drawLine = (field, min, max, colour) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2 * ratio;
    ctx.beginPath();
    let penDown = false;
    chart.points.forEach((point, i) => {
      const value = point[field];
      if (!Number.isFinite(value)) { penDown = false; return; }     // leave a gap when there's no reading
      const x = width - (count - 1 - i) * stepX;
      const y = pad + (height - 2 * pad) * (1 - (value - min) / (max - min));
      if (penDown) ctx.lineTo(x, y); else { ctx.moveTo(x, y); penDown = true; }
    });
    ctx.stroke();
  };

  drawLine("temp", 10, 45, colours.getPropertyValue("--manual"));
  drawLine("hum", 0, 100, colours.getPropertyValue("--accent"));
  drawLine("level", 1, 5, colours.getPropertyValue("--ink"));
}

// Called at the end of every update().
function updateChartAndStatus() {
  const now = Date.now();
  if (scenario.running || now - chart.lastAdded >= 900) {
    chart.lastAdded = now;
    chart.points.push({ temp: sensor.out.t, hum: sensor.out.h, level: state.activeLevel });
    if (chart.points.length > CHART_POINTS) chart.points.shift();
    drawChart();
  }

  let sensorWord = "working";
  if (state.unplugged) sensorWord = "unplugged";
  else if (sensor.frozen) sensorWord = "frozen, so it isn't trusted";
  setText(el.sensorStatus,
    `Filter: middle of the last ${FILTER_SIZE} readings · Spikes ignored so far: ${sensor.spikesIgnored} · Sensor: ${sensorWord}`);
}


/* ---------- 8. Buttons and sliders ---------- */

function createLevelButtons() {
  for (let n = 1; n <= 5; n++) {
    const button = document.createElement("button");
    button.textContent = n;
    button.dataset.level = n;
    button.setAttribute("aria-label", `Fan level ${n}`);
    button.addEventListener("click", () => { state.manualLevel = n; update(); });
    el.levels.appendChild(button);
  }
}

function setFault(name, on) {
  faults[name] = on;
  if (name === "frozen" && on) { faults.frozenT = state.temp; faults.frozenH = state.hum; }
  document.querySelector(`[data-fault="${name}"]`).setAttribute("aria-pressed", String(on));
  logEvent(`Sensor problem "${name}" switched ${on ? "on" : "off"}`);
  update();
}

function bindControls() {
  el.temp.addEventListener("input", () => { state.temp = Number(el.temp.value); update(); });
  el.hum.addEventListener("input", () => { state.hum = Number(el.hum.value); update(); });
  el.unplug.addEventListener("change", () => { state.unplugged = el.unplug.checked; update(); });

  el.modeAuto.addEventListener("click", () => { state.mode = "auto"; update(); });
  el.modeManual.addEventListener("click", () => {
    state.mode = "manual";
    if (state.activeLevel !== null) state.manualLevel = state.activeLevel;   // start from where the fan is, so nothing jumps
    update();
  });

  document.querySelectorAll("[data-fault]").forEach((button) =>
    button.addEventListener("click", () => setFault(button.dataset.fault, button.getAttribute("aria-pressed") !== "true")));
  document.querySelectorAll("[data-scenario]").forEach((button) =>
    button.addEventListener("click", () => startScenario(button.dataset.scenario)));

  el.exportCsv.addEventListener("click", downloadCsv);
  el.runQuick.addEventListener("click", runQuickChecks);
  el.runBig.addEventListener("click", runHundredCases);
  el.runSteady.addEventListener("click", runSteadinessTest);
}


/* ---------- 9. Self-checks ---------- */

// [description, temperature, humidity, previous level, expected level]
const LEVEL_CHECKS = [
  ["23.9 °C gives level 1",                          23.9, 50, null, 1],
  ["24 °C (boundary) gives level 2",                 24,   50, null, 2],
  ["27.9 °C gives level 2",                          27.9, 50, null, 2],
  ["28 °C (boundary) gives level 3",                 28,   50, null, 3],
  ["29 °C at 65% humidity gives level 3",            29,   65, null, 3],
  ["31.9 °C gives level 3",                          31.9, 50, null, 3],
  ["32 °C (boundary) gives level 4",                 32,   50, null, 4],
  ["35 °C (boundary) gives level 5",                 35,   50, null, 5],
  ["40 °C gives level 5",                            40,   50, null, 5],
  ["29 °C at 70% humidity goes up one level",        29,   70, null, 4],
  ["40 °C at 90% humidity stays at 5",               40,   90, null, 5],
  ["27.5 °C after level 3 holds level 3",            27.5, 50, 3, 3],
  ["26.9 °C after level 3 drops to level 2",         26.9, 50, 3, 2],
  ["68% humidity after a humidity boost holds",      29,   68, 4, 4],
  ["66% humidity after a humidity boost drops",      29,   66, 4, 3]
];

// [description, temperature, humidity, should it be accepted?]
const READING_CHECKS = [
  ["A missing temperature is rejected",  NaN, 50,        false],
  ["A missing humidity is rejected",     25,  undefined, false],
  ["A temperature of 100 °C is rejected", 100, 50,       false],
  ["A humidity of 120% is rejected",     25,  120,       false],
  ["A normal reading is accepted",       25,  50,        true]
];

function showResults(summary, rows) {
  el.testSummary.textContent = summary;
  el.testList.innerHTML = "";
  for (const [passed, text] of rows) {
    const item = document.createElement("li");
    item.className = passed ? "pass" : "fail";
    item.textContent = `${passed ? "Pass" : "Fail"} – ${text}`;
    el.testList.appendChild(item);
  }
}

function runQuickChecks() {
  const rows = [];

  for (const [name, t, h, previous, expected] of LEVEL_CHECKS) {
    const got = getFanLevel(t, h, previous).level;
    rows.push([got === expected, got === expected ? name : `${name} (expected ${expected}, got ${got})`]);
  }
  for (const [name, t, h, expected] of READING_CHECKS) {
    const got = validateReading(t, h).ok;
    rows.push([got === expected, name]);
  }

  rows.push([median([27, 27.2, 42, 27.1, 27]) === 27.1, "The filter ignores a single wild reading"]);
  rows.push([median([1, 2, 3, 4]) === 2.5, "The filter handles an even number of readings"]);

  const summerDay = buildSeries("summer", 2026);
  const monsoonDay = buildSeries("monsoon", 2026);
  rows.push([summerDay.length === 144 && monsoonDay.length === 144, "A replayed day has 144 readings (one every 10 minutes)"]);
  rows.push([
    countChanges(summerDay, true) <= countChanges(summerDay, false) && countChanges(monsoonDay, true) <= countChanges(monsoonDay, false),
    "The breathing-room rule never adds level changes"
  ]);

  const shortGap = failSafeDecision(0, 4);
  const longGap = failSafeDecision(FAILSAFE_DELAY_MS + 1, 4);
  const neverKnown = failSafeDecision(0, null);
  rows.push([shortGap.level === 4 && !shortGap.active, "A short sensor gap keeps the last level"]);
  rows.push([longGap.level === FAILSAFE_LEVEL && longGap.active, "A long sensor gap switches to safe mode"]);
  rows.push([neverKnown.level === FAILSAFE_LEVEL && neverKnown.active, "No reading at all switches to safe mode"]);

  rows.push([
    chooseActiveLevel("manual", 5, 2) === 5 && chooseActiveLevel("auto", 5, 2) === 2,
    "Manual mode overrides the automatic level; automatic mode follows it"
  ]);

  const passed = rows.filter(([ok]) => ok).length;
  showResults(`${passed} of ${rows.length} quick checks passed`, rows);
}

// 100 cases: 16 boundary cases plus 84 repeatable random ones, checked against the second version of the rules.
function runHundredCases() {
  const cases = [];
  [23.9, 24, 27.9, 28, 31.9, 32, 34.9, 35].forEach((t) => [69, 70].forEach((h) => cases.push([t, h])));
  const random = makeRng(2026);
  while (cases.length < 100) {
    cases.push([Math.round((10 + random() * 35) * 2) / 2, Math.round(20 + random() * 75)]);
  }

  let correct = 0;
  const misses = [];
  for (const [t, h] of cases) {
    const got = getFanLevel(t, h, null).level;
    const expected = expectedLevel(t, h);
    if (got === expected) correct++;
    else misses.push([false, `${t} °C at ${h}%: expected level ${expected}, got ${got}`]);
  }
  showResults(`${correct} of 100 cases correct (the goal is at least 95)`, [
    [correct >= 95, "Meets the 95-out-of-100 goal. This tests the decision rules only, not real sensor accuracy."],
    ...misses.slice(0, 5)
  ]);
}

function runSteadinessTest() {
  const result = simulateSteadiness();
  const plural = (n) => `${n} level change${n === 1 ? "" : "s"}`;
  showResults(`${result.samples} readings (one per second) hovering around 28 °C`, [
    [result.withRule <= 1, `With AirSense's breathing-room rule: ${plural(result.withRule)}`],
    [result.withoutRule > result.withRule, `Without it: ${plural(result.withoutRule)}`]
  ]);
}


/* ---------- 10. The 24-hour replay ---------- */

const scenario = { running: false, timer: null, key: "", series: [], step: 0, changes: 0, previous: null, minutesAtLevel: [] };

function formatMinutes(minutes) {
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function setReplayLocked(locked) {
  for (const control of [el.temp, el.hum, el.unplug]) control.disabled = locked;
  document.querySelectorAll("[data-scenario]").forEach((button) => { button.disabled = locked; });
}

function startScenario(key) {
  if (scenario.running) return;

  // Start from a clean slate: automatic mode, sensor plugged in, no faults
  state.mode = "auto";
  state.unplugged = false;
  el.unplug.checked = false;
  for (const name of ["noise", "spike", "frozen"]) {
    if (faults[name]) setFault(name, false);
  }

  Object.assign(scenario, {
    running: true, key, series: buildSeries(key, 2026), step: 0, changes: 0, previous: null,
    minutesAtLevel: [0, 0, 0, 0, 0, 0]
  });
  el.scenarioOut.innerHTML = "";
  setReplayLocked(true);

  scenario.timer = setInterval(() => {
    const point = scenario.series[scenario.step];
    state.temp = point.t;
    state.hum = point.h;
    el.temp.value = point.t;
    el.hum.value = point.h;
    update();

    if (scenario.previous !== null && state.activeLevel !== scenario.previous) scenario.changes++;
    scenario.previous = state.activeLevel;
    scenario.minutesAtLevel[state.activeLevel] += 10;

    const hours = String(Math.floor(scenario.step / 6)).padStart(2, "0");
    const minutes = String((scenario.step % 6) * 10).padStart(2, "0");
    setText(el.simTime, `${SCENARIOS[key].name} – simulated time ${hours}:${minutes}`);

    scenario.step++;
    if (scenario.step >= scenario.series.length) finishScenario();
  }, 100);
}

function finishScenario() {
  clearInterval(scenario.timer);
  scenario.running = false;
  setReplayLocked(false);
  render();   // re-enable the controls that depend on the replay state

  const withoutRule = countChanges(scenario.series, false);
  const lines = [
    `Level changes with AirSense: ${scenario.changes}`,
    `Level changes on the same day without its filter and breathing-room rule: ${withoutRule}`,
    ...[1, 2, 3, 4, 5].map((level) => `Time at level ${level}: ${formatMinutes(scenario.minutesAtLevel[level])}`)
  ];
  for (const text of lines) {
    const item = document.createElement("li");
    item.textContent = text;
    el.scenarioOut.appendChild(item);
  }
  logEvent(`Replay finished (${SCENARIOS[scenario.key].name}): ${scenario.changes} level changes`);
}


/* ---------- 11. Start-up ---------- */

createLevelButtons();
bindControls();
loadSettings();
update();
setInterval(update, 1000);   // check again every second so safe mode can kick in on time
