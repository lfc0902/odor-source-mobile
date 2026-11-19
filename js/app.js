'use strict';

/* =========================================================
 * 嗅辨溯源 · 移动端 MVP
 * 链路：手机定位 → Open-Meteo 取当地风/温/湿 → 气味等级
 *       → 在定位点沿上风向画扇形（距离区间由等级估计）
 * ========================================================= */

const CONFIG = {
  defaultCenter: [39.9042, 116.4074], // 北京
  defaultZoom: 13,
  halfAngleDeg: 25,          // 扇形半角（度）
  weatherMaxAgeMs: 10 * 60 * 1000,
  windHistoryHours: 6,       // 取近几小时逐时风评估稳定性
  surveyPromptMs: 45 * 1000, // 巡测时每隔多久提示再评一次
  surveyTrailMinDist: 12,    // 巡测轨迹最小间距（米），过滤 GPS 抖动
  locateSampleMs: 20000,     // 首次定位最多连续采样多久（毫秒）
  surveyMaxAcc: 60,          // 巡测记录允许的最大定位误差（米）
  surveyStableMs: 10000,     // 巡测提交时用最近多少秒的定位点求稳健位置
  gradientMinDist: 80,       // 气味梯度只比较间距 ≥ 此值的点对（米）
  // 气味等级 → 距污染源的大致距离区间（米）。经验值，均可调。
  levels: {
    1: { label: '勉强闻到', short: '勉强', near: 1500, far: 6000, color: '#38bdf8' },
    2: { label: '气味较弱', short: '较弱', near: 800,  far: 3000, color: '#22c55e' },
    3: { label: '气味明显', short: '明显', near: 300,  far: 1200, color: '#eab308' },
    4: { label: '气味强烈', short: '强烈', near: 80,   far: 400,  color: '#f97316' },
    5: { label: '无法忍受', short: '无法忍', near: 0,  far: 150,  color: '#ef4444' },
  },
};

const state = {
  lat: null,
  lon: null,
  accuracy: null,
  manualLocation: false,
  weather: null,
  weatherAt: 0,
  selectedLevel: null,
  records: [],
  seq: 0,
  calib: null,        // 本机定位系统偏移（设备坐标系不是 WGS-84 时用）
  lastRawFix: null,   // 最近一次原始 GPS（未经校准）
  calibrating: false,
  fusion: null,       // 多条记录的综合估计
  heatmap: null,      // 概率热区图层
  peakMarker: null,   // 模型最可能点标记
  showHeat: true,
  survey: null,       // 巡测会话 {id, startedAt, lastPromptAt, trail, watchId, gradient, dueNotified}
  surveyTimer: null,
  trailLayer: null,   // 巡测轨迹线
  gradientLayer: null,// 气味增强方向箭头（线）
  gradientMarker: null,
  lastSurvey: null,   // 结束后的摘要 {id, gradient, lat, lon, points}
  evalPick: false,    // 正在地图上点选真值
  evalTruth: null,    // 对照实验的真实源位置
  evalMarker: null,
  evalLine: null,
  evals: [],          // 已保存的评估结果
  lastExport: null,   // 最近一次导出 {filename, text, mime, label}
};

const CALIB_KEY = 'odor_calib_v1';
const SESSION_KEY = 'odor_session_v1';
const EVALS_KEY = 'odor_evals_v1';

function loadCalib() {
  try {
    const v = JSON.parse(localStorage.getItem(CALIB_KEY) || 'null');
    if (v && Number.isFinite(v.dLat) && Number.isFinite(v.dLon) &&
        Math.abs(v.dLat) < 0.05 && Math.abs(v.dLon) < 0.05) {
      return v;
    }
  } catch (_) { /* 隐私模式等 */ }
  return null;
}
state.calib = loadCalib();

function loadEvals() {
  try {
    const v = JSON.parse(localStorage.getItem(EVALS_KEY) || '[]');
    if (Array.isArray(v)) {
      return v.filter((e) => e && e.truth && e.peak &&
        Number.isFinite(e.truth.lat) && Number.isFinite(e.truth.lon));
    }
  } catch (_) { /* 隐私模式等 */ }
  return [];
}
state.evals = loadEvals();

const { gradient: smellGradient, windStability, sigFromStability } = SURVEY;
const { stableFix, plausible, gradeAccuracy } = GEOFIX;

const IS_WECHAT = /MicroMessenger/i.test(navigator.userAgent);
const $ = (id) => document.getElementById(id);
const els = {
  loc: $('locText'),
  weather: $('weatherText'),
  warn: $('warnText'),
  levels: $('levels'),
  submit: $('btnSubmit'),
  summary: $('summary'),
  records: $('records'),
  recCount: $('recCount'),
  locate: $('btnLocate'),
  refresh: $('btnRefresh'),
  clear: $('btnClear'),
  manual: $('manual'),
  manualBtn: $('btnManual'),
  mwDir: $('mwDir'),
  mwSpd: $('mwSpd'),
  mwApply: $('mwApply'),
  calib: $('btnCalib'),
  envHint: $('envHint'),
  fusion: $('fusion'),
  fusionConf: $('fusionConf'),
  fusionText: $('fusionText'),
  fusionToggle: $('btnFusionToggle'),
  fusionFocus: $('btnFusionFocus'),
  windHint: $('windHint'),
  survey: $('survey'),
  surveyBtn: $('btnSurvey'),
  surveyText: $('surveyText'),
  surveyGrad: $('surveyGrad'),
  surveyBanner: $('surveyBanner'),
  surveyBannerText: $('surveyBannerText'),
  exportCsv: $('btnExportCsv'),
  exportGeo: $('btnExportGeo'),
  exportNote: $('exportNote'),
  exportNoteText: $('exportNoteText'),
  exportRetry: $('btnExportRetry'),
  exportCopy: $('btnExportCopy'),
  toast: $('toast'),
  evalToggle: $('btnEvalToggle'),
  evalPanel: $('evalPanel'),
  evalPick: $('btnEvalPick'),
  evalRun: $('btnEvalRun'),
  evalClear: $('btnEvalClear'),
  evalExport: $('btnEvalExport'),
  evalText: $('evalText'),
};

/* ---------------- 地图 ---------------- */

// 高德瓦片是 GCJ-02：图面要素先转换为 GCJ-02，内部计算仍全部使用 WGS-84
const { wgs84ToGcj02, gcj02ToWgs84 } = COORDS;
const toDisp = (lat, lon) => wgs84ToGcj02(lat, lon);

const map = L.map('map', {
  zoomControl: false,
  attributionControl: true,
}).setView(wgs84ToGcj02(...CONFIG.defaultCenter), CONFIG.defaultZoom);

L.tileLayer(
  'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
  {
    subdomains: ['1', '2', '3', '4'],
    maxZoom: 18,
    attribution: '&copy; 高德地图',
  }
).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

map.createPane('heatPane');
map.getPane('heatPane').style.zIndex = 350;

let currentMarker = null;
let accuracyCircle = null;

function setCurrentMarker(lat, lon, acc) {
  const disp = toDisp(lat, lon);
  if (!currentMarker) {
    currentMarker = L.circleMarker(disp, {
      radius: 8,
      color: '#ffffff',
      weight: 3,
      fillColor: '#38bdf8',
      fillOpacity: 1,
      interactive: false,
    }).addTo(map);
  } else {
    currentMarker.setLatLng(disp);
  }
  if (acc != null) {
    if (!accuracyCircle) {
      accuracyCircle = L.circle(disp, {
        radius: acc,
        color: '#38bdf8',
        weight: 1,
        opacity: 0.5,
        fillColor: '#38bdf8',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map);
    } else {
      accuracyCircle.setLatLng(disp).setRadius(acc);
    }
  }
}

/* ---------------- 地理计算（js/geo.js） ---------------- */

const { destination, sectorPolygon, dirName } = GEO;

const WEATHER_CODES = {
  0: '晴', 1: '大部晴', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '中毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '中阵雨', 82: '强阵雨',
  85: '小阵雪', 86: '大阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
};

/* ---------------- UI 工具 ---------------- */

let warnTimer = null;
function setWarn(msg, persist = false) {
  els.warn.textContent = msg;
  els.warn.classList.remove('hidden');
  if (warnTimer) clearTimeout(warnTimer);
  if (!persist) {
    warnTimer = setTimeout(() => els.warn.classList.add('hidden'), 6000);
  }
}
function clearWarn() {
  if (warnTimer) clearTimeout(warnTimer);
  els.warn.classList.add('hidden');
}

/* 顶部浮层提示：不随底部面板滚动，确保操作后一定看得到 */
let toastTimer = null;
let toastHideTimer = null;
function showToast(msg, type = 'info', ms = 4200) {
  if (!els.toast) return;
  els.toast.textContent = msg;
  els.toast.className = 'toast show ' + type;
  if (toastTimer) clearTimeout(toastTimer);
  if (toastHideTimer) clearTimeout(toastHideTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    toastHideTimer = setTimeout(() => els.toast.classList.add('hidden'), 220);
  }, ms);
}

/* 导出结果直接显示在按钮下方，避免提示在面板顶部看不见 */
function showExportNote(msg, isErr) {
  els.exportNoteText.textContent = msg;
  els.exportNote.classList.toggle('err', !!isErr);
  els.exportNote.classList.remove('hidden');
  if (typeof els.exportNote.scrollIntoView === 'function') {
    try {
      els.exportNote.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (_) { /* 老浏览器忽略 */ }
  }
}

function renderLevelButtons() {
  els.levels.innerHTML = '';
  Object.entries(CONFIG.levels).forEach(([n, cfg]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'level-btn';
    btn.style.setProperty('--c', cfg.color);
    btn.dataset.level = n;
    btn.innerHTML = `<span class="n">${n}</span><span class="t">${cfg.short}</span>`;
    btn.addEventListener('click', () => selectLevel(Number(n)));
    els.levels.appendChild(btn);
  });
}

function selectLevel(n) {
  state.selectedLevel = n;
  els.levels.querySelectorAll('.level-btn').forEach((b) => {
    b.classList.toggle('sel', Number(b.dataset.level) === n);
  });
  updateSubmitState();
}

function updateSubmitState() {
  els.submit.disabled = !(state.lat != null && state.selectedLevel != null);
}

/* ---------------- 定位 ---------------- */

function describeGeoError(err) {
  if (err && err.code === 1) return '定位权限被拒绝，可点击地图手动设置位置。';
  if (err && err.code === 2) return '无法获取位置（无信号），可点击地图手动设置位置。';
  if (err && err.code === 3) return '定位超时，可点击地图手动设置位置。';
  return '定位失败，可点击地图手动设置位置。';
}

let geoWatch = null;
let geoTimer = null;
let geoHintTimer = null;
let geoBest = null;
let geoFirstFix = false;
let geoDone = false;
let geoSession = 0; // 定位会话号：旧 watch/定时器回调不能覆盖新定位
let fixBuf = []; // 最近定位点（已校准），用于稳健平均

function clearFixBuffer() {
  fixBuf = [];
}

function pushFix(lat, lon, acc) {
  const t = Date.now();
  fixBuf.push({ lat, lon, acc: acc == null ? null : Number(acc), t });
  while (fixBuf.length > 150 || (fixBuf.length && t - fixBuf[0].t > 90000)) {
    fixBuf.shift();
  }
}

function accuracyText(acc) {
  const q = gradeAccuracy(acc);
  if (q === 'good') return `GPS 精度 ±${Math.round(acc)} m`;
  if (q === 'ok') return `±${Math.round(acc)} m，精度一般`;
  if (q === 'poor') return `±${Math.round(acc)} m，精度较低，可点地图校正`;
  return '';
}

function stopGeoWatch() {
  geoSession++; // 让已排队的旧回调失效
  if (geoWatch != null) {
    navigator.geolocation.clearWatch(geoWatch);
    geoWatch = null;
  }
  if (geoTimer) {
    clearTimeout(geoTimer);
    geoTimer = null;
  }
  if (geoHintTimer) {
    clearTimeout(geoHintTimer);
    geoHintTimer = null;
  }
}

/** 实时落点：只更新位置显示与标记，不重复请求天气 */
function applyFix(lat, lon, acc) {
  const a = acc == null ? null : Number(acc);
  state.lastRawFix = { lat, lon, acc: a };
  const c = state.calib;
  const plat = lat + (c ? c.dLat : 0);
  const plon = lon + (c ? c.dLon : 0);
  state.lat = plat;
  state.lon = plon;
  state.accuracy = a;
  state.manualLocation = false;
  state.lastFixAt = Date.now();
  pushFix(plat, plon, a);
  setCurrentMarker(plat, plon, a);
  els.loc.textContent =
    `位置 ${plat.toFixed(5)}, ${plon.toFixed(5)}` +
    (a != null ? `（${accuracyText(a)}）` : '') +
    (c ? ' · 已校准' : '');
  const q = gradeAccuracy(a);
  els.loc.classList.remove('good', 'warn', 'poor');
  if (q === 'good') els.loc.classList.add('good');
  else if (q === 'ok') els.loc.classList.add('warn');
  else if (q === 'poor') els.loc.classList.add('poor');
  updateSubmitState();
}

function updateCalibButton() {
  els.calib.textContent = state.calib ? '清除校准' : '校准';
  els.calib.classList.toggle('on', state.calibrating);
}

/** 用地图点校正本机 GPS 的系统性偏移，并记住 */
function toggleCalibration() {
  if (state.calibrating) {
    state.calibrating = false;
    updateCalibButton();
    setWarn('已取消校准。');
    return;
  }
  if (state.calib) {
    state.calib = null;
    try { localStorage.removeItem(CALIB_KEY); } catch (_) { /* 忽略 */ }
    state.calibrating = false;
    updateCalibButton();
    if (state.lastRawFix) {
      applyFix(state.lastRawFix.lat, state.lastRawFix.lon, state.lastRawFix.acc);
      refreshWeather(true);
    }
    setWarn('已清除位置校准。');
    return;
  }
  if (!state.lastRawFix) {
    setWarn('请先点「重新定位」拿到 GPS 位置，再点校准。', true);
    return;
  }
  state.calibrating = true;
  updateCalibButton();
  setWarn('校准：请在地图上点一下你此刻的真实位置。', true);
}

function applyCalibration(tLat, tLon) {
  const raw = state.lastRawFix;
  if (!raw) {
    state.calibrating = false;
    updateCalibButton();
    setWarn('没有可用的 GPS 基准，请先重新定位。', true);
    return;
  }
  const dLat = tLat - raw.lat;
  const dLon = tLon - raw.lon;
  const dist = Math.hypot(
    dLat * 111320,
    dLon * 111320 * Math.cos(tLat * Math.PI / 180)
  );
  if (dist > 3000) {
    setWarn(`点选位置与 GPS 相差约 ${Math.round(dist)} 米，偏差过大，未保存。请确认点的是你当前实际位置。`, true);
    return;
  }
  state.calib = { dLat, dLon };
  try { localStorage.setItem(CALIB_KEY, JSON.stringify(state.calib)); } catch (_) { /* 忽略 */ }
  state.calibrating = false;
  updateCalibButton();
  applyFix(raw.lat, raw.lon, raw.acc);
  refreshWeather(true);
  setWarn(`已校准：本机定位偏差约 ${Math.round(dist)} 米，之后会自动修正。`);
}

function locate() {
  clearWarn();
  if (!navigator.geolocation) {
    setWarn('此浏览器不支持定位，请点击地图手动设置位置。', true);
    return;
  }
  if (!window.isSecureContext) {
    setWarn(
      '当前页面不是 HTTPS，手机浏览器禁止定位。请点击地图手动设置位置，或改用 localhost / HTTPS 访问。',
      true
    );
    return;
  }

  // 连续采样最多 20 秒；拿到 3 个 ≤15 m 且彼此靠近的点就提前结束
  stopGeoWatch();
  const session = ++geoSession;
  geoBest = null;
  geoFirstFix = false;
  geoDone = false;
  clearFixBuffer();
  els.loc.textContent = '正在定位（提高精度中，最多约 20 秒）…';
  els.loc.classList.remove('good', 'warn', 'poor');

  const finish = (why, err) => {
    if (session !== geoSession || geoDone) return;
    geoDone = true;
    stopGeoWatch();
    const s = stableFix(fixBuf, Date.now(), {
      windowMs: CONFIG.locateSampleMs + 1000,
      maxAcc: 200,
      maxSpread: 100,
    });
    if (s) {
      applyFix(s.lat, s.lon, s.acc);
      if (gradeAccuracy(s.acc) === 'poor') {
        setWarn(
          `当前定位精度只有 ±${Math.round(s.acc)} m，很可能是网络定位。` +
          '请确认手机已开启「精确位置」和 GPS，到室外再点「重新定位」；也可点地图手动标点。',
          true
        );
      } else {
        setWarn(
          `定位完成：${gradeAccuracy(s.acc) === 'good' ? '精度良好' : '精度一般'}` +
          `（±${Math.round(s.acc)} m，${s.n} 个采样点）。`
        );
      }
      return;
    }
    if (geoBest) {
      applyFix(geoBest.lat, geoBest.lon, geoBest.acc);
      setWarn(
        '只拿到了低精度位置，可能是网络定位。请开启系统「精确位置」、到室外后再试，或点地图手动标点。',
        true
      );
      return;
    }
    els.loc.textContent = '未获取到定位';
    if (err) setWarn(describeGeoError(err), true);
    else if (why === 'timeout') {
      setWarn(
        '定位超时：请点右上角「重新定位」再试（iOS 只允许点击后定位），' +
        '并确认系统已允许「精确位置」；也可点击地图手动标点。',
        true
      );
    }
  };

  const onPos = (pos) => {
    if (session !== geoSession) return;
    const { latitude, longitude, accuracy } = pos.coords;
    const acc = accuracy == null ? null : accuracy;
    state.lastGeoError = null;
    if (!geoBest || (acc != null && (geoBest.acc == null || acc < geoBest.acc))) {
      geoBest = { lat: latitude, lon: longitude, acc };
    }
    applyFix(latitude, longitude, acc);
    if (!geoFirstFix) {
      geoFirstFix = true;
      refreshWeather(true); // 第一次拿到位置就取当地天气
    }
    if (!geoDone) {
      els.loc.textContent += ' · 采样中';
      const s = stableFix(fixBuf, Date.now(), {
        windowMs: 8000, maxAcc: 25, maxSpread: 20,
      });
      if (s && s.n >= 3 && gradeAccuracy(s.acc) === 'good') finish('early');
    }
  };

  const onErr = (err) => {
    if (session !== geoSession) return;
    state.lastGeoError = err ? { code: err.code, message: err.message } : null;
    if (geoBest) { finish('error', err); return; }
    geoDone = true;
    stopGeoWatch();
    els.loc.textContent = '未获取到定位';
    setWarn(describeGeoError(err), true);
  };

  geoWatch = navigator.geolocation.watchPosition(onPos, onErr, {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0, // 不使用缓存位置，避免拿到几分钟前的旧点
  });

  // iOS 只允许在用户点击后定位；页面加载自动调用可能被静默拦截
  geoHintTimer = setTimeout(() => {
    if (session === geoSession && !geoFirstFix && !geoDone) {
      setWarn(
        '还没有拿到位置：请点右上角「重新定位」。iOS 只允许点击后定位，' +
        '并需在系统设置中为浏览器开启「精确位置」。',
        true
      );
    }
  }, 3000);

  geoTimer = setTimeout(() => finish('timeout'), CONFIG.locateSampleMs);
}

function setLocation(lat, lon, acc, manual = false) {
  state.lat = lat;
  state.lon = lon;
  state.accuracy = acc == null ? null : acc;
  state.manualLocation = manual;
  if (manual) {
    stopGeoWatch(); // 手动标点后，旧的 GPS 回调不应再覆盖位置
    clearFixBuffer(); // 手动点位不参与 GPS 稳健平均
    if (state.survey) {
      state.survey.lastAcc = null; // 手动点位没有 GPS 精度
      updateSurveyUI();
    }
  }
  setCurrentMarker(lat, lon, state.accuracy);
  els.loc.textContent =
    `位置 ${lat.toFixed(5)}, ${lon.toFixed(5)}` +
    (state.accuracy ? `（${accuracyText(state.accuracy)}）` : '') +
    (manual ? ' · 手动标点（不依赖 GPS）' : '');
  els.loc.classList.remove('good', 'warn', 'poor');
  if (!manual) {
    const q = gradeAccuracy(state.accuracy);
    if (q === 'good') els.loc.classList.add('good');
    else if (q === 'ok') els.loc.classList.add('warn');
    else if (q === 'poor') els.loc.classList.add('poor');
  }
  updateSubmitState();
  refreshWeather(true);
}

/** 用多个 GPS 点求出的稳健位置更新界面（坐标已完成校准） */
function useSmoothedPosition(lat, lon, acc, note) {
  state.lat = lat;
  state.lon = lon;
  state.accuracy = acc == null ? null : acc;
  setCurrentMarker(lat, lon, state.accuracy);
  els.loc.textContent =
    `位置 ${lat.toFixed(5)}, ${lon.toFixed(5)}` +
    (state.accuracy != null ? `（${accuracyText(state.accuracy)}）` : '') +
    (note ? ` · ${note}` : '');
  els.loc.classList.remove('good', 'warn', 'poor');
  const q = gradeAccuracy(state.accuracy);
  if (q === 'good') els.loc.classList.add('good');
  else if (q === 'ok') els.loc.classList.add('warn');
  else if (q === 'poor') els.loc.classList.add('poor');
  updateSubmitState();
}

/* ---------------- 天气（Open-Meteo 主源 + wttr.in 备源 + 手动兜底） ---------------- */

// wttr.in 的英文天气描述 → 中文
const WTTR_CN = {
  Sunny: '晴', Clear: '晴', 'Partly cloudy': '多云', Cloudy: '多云', Overcast: '阴',
  Mist: '薄雾', Fog: '雾', Haze: '霾', 'Freezing fog': '冻雾',
  'Light rain': '小雨', 'Moderate rain': '中雨', 'Heavy rain': '大雨',
  'Light drizzle': '毛毛雨', 'Patchy light drizzle': '局部毛毛雨',
  'Patchy rain possible': '局部有雨', 'Patchy light rain': '局部小雨',
  'Light rain shower': '小阵雨', 'Moderate or heavy rain shower': '强阵雨',
  'Thundery outbreaks possible': '可能有雷雨',
  'Light snow': '小雪', 'Moderate snow': '中雪', 'Heavy snow': '大雪',
  'Blizzard': '暴雪', 'Patchy snow possible': '局部有雪',
  'Light freezing rain': '冻雨', 'Light sleet': '小雨夹雪', Sleet: '雨夹雪',
};

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenMeteo(lat, lon) {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,' +
    'wind_direction_10m,weather_code' +
    '&wind_speed_unit=ms&timezone=auto';
  const data = await fetchJson(url, 8000);
  if (!data.current) throw new Error('Open-Meteo 响应异常');
  const c = data.current;
  return {
    source: 'Open-Meteo',
    temperature_2m: c.temperature_2m,
    relative_humidity_2m: c.relative_humidity_2m,
    wind_speed_10m: c.wind_speed_10m,
    wind_direction_10m: c.wind_direction_10m,
    desc: WEATHER_CODES[c.weather_code] || '',
  };
}

async function fetchWttr(lat, lon) {
  const url = `https://wttr.in/${lat.toFixed(4)},${lon.toFixed(4)}?format=j1`;
  const data = await fetchJson(url, 12000);
  const c = data.current_condition && data.current_condition[0];
  if (!c) throw new Error('wttr.in 响应异常');
  const kmph = Number(c.windspeedKmph);
  const desc = c.weatherDesc && c.weatherDesc[0] && c.weatherDesc[0].value;
  return {
    source: 'wttr.in',
    temperature_2m: c.temp_C != null ? Number(c.temp_C) : null,
    relative_humidity_2m: c.humidity != null ? Number(c.humidity) : null,
    wind_speed_10m: Number.isFinite(kmph) ? kmph / 3.6 : null,
    wind_direction_10m: c.winddirDegree != null ? Number(c.winddirDegree) : null,
    desc: desc ? (WTTR_CN[desc.trim()] || desc.trim()) : '',
  };
}

/** 近几小时逐时风：只用于评估风向稳定性，失败不影响主天气链路 */
async function fetchWindHistory(lat, lon) {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    '&hourly=wind_speed_10m,wind_direction_10m' +
    '&wind_speed_unit=ms&timezone=auto&past_days=1&forecast_days=1';
  const data = await fetchJson(url, 6000);
  const h = data.hourly;
  if (!h || !Array.isArray(h.time) || !Array.isArray(h.wind_direction_10m) ||
      !Array.isArray(h.wind_speed_10m)) {
    throw new Error('历史风场响应异常');
  }
  const now = Date.now();
  const keep = [];
  for (let i = 0; i < h.time.length; i++) {
    const t = Date.parse(h.time[i]);
    if (Number.isFinite(t) && t <= now + 15 * 60 * 1000) keep.push(i);
  }
  const last = keep.slice(-CONFIG.windHistoryHours);
  const st = windStability({
    wind_direction_10m: last.map((i) => h.wind_direction_10m[i]),
    wind_speed_10m: last.map((i) => h.wind_speed_10m[i]),
  });
  if (!st.count) throw new Error('无历史风数据');
  return st;
}

/** 依次尝试数据源，任一成功即返回 */
async function fetchWeather(lat, lon) {
  const errors = [];
  for (const fn of [fetchOpenMeteo, fetchWttr]) {
    try {
      return await fn(lat, lon);
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error([...new Set(errors)].join(' / '));
}

async function refreshWeather(force = false) {
  if (state.lat == null) return;
  if (!force && Date.now() - state.weatherAt < CONFIG.weatherMaxAgeMs) return;
  els.weather.textContent = '正在获取当地气象…';
  try {
    const [cur, hist] = await Promise.all([
      fetchWeather(state.lat, state.lon),
      fetchWindHistory(state.lat, state.lon).catch(() => null),
    ]);
    cur.history = hist;
    state.weather = cur;
    state.weatherAt = Date.now();
    renderWeather(cur);
  } catch (e) {
    state.weather = null;
    state.weatherAt = 0;
    els.weather.textContent = '气象获取失败';
    els.windHint.classList.add('hidden');
    els.manual.classList.remove('hidden');
    setWarn(`天气接口失败（${e.message}）。可点「手动」输入风向风速。`, true);
  }
}

function renderWindHint(cur) {
  const h = cur && cur.history;
  if (!h || h.count < 3) {
    els.windHint.classList.add('hidden');
    return;
  }
  const r = h.R.toFixed(2);
  if (h.R >= 0.75) {
    els.windHint.textContent = `近 ${h.count} 小时风向较稳定（一致性 ${r}）`;
    els.windHint.className = 'wind-hint ok';
  } else if (h.R >= 0.45) {
    els.windHint.textContent =
      `近 ${h.count} 小时风向有摆动（一致性 ${r}），方位估计已适当放宽`;
    els.windHint.className = 'wind-hint warnish';
  } else {
    els.windHint.textContent =
      `近 ${h.count} 小时风向变化较大（一致性 ${r}），方位可信度较低`;
    els.windHint.className = 'wind-hint bad';
  }
}

function renderWeather(cur) {
  const parts = [];
  if (cur.desc) parts.push(cur.desc);

  const ws = cur.wind_speed_10m;
  const wd = cur.wind_direction_10m;
  if (wd != null && ws != null) {
    parts.push(`风：<b>${dirName(wd)}风 ${Math.round(wd)}°</b>，${ws.toFixed(1)} m/s`);
  } else {
    parts.push('风：无有效数据');
  }
  if (cur.temperature_2m != null) parts.push(`气温 ${cur.temperature_2m.toFixed(1)}°C`);
  if (cur.relative_humidity_2m != null) parts.push(`湿度 ${Math.round(cur.relative_humidity_2m)}%`);
  const src = cur.source ? ` <span class="src">（${cur.source}）</span>` : '';
  els.weather.innerHTML = parts.join(' · ') + src;
  renderWindHint(cur);

  if (ws != null && ws < 0.5) {
    setWarn('当前风速过小（<0.5 m/s），风向参考性差，溯源结果可靠性下降。', true);
  } else {
    clearWarn();
  }
}

function applyManualWind() {
  const dir = Number(els.mwDir.value);
  const spd = Number(els.mwSpd.value);
  if (!Number.isFinite(dir) || dir < 0 || dir > 359) {
    setWarn('请输入有效的风向：0–359°（气象风向 = 风的来向）。');
    return;
  }
  if (!Number.isFinite(spd) || spd < 0) {
    setWarn('请输入有效的风速（m/s）。');
    return;
  }
  const w = {
    source: '手动输入',
    temperature_2m: null,
    relative_humidity_2m: null,
    wind_speed_10m: spd,
    wind_direction_10m: dir,
    desc: '',
    history: null, // 手动风没有历史风场，方位不确定度按默认值
  };
  state.weather = w;
  state.weatherAt = Date.now();
  renderWeather(w);
  clearWarn();
  els.manual.classList.add('hidden');
}

/* ---------------- 多条记录综合估计（js/fusion.js） ---------------- */

const { rel: relPos } = FUSION;

function fusionInputs() {
  return state.records.map((r) => {
    const cfg = CONFIG.levels[r.level];
    return {
      lat: r.lat,
      lon: r.lon,
      bearing: r.bearing,
      near: cfg.near,
      far: cfg.far,
      windSpeed: r.windSpeed,
      level: r.level,
      sigmaAng: r.sigmaAng,
      windR: r.windR,
    };
  });
}

function rampColor(t) {
  const stops = [
    [0.0, [56, 189, 248]],
    [0.4, [34, 197, 94]],
    [0.7, [234, 179, 8]],
    [1.0, [239, 68, 68]],
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) { a = stops[i - 1]; b = stops[i]; break; }
  }
  const span = b[0] - a[0] || 1;
  const k = Math.max(0, Math.min(1, (t - a[0]) / span));
  return [
    Math.round(a[1][0] + (b[1][0] - a[1][0]) * k),
    Math.round(a[1][1] + (b[1][1] - a[1][1]) * k),
    Math.round(a[1][2] + (b[1][2] - a[1][2]) * k),
  ];
}

function removeHeatmap() {
  if (state.heatmap) {
    map.removeLayer(state.heatmap);
    state.heatmap = null;
  }
  state.records.forEach((r) => r.sector.setStyle({ fillOpacity: 0.18 }));
}

function removePeakMarker() {
  if (state.peakMarker) {
    map.removeLayer(state.peakMarker);
    state.peakMarker = null;
  }
}

function renderPeakMarker() {
  removePeakMarker();
  const f = state.fusion;
  if (!f || f.error) return;
  state.peakMarker = L.circleMarker(toDisp(f.peak.lat, f.peak.lon), {
    radius: 5,
    color: '#ffffff',
    weight: 2,
    fillColor: '#ef4444',
    fillOpacity: 1,
    interactive: false,
  }).addTo(map);
  state.peakMarker.bindTooltip('模型最可能点（粗略）', { direction: 'top' });
}

/** 把归一化概率画成一张贴在地图上的热区图（单个 imageOverlay，手机上也不卡） */
function renderHeatmap() {
  const f = state.fusion;
  if (!f || f.error) return;
  removeHeatmap();
  const canvas = document.createElement('canvas');
  canvas.width = f.nLon;
  canvas.height = f.nLat;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(f.nLon, f.nLat);
  const data = img.data;
  const peakP = f.peak.p || 1;
  for (let i = 0; i < f.nLat; i++) {
    for (let j = 0; j < f.nLon; j++) {
      const p = f.weights[i * f.nLon + j];
      const t = p / peakP;
      if (t < 0.05) continue;
      const rgb = rampColor(Math.min(1, Math.pow(t, 0.6)));
      const o = ((f.nLat - 1 - i) * f.nLon + j) * 4; // 图像顶部对应北
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = Math.round(255 * Math.min(0.82, 0.12 + 0.8 * Math.sqrt(t)));
    }
  }
  ctx.putImageData(img, 0, 0);

  const sw = toDisp(f.minLat, f.minLon);
  const ne = toDisp(f.maxLat, f.maxLon);
  state.heatmap = L.imageOverlay(canvas.toDataURL('image/png'),
    L.latLngBounds(sw, ne), {
      pane: 'heatPane',
      opacity: 0.85,
      interactive: false,
    }).addTo(map);
  state.records.forEach((r) => r.sector.setStyle({ fillOpacity: 0.06 }));
}

function fmtArea(m2) {
  if (!(m2 >= 0)) return '—';
  if (m2 >= 1e6) return (m2 / 1e6).toFixed(1) + ' km²';
  if (m2 >= 1e4) return (m2 / 1e4).toFixed(1) + ' 公顷';
  return Math.round(m2) + ' m²';
}

function renderFusion() {
  const f = state.fusion;
  if (!f || state.records.length < 2) {
    els.fusion.classList.add('hidden');
    return;
  }
  els.fusion.classList.remove('hidden');
  if (f.error) {
    els.fusionConf.textContent = '';
    els.fusionConf.className = 'conf';
    els.fusionText.textContent = '无法综合：' + f.error + '。请检查记录的风向是否正确。';
    return;
  }
  const confText = { high: '较高', medium: '中等', low: '较低' }[f.confidence] || '';
  els.fusionConf.textContent = confText;
  els.fusionConf.className = 'conf ' + f.confidence;

  const fromCur = state.lat != null ? relPos(state.lat, state.lon, f.peak.lat, f.peak.lon) : null;
  let txt = `已综合 ${f.count} 条记录。模型最可能点见地图红点`;
  if (fromCur) {
    txt += `，距当前位置约 ${Math.round(fromCur.d)} 米（${dirName(fromCur.brg)}方向）`;
  }
  txt += `。50% 概率区域约 ${fmtArea(f.region50.area)}，` +
         `80% 概率区域约 ${fmtArea(f.region80.area)}。` +
         '热区颜色越红，模型概率越高。';
  if (f.notes.length) txt += ' ' + f.notes.join('；') + '。';
  els.fusionText.textContent = txt;
  els.fusionToggle.textContent = state.showHeat ? '隐藏热区' : '显示热区';
}

function updateFusion() {
  removeEvalLine(); // 记录变化后旧的真值-峰值连线失效
  if (state.records.length < 2) {
    state.fusion = null;
    removeHeatmap();
    removePeakMarker();
    renderFusion();
    updateEvalUI();
    return;
  }
  const f = FUSION.compute(fusionInputs(), {
    cells: 128,
    sigmaAng: CONFIG.halfAngleDeg,
    halfAngle: CONFIG.halfAngleDeg,
  });
  state.fusion = f;
  if (f && !f.error && state.showHeat) renderHeatmap();
  else removeHeatmap();
  renderPeakMarker();
  renderFusion();
  updateEvalUI();
}

function toggleHeat() {
  state.showHeat = !state.showHeat;
  if (state.showHeat && state.fusion && !state.fusion.error) renderHeatmap();
  else removeHeatmap();
  renderFusion();
}

function focusFusion() {
  const f = state.fusion;
  if (!f || f.error || !f.region80.bounds) return;
  const b = f.region80.bounds;
  const sheetH = document.getElementById('sheet').offsetHeight || 0;
  map.fitBounds(L.latLngBounds(
    toDisp(b.minLat, b.minLon),
    toDisp(b.maxLat, b.maxLon)
  ), {
    paddingTopLeft: [40, 90],
    paddingBottomRight: [40, sheetH + 30],
    maxZoom: 16,
  });
}

/* ---------------- 提交与绘制 ---------------- */

/** 依据记录的数值生成地图图层（也用于从本地会话恢复） */
function buildRecordLayers(rec) {
  const cfg = CONFIG.levels[rec.level];
  // 几何在 WGS-84 中计算，绘制前统一转 GCJ-02
  const poly = sectorPolygon(
    rec.lat, rec.lon, rec.bearing, CONFIG.halfAngleDeg, cfg.near, cfg.far
  ).map(([la, lo]) => toDisp(la, lo));
  rec.sector = L.polygon(poly, {
    color: cfg.color,
    weight: 1.5,
    opacity: 0.9,
    fillColor: cfg.color,
    fillOpacity: 0.18,
    interactive: false,
  }).addTo(map);

  rec.dot = L.circleMarker(toDisp(rec.lat, rec.lon), {
    radius: 4,
    color: '#0b1220',
    weight: 1,
    fillColor: cfg.color,
    fillOpacity: 1,
    interactive: false,
  }).addTo(map);

  // 估算的"大概位置"：扇形中线，取距离区间中点
  const midR = (cfg.near + cfg.far) / 2;
  const estPos = destination(rec.lat, rec.lon, rec.bearing, midR);
  rec.estCircle = L.circle(toDisp(estPos[0], estPos[1]), {
    radius: Math.max((cfg.far - cfg.near) / 2, 20),
    color: cfg.color,
    weight: 1.5,
    dashArray: '6 6',
    opacity: 0.85,
    fillColor: cfg.color,
    fillOpacity: 0.06,
    interactive: false,
  }).addTo(map);
  rec.estCircle.bindTooltip('粗略估算位置范围', { direction: 'top' });
}

function recordData(r) {
  return {
    id: r.id,
    time: r.time instanceof Date ? r.time.toISOString() : r.time,
    lat: r.lat,
    lon: r.lon,
    level: r.level,
    bearing: r.bearing,
    windSpeed: r.windSpeed,
    windSource: r.windSource || '',
    windR: r.windR == null ? null : r.windR,
    sigmaAng: r.sigmaAng == null ? null : r.sigmaAng,
    accuracy: r.accuracy == null ? null : r.accuracy,
    surveyId: r.surveyId == null ? null : r.surveyId,
  };
}

/** 每次记录变化后写入本机会话，刷新/重开页面可恢复 */
function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      seq: state.seq,
      records: state.records.map(recordData),
      lastSurvey: state.lastSurvey ? {
        id: state.lastSurvey.id,
        gradient: state.lastSurvey.gradient || null,
        points: state.lastSurvey.points || 0,
        lat: state.lastSurvey.lat,
        lon: state.lastSurvey.lon,
      } : null,
    }));
  } catch (_) { /* 隐私模式/容量不足 */ }
}

function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return; }
  if (!saved || saved.v !== 1 || !Array.isArray(saved.records)) return;
  const recs = saved.records
    .filter((r) => r && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)) &&
      Number.isFinite(Number(r.bearing)) && CONFIG.levels[Number(r.level)])
    .map((r) => ({
      id: Number(r.id) || 0,
      time: new Date(r.time),
      lat: Number(r.lat),
      lon: Number(r.lon),
      level: Number(r.level),
      bearing: Number(r.bearing),
      windSpeed: Number(r.windSpeed) || 0,
      windSource: r.windSource || '',
      windR: r.windR == null ? null : Number(r.windR),
      sigmaAng: r.sigmaAng == null ? null : Number(r.sigmaAng),
      accuracy: r.accuracy == null ? null : Number(r.accuracy),
      surveyId: r.surveyId == null ? null : Number(r.surveyId),
    }))
    .filter((r) => Number.isFinite(r.time.getTime()));
  recs.forEach(buildRecordLayers);
  state.records = recs;
  state.seq = Math.max(saved.seq || 0, ...recs.map((r) => r.id || 0));
  const ls = saved.lastSurvey;
  if (ls && Number.isFinite(Number(ls.lat)) && Number.isFinite(Number(ls.lon))) {
    state.lastSurvey = {
      id: Number(ls.id) || null,
      gradient: ls.gradient && Number.isFinite(Number(ls.gradient.brg))
        ? ls.gradient : null,
      points: Number(ls.points) || 0,
      lat: Number(ls.lat),
      lon: Number(ls.lon),
    };
  }
  if (!recs.length) return;
  renderRecords();
  renderSummary(recs[recs.length - 1]);
  updateFusion();
  if (state.lastSurvey) {
    updateSurveyGradient();
    const n = surveyRecords().length;
    if (n) {
      els.surveyText.textContent = `巡测结束：共记录 ${n} 个点` +
        (state.lastSurvey.gradient && state.lastSurvey.gradient.brg != null
          ? '，气味增强方向见地图箭头' : '');
    }
  }
  setTimeout(() => {
    fitToLayer(L.featureGroup(recs.map((r) => r.sector)));
  }, 300);
}

/** 每次观测期间的风场稳定性 → 方位标准差（无历史风场则用默认） */
function windStabilityOf(w) {
  const h = w && w.history;
  if (!h || h.count < 3 || !Number.isFinite(h.R)) {
    return { R: null, sigmaAng: CONFIG.halfAngleDeg };
  }
  return { R: h.R, sigmaAng: sigFromStability(h.R, w.wind_speed_10m) };
}

function addRecord() {
  const level = state.selectedLevel;
  const w = state.weather;

  if (state.lat == null || state.lon == null) {
    setWarn('请先定位或点击地图设置位置。');
    return;
  }
  if (level == null) {
    setWarn('请选择气味强度。');
    return;
  }
  if (!w || w.wind_direction_10m == null) {
    setWarn('还没有可用的风向数据，请先「刷新天气」。');
    return;
  }

  // 用最近一段定位点求稳健位置，避免单个漂移点把记录画到几十米外
  let lat = state.lat;
  let lon = state.lon;
  let acc = state.accuracy;
  if (state.survey && !state.manualLocation) {
    const s = stableFix(fixBuf, Date.now(), {
      windowMs: CONFIG.surveyStableMs,
      maxAcc: CONFIG.surveyMaxAcc,
      maxSpread: 60,
    });
    if (!s) {
      const msg = '巡测定位未就绪：最近 10 秒没有 ±60 m 内的稳定定位点。' +
        '请到开阔处稍等几秒再提交；也可点地图手动标点后再记录。';
      setWarn(msg, true);
      showToast('定位不够稳，暂不记录：稍等几秒再提交', 'err', 5200);
      return;
    }
    lat = s.lat;
    lon = s.lon;
    acc = s.acc;
    useSmoothedPosition(lat, lon, acc, `稳健平均 ${s.n} 点`);
  } else if (!state.manualLocation) {
    const s = stableFix(fixBuf, Date.now(), {
      windowMs: 8000, maxAcc: 200, maxSpread: 100,
    });
    if (s) {
      lat = s.lat;
      lon = s.lon;
      acc = s.acc;
      useSmoothedPosition(lat, lon, acc, '稳健平均');
    }
  }

  const bearing = w.wind_direction_10m; // 气象风向 = 风的来向 = 污染源方位
  const windSpeed = w.wind_speed_10m == null ? 0 : Number(w.wind_speed_10m);
  const st = windStabilityOf(w);

  const rec = {
    id: ++state.seq,
    time: new Date(),
    lat,
    lon,
    level,
    bearing,
    windSpeed,
    windSource: w.source || '',
    windR: st.R,
    sigmaAng: st.sigmaAng,
    accuracy: acc == null ? null : Math.round(acc),
    surveyId: state.survey ? state.survey.id : null,
  };
  buildRecordLayers(rec);
  state.records.push(rec);

  renderRecords();
  renderSummary(rec);
  fitToLayer(rec.sector);
  updateFusion();
  saveSession();

  if (state.survey) {
    state.survey.lastPromptAt = Date.now();
    state.survey.dueNotified = false;
    updateSurveyGradient();
    const n = state.records.filter((r) => r.surveyId === state.survey.id).length;
    showToast(`已记录：等级 ${level} · 巡测第 ${n} 点`, 'ok', 2600);
  }
  updateSurveyUI();
  updateEvalUI();
}

/** 让要素落在底部面板上方的可视区域，而不是被面板遮住 */
function fitToLayer(layer) {
  const sheetH = document.getElementById('sheet').offsetHeight || 0;
  map.fitBounds(layer.getBounds(), {
    paddingTopLeft: [40, 90],
    paddingBottomRight: [40, sheetH + 30],
    maxZoom: 15,
  });
}

function renderSummary(rec) {
  const cfg = CONFIG.levels[rec.level];
  const range =
    cfg.near === 0 ? `约 0–${cfg.far} 米` : `约 ${cfg.near}–${cfg.far} 米`;
  const extra = rec.sigmaAng != null && rec.sigmaAng >= 35
    ? `<br>该次观测期间风向摆动较大，方位不确定度已放宽（σ≈${rec.sigmaAng}°）。`
    : '';
  els.summary.innerHTML = `
    <div class="sum-card">
      污染源可能在当前位置的 <b>${dirName(rec.bearing)}方向</b>，距离 <b>${range}</b>（粗略估计）。
      <div class="sub">
        依据：${dirName(rec.bearing)}风 ${Math.round(rec.bearing)}°、${rec.windSpeed.toFixed(1)} m/s；
        气味等级 ${rec.level}（${cfg.label}）。距离区间为经验值，虚线圆只表示区间中点。${extra}
      </div>
    </div>`;
}

function renderRecords() {
  els.recCount.textContent = state.records.length ? `(${state.records.length})` : '';
  if (!state.records.length) {
    els.records.innerHTML = '<div class="empty">还没有记录。定位后选择气味强度并提交。</div>';
    return;
  }
  els.records.innerHTML = '';
  [...state.records].reverse().forEach((r) => {
    const cfg = CONFIG.levels[r.level];
    const el = document.createElement('div');
    el.className = 'rec';
    el.style.setProperty('--c', cfg.color);
    const surveyTag = r.surveyId ? ' · 巡测' : '';
    el.innerHTML = `
      <span class="dot"></span>
      <div class="main">
        <div class="lvl">等级 ${r.level} · ${cfg.label}${surveyTag}</div>
        <div class="meta">
          ${dirName(r.bearing)}风 ${Math.round(r.bearing)}° · ${r.windSpeed.toFixed(1)} m/s ·
          ${r.time.toLocaleTimeString('zh-CN', { hour12: false })}
        </div>
      </div>
      <button type="button" class="rec-del" aria-label="删除这条记录">×</button>`;
    el.addEventListener('click', () => focusRecord(r));
    el.querySelector('.rec-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeRecord(r.id);
    });
    els.records.appendChild(el);
  });
}

function removeRecord(id) {
  const i = state.records.findIndex((r) => r.id === id);
  if (i < 0) return;
  const [r] = state.records.splice(i, 1);
  map.removeLayer(r.sector);
  map.removeLayer(r.dot);
  map.removeLayer(r.estCircle);
  renderRecords();
  if (state.records.length) renderSummary(state.records[state.records.length - 1]);
  else els.summary.innerHTML = '';
  updateFusion();
  saveSession();
  updateSurveyGradient();
  updateEvalUI();
}

function focusRecord(r) {
  fitToLayer(r.sector);
  r.sector.setStyle({ weight: 3, fillOpacity: 0.3 });
  setTimeout(() => r.sector.setStyle({
    weight: 1.5,
    fillOpacity: state.heatmap ? 0.06 : 0.18,
  }), 1200);
}

function clearAll() {
  if (state.survey) stopSurvey();
  els.survey.classList.remove('on');
  els.surveyBanner.classList.add('hidden');
  removeHeatmap();
  state.records.forEach((r) => {
    map.removeLayer(r.sector);
    map.removeLayer(r.dot);
    map.removeLayer(r.estCircle);
  });
  state.records = [];
  state.lastSurvey = null;
  els.summary.innerHTML = '';
  els.surveyGrad.classList.add('hidden');
  els.surveyText.textContent = '巡测：走动中每隔约 45 秒评一次气味，可看增强方向';
  els.surveyText.classList.remove('due');
  removeGradient();
  removeTrail();
  clearEvalTruth();
  renderRecords();
  updateFusion();
  saveSession();
  updateSurveyUI();
  updateEvalUI();
}

/* ---------------- 巡测（走动观测 + 气味增强方向） ---------------- */

function removeTrail() {
  if (state.trailLayer) {
    map.removeLayer(state.trailLayer);
    state.trailLayer = null;
  }
}

function drawTrail() {
  const s = state.survey;
  if (!s || !s.trail.length) return;
  const pts = s.trail.map(([la, lo]) => toDisp(la, lo));
  if (!state.trailLayer) {
    state.trailLayer = L.polyline(pts, {
      color: '#38bdf8', weight: 3, opacity: 0.55, interactive: false,
    }).addTo(map);
  } else {
    state.trailLayer.setLatLngs(pts);
  }
}

function removeGradient() {
  if (state.gradientLayer) {
    map.removeLayer(state.gradientLayer);
    state.gradientLayer = null;
  }
  if (state.gradientMarker) {
    map.removeLayer(state.gradientMarker);
    state.gradientMarker = null;
  }
}

function renderGradient(g, pts) {
  removeGradient();
  if (!g || g.brg == null) {
    if (pts.length >= 2) {
      els.surveyGrad.textContent =
        `各观测点间距不足 ${CONFIG.gradientMinDist} 米，或气味等级相同，` +
        '暂时判断不出气味增强方向。';
      els.surveyGrad.classList.remove('hidden');
    } else {
      els.surveyGrad.classList.add('hidden');
    }
    return;
  }
  const ref = pts.length ? pts[pts.length - 1] : null;
  if (!ref) return;

  const end = destination(ref.lat, ref.lon, g.brg, 150);
  state.gradientLayer = L.polyline(
    [toDisp(ref.lat, ref.lon), toDisp(end[0], end[1])],
    { color: '#f59e0b', weight: 4, opacity: 0.9, interactive: false }
  ).addTo(map);
  state.gradientMarker = L.marker(toDisp(end[0], end[1]), {
    icon: L.divIcon({
      className: 'survey-arrow',
      html: `<div class="arrow-glyph" style="transform:rotate(${g.brg.toFixed(1)}deg)">▲</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    }),
    interactive: false,
  }).addTo(map);

  let txt = `气味增强方向：<b>${dirName(g.brg)}</b>（${Math.round(g.brg)}°），` +
    `一致性 ${g.R.toFixed(2)}（${g.pairs} 组对比）。`;
  txt += g.reliable
    ? '沿箭头方向再走一段，通常会更接近源。'
    : '信号还不够一致，建议沿不同方向多走几个点。';
  if (g.skippedWind) {
    txt += ` 另有 ${g.skippedWind} 组因两次观测间风向变化较大被忽略。`;
  }
  els.surveyGrad.innerHTML = txt;
  els.surveyGrad.classList.remove('hidden');
}

function surveyRecords() {
  const id = state.survey ? state.survey.id
    : (state.lastSurvey ? state.lastSurvey.id : null);
  return id == null ? [] : state.records.filter((r) => r.surveyId === id);
}

function updateSurveyGradient() {
  if (!state.survey && !state.lastSurvey) return;
  const pts = surveyRecords();
  const g = smellGradient(pts, { minDist: CONFIG.gradientMinDist });
  if (state.survey) state.survey.gradient = g;
  else if (state.lastSurvey) state.lastSurvey.gradient = g;
  renderGradient(g, pts);
}

function updateSurveyUI() {
  const s = state.survey;
  if (!s) {
    els.surveyBanner.classList.add('hidden');
    return;
  }
  const mins = Math.floor((Date.now() - s.startedAt) / 60000);
  const n = state.records.filter((r) => r.surveyId === s.id).length;
  const since = Math.floor((Date.now() - s.lastPromptAt) / 1000);
  const due = n > 0 && Date.now() - s.lastPromptAt >= CONFIG.surveyPromptMs;
  const acc = s.lastAcc == null ? null : Number(s.lastAcc);
  const accTxt = acc != null ? ` · ±${Math.round(acc)} m` : '';
  let txt = `巡测中 · 已 ${mins} 分钟 · 记录 ${n} 点${accTxt}`;
  if (!n) txt += ' · 走几步后按气味选择等级提交';
  else if (due) txt += ` · 距上次评分 ${since} 秒，建议再评一次`;
  els.surveyText.textContent = txt;
  els.surveyText.classList.toggle('due', due);

  els.surveyBanner.classList.remove('hidden', 'warn', 'bad');
  const q = gradeAccuracy(acc);
  if (q === 'ok') els.surveyBanner.classList.add('warn');
  else if (q === 'poor') els.surveyBanner.classList.add('bad');
  els.surveyBannerText.textContent = `巡测中 · ${mins} 分钟 · ${n} 点${accTxt}` +
    (due ? ' · 该评分了' : '');

  if (due && !s.dueNotified) {
    s.dueNotified = true;
    if (navigator.vibrate) {
      try { navigator.vibrate(80); } catch (_) { /* 忽略 */ }
    }
  }
}

function onSurveyPos(pos) {
  const s = state.survey;
  if (!s) return;
  const { latitude, longitude, accuracy } = pos.coords;
  const acc = accuracy == null ? null : accuracy;
  applyFix(latitude, longitude, acc);
  s.lastAcc = acc;
  s.lastFixAt = Date.now();
  if (acc != null && acc > CONFIG.surveyMaxAcc) {
    // 精度太差：只更新当前位置，不进轨迹，也不用于提交时的稳健平均
    if (!s.accWarned) {
      s.accWarned = true;
      setWarn(
        `巡测定位精度较低（±${Math.round(acc)} m），轨迹可能不准。请到开阔处并确认已开启「精确位置」。`,
        true
      );
    }
    return;
  }
  if (state.lat == null || state.lon == null) return;
  const now = Date.now();
  const last = s.trail[s.trail.length - 1];
  if (last) {
    const prev = { lat: last[0], lon: last[1], t: last[2] || now };
    const next = { lat: state.lat, lon: state.lon, t: now };
    if (!plausible(prev, next, { maxSpeed: 3.5, tolerance: 25 })) {
      return; // 瞬移/漂移点，不画进轨迹（位置显示仍已更新）
    }
    const moved = relPos(last[0], last[1], state.lat, state.lon).d;
    if (moved < CONFIG.surveyTrailMinDist) return;
  }
  s.trail.push([state.lat, state.lon, now]);
  if (s.trail.length > 800) s.trail.shift();
  drawTrail();
}

function onSurveyErr(err) {
  const s = state.survey;
  if (!s || s.errWarned) return;
  s.errWarned = true;
  setWarn('巡测定位出错：' + describeGeoError(err));
}

function startSurvey() {
  if (state.survey) { stopSurvey(); return; }
  if (!navigator.geolocation) {
    setWarn('此浏览器不支持定位，无法巡测；可在不同位置点地图手动记录。', true);
    showToast('此浏览器不支持定位，无法巡测', 'err');
    return;
  }
  if (!window.isSecureContext) {
    setWarn('巡测需要 HTTPS 定位；可点击地图手动记录，或改用 HTTPS 访问。', true);
    showToast('巡测需要 HTTPS 定位，请改用 HTTPS 打开', 'err');
    return;
  }
  // 巡测接管持续定位，避免首轮定位采样与巡测 watch 互相覆盖
  stopGeoWatch();
  const id = Date.now();
  state.survey = {
    id, startedAt: id, lastPromptAt: id,
    trail: [], watchId: null, gradient: null,
    dueNotified: false, errWarned: false, accWarned: false,
    lastAcc: state.manualLocation ? null : state.accuracy,
    lastFixAt: state.manualLocation ? null : (state.lastFixAt || null),
  };
  state.lastSurvey = null;
  removeTrail();
  removeGradient();
  els.surveyGrad.classList.add('hidden');
  state.survey.watchId = navigator.geolocation.watchPosition(
    onSurveyPos, onSurveyErr,
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
  state.surveyTimer = setInterval(updateSurveyUI, 5000);
  els.surveyBtn.textContent = '结束巡测';
  els.surveyBtn.classList.add('on');
  els.survey.classList.add('on');
  refreshWeather(false);
  updateSurveyUI();
  showToast('巡测已开始：走动中每隔约 45 秒评一次气味', 'ok');
  setWarn('巡测开始：走动中每隔约 45 秒评一次气味，感到明显变化也可随时提交。');
  if (navigator.vibrate) {
    try { navigator.vibrate([60, 40, 60]); } catch (_) { /* 忽略 */ }
  }
}

function stopSurvey() {
  const s = state.survey;
  if (!s) return;
  if (s.watchId != null) navigator.geolocation.clearWatch(s.watchId);
  if (state.surveyTimer) {
    clearInterval(state.surveyTimer);
    state.surveyTimer = null;
  }
  const pts = state.records.filter((r) => r.surveyId === s.id);
  const g = smellGradient(pts, { minDist: CONFIG.gradientMinDist });
  const ref = pts.length ? pts[pts.length - 1] : null;
  state.lastSurvey = {
    id: s.id,
    gradient: g,
    points: pts.length,
    lat: ref ? ref.lat : state.lat,
    lon: ref ? ref.lon : state.lon,
  };
  state.survey = null;
  els.surveyBtn.textContent = '开始巡测';
  els.surveyBtn.classList.remove('on');
  els.survey.classList.remove('on');
  els.surveyBanner.classList.add('hidden');
  els.surveyText.classList.remove('due');
  els.surveyText.textContent = `巡测结束：共记录 ${pts.length} 个点` +
    (g && g.brg != null ? '，气味增强方向见地图箭头' : '');
  renderGradient(g, pts);
  saveSession();
  showToast(`巡测已结束：共记录 ${pts.length} 个点`, 'ok');
}

/* ---------------- 导出 ---------------- */

function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}`;
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1200);
}

/* 生成文件并触发下载；同时保存内容，供「再次下载 / 复制」兜底 */
function downloadText(filename, text, mime, label) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  state.lastExport = { filename, text, mime, label: label || '导出内容', url };
  triggerDownload(url, filename);
  // 移动端下载可能延迟取走 blob，稍后再释放
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch (_) { /* 忽略 */ }
  }, 120000);
  return state.lastExport;
}

function exportHint(msg) {
  return msg + (IS_WECHAT
    ? ' 微信内置浏览器可能拦截下载：请点右上角「…」选择在浏览器打开，或点「复制内容」。'
    : ' 如果没看到下载提示，可点「再次下载」，或「复制内容」粘贴到 Excel/WPS。');
}

function exportRecordsCsv() {
  if (!state.records.length) {
    showExportNote('还没有记录可导出。先定位并提交至少一条嗅辨记录。', true);
    showToast('没有记录可导出', 'err');
    setWarn('还没有记录可导出。');
    return;
  }
  try {
    const filename = `odor_records_${dateStamp()}.csv`;
    downloadText(filename, EXPORTERS.recordsToCsv(state.records),
      'text/csv;charset=utf-8', 'CSV');
    showExportNote(`已生成 CSV（${state.records.length} 条记录）。` + exportHint(''));
    showToast(`已生成 CSV：${state.records.length} 条记录`, 'ok');
    setWarn(`已导出 ${state.records.length} 条记录（CSV，WGS-84 坐标）。`);
  } catch (e) {
    showExportNote('导出失败：' + e.message, true);
    showToast('导出失败：' + e.message, 'err');
  }
}

function exportGeoJson() {
  if (!state.records.length) {
    showExportNote('还没有记录可导出。先定位并提交至少一条嗅辨记录。', true);
    showToast('没有记录可导出', 'err');
    setWarn('还没有记录可导出。');
    return;
  }
  try {
    const g = state.lastSurvey ? state.lastSurvey.gradient
      : (state.survey ? state.survey.gradient : null);
    const ref = state.lastSurvey ? state.lastSurvey
      : (state.survey && state.lat != null ? { lat: state.lat, lon: state.lon } : null);
    let extra = null;
    if (g && g.brg != null && ref &&
        Number.isFinite(ref.lat) && Number.isFinite(ref.lon)) {
      extra = { gradient: g, lat: ref.lat, lon: ref.lon };
    }
    const filename = `odor_survey_${dateStamp()}.geojson`;
    downloadText(filename,
      EXPORTERS.recordsToGeoJson(state.records, state.fusion, extra),
      'application/geo+json;charset=utf-8', 'GeoJSON');
    showExportNote(`已生成 GeoJSON（${state.records.length} 条记录 + 融合结果）。` +
      exportHint(''));
    showToast('已生成 GeoJSON 文件', 'ok');
    setWarn(`已导出 ${state.records.length} 条记录和融合结果（GeoJSON）。`);
  } catch (e) {
    showExportNote('导出失败：' + e.message, true);
    showToast('导出失败：' + e.message, 'err');
  }
}

/* 下载被拦截时的兜底：再点一次，或复制到剪贴板 */
function retryExport() {
  const x = state.lastExport;
  if (!x) {
    showExportNote('还没有生成可下载的文件，请先点「导出 CSV / GeoJSON」。', true);
    return;
  }
  try {
    let url = x.url;
    if (!url) {
      url = URL.createObjectURL(new Blob([x.text], { type: x.mime }));
      x.url = url;
    }
    triggerDownload(url, x.filename);
    showToast('已再次触发下载：' + x.filename, 'ok');
  } catch (e) {
    showExportNote('再次下载失败：' + e.message, true);
    showToast('再次下载失败', 'err');
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  ta.remove();
  if (!ok) throw new Error('浏览器不允许复制');
}

async function copyExport() {
  const x = state.lastExport;
  if (!x) {
    showExportNote('还没有生成可复制的内容，请先点「导出 CSV / GeoJSON」。', true);
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(x.text);
    } else {
      fallbackCopy(x.text);
    }
    showExportNote(`已复制 ${x.label} 内容（${x.text.length} 字符），可直接粘贴到 Excel/WPS。`);
    showToast('已复制到剪贴板', 'ok', 3000);
  } catch (_) {
    try {
      fallbackCopy(x.text);
      showExportNote(`已复制 ${x.label} 内容，可直接粘贴到 Excel/WPS。`);
      showToast('已复制到剪贴板', 'ok', 3000);
    } catch (e2) {
      showExportNote('复制失败：' + e2.message + '。请用「再次下载」或换浏览器打开。', true);
      showToast('复制失败', 'err');
    }
  }
}

function saveEvals() {
  try {
    localStorage.setItem(EVALS_KEY, JSON.stringify(state.evals.slice(-50)));
  } catch (_) { /* 忽略 */ }
}

function exportEvalsCsv() {
  if (!state.evals.length) {
    showExportNote('还没有对照评估结果。先在「评估模式」里选真值并计算一次。', true);
    showToast('没有评估结果可导出', 'err');
    setWarn('还没有对照评估结果可导出。');
    return;
  }
  try {
    const filename = `odor_eval_${dateStamp()}.csv`;
    downloadText(filename, EXPORTERS.evalsToCsv(state.evals),
      'text/csv;charset=utf-8', '评估 CSV');
    showExportNote(`已生成评估 CSV（${state.evals.length} 次对照）。` + exportHint(''));
    showToast(`已生成评估 CSV：${state.evals.length} 次`, 'ok');
    setWarn(`已导出 ${state.evals.length} 次评估结果。`);
  } catch (e) {
    showExportNote('导出失败：' + e.message, true);
    showToast('导出失败：' + e.message, 'err');
  }
}

/* ---------------- 对照实验（真值评估） ---------------- */

function removeEvalLine() {
  if (state.evalLine) {
    map.removeLayer(state.evalLine);
    state.evalLine = null;
  }
}

function removeEvalMarker() {
  if (state.evalMarker) {
    map.removeLayer(state.evalMarker);
    state.evalMarker = null;
  }
}

function clearEvalTruth() {
  state.evalPick = false;
  state.evalTruth = null;
  removeEvalMarker();
  removeEvalLine();
  updateEvalUI();
}

function drawEvalMarker() {
  removeEvalMarker();
  const t = state.evalTruth;
  if (!t) return;
  state.evalMarker = L.marker(toDisp(t.lat, t.lon), {
    icon: L.divIcon({
      className: 'truth-icon', html: '★',
      iconSize: [26, 26], iconAnchor: [13, 13],
    }),
    interactive: false,
  }).addTo(map);
  state.evalMarker.bindTooltip('真实源位置（对照实验）', { direction: 'top' });
}

function setEvalTruth(lat, lon) {
  state.evalTruth = { lat, lon };
  state.evalPick = false;
  removeEvalLine(); // 换了真值，旧连线失效
  drawEvalMarker();
  updateEvalUI();
  setWarn('已记录真实源位置。点「计算评估」查看命中情况。');
}

function startEvalPick() {
  if (state.evalPick) {
    state.evalPick = false;
    updateEvalUI();
    setWarn('已取消选择真值。');
    return;
  }
  if (state.records.length < 2) {
    setWarn('至少需要 2 条记录才能做对照评估。');
    return;
  }
  state.evalPick = true;
  updateEvalUI();
  setWarn('请在地图上点一下真实的污染源位置。', true);
}

function runEvaluation() {
  const f = state.fusion;
  const truth = state.evalTruth;
  if (!truth) { setWarn('请先在地图上选真实源位置。'); return; }
  if (!f || f.error || state.records.length < 2) {
    setWarn('需要至少 2 条记录和有效的融合结果。');
    return;
  }
  const p = FUSION.probAt(f, truth.lat, truth.lon);
  const hit50 = p >= f.thresholds.p50;
  const hit80 = p >= f.thresholds.p80;
  const dPeak = relPos(truth.lat, truth.lon, f.peak.lat, f.peak.lon).d;

  let clat = 0, clon = 0;
  state.records.forEach((r) => { clat += r.lat; clon += r.lon; });
  clat /= state.records.length;
  clon /= state.records.length;
  const bTruth = relPos(clat, clon, truth.lat, truth.lon).brg;
  const bPeak = relPos(clat, clon, f.peak.lat, f.peak.lon).brg;
  const dirErr = FUSION.angDiff(bTruth, bPeak);

  const entry = {
    time: new Date().toISOString(),
    truth: { lat: truth.lat, lon: truth.lon },
    peak: { lat: f.peak.lat, lon: f.peak.lon },
    p, hit50, hit80, dPeak, dirErr, n: state.records.length,
  };
  state.evals.push(entry);
  if (state.evals.length > 50) state.evals.splice(0, state.evals.length - 50);
  saveEvals();

  removeEvalLine();
  state.evalLine = L.polyline(
    [toDisp(truth.lat, truth.lon), toDisp(f.peak.lat, f.peak.lon)],
    { color: '#c084fc', weight: 2, dashArray: '5 5', opacity: 0.9, interactive: false }
  ).addTo(map);

  renderEvalSummary(entry);
  updateEvalUI();
}

function renderEvalSummary(latest) {
  if (!latest) {
    latest = state.evals[state.evals.length - 1];
  }
  if (!latest) {
    els.evalText.textContent = '';
    return;
  }
  const yes = (v) => (v ? '✓' : '✗');
  const n = state.evals.length;
  const h50 = state.evals.filter((e) => e.hit50).length;
  const h80 = state.evals.filter((e) => e.hit80).length;
  const cell = state.fusion && !state.fusion.error
    ? Math.round(Math.sqrt(state.fusion.cellArea)) : null;
  els.evalText.innerHTML =
    `最近一次：真值在 50% 区内 <b>${yes(latest.hit50)}</b>、` +
    `80% 区内 <b>${yes(latest.hit80)}</b>；` +
    `距峰值 ${Math.round(latest.dPeak)} m，方向偏差约 ${Math.round(latest.dirErr)}°。` +
    (cell ? `（按格点概率判定，格点边长约 ${cell} m。）` : '') +
    `<br>累计 ${n} 次对照：80% 区命中 ${h80} 次` +
    `（${Math.round(100 * h80 / n)}%），50% 区命中 ${h50} 次` +
    `（${Math.round(100 * h50 / n)}%）。`;
}

function updateEvalUI() {
  if (!els.evalRun) return;
  els.evalRun.disabled = !(
    state.evalTruth && state.fusion && !state.fusion.error &&
    state.records.length >= 2
  );
  els.evalPick.textContent = state.evalPick ? '点地图选真值…' : '在地图上选真值';
  els.evalPick.classList.toggle('on', state.evalPick);
  els.evalExport.classList.toggle('hidden', !state.evals.length);
  if (!state.evals.length) els.evalText.textContent = '';
  else renderEvalSummary();
}

function toggleEvalPanel() {
  els.evalPanel.classList.toggle('hidden');
  updateEvalUI();
}

/* ---------------- 事件绑定 ---------------- */

els.locate.addEventListener('click', locate);
els.refresh.addEventListener('click', () => refreshWeather(true));
els.submit.addEventListener('click', addRecord);
els.clear.addEventListener('click', clearAll);
els.manualBtn.addEventListener('click', () => els.manual.classList.toggle('hidden'));
els.mwApply.addEventListener('click', applyManualWind);
els.calib.addEventListener('click', toggleCalibration);
els.fusionToggle.addEventListener('click', toggleHeat);
els.fusionFocus.addEventListener('click', focusFusion);
els.surveyBtn.addEventListener('click', startSurvey);
els.exportCsv.addEventListener('click', exportRecordsCsv);
els.exportGeo.addEventListener('click', exportGeoJson);
els.exportRetry.addEventListener('click', retryExport);
els.exportCopy.addEventListener('click', copyExport);
els.evalToggle.addEventListener('click', toggleEvalPanel);
els.evalPick.addEventListener('click', startEvalPick);
els.evalRun.addEventListener('click', runEvaluation);
els.evalClear.addEventListener('click', () => {
  clearEvalTruth();
  setWarn('已清除对照真值。');
});
els.evalExport.addEventListener('click', exportEvalsCsv);

map.on('click', (e) => {
  const [lat, lon] = gcj02ToWgs84(e.latlng.lat, e.latlng.lng);
  if (state.calibrating) {
    applyCalibration(lat, lon);
    return;
  }
  if (state.evalPick) {
    setEvalTruth(lat, lon);
    return;
  }
  setLocation(lat, lon, null, true);
});

/* ---------------- 启动 ---------------- */

renderLevelButtons();
restoreSession();
renderRecords();
updateSubmitState();
updateCalibButton();
updateEvalUI();
renderFusion();

if (/MicroMessenger/i.test(navigator.userAgent)) {
  els.envHint.textContent =
    '当前在微信内打开，定位可能偏差较大。请点右上角「…」选择「在浏览器打开」，' +
    '并允许「精确位置」。';
  els.envHint.classList.remove('hidden');
}

if (!window.isSecureContext) {
  setWarn(
    '当前页面不是 HTTPS（手机通过局域网 IP 访问时），浏览器会禁止自动定位。' +
      '请点击地图手动设置你的位置。',
    true
  );
}
locate();

// PWA：注册离线壳（HTTPS 或 localhost 下生效）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
