'use strict';
/* 端到端自测：headless Edge + CDP
 * 模拟手机视口 → 注入定位 → 真实调用 Open-Meteo → 选等级 → 提交 → 截图
 * 用法：先启动静态服务（8123），再 node test/e2e_cdp.js
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = process.env.EDGE_BIN ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// 每次用独立端口：避免连到上一次没退干净的 headless 实例（会跑旧代码）
const PORT = 9300 + Math.floor(Math.random() * 500);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123/';
const ROOT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (_) { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error('等待 CDP 超时: ' + url);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      '页面 JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    );
  }
  return r.result.value;
}

async function shot(cdp, filename) {
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  fs.writeFileSync(path.join(ROOT, filename), Buffer.from(r.data, 'base64'));
}

(async () => {
  const profile = path.join(os.tmpdir(), 'edge_e2e_' + Date.now());
  const child = spawn(EDGE, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const report = {};
  try {
    const targets = await waitJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到页面 target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WS 连接失败')));
    });
    const cdp = new CDP(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    // 自测时禁用缓存与 Service Worker，确保跑的是磁盘上的最新代码
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    try { await cdp.send('Network.setBypassServiceWorker', { bypass: true }); } catch (_) {}
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send('Page.navigate', { url: BASE + (BASE.includes('?') ? '&' : '?') + 't=' + Date.now() });
    await sleep(2500);

    report.viewport = await evalJs(cdp, 'innerWidth + "x" + innerHeight');
    report.leafletLoaded = await evalJs(cdp, 'typeof L !== "undefined"');
    report.levelsCount = await evalJs(cdp, 'document.querySelectorAll(".level-btn").length');
    // 新代码断言：备源与手动风速必须存在
    report.hasWttr = await evalJs(cdp, 'typeof fetchWttr === "function"');
    report.hasManual = await evalJs(cdp, 'typeof applyManualWind === "function"');

    // 真实定位链路：授权 geolocation 并模拟 GPS，验证 HTTPS 下自动定位可用
    let geoOk = false;
    try {
      await cdp.send('Browser.grantPermissions', {
        origin: new URL(BASE).origin,
        permissions: ['geolocation'],
      });
      await cdp.send('Emulation.setGeolocationOverride', {
        latitude: 39.9042, longitude: 116.4074, accuracy: 15,
      });
      await evalJs(cdp, 'locate(); true');
      for (let i = 0; i < 40; i++) {
        const st = JSON.parse(await evalJs(cdp,
          'JSON.stringify({lat:state.lat, lon:state.lon, manual:state.manualLocation})'));
        if (st.lat != null && st.manual === false &&
            Math.abs(st.lat - 39.9042) < 1e-6 && Math.abs(st.lon - 116.4074) < 1e-6) {
          geoOk = true;
          break;
        }
        await sleep(250);
      }
      report.geoLocate = JSON.parse(await evalJs(cdp,
        'JSON.stringify({lat:state.lat, lon:state.lon, manual:state.manualLocation, secure:window.isSecureContext})'));
    } catch (e) {
      report.geoError = e.message;
    }
    report.geoOk = geoOk;
    if (!geoOk) {
      // 环境不支持定位模拟时退回直接注入，保证其余用例可跑
      await evalJs(cdp, 'setLocation(39.9042, 116.4074, 15); true');
    }

    // 等待真实天气返回（Open-Meteo 8s → wttr.in 12s，最长约 20s；给到 32s）
    let weather = null;
    for (let i = 0; i < 80; i++) {
      weather = await evalJs(cdp,
        'state.weather && state.weather.source ? JSON.stringify(state.weather) : null');
      if (weather) break;
      await sleep(400);
    }
    report.weatherOk = !!weather;
    report.weather = weather ? JSON.parse(weather) : null;
    report.weatherSource = weather ? JSON.parse(weather).source : null;
    report.weatherText = await evalJs(cdp, 'document.getElementById("weatherText").innerText');
    await shot(cdp, '_e2e_before.png');

    // 真实天气路径：选等级 4 并提交（两个气象源都挂时跳过，下面用「手动」兜底验证）
    if (weather) {
      report.submitDisabledBefore = await evalJs(cdp, 'document.getElementById("btnSubmit").disabled');
      await evalJs(cdp, 'selectLevel(4); addRecord(); true');
      await sleep(3000);

      report.records = await evalJs(cdp, 'state.records.length');
      report.summary = await evalJs(cdp, 'document.getElementById("summary").innerText');
      report.sectorBounds = await evalJs(cdp,
        'JSON.stringify(state.records[0].sector.getBounds())');
      report.estCircleRadius = await evalJs(cdp, 'state.records[0].estCircle.getRadius()');
      report.mapZoom = await evalJs(cdp, 'map.getZoom()');
      report.mapCenter = await evalJs(cdp, 'JSON.stringify(map.getCenter())');
      report.sheetHeight = await evalJs(cdp, 'document.getElementById("sheet").offsetHeight');
      report.sectorOnMap = await evalJs(cdp, 'map.hasLayer(state.records[0].sector)');
      report.sectorPixelBounds = await evalJs(cdp,
        'JSON.stringify((()=>{const b=state.records[0].sector.getBounds();' +
        'return {sw:map.latLngToContainerPoint(b.getSouthWest()),' +
        'ne:map.latLngToContainerPoint(b.getNorthEast())}})())');
      // 方位约定自检：气象风向 = 污染源方位（上风向）
      report.bearingEqualsWindDir = await evalJs(cdp,
        'state.records[0].bearing === state.weather.wind_direction_10m');
      await shot(cdp, '_e2e_after.png');

      // 清除
      await evalJs(cdp, 'clearAll(); true');
      report.recordsAfterClear = await evalJs(cdp, 'state.records.length');
    }

    // 手动风向 / 风速路径（气象源全部失败时的兜底）
    const manual = await evalJs(cdp, `(() => {
      document.getElementById('mwDir').value = '90';
      document.getElementById('mwSpd').value = '3.2';
      applyManualWind();
      const src = state.weather && state.weather.source;
      const txt = document.getElementById('weatherText').innerText;
      selectLevel(3);
      addRecord();
      const r = state.records[state.records.length - 1];
      return JSON.stringify({
        source: src, text: txt,
        bearing: r && r.bearing, windSpeed: r && r.windSpeed,
        records: state.records.length,
        manualHidden: document.getElementById('manual').classList.contains('hidden'),
        summary: document.getElementById('summary').innerText,
      });
    })()`);
    report.manual = JSON.parse(manual);
    await shot(cdp, '_e2e_manual.png');
    await evalJs(cdp, 'clearAll(); true');
    report.recordsAfterManualClear = await evalJs(cdp, 'state.records.length');

    // 多条记录综合估计：两条互相垂直的风向 → 热区 + 概率区域 + 可信度
    report.fusion = JSON.parse(await evalJs(cdp, `(() => {
      clearAll();
      const w1 = { source: '手动输入', wind_speed_10m: 2, wind_direction_10m: 0,
        desc: '', temperature_2m: null, relative_humidity_2m: null };
      const w2 = Object.assign({}, w1, { wind_direction_10m: 90 });
      state.weather = w1;
      state.lat = 39.9042; state.lon = 116.4074; state.manualLocation = true;
      selectLevel(4); addRecord();
      state.weather = w2;
      state.lat = 39.9080; state.lon = 116.4074; state.manualLocation = true;
      selectLevel(4); addRecord();
      const f = state.fusion;
      return JSON.stringify({
        records: state.records.length,
        visible: !document.getElementById('fusion').classList.contains('hidden'),
        text: document.getElementById('fusionText').innerText,
        conf: document.getElementById('fusionConf').innerText,
        hasHeat: !!state.heatmap && map.hasLayer(state.heatmap),
        hasPeakMarker: !!state.peakMarker && map.hasLayer(state.peakMarker),
        peak: f && f.peak,
        area50: f && f.region50.area,
        area80: f && f.region80.area,
        notes: f && f.notes,
      });
    })()`));
    await sleep(1200);
    await shot(cdp, '_e2e_fusion.png');
    await evalJs(cdp, 'focusFusion(); true');
    await sleep(800);
    report.fusionFocusZoom = await evalJs(cdp, 'map.getZoom()');
    report.heatToggle = JSON.parse(await evalJs(cdp, `(() => {
      toggleHeat();
      const off = { hasHeat: !!state.heatmap,
        btn: document.getElementById('btnFusionToggle').innerText };
      toggleHeat();
      const on = { hasHeat: !!state.heatmap && map.hasLayer(state.heatmap) };
      return JSON.stringify({ off, on });
    })()`));
    await evalJs(cdp, 'clearAll(); true');
    report.fusionAfterClear = JSON.parse(await evalJs(cdp,
      'JSON.stringify({records:state.records.length,' +
      'hidden:document.getElementById("fusion").classList.contains("hidden"),' +
      'hasHeat:!!state.heatmap})'));

    // 备源链路模拟：让 Open-Meteo 失败，应自动落到 wttr.in
    report.fallback = JSON.parse(await evalJs(cdp, `(async () => {
      const orig = window.fetch.bind(window);
      window.fetch = (u, o) => String(u).includes('api.open-meteo.com')
        ? Promise.reject(new Error('模拟主源故障')) : orig(u, o);
      state.weather = null; state.weatherAt = 0;
      await refreshWeather(true);
      const res = {
        source: state.weather && state.weather.source,
        text: document.getElementById('weatherText').innerText,
      };
      window.fetch = orig;
      return JSON.stringify(res);
    })()`));

    // 全部失败：应提示并展开手动输入
    report.allFail = JSON.parse(await evalJs(cdp, `(async () => {
      const orig = window.fetch.bind(window);
      window.fetch = () => Promise.reject(new Error('模拟断网'));
      state.weather = null; state.weatherAt = 0;
      await refreshWeather(true);
      const res = {
        weather: state.weather,
        text: document.getElementById('weatherText').innerText,
        manualVisible: !document.getElementById('manual').classList.contains('hidden'),
        warn: document.getElementById('warnText').innerText,
      };
      window.fetch = orig;
      return JSON.stringify(res);
    })()`));

    // 低精度定位：应明确提示「精度较低」并引导手动校正
    await cdp.send('Emulation.setGeolocationOverride', {
      latitude: 39.9042, longitude: 116.4074, accuracy: 500,
    });
    await evalJs(cdp, 'locate(); true');
    await sleep(1200);
    report.poorAccuracy = JSON.parse(await evalJs(cdp,
      'JSON.stringify({text:document.getElementById("locText").innerText,' +
      'poor:document.getElementById("locText").classList.contains("poor")})'));
    await evalJs(cdp, 'stopGeoWatch(); true');

    // 位置校准：点地图真实位置 → 保存本机偏移 → 新 GPS 自动套用 → 可清除
    report.calibration = JSON.parse(await evalJs(cdp, `(() => {
      toggleCalibration();
      const started = state.calibrating;
      const raw = state.lastRawFix;
      const g = wgs84ToGcj02(raw.lat + 0.0027, raw.lon); // 真实位置在 GPS 以北约 300 m
      map.fire('click', { latlng: L.latLng(g[0], g[1]) });
      const saved = localStorage.getItem('odor_calib_v1');
      const d = state.calib;
      applyFix(raw.lat, raw.lon, 20); // 下一次 GPS 应自动套用偏移
      const text = document.getElementById('locText').innerText;
      toggleCalibration(); // 清除
      return JSON.stringify({
        started,
        saved: saved ? JSON.parse(saved) : null,
        dLat: d && d.dLat, dLon: d && d.dLon,
        text,
        cleared: state.calib,
        lsAfter: localStorage.getItem('odor_calib_v1'),
        btn: document.getElementById('btnCalib').textContent,
      });
    })()`));

    // 地图点击 → GCJ-02 反算为 WGS-84
    const { gcj02ToWgs84, wgs84ToGcj02 } = require('../js/coords.js');
    await evalJs(cdp, 'map.fire("click", {latlng: L.latLng(39.9070, 116.4130)}); true');
    await sleep(400);
    const got = JSON.parse(await evalJs(cdp, 'JSON.stringify({lat:state.lat, lon:state.lon})'));
    const exp = gcj02ToWgs84(39.9070, 116.4130);
    report.clickInverseOk =
      Math.abs(got.lat - exp[0]) < 1e-6 && Math.abs(got.lon - exp[1]) < 1e-6;
    report.clickInverse = { got, expected: { lat: exp[0], lon: exp[1] } };

    // 坐标基准自检：天安门 WGS-84 转换后应落在高德图上的天安门
    const tam = wgs84ToGcj02(39.908692, 116.397477);
    await evalJs(cdp,
      `map.setView([${tam[0] - 0.0015}, ${tam[1]}], 17); ` +
      `L.circleMarker([${tam[0]}, ${tam[1]}], {radius:8,color:'#ffdd00',weight:3,` +
      `fillColor:'#ffdd00',fillOpacity:1}).addTo(map); true`);
    await sleep(3000);
    await shot(cdp, '_e2e_landmark.png');
    report.landmarkGcj = { lat: tam[0], lon: tam[1] };

    ws.close();
  } finally {
    // Edge 会派生子进程，child.kill()/taskkill 都可能杀不干净；
    // 按测试专用 profile 前缀精确清理，否则残留实例会占端口、下次跑到旧代码
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      spawnSync('powershell', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | ' +
        'Where-Object { $_.CommandLine -match \'edge_e2e_\' } | ' +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      ], { stdio: 'ignore', timeout: 15000 });
    } catch (_) { /* 忽略 */ }
    await sleep(500);
  }

  console.log(JSON.stringify(report, null, 2));
})().catch((e) => {
  console.error('E2E FAILED:', e.message);
  process.exit(1);
});
