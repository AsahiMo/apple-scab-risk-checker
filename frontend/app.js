// リンゴ黒星病 感染危険度チェック — フロントエンドロジック
// 設計の詳細は ../README.md を参照

const WORKER_BASE = "https://amedas-proxy.my-worker-o.workers.dev";
const GEOCODE_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch?q=";
const STATION_COOKIE = "applescab_station";
const CANDIDATE_COUNT = 8;

let stationsById = null; // Map<stid, station>

// ---------------------------------------------------------------------------
// 地点マスタ
// ---------------------------------------------------------------------------

async function loadStations() {
  if (stationsById) return stationsById;
  const res = await fetch("data/stations.json");
  const data = await res.json();
  stationsById = new Map(Object.entries(data.stations));
  return stationsById;
}

// kansoku: 6桁の観測要素フラグ。[0]=降水量 [2]=気温。'0'以外なら観測あり。
// (data/stations.jsonのスキーマはREADME.mdの「地点マスタ」を参照)
function hasTempAndPrecip(station) {
  const k = station.kansoku || "";
  return k[0] !== "0" && k[2] !== "0";
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function findNearestStations(lat, lon, count = CANDIDATE_COUNT) {
  const stations = await loadStations();
  const list = [];
  for (const [stid, st] of stations) {
    if (st.lat == null || st.lon == null) continue;
    if (!hasTempAndPrecip(st)) continue;
    const distanceKm = haversineKm(lat, lon, st.lat, st.lon);
    list.push({ stid, ...st, distanceKm });
  }
  list.sort((a, b) => a.distanceKm - b.distanceKm);
  return list.slice(0, count);
}

// ---------------------------------------------------------------------------
// ジオコーディング（国土地理院 住所検索API）
// ---------------------------------------------------------------------------

async function geocodeAddress(query) {
  const res = await fetch(GEOCODE_URL + encodeURIComponent(query));
  if (!res.ok) throw new Error("住所検索に失敗しました");
  const features = await res.json();
  if (!Array.isArray(features) || features.length === 0) return null;
  const [lon, lat] = features[0].geometry.coordinates;
  return { lat, lon, title: features[0].properties.title };
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 86400000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/`;
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// ---------------------------------------------------------------------------
// アメダスデータ取得
// ---------------------------------------------------------------------------

async function fetchHourly(stid, fromYmd, toYmd) {
  const url = `${WORKER_BASE}/api/amedas?station=${encodeURIComponent(stid)}&from=${fromYmd}&to=${toYmd}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "データ取得に失敗しました");
  return data.hourly;
}

// ---------------------------------------------------------------------------
// 濡れ時間推定（README.md の疑似コードに準拠）
// 夜間 = 20:00〜翌6:59（JST）。欠測（precipitation_mm=null）は降水なし扱い。
// ---------------------------------------------------------------------------

function isNightJst(date) {
  const hour = Number(
    new Intl.DateTimeFormat("ja-JP", { hour: "numeric", hour12: false, timeZone: "Asia/Tokyo" }).format(date)
  );
  return hour >= 20 || hour < 7;
}

function estimateWetness(hourly) {
  let lastRainTime = null;
  return hourly.map((h) => {
    const t = new Date(h.datetime);
    const precip = h.precipitation_mm;
    let wet;
    if (precip !== null && precip > 0) {
      wet = true;
      lastRainTime = t;
    } else if (lastRainTime !== null) {
      const elapsedHours = (t - lastRainTime) / 3600000;
      if (elapsedHours <= 2) {
        wet = true;
      } else if (isNightJst(t)) {
        wet = true;
      } else {
        wet = false;
        lastRainTime = null;
      }
    } else {
      wet = false;
    }
    return { ...h, wet };
  });
}

function groupWetPeriods(hourlyWithWet) {
  const periods = [];
  let current = null;
  for (const h of hourlyWithWet) {
    if (h.wet) {
      if (!current) current = { hours: [] };
      current.hours.push(h);
    } else if (current) {
      periods.push(finalizePeriod(current));
      current = null;
    }
  }
  if (current) periods.push(finalizePeriod(current));
  return periods;
}

function finalizePeriod(period) {
  const temps = period.hours.map((h) => h.temperature_c).filter((v) => v !== null);
  const avgTemp = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
  return {
    start: period.hours[0].datetime,
    end: period.hours[period.hours.length - 1].datetime,
    durationHours: period.hours.length,
    avgTemp,
  };
}

// Millsテーブル（黒星病の感染危険度モデル）に基づく判定。
// 4次多項式による近似曲線3本（S/M/L、それぞれ必要な連続濡れ時間の閾値を気温から算出）。
// 有効な気温範囲は5〜25℃（この範囲外は判定対象外＝リスクなし）。
const MILLS_TEMP_MIN = 5;
const MILLS_TEMP_MAX = 25;

function millsHoursS(t) {
  return 2.0510e-3 * t ** 4 - 1.3758e-1 * t ** 3 + 3.4430 * t ** 2 - 3.8804e1 * t + 1.8879e2;
}
function millsHoursM(t) {
  return 1.2775e-3 * t ** 4 - 8.6231e-2 * t ** 3 + 2.1779 * t ** 2 - 2.4841e1 * t + 1.2271e2;
}
function millsHoursL(t) {
  return 9.8032e-4 * t ** 4 - 6.6561e-2 * t ** 3 + 1.6916 * t ** 2 - 1.9339e1 * t + 9.4446e1;
}

const MILLS_CURVES = { S: millsHoursS, M: millsHoursM, L: millsHoursL };

const MILLS_STATUS = {
  S: { label: "警報", statusKey: "critical" },
  M: { label: "危険", statusKey: "serious" },
  L: { label: "注意", statusKey: "warning" },
  NONE: { label: "リスクなし", statusKey: "good" },
};

// 四捨五入して小数点第一位までにする（判定はこの丸めた気温で行う）
function round1(x) {
  return Math.round(x * 10) / 10;
}

function classifyMills(avgTemp, durationHours) {
  if (avgTemp === null || durationHours === 0) return "NONE";
  const t = round1(avgTemp);
  if (t < MILLS_TEMP_MIN || t > MILLS_TEMP_MAX) return "NONE";
  if (durationHours >= millsHoursS(t)) return "S";
  if (durationHours >= millsHoursM(t)) return "M";
  if (durationHours >= millsHoursL(t)) return "L";
  return "NONE";
}

function assessPeriod(period) {
  const millsClass = classifyMills(period.avgTemp, period.durationHours);
  return { ...period, millsClass, tempForJudgement: period.avgTemp !== null ? round1(period.avgTemp) : null };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);

function formatJst(iso) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function ymd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function setSelectedStation(station) {
  el("current-station").classList.remove("hidden");
  el("current-station-name").textContent = `${station.name}（${station.stid}）`;
  el("station-search").classList.add("hidden");
  el("period-section").classList.remove("hidden");
  el("period-section").dataset.stid = station.stid;
  setCookie(STATION_COOKIE, station.stid, 365);
}

function renderCandidates(candidates) {
  const ul = el("station-candidates");
  ul.innerHTML = "";
  for (const c of candidates) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = c.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `約${c.distanceKm.toFixed(1)}km`;
    const btn = document.createElement("button");
    btn.textContent = "選択";
    btn.className = "secondary";
    btn.addEventListener("click", () => setSelectedStation(c));
    li.append(label, meta, btn);
    ul.appendChild(li);
  }
}

async function handleSearch() {
  const query = el("address-input").value.trim();
  if (!query) return;
  el("search-status").textContent = "検索中…";
  el("station-candidates").innerHTML = "";
  try {
    const geo = await geocodeAddress(query);
    if (!geo) {
      el("search-status").textContent = "住所が見つかりませんでした。別の表記で試してください。";
      return;
    }
    const candidates = await findNearestStations(geo.lat, geo.lon);
    el("search-status").textContent = `「${geo.title}」付近の観測地点`;
    renderCandidates(candidates);
  } catch (err) {
    el("search-status").textContent = "エラー: " + err.message;
  }
}

function renderResults(assessed) {
  el("result-section").classList.remove("hidden");
  const tbody = el("result-tbody");
  tbody.innerHTML = "";

  if (assessed.length === 0) {
    el("result-summary").textContent = "指定期間中、葉が濡れた時間帯はありませんでした。";
  } else {
    const counts = { S: 0, M: 0, L: 0 };
    for (const p of assessed) if (counts[p.millsClass] !== undefined) counts[p.millsClass]++;
    if (counts.S + counts.M + counts.L === 0) {
      el("result-summary").textContent = "Millsテーブルによる感染リスクが認められる濡れ期間はありませんでした。";
    } else {
      const parts = [];
      if (counts.S) parts.push(`警報 ${counts.S}件`);
      if (counts.M) parts.push(`危険 ${counts.M}件`);
      if (counts.L) parts.push(`注意 ${counts.L}件`);
      el("result-summary").textContent = `⚠ ${parts.join("・")}`;
    }
  }

  for (const p of assessed) {
    const tr = document.createElement("tr");
    const status = MILLS_STATUS[p.millsClass];
    const avgTempText = p.avgTemp !== null ? `${p.avgTemp.toFixed(1)}℃` : "—";
    const tdStart = document.createElement("td");
    tdStart.textContent = formatJst(p.start);
    const tdEnd = document.createElement("td");
    tdEnd.textContent = formatJst(p.end);
    const tdDuration = document.createElement("td");
    tdDuration.textContent = `${p.durationHours}時間`;
    const tdTemp = document.createElement("td");
    tdTemp.textContent = avgTempText;
    const tdJudge = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge status-${status.statusKey}`;
    badge.textContent = status.label;
    tdJudge.appendChild(badge);
    tr.append(tdStart, tdEnd, tdDuration, tdTemp, tdJudge);
    tbody.appendChild(tr);
  }

  renderMillsChart(assessed);
}

// ---------------------------------------------------------------------------
// Millsテーブル グラフ（横軸: 期間平均気温, 縦軸: 連続濡れ時間）
// S/M/L 各判定の閾値曲線と、実際の濡れ期間を重ねて表示する。
// ---------------------------------------------------------------------------

const MILLS_ORDER = ["S", "M", "L", "NONE"];

function renderMillsChart(periods) {
  const container = el("mills-chart");
  const legend = el("mills-legend");
  container.innerHTML = "";
  legend.innerHTML = "";

  for (const key of MILLS_ORDER) {
    const status = MILLS_STATUS[key];
    const li = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = `legend-swatch status-${status.statusKey}`;
    const text = document.createElement("span");
    text.textContent = status.label;
    li.append(swatch, text);
    legend.appendChild(li);
  }

  const width = 640, height = 360;
  const margin = { top: 16, right: 68, bottom: 40, left: 48 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  // Y軸の最大値をデータと閾値曲線から動的に決める
  let yMax = 10;
  for (let t = MILLS_TEMP_MIN; t <= MILLS_TEMP_MAX; t += 0.5) {
    yMax = Math.max(yMax, millsHoursS(t));
  }
  for (const p of periods) yMax = Math.max(yMax, p.durationHours);
  yMax = Math.ceil((yMax * 1.1) / 5) * 5;

  const x = (t) => margin.left + ((t - MILLS_TEMP_MIN) / (MILLS_TEMP_MAX - MILLS_TEMP_MIN)) * plotW;
  const y = (h) => margin.top + plotH - (Math.min(h, yMax) / yMax) * plotH;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "気温と濡れ継続時間によるMillsテーブル判定のグラフ");

  // グリッド・軸
  const gridGroup = document.createElementNS(svgNS, "g");
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = (yMax / yTicks) * i;
    const gy = y(val);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", margin.left);
    line.setAttribute("x2", width - margin.right);
    line.setAttribute("y1", gy);
    line.setAttribute("y2", gy);
    line.setAttribute("class", "grid-line");
    gridGroup.appendChild(line);
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", margin.left - 8);
    label.setAttribute("y", gy);
    label.setAttribute("class", "axis-label");
    label.setAttribute("text-anchor", "end");
    label.setAttribute("dominant-baseline", "middle");
    label.textContent = Math.round(val);
    gridGroup.appendChild(label);
  }
  for (let t = MILLS_TEMP_MIN; t <= MILLS_TEMP_MAX; t += 5) {
    const gx = x(t);
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", gx);
    label.setAttribute("y", height - margin.bottom + 18);
    label.setAttribute("class", "axis-label");
    label.setAttribute("text-anchor", "middle");
    label.textContent = `${t}℃`;
    gridGroup.appendChild(label);
  }
  svg.appendChild(gridGroup);

  // 軸タイトル
  const yAxisTitle = document.createElementNS(svgNS, "text");
  yAxisTitle.setAttribute("class", "axis-title");
  yAxisTitle.setAttribute("x", -(margin.top + plotH / 2));
  yAxisTitle.setAttribute("y", 14);
  yAxisTitle.setAttribute("text-anchor", "middle");
  yAxisTitle.setAttribute("transform", "rotate(-90)");
  yAxisTitle.textContent = "連続濡れ時間（時間）";
  svg.appendChild(yAxisTitle);

  const xAxisTitle = document.createElementNS(svgNS, "text");
  xAxisTitle.setAttribute("class", "axis-title");
  xAxisTitle.setAttribute("x", margin.left + plotW / 2);
  xAxisTitle.setAttribute("y", height - 4);
  xAxisTitle.setAttribute("text-anchor", "middle");
  xAxisTitle.textContent = "期間平均気温（℃）";
  svg.appendChild(xAxisTitle);

  // 閾値曲線 S/M/L
  for (const key of ["S", "M", "L"]) {
    const curve = MILLS_CURVES[key];
    const status = MILLS_STATUS[key];
    let d = "";
    for (let t = MILLS_TEMP_MIN; t <= MILLS_TEMP_MAX; t += 0.5) {
      const cmd = t === MILLS_TEMP_MIN ? "M" : "L";
      d += `${cmd}${x(t).toFixed(1)},${y(curve(t)).toFixed(1)} `;
    }
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", d.trim());
    path.setAttribute("class", `mills-curve status-${status.statusKey}`);
    path.setAttribute("fill", "none");
    svg.appendChild(path);

    const endLabel = document.createElementNS(svgNS, "text");
    endLabel.setAttribute("x", x(MILLS_TEMP_MAX) + 6);
    endLabel.setAttribute("y", y(curve(MILLS_TEMP_MAX)));
    endLabel.setAttribute("class", `curve-end-label status-${status.statusKey}`);
    endLabel.setAttribute("dominant-baseline", "middle");
    endLabel.textContent = status.label;
    svg.appendChild(endLabel);
  }

  // 実データ点
  const tooltip = el("mills-tooltip") || createMillsTooltip();
  for (const p of periods) {
    if (p.tempForJudgement === null) continue;
    const cx = x(Math.min(Math.max(p.tempForJudgement, MILLS_TEMP_MIN), MILLS_TEMP_MAX));
    const cy = y(p.durationHours);
    const status = MILLS_STATUS[p.millsClass];

    const hit = document.createElementNS(svgNS, "circle");
    hit.setAttribute("cx", cx);
    hit.setAttribute("cy", cy);
    hit.setAttribute("r", 12);
    hit.setAttribute("class", "mills-point-hit");
    hit.setAttribute("tabindex", "0");
    const showTip = (evt) => {
      tooltip.innerHTML = "";
      const line1 = document.createElement("div");
      line1.className = "tooltip-value";
      line1.textContent = `${p.tempForJudgement.toFixed(1)}℃ / ${p.durationHours}時間`;
      const line2 = document.createElement("div");
      line2.className = "tooltip-label";
      line2.textContent = `${formatJst(p.start)}〜${formatJst(p.end)} — ${status.label}`;
      tooltip.append(line1, line2);
      tooltip.classList.remove("hidden");
      const rect = container.getBoundingClientRect();
      const px = evt && evt.clientX !== undefined ? evt.clientX - rect.left : cx;
      const py = evt && evt.clientY !== undefined ? evt.clientY - rect.top : cy;
      tooltip.style.left = `${px + 12}px`;
      tooltip.style.top = `${py + 12}px`;
    };
    hit.addEventListener("pointermove", showTip);
    hit.addEventListener("mousemove", showTip);
    hit.addEventListener("focus", () => showTip());
    hit.addEventListener("pointerleave", () => tooltip.classList.add("hidden"));
    hit.addEventListener("blur", () => tooltip.classList.add("hidden"));
    svg.appendChild(hit);

    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", cy);
    dot.setAttribute("r", 5);
    dot.setAttribute("class", `mills-point status-${status.statusKey}`);
    svg.appendChild(dot);
  }

  container.appendChild(svg);
}

function createMillsTooltip() {
  const tooltip = document.createElement("div");
  tooltip.id = "mills-tooltip";
  tooltip.className = "chart-tooltip hidden";
  el("mills-chart-wrap").appendChild(tooltip);
  return tooltip;
}

async function handleCheck() {
  const stid = el("period-section").dataset.stid;
  const from = el("from-date").value.replace(/-/g, "");
  const to = el("to-date").value.replace(/-/g, "");
  if (!stid || !from || !to) return;

  // 黒星病の感染期は春〜夏が中心で年をまたぐ期間指定に意味がないため、
  // 年単位での確認に限定する（obsdl側の技術的な制限とは無関係の、意図的な仕様）
  if (from.slice(0, 4) !== to.slice(0, 4)) {
    el("fetch-status").textContent = "開始日と終了日は同じ年内で指定してください。";
    return;
  }

  el("fetch-status").textContent = "データ取得中…";
  el("result-section").classList.add("hidden");
  try {
    const hourly = await fetchHourly(stid, from, to);
    const withWet = estimateWetness(hourly);
    const periods = groupWetPeriods(withWet).map(assessPeriod);
    renderResults(periods);
    el("fetch-status").textContent = "";
  } catch (err) {
    el("fetch-status").textContent = "エラー: " + err.message;
  }
}

// from/toの日付ピッカーが互いに同じ年の範囲しか選べないようにする（handleCheckの年跨ぎ禁止と対）
function syncYearBounds(sourceId, targetId) {
  const source = el(sourceId);
  const target = el(targetId);
  if (!source.value) return;
  const year = source.value.slice(0, 4);
  target.min = `${year}-01-01`;
  target.max = `${year}-12-31`;
  if (target.value && target.value.slice(0, 4) !== year) {
    target.value = `${year}${target.value.slice(4)}`;
  }
}

async function init() {
  // obsdlは当日分のデータをまだ持っていないことが多いため、既定の終了日は「昨日」にする
  const yesterday = new Date(Date.now() - 86400000);
  const weekAgo = new Date(yesterday.getTime() - 6 * 86400000);
  el("to-date").value = ymd(yesterday).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  el("from-date").value = ymd(weekAgo).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  syncYearBounds("to-date", "from-date");

  el("from-date").addEventListener("change", () => syncYearBounds("from-date", "to-date"));
  el("to-date").addEventListener("change", () => syncYearBounds("to-date", "from-date"));

  el("search-btn").addEventListener("click", handleSearch);
  el("address-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSearch();
  });
  el("check-btn").addEventListener("click", handleCheck);
  el("change-station-btn").addEventListener("click", () => {
    el("current-station").classList.add("hidden");
    el("station-search").classList.remove("hidden");
    el("period-section").classList.add("hidden");
  });

  const savedStid = getCookie(STATION_COOKIE);
  if (savedStid) {
    const stations = await loadStations();
    const st = stations.get(savedStid);
    if (st) setSelectedStation({ stid: savedStid, ...st });
  }
}

init();
