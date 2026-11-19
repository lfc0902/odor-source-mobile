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
};

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
  els.loc.textContent = '正在定位…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      state.manualLocation = false;
      setLocation(latitude, longitude, accuracy);
    },
    (err) => {
      els.loc.textContent = '未获取到定位';
      setWarn(describeGeoError(err), true);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

function setLocation(lat, lon, acc, manual = false) {
  state.lat = lat;
  state.lon = lon;
  state.accuracy = acc == null ? null : acc;
  state.manualLocation = manual;
  setCurrentMarker(lat, lon, state.accuracy);
  els.loc.textContent =
    `位置 ${lat.toFixed(5)}, ${lon.toFixed(5)}` +
    (state.accuracy ? `（±${Math.round(state.accuracy)} m）` : '') +
    (manual ? ' · 手动标点' : '');
  updateSubmitState();
  refreshWeather(true);
}

/* ---------------- 天气（Open-Meteo，免 key） ---------------- */

async function fetchWeather(lat, lon) {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,' +
    'wind_direction_10m,weather_code' +
    '&wind_speed_unit=ms&timezone=auto';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.current) throw new Error('响应缺少 current 字段');
    return data.current;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshWeather(force = false) {
  if (state.lat == null) return;
  if (!force && Date.now() - state.weatherAt < CONFIG.weatherMaxAgeMs) return;
  els.weather.textContent = '正在获取当地气象…';
  try {
    const cur = await fetchWeather(state.lat, state.lon);
    state.weather = cur;
    state.weatherAt = Date.now();
    renderWeather(cur);
  } catch (e) {
    state.weather = null;
    state.weatherAt = 0;
    els.weather.textContent = '气象获取失败';
    setWarn(`天气接口失败（${e.message}），请检查网络后点「刷新天气」。`, true);
  }
}

function renderWeather(cur) {
  const parts = [];
  const codeText = WEATHER_CODES[cur.weather_code] || '';
  if (codeText) parts.push(codeText);

  const ws = cur.wind_speed_10m;
  const wd = cur.wind_direction_10m;
  if (wd != null && ws != null) {
    parts.push(`风：<b>${dirName(wd)}风 ${Math.round(wd)}°</b>，${ws.toFixed(1)} m/s`);
  } else {
    parts.push('风：无有效数据');
  }
  if (cur.temperature_2m != null) parts.push(`气温 ${cur.temperature_2m.toFixed(1)}°C`);
  if (cur.relative_humidity_2m != null) parts.push(`湿度 ${Math.round(cur.relative_humidity_2m)}%`);
  els.weather.innerHTML = parts.join(' · ');

  if (ws != null && ws < 0.5) {
    setWarn('当前风速过小（<0.5 m/s），风向参考性差，溯源结果可靠性下降。', true);
  } else {
    clearWarn();
  }
}

/* ---------------- 提交与绘制 ---------------- */

function addRecord() {
  const level = state.selectedLevel;
  const cfg = CONFIG.levels[level];
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

  const bearing = w.wind_direction_10m; // 气象风向 = 风的来向 = 污染源方位
  const windSpeed = w.wind_speed_10m;

  // 几何在 WGS-84 中计算，绘制前统一转 GCJ-02
  const poly = sectorPolygon(
    state.lat, state.lon, bearing, CONFIG.halfAngleDeg, cfg.near, cfg.far
  ).map(([la, lo]) => toDisp(la, lo));
  const sector = L.polygon(poly, {
    color: cfg.color,
    weight: 1.5,
    opacity: 0.9,
    fillColor: cfg.color,
    fillOpacity: 0.18,
    interactive: false,
  }).addTo(map);

  const dot = L.circleMarker(toDisp(state.lat, state.lon), {
    radius: 4,
    color: '#0b1220',
    weight: 1,
    fillColor: cfg.color,
    fillOpacity: 1,
    interactive: false,
  }).addTo(map);

  // 估算的"大概位置"：扇形中线，取距离区间中点
  const midR = (cfg.near + cfg.far) / 2;
  const estPos = destination(state.lat, state.lon, bearing, midR);
  const estCircle = L.circle(toDisp(estPos[0], estPos[1]), {
    radius: Math.max((cfg.far - cfg.near) / 2, 20),
    color: cfg.color,
    weight: 1.5,
    dashArray: '6 6',
    opacity: 0.85,
    fillColor: cfg.color,
    fillOpacity: 0.06,
    interactive: false,
  }).addTo(map);
  estCircle.bindTooltip('估算源位置范围', { direction: 'top' });

  const rec = {
    id: ++state.seq,
    time: new Date(),
    lat: state.lat,
    lon: state.lon,
    level,
    bearing,
    windSpeed,
    sector,
    dot,
    estCircle,
  };
  state.records.push(rec);

  renderRecords();
  renderSummary(bearing, windSpeed, cfg);
  fitToLayer(sector);
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

function renderSummary(bearing, windSpeed, cfg) {
  const level = state.selectedLevel;
  const range =
    cfg.near === 0 ? `约 0–${cfg.far} 米` : `约 ${cfg.near}–${cfg.far} 米`;
  els.summary.innerHTML = `
    <div class="sum-card">
      污染源大概率在当前位置的 <b>${dirName(bearing)}方向</b>，距离 <b>${range}</b>。
      <div class="sub">
        依据：${dirName(bearing)}风 ${Math.round(bearing)}°、${windSpeed.toFixed(1)} m/s；
        气味等级 ${level}（${cfg.label}）。扇形中线距离按 ${(cfg.near + cfg.far) / 2} 米估算。
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
    el.innerHTML = `
      <span class="dot"></span>
      <div class="main">
        <div class="lvl">等级 ${r.level} · ${cfg.label}</div>
        <div class="meta">
          ${dirName(r.bearing)}风 ${Math.round(r.bearing)}° · ${r.windSpeed.toFixed(1)} m/s ·
          ${r.time.toLocaleTimeString('zh-CN', { hour12: false })}
        </div>
      </div>`;
    el.addEventListener('click', () => focusRecord(r));
    els.records.appendChild(el);
  });
}

function focusRecord(r) {
  fitToLayer(r.sector);
  r.sector.setStyle({ weight: 3, fillOpacity: 0.3 });
  setTimeout(() => r.sector.setStyle({ weight: 1.5, fillOpacity: 0.18 }), 1200);
}

function clearAll() {
  state.records.forEach((r) => {
    map.removeLayer(r.sector);
    map.removeLayer(r.dot);
    map.removeLayer(r.estCircle);
  });
  state.records = [];
  els.summary.innerHTML = '';
  renderRecords();
}

/* ---------------- 事件绑定 ---------------- */

els.locate.addEventListener('click', locate);
els.refresh.addEventListener('click', () => refreshWeather(true));
els.submit.addEventListener('click', addRecord);
els.clear.addEventListener('click', clearAll);

map.on('click', (e) => {
  const [lat, lon] = gcj02ToWgs84(e.latlng.lat, e.latlng.lng);
  setLocation(lat, lon, null, true);
});

/* ---------------- 启动 ---------------- */

renderLevelButtons();
renderRecords();
updateSubmitState();

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
