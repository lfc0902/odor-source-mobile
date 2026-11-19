'use strict';
/* 几何算法自测：node test/geo.test.js */
const assert = require('assert');
const { destination, sectorPolygon, dirName } = require('../js/geo.js');

const R = 6371000;
function haversine(a, b) {
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const lat0 = 39.9042, lon0 = 116.4074; // 北京

// 1. 正北 1000 m：纬度增加约 0.009°，经度基本不变
{
  const p = destination(lat0, lon0, 0, 1000);
  assert(Math.abs(p[0] - lat0 - 0.008994) < 0.0001, `north dlat=${p[0] - lat0}`);
  assert(Math.abs(p[1] - lon0) < 1e-9, `north dlon=${p[1] - lon0}`);
  assert(Math.abs(haversine([lat0, lon0], p) - 1000) < 1, 'north distance');
}

// 2. 正东 1000 m：经度增加约 0.0117°（按纬度余弦收缩）
{
  const p = destination(lat0, lon0, 90, 1000);
  assert(Math.abs(p[1] - lon0 - 0.011706) < 0.0003, `east dlon=${p[1] - lon0}`);
  // 大圆航线沿正东走时纬度有极微小变化（~1e-6 量级），不是严格平行
  assert(Math.abs(p[0] - lat0) < 1e-5, `east dlat=${p[0] - lat0}`);
  assert(Math.abs(haversine([lat0, lon0], p) - 1000) < 1, 'east distance');
}

// 3. 各方向距离闭合
for (const b of [0, 45, 135, 225, 300, 359]) {
  const p = destination(lat0, lon0, b, 2500);
  assert(Math.abs(haversine([lat0, lon0], p) - 2500) < 1.5, `bearing ${b}`);
}

// 4. 扇形顶点：数量正确、半径落在区间内
{
  const pts = sectorPolygon(lat0, lon0, 45, 25, 100, 500, 28);
  assert.strictEqual(pts.length, 58, 'vertex count');
  for (const p of pts) {
    const d = haversine([lat0, lon0], p);
    assert(d >= 99 && d <= 501, `vertex radius ${d}`);
  }
  // 外弧前 29 个点半径 ≈ 500，内弧后 29 个点半径 ≈ 100
  assert(Math.abs(haversine([lat0, lon0], pts[0]) - 500) < 1);
  assert(Math.abs(haversine([lat0, lon0], pts[pts.length - 1]) - 100) < 1);
}

// 5. near=0 时不产生 NaN
{
  const pts = sectorPolygon(lat0, lon0, 180, 25, 0, 150, 8);
  assert(pts.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b)), 'finite');
}

// 6. 方位中文名
{
  const cases = [[0, '北'], [22, '东北偏北'], [90, '东'], [180, '南'],
                 [225, '西南'], [270, '西'], [359, '北'], [-90, '西'], [450, '东']];
  for (const [deg, name] of cases) {
    assert.strictEqual(dirName(deg), name, `dirName(${deg})`);
  }
}

console.log('geo tests passed: 6 groups');
