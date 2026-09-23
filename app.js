"use strict";

/* ─── STATO ─────────────────────────────────── */
const DEFAULT_PROFILE = {
  birthYear: 1985,
  height: 175,
  sex: "M",
  activityLevel: 1.375,
};

// Configurazione focus obiettivo — fonti e derivazione dei valori: fonti.md § Deficit calorico e ritmo di dimagrimento
const FOCUS_CONFIG = {
  gradual:    { label:'Graduale',  sub:'Sostenibile', rate:0.35, deficit:375,  color:'#22c55e' },
  moderate:   { label:'Moderato',  sub:'Consigliato', rate:0.60, deficit:625,  color:'#3b82f6' },
  aggressive: { label:'Intensivo', sub:'Impegnativo', rate:0.85, deficit:850,  color:'#f97316' },
};

let state = {
  profile: { ...DEFAULT_PROFILE },
  measurements: [],
  goal: null,
  darkMode: localStorage.getItem("bm_theme") !== "light",
};

/* ─── SUPABASE: client + autenticazione ───────
   I dati (profilo, misurazioni, obiettivo) non vivono più in
   localStorage: vengono letti/scritti su Supabase, così sono
   sincronizzati su ogni dispositivo dove fai login. Il tema
   (dark/light) resta locale al dispositivo, non serve sincronizzarlo. */
const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
);
let currentUser = null;

async function saveProfile() {
  if (!currentUser) return;
  const { error } = await supabaseClient.from("profiles").upsert({
    user_id: currentUser.id,
    birth_year: state.profile.birthYear,
    height: state.profile.height,
    sex: state.profile.sex,
    activity_level: state.profile.activityLevel,
  });
  if (error) showToast("Errore salvataggio profilo", "error");
}

async function saveMeasurements() {
  // Usata solo per import/cancellazione massiva: riscrive tutte le righe.
  if (!currentUser) return;
  const { error: delErr } = await supabaseClient
    .from("measurements")
    .delete()
    .eq("user_id", currentUser.id);
  if (delErr) { showToast("Errore salvataggio misurazioni", "error"); return; }
  if (state.measurements.length === 0) return;
  const rows = state.measurements.map((m) => ({
    user_id: currentUser.id,
    date: m.date,
    weight: m.weight,
    fat: m.fat,
    muscle: m.muscle,
    water: m.water,
  }));
  const { data, error } = await supabaseClient
    .from("measurements")
    .insert(rows)
    .select();
  if (error) { showToast("Errore salvataggio misurazioni", "error"); return; }
  state.measurements = data.map(rowToMeasure);
}

function rowToMeasure(r) {
  return { id: r.id, date: r.date, weight: r.weight, fat: r.fat, muscle: r.muscle, water: r.water };
}

async function loadUserData() {
  const [profileRes, measureRes, goalRes] = await Promise.all([
    supabaseClient.from("profiles").select("*").eq("user_id", currentUser.id).maybeSingle(),
    supabaseClient.from("measurements").select("*").eq("user_id", currentUser.id),
    supabaseClient.from("goals").select("*").eq("user_id", currentUser.id).maybeSingle(),
  ]);

  // Se una qualsiasi lettura fallisce (es. rete instabile), NON tocchiamo
  // mai i dati salvati: mostriamo un avviso e usciamo, senza generare o
  // sovrascrivere nulla. Meglio un'app vuota momentaneamente che perdere dati.
  if (profileRes.error || measureRes.error || goalRes.error) {
    showToast("Errore di connessione: riprova a ricaricare la pagina", "error");
    return false;
  }

  state.profile = profileRes.data
    ? {
        birthYear: profileRes.data.birth_year,
        height: profileRes.data.height,
        sex: profileRes.data.sex,
        activityLevel: profileRes.data.activity_level,
      }
    : { ...DEFAULT_PROFILE };

  state.measurements = (measureRes.data || []).map(rowToMeasure);

  state.goal = goalRes.data
    ? {
        targetWeight: goalRes.data.target_weight,
        focus: goalRes.data.focus,
        startWeight: goalRes.data.start_weight,
        startDate: goalRes.data.start_date,
        projectedEndDate: goalRes.data.projected_end_date,
        weeklyRate: goalRes.data.weekly_rate,
        dailyDeficit: goalRes.data.daily_deficit,
        setAt: goalRes.data.set_at,
      }
    : null;

  // Nessuna generazione automatica di dati di esempio: se non hai ancora
  // misurazioni, l'app parte semplicemente vuota, in attesa che tu ne
  // aggiunga una o importi un JSON.
  return true;
}

/* ─── PLUGIN: testo centrale donut su canvas ── */
const doughnutCenterPlugin = {
  id: "doughnutCenter",
  afterDatasetsDraw(chart) {
    if (chart.config.type !== "doughnut") return;
    const { ctx, chartArea } = chart;
    if (!chartArea) return;
    const cx = (chartArea.left + chartArea.right) / 2;
    const cy = (chartArea.top + chartArea.bottom) / 2;
    const s = sorted();
    const latest = s[s.length - 1];
    const weight = latest ? latest.weight.toFixed(1) + " kg" : "—";
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "10px 'Sora', sans-serif";
    ctx.fillStyle = state.darkMode ? "#475569" : "#94a3b8";
    ctx.fillText("PESO", cx, cy - 10);
    ctx.font = "600 16px 'JetBrains Mono', monospace";
    ctx.fillStyle = state.darkMode ? "#e2e8f0" : "#0f172a";
    ctx.fillText(weight, cx, cy + 9);
    ctx.restore();
  },
};
Chart.register(doughnutCenterPlugin);
if (window["chartjs-plugin-annotation"]) {
  Chart.register(window["chartjs-plugin-annotation"]);
}

/* ─── CALCOLI ──────────────────────────────────
   Fonti e derivazione di tutte le formule/soglie di questa sezione: fonti.md */
function getAge(y) {
  return new Date().getFullYear() - y;
}
function calcBMI(w, h) {
  const m = h / 100;
  return w / (m * m);
}
function getBMIInfo(bmi) {
  // Soglie: fonti.md § BMI (classificazione OMS/WHO)
  if (bmi < 18.5) return { label: "Sottopeso", cls: "bmi-underweight" };
  if (bmi < 25) return { label: "Normopeso", cls: "bmi-normal" };
  if (bmi < 30) return { label: "Sovrappeso", cls: "bmi-overweight" };
  return { label: "Obesità", cls: "bmi-obese" };
}
function calcBMR(w, h, age, sex) {
  // Equazione di Mifflin-St Jeor (1990) — fonti.md § BMR
  const b = 10 * w + 6.25 * h - 5 * age;
  return sex === "M" ? b + 5 : b - 161;
}
function calcTDEE(w, h, age, sex, act) {
  // Fattore di attività (PAL) — fonti.md § TDEE
  return Math.round(calcBMR(w, h, age, sex) * act);
}
function calcFFMI(w, h, fatPct) {
  // Fat-Free Mass Index — fonti.md § FFMI
  return (w * (1 - fatPct / 100)) / Math.pow(h / 100, 2);
}
function actLabel(v) {
  return (
    {
      1.2: "Sedentario",
      1.375: "Leggermente attivo",
      1.55: "Moderato",
      1.725: "Molto attivo",
      1.9: "Estremo",
    }[String(v)] || ""
  );
}

/* ─── DATE / AGGREGAZIONE ────────────────────── */
function sorted() {
  return [...state.measurements].sort(
    (a, b) => new Date(a.date) - new Date(b.date),
  );
}

function filterRange(data, range) {
  if (range === "ALL") return data;
  const now = new Date(),
    cut = new Date(now);
  if (range === "1M") cut.setMonth(now.getMonth() - 1);
  if (range === "3M") cut.setMonth(now.getMonth() - 3);
  if (range === "6M") cut.setMonth(now.getMonth() - 6);
  if (range === "1Y") cut.setFullYear(now.getFullYear() - 1);
  if (range === "3Y") cut.setFullYear(now.getFullYear() - 3);
  return data.filter((d) => new Date(d.date) >= cut);
}

function avg(items, key) {
  return parseFloat(
    (items.reduce((s, i) => s + i[key], 0) / items.length).toFixed(1),
  );
}

function aggregateMonthly(data) {
  const g = {};
  data.forEach((d) => {
    const k = d.date.slice(0, 7);
    (g[k] = g[k] || []).push(d);
  });
  return Object.entries(g)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, items]) => ({
      date: k + "-15",
      weight: avg(items, "weight"),
      fat: avg(items, "fat"),
      muscle: avg(items, "muscle"),
      water: avg(items, "water"),
    }));
}
function aggregateYearly(data) {
  const g = {};
  data.forEach((d) => {
    const k = d.date.slice(0, 4);
    (g[k] = g[k] || []).push(d);
  });
  return Object.entries(g)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, items]) => ({
      date: k + "-07-01",
      weight: avg(items, "weight"),
      fat: avg(items, "fat"),
      muscle: avg(items, "muscle"),
      water: avg(items, "water"),
    }));
}
function prepareData(range, viewMode) {
  const base = filterRange(sorted(), range);
  if (viewMode === "monthly") return aggregateMonthly(base);
  if (viewMode === "yearly") return aggregateYearly(base);
  return base;
}
function timeUnitFor(mode, count) {
  if (mode === "yearly") return "year";
  if (mode === "monthly") return "month";
  if (count <= 15) return "day";
  if (count <= 70) return "week";
  return "month";
}
function fmtTooltipDate(ts, mode) {
  const d = new Date(ts);
  if (mode === "yearly") return d.getFullYear().toString();
  if (mode === "monthly")
    return d.toLocaleDateString("it-IT", { month: "long", year: "numeric" });
  return d.toLocaleDateString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
function fmtDateIT(str) {
  return new Date(str + "T12:00:00").toLocaleDateString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/* ─── ISTANZE CHART ─────────────────────────── */
let chartW = null,
  chartC = null,
  chartBC = null,
  chartR = null;

/* ─── STATO UI ──────────────────────────────── */
let rangeW = "1Y",
  viewW = "daily";
let rangeBC = "1Y",
  viewBC = "daily";
let expandedW = false,
  expandedBC = false;
let hiddenDatasetsBC = new Set(["BMI", "FFMI"]);

/* ─── COLORI TEMA ────────────────────────────── */
function cc() {
  const dk = state.darkMode;
  return {
    grid: dk ? "rgba(255,255,255,0.045)" : "rgba(0,0,0,0.055)",
    tick: dk ? "#475569" : "#94a3b8",
    ttBg: dk ? "#1a2436" : "#ffffff",
    ttBrd: dk ? "#1e2d45" : "#dde3ee",
    ttTi: dk ? "#e2e8f0" : "#0f172a",
    ttBo: dk ? "#94a3b8" : "#64748b",
    ptBrd: dk ? "#111827" : "#ffffff",
  };
}
function mkGrad(ctx, h, r, g, b) {
  const gr = ctx.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, `rgba(${r},${g},${b},0.28)`);
  gr.addColorStop(1, `rgba(${r},${g},${b},0.00)`);
  return gr;
}

/* ─── CHART: PESO ────────────────────────────── */
function renderWeightChart() {
  if (goalMode && state.goal) { renderGoalModeChart(); return; }
  const data = prepareData(rangeW, viewW);
  const c = cc(),
    ctx = el("chart-weight").getContext("2d");
  const H = el("wrap-weight").offsetHeight || 280;
  const grad = mkGrad(ctx, H, 59, 130, 246);
  const pr = data.length > 40 ? 2 : 5;
  const datasets = [
    {
      label: "Peso (kg)",
      data: data.map((d) => d.weight),
      borderColor: "#3b82f6",
      backgroundColor: grad,
      borderWidth: 2.5,
      pointRadius: pr,
      pointHoverRadius: 8,
      pointBackgroundColor: "#3b82f6",
      pointBorderColor: c.ptBrd,
      pointBorderWidth: 2,
      fill: true,
      tension: 0.4,
    },
  ];
  if (chartW) chartW.destroy();
  chartW = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map((d) => d.date),
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 550, easing: "easeInOutCubic" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: c.ttBg,
          borderColor: c.ttBrd,
          borderWidth: 1,
          titleColor: c.ttTi,
          bodyColor: c.ttBo,
          padding: 12,
          callbacks: {
            title: (items) => fmtTooltipDate(items[0].parsed.x, viewW),
            label: (item) => `  Peso: ${item.parsed.y.toFixed(1)} kg`,
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: {
            unit: timeUnitFor(viewW, data.length),
            displayFormats: {
              day: "dd/MM",
              week: "dd/MM",
              month: "MMM ''yy",
              year: "yyyy",
            },
          },
          grid: { color: c.grid, drawTicks: false },
          ticks: {
            color: c.tick,
            font: { family: "'JetBrains Mono'", size: 10 },
            maxRotation: 0,
          },
          border: { display: false },
        },
        y: {
          grid: { color: c.grid },
          ticks: {
            color: c.tick,
            font: { family: "'JetBrains Mono'", size: 10 },
            callback: (v) => v + " kg",
          },
          border: { display: false },
        },
      },
    },
  });
}

/* ─── CHART: DONUT ───────────────────────────── */
function renderCompositionChart() {
  const s = sorted(),
    latest = s[s.length - 1],
    ctx = el("chart-composition").getContext("2d"),
    c = cc();
  el("comp-date").textContent = latest ? fmtDateIT(latest.date) : "";
  el("leg-fat").textContent = latest ? latest.fat.toFixed(1) + "%" : "—";
  el("leg-muscle").textContent = latest ? latest.muscle.toFixed(1) + "%" : "—";
  el("leg-water").textContent = latest ? latest.water.toFixed(1) + "%" : "—";
  const vals = latest
    ? [latest.fat, latest.muscle, latest.water]
    : [33.3, 33.3, 33.4];
  if (chartC) chartC.destroy();
  chartC = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Grasso", "Muscolo", "Acqua"],
      datasets: [
        {
          data: vals,
          backgroundColor: [
            "rgba(249,115,22,0.82)",
            "rgba(34,197,94,0.82)",
            "rgba(56,189,248,0.82)",
          ],
          borderColor: ["#f97316", "#22c55e", "#38bdf8"],
          borderWidth: 2,
          hoverOffset: 10,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "66%",
      animation: { duration: 600, easing: "easeInOutCubic" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: c.ttBg,
          borderColor: c.ttBrd,
          borderWidth: 1,
          titleColor: c.ttTi,
          bodyColor: c.ttBo,
          padding: 10,
          callbacks: {
            label: (item) => `  ${item.label}: ${item.parsed.toFixed(1)}%`,
          },
        },
      },
    },
  });
}

/* ─── CHART: COMPOSIZIONE (fat/muscle/water) ─── */
const GROUP_PCT = ["Grasso (%)", "Muscolo (%)", "Acqua (%)"];
const GROUP_DERIVED = ["BMI", "FFMI"];

function renderBodyCompChart() {
  const data = prepareData(rangeBC, viewBC);
  const c = cc(),
    ctx = el("chart-body-comp").getContext("2d");
  const H = el("wrap-comp").offsetHeight || 280;
  const gFat = mkGrad(ctx, H, 249, 115, 22),
    gMuscle = mkGrad(ctx, H, 34, 197, 94),
    gWater = mkGrad(ctx, H, 56, 189, 248),
    gBmi = mkGrad(ctx, H, 168, 85, 247),
    gFfmi = mkGrad(ctx, H, 234, 179, 8);
  const pr = data.length > 40 ? 2 : 5;

  const p = state.profile,
    age = getAge(p.birthYear),
    ranges = getIdealRanges(age, p.sex);

  // Modalità attiva: 'derived' se BMI o FFMI sono visibili, altrimenti 'pct'
  const mode =
    !hiddenDatasetsBC.has("BMI") || !hiddenDatasetsBC.has("FFMI")
      ? "derived"
      : "pct";

  const ds = (label, vals, color, grad, extra = {}) => ({
    label,
    data: vals,
    borderColor: color,
    backgroundColor: grad,
    borderWidth: 2.5,
    pointRadius: pr,
    pointHoverRadius: 8,
    pointBackgroundColor: color,
    pointBorderColor: c.ptBrd,
    pointBorderWidth: 2,
    fill: true,
    tension: 0.4,
    hidden: hiddenDatasetsBC.has(label),
    ...extra,
  });

  const datasets = [
    ds(
      "Grasso (%)",
      data.map((d) => d.fat),
      "#f97316",
      gFat,
    ),
    ds(
      "Muscolo (%)",
      data.map((d) => d.muscle),
      "#22c55e",
      gMuscle,
    ),
    ds(
      "Acqua (%)",
      data.map((d) => d.water),
      "#38bdf8",
      gWater,
    ),
  ];

  /* ─ BMI + FFMI (mutuamente esclusivi con Grasso/Muscolo/Acqua) ─ */
  datasets.push(
    ds(
      "BMI",
      data.map((d) => calcBMI(d.weight, p.height)),
      "#a855f7",
      gBmi,
      { fill: false, yAxisID: "y" },
    ),
  );
  datasets.push(
    ds(
      "FFMI",
      data.map((d) => calcFFMI(d.weight, p.height, d.fat)),
      "#eab308",
      gFfmi,
      { fill: false, yAxisID: "y" },
    ),
  );

  if (chartBC) chartBC.destroy();
  chartBC = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map((d) => d.date),
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 550, easing: "easeInOutCubic" },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: {
            color: c.tick,
            font: { family: "'Sora'", size: 12 },
            usePointStyle: true,
            pointStyleWidth: 8,
            padding: 18,
          },
          onClick(e, legendItem, legend) {
            const idx = legendItem.datasetIndex;
            const label = legend.chart.data.datasets[idx].label;

            if (hiddenDatasetsBC.has(label)) {
              hiddenDatasetsBC.delete(label);
              if (GROUP_DERIVED.includes(label)) {
                GROUP_PCT.forEach((l) => hiddenDatasetsBC.add(l));
              }
              if (GROUP_PCT.includes(label)) {
                GROUP_DERIVED.forEach((l) => hiddenDatasetsBC.add(l));
              }
            } else {
              hiddenDatasetsBC.add(label);
            }

            renderBodyCompChart();
          },
        },
        tooltip: {
          backgroundColor: c.ttBg,
          borderColor: c.ttBrd,
          borderWidth: 1,
          titleColor: c.ttTi,
          bodyColor: c.ttBo,
          padding: 12,
          callbacks: {
            title: (items) => fmtTooltipDate(items[0].parsed.x, viewBC),
            label: (item) => {
              const v = item.parsed.y;
              if (v == null) return null;
              const label = item.dataset.label;
              if (label === "BMI" || label === "FFMI")
                return `  ${label}: ${v.toFixed(1)}`;
              return `  ${label}: ${v.toFixed(1)}%`;
            },
          },
        },
        annotation: {
          annotations: {
            ...(mode === "derived" && !hiddenDatasetsBC.has("BMI")
              ? {
                  bmiBand: {
                    type: "box",
                    yScaleID: "y",
                    yMin: ranges.bmi.min,
                    yMax: ranges.bmi.max,
                    backgroundColor: "rgba(168,85,247,0.08)",
                    borderWidth: 0,
                  },
                }
              : {}),
            ...(mode === "derived" && !hiddenDatasetsBC.has("FFMI")
              ? {
                  ffmiBand: {
                    type: "box",
                    yScaleID: "y",
                    yMin: ranges.ffmi.min,
                    yMax: ranges.ffmi.max,
                    backgroundColor: "rgba(234,179,8,0.08)",
                    borderWidth: 0,
                  },
                }
              : {}),
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: {
            unit: timeUnitFor(viewBC, data.length),
            displayFormats: {
              day: "dd/MM",
              week: "dd/MM",
              month: "MMM ''yy",
              year: "yyyy",
            },
          },
          grid: { color: c.grid, drawTicks: false },
          ticks: {
            color: c.tick,
            font: { family: "'JetBrains Mono'", size: 10 },
            maxRotation: 0,
          },
          border: { display: false },
        },
        y: {
          grid: { color: c.grid },
          ticks: {
            color: c.tick,
            font: { family: "'JetBrains Mono'", size: 10 },
            callback: (v) => (mode === "pct" ? v + "%" : v),
          },
          border: { display: false },
        },
      },
    },
  });
}

/* ─── CHART: RADAR ───────────────────────────── */
// Range ideali per età/sesso (grasso, muscolo, acqua, FFMI) — fonti.md § Range ideali per età e sesso
function getIdealRanges(age, sex) {
  const M = sex === "M";
  const fat = M
    ? age < 40
      ? { min: 8, max: 20 }
      : age < 60
        ? { min: 11, max: 22 }
        : { min: 13, max: 25 }
    : age < 40
      ? { min: 21, max: 33 }
      : age < 60
        ? { min: 23, max: 34 }
        : { min: 24, max: 36 };
  const muscle = M
    ? age < 40
      ? { min: 40, max: 44 }
      : age < 60
        ? { min: 38, max: 42 }
        : { min: 36, max: 40 }
    : age < 40
      ? { min: 34, max: 38 }
      : age < 60
        ? { min: 32, max: 36 }
        : { min: 30, max: 34 };
  const water = M ? { min: 55, max: 65 } : { min: 45, max: 55 };
  const bmi = { min: 18.5, max: 24.9 };
  const ffmi = M ? { min: 18, max: 22 } : { min: 15, max: 18.5 };
  return { fat, muscle, water, bmi, ffmi };
}
function scoreMetric(val, idealMin, idealMax, worstLow, worstHigh) {
  if (val >= idealMin && val <= idealMax) {
    const mid = (idealMin + idealMax) / 2,
      half = (idealMax - idealMin) / 2;
    return Math.round(100 - (Math.abs(val - mid) / half) * 30);
  }
  if (val < idealMin) {
    const r = Math.max(idealMin - worstLow, 0.01);
    return Math.max(0, Math.round((70 * (val - worstLow)) / r));
  }
  const r = Math.max(worstHigh - idealMax, 0.01);
  return Math.max(0, Math.round(70 * (1 - (val - idealMax) / r)));
}
function renderRadarChart() {
  const s = sorted(),
    latest = s[s.length - 1],
    p = state.profile;
  const age = getAge(p.birthYear),
    c = cc(),
    ctx = el("chart-radar").getContext("2d"),
    dk = state.darkMode;
  el("radar-age-tag").textContent =
    `${age} anni · ${p.sex === "M" ? "M" : "F"}`;
  if (!latest) {
    el("radar-metrics").innerHTML =
      '<p style="text-align:center;color:var(--txt3);padding:12px;font-size:12px">Nessun dato</p>';
    if (chartR) {
      chartR.destroy();
      chartR = null;
    }
    return;
  }
  const bmi = calcBMI(latest.weight, p.height),
    ffmi = calcFFMI(latest.weight, p.height, latest.fat);
  const ranges = getIdealRanges(age, p.sex);
  const metrics = [
    { key: "BMI", val: bmi, unit: "", dp: 1, r: ranges.bmi, lo: 12, hi: 40 },
    {
      key: "Grasso",
      val: latest.fat,
      unit: "%",
      dp: 1,
      r: ranges.fat,
      lo: 2,
      hi: 55,
    },
    {
      key: "Muscolo",
      val: latest.muscle,
      unit: "%",
      dp: 1,
      r: ranges.muscle,
      lo: 15,
      hi: 65,
    },
    {
      key: "Acqua",
      val: latest.water,
      unit: "%",
      dp: 1,
      r: ranges.water,
      lo: 25,
      hi: 80,
    },
    { key: "FFMI", val: ffmi, unit: "", dp: 1, r: ranges.ffmi, lo: 10, hi: 30 },
  ];
  const scores = metrics.map((m) =>
    scoreMetric(m.val, m.r.min, m.r.max, m.lo, m.hi),
  );
  el("radar-metrics").innerHTML = metrics
    .map((m, i) => {
      const sc = scores[i],
        color = sc >= 70 ? "#22c55e" : sc >= 45 ? "#f97316" : "#ef4444";
      return `<div class="rm-row" title="Range ideale: ${m.r.min}–${m.r.max}${m.unit}">
                  <div class="rm-key">${m.key}</div>
                  <div class="rm-val">${m.val.toFixed(m.dp)}${m.unit}</div>
                  <div class="rm-bar-wrap"><div class="rm-bar" style="width:${sc}%;background:${color}"></div></div>
                  <div class="rm-score" style="color:${color}">${sc}</div>
                </div>`;
    })
    .join("");
  const aRgb = dk ? "59,130,246" : "37,99,235";
  const refBrd = dk ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.13)";
  const gridC = dk ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.08)";
  if (chartR) chartR.destroy();
  chartR = new Chart(ctx, {
    type: "radar",
    data: {
      labels: metrics.map((m) => m.key),
      datasets: [
        {
          label: "Zona ideale",
          data: [85, 85, 85, 85, 85],
          borderColor: refBrd,
          backgroundColor: dk ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)",
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          pointHoverRadius: 0,
          order: 1,
        },
        {
          label: "Valori attuali",
          data: scores,
          borderColor: `rgba(${aRgb},1)`,
          backgroundColor: `rgba(${aRgb},0.18)`,
          borderWidth: 2.2,
          pointRadius: 4,
          pointHoverRadius: 7,
          pointBackgroundColor: `rgba(${aRgb},1)`,
          pointBorderColor: dk ? "#111827" : "#ffffff",
          pointBorderWidth: 2,
          order: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 650, easing: "easeInOutCubic" },
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: {
            color: c.tick,
            font: { family: "'Sora'", size: 11 },
            usePointStyle: true,
            pointStyleWidth: 6,
            padding: 12,
          },
        },
        tooltip: {
          backgroundColor: c.ttBg,
          borderColor: c.ttBrd,
          borderWidth: 1,
          titleColor: c.ttTi,
          bodyColor: c.ttBo,
          padding: 10,
          callbacks: {
            title: (items) => items[0].label,
            label: (item) =>
              item.datasetIndex === 0
                ? "  Zona ideale: 85/100"
                : `  Valore: ${metrics[item.dataIndex].val.toFixed(1)}${metrics[item.dataIndex].unit}  |  Score: ${scores[item.dataIndex]}/100`,
            afterLabel: (item) =>
              item.datasetIndex !== 1
                ? ""
                : ` Range ideale: ${metrics[item.dataIndex].r.min}–${metrics[item.dataIndex].r.max}${metrics[item.dataIndex].unit}`,
          },
        },
      },
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: {
            stepSize: 25,
            color: c.tick,
            font: { family: "'JetBrains Mono'", size: 9 },
            backdropColor: "transparent",
          },
          grid: { color: gridC },
          angleLines: { color: gridC },
          pointLabels: {
            color: c.ttTi,
            font: { family: "'Sora'", size: 12, weight: "600" },
          },
        },
      },
    },
  });
}

/* ─── KPI ────────────────────────────────────── */
function renderKPIs() {
  const s = sorted(),
    latest = s[s.length - 1],
    prev = s[s.length - 2];
  if (!latest) {
    [
      "val-weight",
      "val-bmi",
      "val-calories",
      "val-fat",
      "val-muscle",
      "val-water",
    ].forEach((id) => (el(id).textContent = "—"));
    el("trend-weight").textContent = "";
    el("cat-bmi").textContent = "";
    el("val-fat-kg").textContent = "";
    el("val-muscle-kg").textContent = "";
    el("val-water-kg").textContent = "";
    el("profile-badge").innerHTML =
      '<i class="fas fa-user"></i> Configura il profilo';
    return;
  }
  const p = state.profile,
    age = getAge(p.birthYear);
  const bmi = calcBMI(latest.weight, p.height),
    bmiI = getBMIInfo(bmi);
  const bmr = Math.round(calcBMR(latest.weight, p.height, age, p.sex));
  const tdee = calcTDEE(latest.weight, p.height, age, p.sex, p.activityLevel);
  countUp("val-weight", latest.weight, (v) => v.toFixed(1) + " kg");
  countUp("val-calories", tdee, (v) => Math.round(v).toLocaleString("it-IT"));
  countUp("val-fat", latest.fat, (v) => v.toFixed(1) + "%");
  countUp("val-muscle", latest.muscle, (v) => v.toFixed(1) + "%");
  countUp("val-water", latest.water, (v) => v.toFixed(1) + "%");
  el("val-bmi").textContent = bmi.toFixed(1);
  el("val-bmi").className = "kpi-val mono " + bmiI.cls;
  el("cat-bmi").textContent = bmiI.label;
  el("cat-bmi").className = "kpi-sub " + bmiI.cls;
  if (prev) {
    const d = latest.weight - prev.weight,
      tEl = el("trend-weight");
    if (Math.abs(d) < 0.05) {
      tEl.textContent = "▸ Stabile";
      tEl.className = "kpi-trend trend-neutral";
    } else if (d > 0) {
      tEl.textContent = `▲ +${d.toFixed(1)} kg`;
      tEl.className = "kpi-trend trend-up";
    } else {
      tEl.textContent = `▼ ${d.toFixed(1)} kg`;
      tEl.className = "kpi-trend trend-down";
    }
  }
  el("val-fat-kg").textContent =
    ((latest.weight * latest.fat) / 100).toFixed(1) + " kg";
  el("val-muscle-kg").textContent =
    ((latest.weight * latest.muscle) / 100).toFixed(1) + " kg";
  el("val-water-kg").textContent =
    ((latest.weight * latest.water) / 100).toFixed(1) + " kg";
  el("profile-badge").innerHTML =
    `<i class="fas fa-user"></i> ${age} anni · ${p.height} cm · ${p.sex === "M" ? "M" : "F"} &nbsp;|&nbsp; BMR: <strong>${bmr.toLocaleString("it-IT")} kcal</strong>`;
}

/* ─── TABELLA ────────────────────────────────── */
let tableExpanded = false;
const TABLE_COLLAPSED_ROWS = 9;

function renderTable() {
  const s = sorted().reverse(),
    tbody = el("table-body");
  el("record-count").textContent = s.length + " voci";
  if (!s.length) {
    tbody.innerHTML =
      '<tr class="empty-state-row"><td colspan="7"><i class="fas fa-inbox"></i><p>Nessun dato inserito</p></td></tr>';
    renderTableExpandBtn(0);
    return;
  }
  const visible = tableExpanded ? s : s.slice(0, TABLE_COLLAPSED_ROWS);
  tbody.innerHTML = visible
    .map((d, i) => {
      const bmi = calcBMI(d.weight, state.profile.height),
        bmiI = getBMIInfo(bmi);
      return `<tr style="animation:fadeSlideUp .3s ease ${i * 0.025}s both">
                  <td>${fmtDateIT(d.date)}</td><td>${d.weight.toFixed(1)} kg</td>
                  <td class="${bmiI.cls}">${bmi.toFixed(1)}</td>
                  <td style="color:var(--fat-color)">${d.fat.toFixed(1)}%</td>
                  <td style="color:var(--water-color)">${d.water.toFixed(1)}%</td>
                  <td style="color:var(--muscle-color)">${d.muscle.toFixed(1)}%</td>
                  <td><button class="btn-delete" onclick="delMeasure('${d.id}')"><i class="fas fa-trash-alt"></i></button></td>
                </tr>`;
    })
    .join("");
  renderTableExpandBtn(s.length);
}

function renderTableExpandBtn(total) {
  const btn = el("btn-table-expand");
  if (!btn) return;
  if (total <= TABLE_COLLAPSED_ROWS) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  const hiddenCount = total - TABLE_COLLAPSED_ROWS;
  btn.innerHTML = tableExpanded
    ? '<i class="fas fa-chevron-up"></i> Mostra solo le ultime 9'
    : `<i class="fas fa-chevron-down"></i> Mostra tutte le voci (+${hiddenCount})`;
}

function renderAll() {
  renderKPIs();
  renderWeightChart();
  renderCompositionChart();
  renderBodyCompChart();
  renderRadarChart();
  renderTable();
}

/* ─── DATA OPS ───────────────────────────────── */
async function addMeasure(m) {
  if (!currentUser) return;
  const { data, error } = await supabaseClient
    .from("measurements")
    .upsert(
      {
        user_id: currentUser.id,
        date: m.date,
        weight: m.weight,
        fat: m.fat,
        muscle: m.muscle,
        water: m.water,
      },
      { onConflict: "user_id,date" },
    )
    .select()
    .single();
  if (error) { showToast("Errore salvataggio misurazione", "error"); return; }
  const exists = state.measurements.find((x) => x.date === m.date);
  if (exists) {
    Object.assign(exists, rowToMeasure(data));
    showToast("Misurazione aggiornata", "success");
  } else {
    state.measurements.push(rowToMeasure(data));
    showToast("Misurazione aggiunta!", "success");
  }
  renderAll();
}
window.delMeasure = async function (id) {
  if (!confirm("Eliminare questa misurazione?")) return;
  const { error } = await supabaseClient
    .from("measurements")
    .delete()
    .eq("id", id)
    .eq("user_id", currentUser.id);
  if (error) { showToast("Errore eliminazione", "error"); return; }
  state.measurements = state.measurements.filter((m) => m.id !== id);
  renderAll();
  showToast("Misurazione eliminata", "success");
};

/* ─── EXPAND ─────────────────────────────────── */
function toggleExpand(which) {
  if (which === "W") {
    expandedW = !expandedW;
    const sec = el("section-r1"),
      card = el("card-donut"),
      btn = el("expand-weight");
    sec.classList.toggle("expanded", expandedW);
    card.style.display = expandedW ? "none" : "";
    btn.querySelector("i").className = expandedW
      ? "fas fa-compress-alt"
      : "fas fa-expand-alt";
    btn.classList.toggle("active", expandedW);
    setTimeout(() => {
      if (chartW) chartW.resize();
    }, 60);
  } else {
    expandedBC = !expandedBC;
    const sec = el("section-r2"),
      card = el("card-radar"),
      btn = el("expand-comp");
    sec.classList.toggle("expanded", expandedBC);
    card.style.display = expandedBC ? "none" : "";
    btn.querySelector("i").className = expandedBC
      ? "fas fa-compress-alt"
      : "fas fa-expand-alt";
    btn.classList.toggle("active", expandedBC);
    setTimeout(() => {
      if (chartBC) chartBC.resize();
    }, 60);
  }
}

/* ─── TEMA ───────────────────────────────────── */
function applyTheme(rebuild = false) {
  document.documentElement.setAttribute(
    "data-theme",
    state.darkMode ? "dark" : "light",
  );
  const icon = document.querySelector("#btn-theme i");
  if (icon) icon.className = state.darkMode ? "fas fa-sun" : "fas fa-moon";
  localStorage.setItem("bm_theme", state.darkMode ? "dark" : "light");
  if (rebuild)
    setTimeout(() => {
      renderWeightChart();
      renderCompositionChart();
      renderBodyCompChart();
      renderRadarChart();
    }, 30);
}

/* ─── EXPORT / IMPORT ────────────────────────── */
function exportJSON() {
  const blob = new Blob(
    [
      JSON.stringify(
        {
          profile: state.profile,
          measurements: state.measurements,
          goal: state.goal || null,
          exported: new Date().toISOString(),
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = `bodymetrics-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Dati esportati!", "success");
}
function importJSON(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.profile)      state.profile      = data.profile;
      if (data.measurements) state.measurements = data.measurements;
      // Ripristina obiettivo se presente, altrimenti azzera
      state.goal = data.goal || null;
      await saveProfile();
      await saveMeasurements(); // riscrive tutte le righe su Supabase
      await saveGoal();
      // Se era in modalità obiettivo ma non c'è più goal, torna alla normale
      if (goalMode && !state.goal) { goalMode = false; }
      loadProfileForm();
      renderAll();
      updateGoalButton();
      const goalMsg = state.goal ? ` + obiettivo "${FOCUS_CONFIG[state.goal.focus]?.label}"` : "";
      showToast(`Importati ${state.measurements.length} record${goalMsg}!`, "success");
    } catch {
      showToast("File JSON non valido", "error");
    }
  };
  reader.readAsText(file);
}

/* ─── PROFILO ────────────────────────────────── */
function loadProfileForm() {
  el("birth-year").value = state.profile.birthYear;
  el("height").value = state.profile.height;
  el("sex").value = state.profile.sex;
  el("activity-level").value = state.profile.activityLevel;
  updateCalPreview();
}
function updateCalPreview() {
  const by = parseInt(el("birth-year").value) || state.profile.birthYear;
  const h = parseInt(el("height").value) || state.profile.height;
  const sx = el("sex").value || state.profile.sex;
  const act =
    parseFloat(el("activity-level").value) || state.profile.activityLevel;
  const s = sorted(),
    lat = s[s.length - 1];
  if (!lat) {
    el("modal-calorie-preview").textContent =
      "Aggiungi una misurazione per calcolare le calorie.";
    return;
  }
  const age = getAge(by),
    bmr = Math.round(calcBMR(lat.weight, h, age, sx)),
    tdee = Math.round(bmr * act);
  el("modal-calorie-preview").innerHTML =
    `<strong>BMR</strong> (basale): ${bmr.toLocaleString("it-IT")} kcal &nbsp;|&nbsp; <strong>TDEE</strong> (fabbisogno): ${tdee.toLocaleString("it-IT")} kcal<br>Formula Mifflin-St Jeor · ${actLabel(act)} ×${act}`;
}

/* ─── TOAST ──────────────────────────────────── */
let _tt;
function showToast(msg, type = "success") {
  const t = el("toast");
  el("toast-msg").textContent = msg;
  el("toast-icon").className =
    type === "success" ? "fas fa-check-circle" : "fas fa-circle-exclamation";
  t.className = `toast t-${type}`;
  clearTimeout(_tt);
  _tt = setTimeout(() => t.classList.add("hidden"), 3200);
}

/* ─── COUNT-UP ───────────────────────────────── */
function countUp(id, target, fmt) {
  const e = el(id),
    from = parseFloat(e.dataset.prev || 0);
  e.dataset.prev = target;
  const dur = 520,
    t0 = performance.now();
  const tick = (now) => {
    const p = Math.min((now - t0) / dur, 1),
      ease = 1 - Math.pow(1 - p, 3);
    e.textContent = fmt(from + (target - from) * ease);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ─── FORM VALIDATOR ─────────────────────────── */
function validateSum() {
  const f = parseFloat(el("entry-fat").value) || 0,
    m = parseFloat(el("entry-muscle").value) || 0,
    w = parseFloat(el("entry-water").value) || 0;
  if (!f && !m && !w) {
    el("form-sum").textContent = "";
    return;
  }
  const sum = f + m + w,
    se = el("form-sum");
  se.textContent = `Somma: ${sum.toFixed(1)}%`;
  if (sum >= 95 && sum <= 105) {
    se.className = "sum-indicator sum-ok";
    se.textContent += " ✓";
  } else if (sum < 90 || sum > 112) {
    se.className = "sum-indicator sum-error";
    se.textContent += " — controlla i valori";
  } else {
    se.className = "sum-indicator sum-warn";
    se.textContent += " — attenzione";
  }
}

/* ─── SHORTHAND ──────────────────────────────── */
function el(id) {
  return document.getElementById(id);
}
function openModal(id) {
  el(id).classList.remove("hidden");
}
function closeModal(id) {
  el(id).classList.add("hidden");
}

/* ─── SAMPLE DATA ────────────────────────────── */
function generateSampleData() {
  const data = [],
    now = new Date();
  let w = 82.4,
    fat = 21.8,
    mus = 42.1;
  for (let i = 168; i >= 0; i -= 7) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    w += (Math.random() - 0.53) * 0.5;
    fat += (Math.random() - 0.52) * 0.25;
    mus += (Math.random() - 0.48) * 0.2;
    w = Math.max(75, Math.min(90, w));
    fat = Math.max(14, Math.min(30, fat));
    mus = Math.max(36, Math.min(50, mus));
    const wat = Math.max(100 - fat - mus - 5, 20);
    data.push({
      id: "sample_" + i,
      date: d.toISOString().slice(0, 10),
      weight: parseFloat(w.toFixed(1)),
      fat: parseFloat(fat.toFixed(1)),
      muscle: parseFloat(mus.toFixed(1)),
      water: parseFloat(wat.toFixed(1)),
    });
  }
  return data;
}

/* ═══════════════════════════════════════════════
               EVENT LISTENERS
            ═══════════════════════════════════════════════ */
function initApp() {
  el("entry-date").value = new Date().toISOString().slice(0, 10);
  loadProfileForm();
  applyTheme(false);
  renderAll();
  updateGoalButton();

  /* tema */
  el("btn-theme").addEventListener("click", () => {
    state.darkMode = !state.darkMode;
    applyTheme(true);
  });

  /* modal profilo */
  el("btn-profile").addEventListener("click", () => {
    loadProfileForm();
    openModal("modal-profile");
    openGoalModal();
  });
  el("btn-close-modal").addEventListener("click", () =>
    closeModal("modal-profile"),
  );
  el("btn-close-modal-2").addEventListener("click", () =>
    closeModal("modal-profile"),
  );
  el("modal-profile").addEventListener("click", (e) => {
    if (e.target === el("modal-profile")) closeModal("modal-profile");
  });
  ["birth-year", "height", "sex", "activity-level"].forEach((id) => {
    el(id).addEventListener("change", updateCalPreview);
    el(id).addEventListener("input", updateCalPreview);
  });
  el("form-profile").addEventListener("submit", (e) => {
    e.preventDefault();
    state.profile = {
      birthYear: parseInt(el("birth-year").value),
      height: parseInt(el("height").value),
      sex: el("sex").value,
      activityLevel: parseFloat(el("activity-level").value),
    };
    saveProfile();
    closeModal("modal-profile");
    renderAll();
    showToast("Profilo aggiornato!", "success");
  });
  el("btn-clear-data").addEventListener("click", async () => {
    if (!confirm("Sei sicuro? Verranno cancellate TUTTE le misurazioni."))
      return;
    state.measurements = [];
    await saveMeasurements();
    closeModal("modal-profile");
    renderAll();
    updateGoalButton();
    showToast("Tutti i dati cancellati", "success");
  });

  /* modal aggiungi — pre-compila l'ultimo peso */
  const openAdd = () => {
    el("entry-date").value = new Date().toISOString().slice(0, 10);
    const s = sorted(),
      latest = s[s.length - 1];
    if (latest) {
      el("entry-weight").value = latest.weight.toFixed(1);
      el("entry-fat").value = latest.fat.toFixed(1);
      el("entry-water").value = latest.water.toFixed(1);
      el("entry-muscle").value = latest.muscle.toFixed(1);
      validateSum();
    } else {
      el("entry-weight").value = "";
      el("entry-fat").value = "";
      el("entry-water").value = "";
      el("entry-muscle").value = "";
      el("form-sum").textContent = "";
    }
    openModal("modal-add");
  };
  el("kpi-0").addEventListener("click", openAdd);
  el("btn-open-add").addEventListener("click", openAdd);
  el("btn-close-add").addEventListener("click", () => closeModal("modal-add"));
  el("modal-add").addEventListener("click", (e) => {
    if (e.target === el("modal-add")) closeModal("modal-add");
  });

  el("form-entry").addEventListener("submit", (e) => {
    e.preventDefault();
    const fat = parseFloat(el("entry-fat").value),
      muscle = parseFloat(el("entry-muscle").value),
      water = parseFloat(el("entry-water").value);
    if (fat + muscle + water > 125) {
      showToast("Somma percentuali troppo alta", "error");
      return;
    }
    addMeasure({
      date: el("entry-date").value,
      weight: parseFloat(el("entry-weight").value),
      fat,
      muscle,
      water,
    });
    el("form-entry").reset();
    el("entry-date").value = new Date().toISOString().slice(0, 10);
    el("form-sum").textContent = "";
    closeModal("modal-add");
  });
  ["entry-fat", "entry-muscle", "entry-water"].forEach((id) =>
    el(id).addEventListener("input", validateSum),
  );

  /* ─── GESTIONE SINCRONIZZATA FILTRI (Desktop & Mobile) ───
     Le selezioni Giorno/Mese/Anno e Periodo (1M/3M/…) sono condivise tra
     "Evoluzione del Peso" e "Composizione Corporea": cambiandole in un box
     si riflettono automaticamente anche nell'altro. In modalità Obiettivo
     il grafico Peso non mostra il cambiamento (mostra il piano obiettivo),
     ma lo stato resta sincronizzato "sotto traccia": uscendo da Obiettivo
     il grafico Peso si allinea subito a Composizione Corporea. */
  const updatePillsUI = (pillsId, dropId, attr, val) => {
    const pills = el(pillsId),
      drop = el(dropId);
    if (pills)
      pills
        .querySelectorAll(".pill")
        .forEach((x) => x.classList.toggle("active", x.dataset[attr] === val));
    if (drop)
      drop
        .querySelectorAll(".dropdown-item")
        .forEach((x) => x.classList.toggle("active", x.dataset[attr] === val));
  };

  const setViewWeight = (val, sync = true) => {
    viewW = val;
    updatePillsUI("view-weight", "drop-view-weight", "v", val);
    renderWeightChart();
    if (sync) setViewComp(val, false);
  };

  const setRangeWeight = (val, sync = true) => {
    rangeW = val;
    updatePillsUI("range-weight", "drop-range-weight", "r", val);
    renderWeightChart();
    if (sync) setRangeComp(val, false);
  };

  const setViewComp = (val, sync = true) => {
    viewBC = val;
    updatePillsUI("view-comp", "drop-view-comp", "v", val);
    renderBodyCompChart();
    if (sync) setViewWeight(val, false);
  };

  const setRangeComp = (val, sync = true) => {
    rangeBC = val;
    updatePillsUI("range-comp", "drop-range-comp", "r", val);
    renderBodyCompChart();
    if (sync) setRangeWeight(val, false);
  };

  /* Clic su Peso (Pills & Dropdown Items) */
  el("range-weight").addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (b) setRangeWeight(b.dataset.r);
  });
  el("drop-range-weight").addEventListener("click", (e) => {
    const b = e.target.closest(".dropdown-item");
    if (b) setRangeWeight(b.dataset.r);
  });
  el("view-weight").addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (b) setViewWeight(b.dataset.v);
  });
  el("drop-view-weight").addEventListener("click", (e) => {
    const b = e.target.closest(".dropdown-item");
    if (b) setViewWeight(b.dataset.v);
  });

  /* Clic su Composizione Corporea (Pills & Dropdown Items) */
  el("range-comp").addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (b) setRangeComp(b.dataset.r);
  });
  el("drop-range-comp").addEventListener("click", (e) => {
    const b = e.target.closest(".dropdown-item");
    if (b) setRangeComp(b.dataset.r);
  });
  el("view-comp").addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (b) setViewComp(b.dataset.v);
  });
  el("drop-view-comp").addEventListener("click", (e) => {
    const b = e.target.closest(".dropdown-item");
    if (b) setViewComp(b.dataset.v);
  });

  /* Toggle confronto anno su anno */
  /* ─── INIZIALIZZAZIONE DROPDOWN SCOMPARSA MOBILE ─── */
  const setupDropdown = (btnId, menuId) => {
    const btn = el(btnId);
    const menu = el(menuId);
    if (!btn || !menu) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".dropdown-menu").forEach((m) => {
        if (m !== menu) m.classList.add("hidden");
      });
      menu.classList.toggle("hidden");
    });
  };
  setupDropdown("btn-dropdown-weight", "menu-weight");
  setupDropdown("btn-dropdown-comp", "menu-comp");

  // Chiude tutti i menu a tendina cliccando all'esterno
  document.addEventListener("click", () => {
    document
      .querySelectorAll(".dropdown-menu")
      .forEach((m) => m.classList.add("hidden"));
  });

  /* expand */
  el("expand-weight").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleExpand("W");
  });
  el("expand-comp").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleExpand("BC");
  });

  /* accordion radar */
  el("toggle-radar").addEventListener("click", () => {
    const body = el("radar-metrics"),
      hd = el("toggle-radar");
    const isOpen = body.classList.toggle("open");
    hd.classList.toggle("open", isOpen);
    setTimeout(() => {
      if (chartBC) chartBC.resize();
      if (chartR) chartR.resize();
    }, 360);
  });

  /* export / import */
  el("btn-export").addEventListener("click", exportJSON);
  el("import-file").addEventListener("change", (e) => {
    if (e.target.files[0]) {
      importJSON(e.target.files[0]);
      e.target.value = "";
    }
  });

  /* ─── OTTIMIZZAZIONE RESIZE GLOBALE ─── */
  window.addEventListener("resize", () => {
    if (chartW) chartW.resize();
    if (chartC) chartC.resize();
    if (chartBC) chartBC.resize();
    if (chartR) chartR.resize();
  });

  /* ─── OBIETTIVO: EVENT LISTENERS ─── */

  // Tab switching in profile modal
  document.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      el('tab-' + tab.dataset.tab).classList.remove('hidden');
      if (tab.dataset.tab === 'goal') openGoalTab();
    });
  });

  // Focus selector (Graduale / Moderato / Intensivo)
  el('focus-selector').addEventListener('click', e => {
    const btn = e.target.closest('.focus-btn');
    if (!btn) return;
    _selectedFocus = btn.dataset.f;
    el('focus-selector').querySelectorAll('.focus-btn').forEach(b => b.classList.toggle('active', b.dataset.f === _selectedFocus));
    updateGoalPreview();
  });

  // Live preview quando cambia peso obiettivo
  el('goal-weight').addEventListener('input', updateGoalPreview);

  // Imposta obiettivo
  el('btn-set-goal').addEventListener('click', () => {
    const targetW = parseFloat(el('goal-weight').value);
    const s = sorted(), latest = s[s.length-1];
    if (!latest || isNaN(targetW) || targetW <= 0) { showToast('Inserisci un peso obiettivo valido', 'error'); return; }
    if (targetW >= latest.weight) { showToast('L\'obiettivo deve essere inferiore al peso attuale', 'error'); return; }
    const startDate = new Date().toISOString().slice(0,10);
    state.goal = {
      targetWeight: targetW,
      focus: _selectedFocus,
      startWeight: latest.weight,
      startDate,
      projectedEndDate: calcGoalEndDate(startDate, latest.weight, targetW, _selectedFocus),
      weeklyRate: getFocusRate(_selectedFocus),
      dailyDeficit: FOCUS_CONFIG[_selectedFocus].deficit,
      setAt: new Date().toISOString(),
    };
    saveGoal();
    openGoalTab();
    updateGoalButton();
    showToast('Obiettivo impostato! Visualizzalo nel grafico peso.', 'success');
  });

  // Elimina obiettivo
  el('btn-delete-goal').addEventListener('click', async () => {
    if (!confirm('Rimuovere l\'obiettivo corrente?')) return;
    state.goal = null;
    await saveGoal();
    if (goalMode) { goalMode = false; renderWeightChart(); }
    el('goal-info-bar').classList.add('hidden');
    openGoalTab();
    updateGoalButton();
    showToast('Obiettivo rimosso', 'success');
  });

  // Toggle modalità obiettivo nel grafico peso
  el('btn-goal-mode').addEventListener('click', toggleGoalMode);

  /* ─── TABELLA: ESPANDI / COMPRIMI ─── */
  el('btn-table-expand').addEventListener('click', () => {
    tableExpanded = !tableExpanded;
    renderTable();
  });

  /* logout */
  el('btn-logout').addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
    location.reload();
  });

  /* ─── HAMBURGER MENU (mobile verticale) ─── */
  const menuToggle = el('btn-menu-toggle');
  const headerActions = el('header-actions');
  if (menuToggle && headerActions) {
    menuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      headerActions.classList.toggle('open');
    });
    // chiudi il menu dopo aver scelto una voce
    headerActions.querySelectorAll('.btn-header').forEach((btn) => {
      btn.addEventListener('click', () => headerActions.classList.remove('open'));
    });
    // chiudi il menu cliccando fuori
    document.addEventListener('click', (e) => {
      if (
        headerActions.classList.contains('open') &&
        !headerActions.contains(e.target) &&
        e.target !== menuToggle &&
        !menuToggle.contains(e.target)
      ) {
        headerActions.classList.remove('open');
      }
    });
  }
}

/* ═══════════════════════════════════════════════
               AUTENTICAZIONE (Supabase Auth)
   L'app resta bloccata dietro l'overlay di login finché non
   c'è una sessione valida. Dopo il login, carica i dati
   dell'utente da Supabase e poi avvia l'app (initApp).
   ═══════════════════════════════════════════════ */
let authMode = "login"; // "login" | "signup"

async function bootstrapAuth() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    await enterApp(session.user);
    return;
  }
  setupAuthForm();
}

async function enterApp(user) {
  currentUser = user;
  el("auth-overlay").classList.add("hidden");
  const ok = await loadUserData();
  if (!ok) {
    // Caricamento fallito: mostriamo di nuovo il login/overlay invece di
    // avviare l'app con dati incompleti, per evitare di salvare stati errati.
    el("auth-overlay").classList.remove("hidden");
    return;
  }
  initApp();
}

function setupAuthForm() {
  const form = el("form-auth");
  const toggleBtn = el("btn-auth-toggle");
  const errEl = el("auth-error");
  const infoEl = el("auth-info");
  const submitBtn = el("btn-auth-submit");

  const showError = (msg) => {
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
    infoEl.classList.add("hidden");
  };
  const showInfo = (msg) => {
    infoEl.textContent = msg;
    infoEl.classList.remove("hidden");
    errEl.classList.add("hidden");
  };

  toggleBtn.addEventListener("click", () => {
    authMode = authMode === "login" ? "signup" : "login";
    el("auth-title").textContent = authMode === "login" ? "Accedi" : "Crea account";
    submitBtn.textContent = authMode === "login" ? "Accedi" : "Registrati";
    toggleBtn.textContent =
      authMode === "login" ? "Non hai un account? Registrati" : "Hai già un account? Accedi";
    errEl.classList.add("hidden");
    infoEl.classList.add("hidden");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = el("auth-email").value.trim();
    const password = el("auth-password").value;
    submitBtn.disabled = true;
    errEl.classList.add("hidden");
    infoEl.classList.add("hidden");
    try {
      if (authMode === "login") {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) { showError(error.message); return; }
        await enterApp(data.user);
      } else {
        const { data, error } = await supabaseClient.auth.signUp({ email, password });
        if (error) { showError(error.message); return; }
        if (data.session) {
          await enterApp(data.user);
        } else {
          showInfo("Controlla la tua email per confermare la registrazione, poi accedi.");
        }
      }
    } finally {
      submitBtn.disabled = false;
    }
  });
}

document.addEventListener("DOMContentLoaded", bootstrapAuth);

/* ═══════════════════════════════════════════════
   OBIETTIVO — SISTEMA COMPLETO
   Basi scientifiche e derivazione dei valori: vedi fonti.md
   (§ Deficit calorico e ritmo di dimagrimento, § Proiezione adattativa del calo peso)
═══════════════════════════════════════════════ */

// Variabili stato obiettivo
let _selectedFocus = 'moderate';
let goalMode = false;

async function saveGoal() {
  if (!currentUser) return;
  if (state.goal === null) {
    const { error } = await supabaseClient.from('goals').delete().eq('user_id', currentUser.id);
    if (error) showToast('Errore rimozione obiettivo', 'error');
    return;
  }
  const g = state.goal;
  const { error } = await supabaseClient.from('goals').upsert({
    user_id: currentUser.id,
    target_weight: g.targetWeight,
    focus: g.focus,
    start_weight: g.startWeight,
    start_date: g.startDate,
    projected_end_date: g.projectedEndDate,
    weekly_rate: g.weeklyRate,
    daily_deficit: g.dailyDeficit,
    set_at: g.setAt,
  });
  if (error) showToast('Errore salvataggio obiettivo', 'error');
}

function getFocusRate(focus) { return FOCUS_CONFIG[focus]?.rate || 0.60; }

function calcGoalEndDate(startDate, startWeight, targetWeight, focus) {
  const diff = startWeight - targetWeight;
  if (diff <= 0) return startDate;
  const weeks = Math.ceil(diff / getFocusRate(focus));
  const d = new Date(startDate + 'T12:00:00');
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

function generateSampleGoal(measurements) {
  const s = [...measurements].sort((a,b) => new Date(a.date)-new Date(b.date));
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  // Trova la misurazione più vicina a 1 mese fa
  const startM = s.reduce((prev, curr) =>
    Math.abs(new Date(curr.date) - oneMonthAgo) < Math.abs(new Date(prev.date) - oneMonthAgo) ? curr : prev
  );
  const startWeight = startM.weight;
  const targetWeight = parseFloat((startWeight - 7).toFixed(1));
  const focus = 'moderate';
  const projectedEndDate = calcGoalEndDate(startM.date, startWeight, targetWeight, focus);
  return {
    targetWeight, focus, startWeight,
    startDate: startM.date,
    projectedEndDate,
    weeklyRate: getFocusRate(focus),
    dailyDeficit: FOCUS_CONFIG[focus].deficit,
    setAt: new Date().toISOString(),
  };
}

/* ── Rendering chart in modalità obiettivo ─── */
function renderGoalModeChart() {
  const goal = state.goal;
  if (!goal) return;
  const s = sorted();
  const goalStartDate = new Date(goal.startDate + 'T00:00:00');
  const actual = s.filter(d => new Date(d.date + 'T00:00:00') >= goalStartDate);
  const projEnd = new Date(goal.projectedEndDate + 'T12:00:00');
  const projStart = new Date(goal.startDate + 'T12:00:00');
  const totalDays = Math.ceil((projEnd - projStart) / 86400000);
  const totalLoss = goal.startWeight - goal.targetWeight;

  // Se hai continuato a inserire misurazioni oltre la data prevista di
  // traguardo, espandiamo il range del grafico fino all'ultima misurazione
  // disponibile, invece di tagliarlo alla data prevista.
  const lastActualDate = actual.length
    ? new Date(actual[actual.length - 1].date + 'T12:00:00')
    : projStart;
  const effectiveEnd = lastActualDate > projEnd ? lastActualDate : projEnd;
  const effectiveEndStr = effectiveEnd.toISOString().slice(0, 10);

  // Proiezione adattativa: peso(t) = target + (start - target) * (1 - t/T)^1.4
  // Fonte e motivazione dell'esponente: fonti.md § Proiezione adattativa del calo peso
  const proj = [];
  const steps = Math.max(1, Math.floor(totalDays / 60));
  for (let day = 0; day <= totalDays; day += steps) {
    const d = new Date(projStart); d.setDate(d.getDate() + day);
    const factor = Math.pow(1 - day / totalDays, 1.4);
    proj.push({ x: d.toISOString().slice(0,10), y: parseFloat((goal.targetWeight + totalLoss * factor).toFixed(2)) });
  }
  proj.push({ x: goal.projectedEndDate, y: goal.targetWeight });
  // Oltre la data prevista, la proiezione prosegue piatta sul peso obiettivo
  if (effectiveEnd > projEnd) {
    proj.push({ x: effectiveEndStr, y: goal.targetWeight });
  }
  const c = cc(), ctx = el('chart-weight').getContext('2d');
  const H = el('wrap-weight').offsetHeight || 280;
  const grad = mkGrad(ctx, H, 59, 130, 246);
  const allW = actual.map(d=>d.weight).concat([goal.targetWeight, goal.startWeight]);
  const yMin = Math.floor(Math.min(...allW) - 2);
  const yMax = Math.ceil(Math.max(...allW) + 1.5);
  const focusCfg = FOCUS_CONFIG[goal.focus];
  if (chartW) chartW.destroy();
  chartW = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Peso rilevato',
          data: actual.map(d=>({ x:d.date, y:d.weight })),
          borderColor: '#3b82f6', backgroundColor: grad, borderWidth: 2.5,
          pointRadius: 5, pointHoverRadius: 8, pointBackgroundColor: '#3b82f6',
          pointBorderColor: c.ptBrd, pointBorderWidth: 2, fill: true, tension: 0.4, order:1,
        },
        {
          label: `Proiezione adattativa (${focusCfg.label})`,
          data: proj,
          borderColor: focusCfg.color+'cc', backgroundColor:'transparent',
          borderWidth: 2, borderDash: [8,5], pointRadius:0, pointHoverRadius:4,
          fill: false, tension: 0.2, order:2,
        },
        {
          label: `Obiettivo: ${goal.targetWeight} kg`,
          data: [{ x:goal.startDate, y:goal.targetWeight }, { x:effectiveEndStr, y:goal.targetWeight }],
          borderColor: '#22c55e66', backgroundColor:'transparent',
          borderWidth: 1.5, borderDash:[4,4], pointRadius:0,
          fill: false, order:3,
        }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false, animation:{duration:550,easing:'easeInOutCubic'},
      plugins: {
        legend:{ display:true, position:'top', labels:{ color:c.tick, font:{family:"'Sora'",size:11}, usePointStyle:true, pointStyleWidth:8, padding:14 }},
        tooltip:{
          backgroundColor:c.ttBg, borderColor:c.ttBrd, borderWidth:1,
          titleColor:c.ttTi, bodyColor:c.ttBo, padding:12,
          callbacks:{
            title: items => fmtTooltipDate(items[0].parsed.x, 'daily'),
            label: item => `  ${item.dataset.label}: ${item.parsed.y.toFixed(1)} kg`,
          }
        }
      },
      scales:{
        x:{ type:'time', time:{unit:'week', displayFormats:{week:'dd/MM',month:"MMM ''yy"}},
          min: goal.startDate, max: effectiveEndStr,
          grid:{color:c.grid,drawTicks:false}, ticks:{color:c.tick,font:{family:"'JetBrains Mono'",size:10},maxRotation:0}, border:{display:false} },
        y:{ min:yMin, max:yMax, grid:{color:c.grid},
          ticks:{color:c.tick,font:{family:"'JetBrains Mono'",size:10},callback:v=>v+' kg'}, border:{display:false} }
      }
    }
  });
  updateGoalInfoBar();
}

function updateGoalInfoBar() {
  const goal = state.goal;
  const s = sorted();
  const latest = s[s.length-1];
  if (!goal || !latest) { el('goal-info-bar').classList.add('hidden'); return; }
  const totalToLose = goal.startWeight - goal.targetWeight;
  const alreadyLost = goal.startWeight - latest.weight;
  const pct = totalToLose > 0 ? Math.max(0, Math.min(100, (alreadyLost / totalToLose) * 100)) : 0;
  const remaining = Math.max(0, latest.weight - goal.targetWeight);
  // Calorie giornaliere da assumere = TDEE attuale - deficit scelto
  const p = state.profile;
  const age = getAge(p.birthYear);
  const currentTDEE = calcTDEE(latest.weight, p.height, age, p.sex, p.activityLevel);
  const dailyCals = Math.max(1200, Math.round(currentTDEE - goal.dailyDeficit));
  el('gib-start').textContent     = goal.startWeight.toFixed(1) + ' kg';
  el('gib-target').textContent    = goal.targetWeight.toFixed(1) + ' kg';
  el('gib-remaining').textContent = remaining.toFixed(1) + ' kg';
  el('gib-pct').textContent       = pct.toFixed(0) + '%';
  el('gib-eta').textContent       = fmtDateIT(goal.projectedEndDate);
  el('gib-calories').textContent  = dailyCals.toLocaleString('it-IT') + ' kcal';
  el('gib-bar').style.width       = pct + '%';
  el('goal-info-bar').classList.remove('hidden');
}

/* ── Toggle modalità obiettivo ─────────────── */
function toggleGoalMode() {
  goalMode = !goalMode;
  const btn = el('btn-goal-mode');
  btn.classList.toggle('active', goalMode);
  btn.innerHTML = goalMode
    ? '<i class="fas fa-chart-area"></i> Normale'
    : '<i class="fas fa-route"></i> Obiettivo';
  // Mostra/nascondi selettori range e view
  const rangeW = document.getElementById('range-weight');
  const viewW  = document.getElementById('view-weight');
  [rangeW, viewW].forEach(el => { if(el) el.style.opacity = goalMode ? '0.3' : ''; el && (el.style.pointerEvents = goalMode ? 'none' : ''); });
  if (goalMode) renderGoalModeChart();
  else          renderWeightChart();
}

function updateGoalButton() {
  const btn = el('btn-goal-mode');
  if (!btn) return;
  if (state.goal) {
    // Goal presente: mostra il bottone
    btn.classList.remove('hidden');
  } else {
    // Nessun goal: nascondi bottone e ripristina tutto
    btn.classList.add('hidden');
    btn.classList.remove('active');
    btn.innerHTML = '<i class="fas fa-route"></i> Obiettivo';
    if (goalMode) {
      goalMode = false;
      // Riabilita i selettori range/view
      const rW = document.getElementById('range-weight');
      const vW = document.getElementById('view-weight');
      [rW, vW].forEach(e => { if (e) { e.style.opacity = ''; e.style.pointerEvents = ''; } });
      renderWeightChart();
    }
    el('goal-info-bar').classList.add('hidden');
  }
}

/* ── UI modale obiettivo (tab Obiettivo) ────── */
function openGoalTab() {
  const hasGoal = !!state.goal;
  const summaryEl = el('goal-current-summary');
  const deleteBtn = el('btn-delete-goal');
  // Mostra/nascondi riepilogo esistente
  summaryEl.classList.toggle('hidden', !hasGoal);
  deleteBtn.classList.toggle('hidden', !hasGoal);
  if (hasGoal) {
    el('goal-form-title').textContent = 'Aggiorna obiettivo';
    renderGoalSummary();
    // Pre-compila con valori esistenti
    el('goal-weight').value = state.goal.targetWeight.toFixed(1);
    _selectedFocus = state.goal.focus;
    el('focus-selector').querySelectorAll('.focus-btn').forEach(b => b.classList.toggle('active', b.dataset.f === _selectedFocus));
  } else {
    el('goal-form-title').textContent = 'Imposta obiettivo';
    const s = sorted(), latest = s[s.length-1];
    el('goal-weight').value = latest ? latest.weight.toFixed(1) : '';
    _selectedFocus = 'moderate';
    el('focus-selector').querySelectorAll('.focus-btn').forEach(b => b.classList.toggle('active', b.dataset.f === 'moderate'));
  }
  updateGoalPreview();
}

// Legacy alias
function openGoalModal() { openGoalTab(); }

function renderGoalSummary() {
  const goal = state.goal;
  if (!goal) return;
  const s = sorted(), latest = s[s.length-1];
  const totalToLose = goal.startWeight - goal.targetWeight;
  const alreadyLost = latest ? Math.max(0, goal.startWeight - latest.weight) : 0;
  const pct = totalToLose > 0 ? Math.min(100, (alreadyLost / totalToLose) * 100) : 0;
  const focusCfg = FOCUS_CONFIG[goal.focus];
  el('goal-summary-card').innerHTML = `
    <div class="gs-row"><span class="gs-label">Obiettivo</span><span class="gs-val green">${goal.targetWeight} kg (−${totalToLose.toFixed(1)} kg)</span></div>
    <div class="gs-row"><span class="gs-label">Partenza</span><span class="gs-val">${fmtDateIT(goal.startDate)} · ${goal.startWeight} kg</span></div>
    <div class="gs-row"><span class="gs-label">Ritmo</span><span class="gs-val orange">${focusCfg.label} — ~${focusCfg.deficit} kcal/giorno</span></div>
    <div class="gs-row"><span class="gs-label">Traguardo stimato</span><span class="gs-val">${fmtDateIT(goal.projectedEndDate)}</span></div>
    <div class="gs-row"><span class="gs-label">Progresso</span><span class="gs-val">${alreadyLost.toFixed(1)} kg persi · ${pct.toFixed(0)}%</span></div>
    <div class="gs-progress-wrap"><div class="gs-progress-bar" style="width:${pct}%"></div></div>
  `;
}

function updateGoalPreview() {
  const targetW = parseFloat(el('goal-weight').value);
  const s = sorted(), latest = s[s.length-1];
  const preview = el('goal-preview');
  if (!latest || isNaN(targetW)) { preview.textContent = ''; return; }
  const diff = parseFloat((latest.weight - targetW).toFixed(1));
  if (diff <= 0.1) {
    preview.innerHTML = diff === 0 ? '✓ Questo è già il tuo peso attuale.' : `↑ Obiettivo di guadagno peso — inserisci un valore inferiore al peso attuale per perdita peso.`;
    preview.className = 'goal-preview warn'; return;
  }
  const cfg = FOCUS_CONFIG[_selectedFocus];
  const weeks = Math.ceil(diff / cfg.rate);
  const projEnd = new Date(); projEnd.setDate(projEnd.getDate() + weeks * 7);
  preview.innerHTML = `
    <strong>−${diff.toFixed(1)} kg</strong> in circa <strong>${weeks} settimane</strong> (~${Math.round(weeks/4.3)} mesi)<br>
    Traguardo stimato: <strong>${projEnd.toLocaleDateString('it-IT',{day:'2-digit',month:'long',year:'numeric'})}</strong><br>
    Deficit: ~${cfg.deficit} kcal/giorno · ~${(cfg.rate*1000).toFixed(0)} g/settimana<br>
    <span style="font-size:10px;opacity:0.7">Fonte: Wishnofsky 1958 (7.700 kcal/kg) · ACSM 2009</span>
  `;
  preview.className = 'goal-preview ok';
}

