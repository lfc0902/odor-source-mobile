'use strict';
/* 端到端自测：headless Edge + CDP
 * 模拟手机视口 → 注入定位 → 真实调用 Open-Meteo → 选等级 → 提交 → 截图
 * 用法：先启动静态服务（8123），再 node test/e2e_cdp.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = process.env.EDGE_BIN ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const BASE = 'http://127.0.0.1:8123/';
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
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2500);

    report.viewport = await evalJs(cdp, 'innerWidth + "x" + innerHeight');
    report.leafletLoaded = await evalJs(cdp, 'typeof L !== "undefined"');
    report.levelsCount = await evalJs(cdp, 'document.querySelectorAll(".level-btn").length');

    // 注入 GPS（绕过 headless 无法授权定位）
    await evalJs(cdp, 'setLocation(39.9042, 116.4074, 15); true');

    // 等待真实天气返回
    let weather = null;
    for (let i = 0; i < 50; i++) {
      weather = await evalJs(cdp, 'state.weather ? JSON.stringify(state.weather) : null');
      if (weather) break;
      await sleep(400);
    }
    if (!weather) throw new Error('天气 API 未返回');
    report.weather = JSON.parse(weather);
    report.weatherText = await evalJs(cdp, 'document.getElementById("weatherText").innerText');
    await shot(cdp, '_e2e_before.png');

    // 选等级 4 并提交
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

    // 地图点击 → GCJ-02 反算为 WGS-84
    const { gcj02ToWgs84 } = require('../js/coords.js');
    await evalJs(cdp, 'map.fire("click", {latlng: L.latLng(39.9070, 116.4130)}); true');
    await sleep(400);
    const got = JSON.parse(await evalJs(cdp, 'JSON.stringify({lat:state.lat, lon:state.lon})'));
    const exp = gcj02ToWgs84(39.9070, 116.4130);
    report.clickInverseOk =
      Math.abs(got.lat - exp[0]) < 1e-6 && Math.abs(got.lon - exp[1]) < 1e-6;
    report.clickInverse = { got, expected: { lat: exp[0], lon: exp[1] } };

    ws.close();
  } finally {
    child.kill();
  }

  console.log(JSON.stringify(report, null, 2));
})().catch((e) => {
  console.error('E2E FAILED:', e.message);
  process.exit(1);
});
