'use strict';
/* 定位质量：精度分级、速度门控、稳健平均 */
const assert = require('assert');
const G = require('../js/geofix.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

console.log('geofix tests');

const fix = (lat, lon, acc, t) => ({ lat, lon, acc, t });

check('精度分级：25 / 60 米为分界', () => {
  assert.strictEqual(G.gradeAccuracy(8), 'good');
  assert.strictEqual(G.gradeAccuracy(25), 'good');
  assert.strictEqual(G.gradeAccuracy(26), 'ok');
  assert.strictEqual(G.gradeAccuracy(60), 'ok');
  assert.strictEqual(G.gradeAccuracy(61), 'poor');
  assert.strictEqual(G.gradeAccuracy(null), 'unknown');
});

check('速度门控：正常步行通过，瞬移被拒绝', () => {
  const t0 = 1000000;
  assert.strictEqual(G.plausible(
    { lat: 39.9042, lon: 116.4074, t: t0 },
    { lat: 39.90425, lon: 116.4074, t: t0 + 2000 }), true); // ~5.5 m / 2 s
  assert.strictEqual(G.plausible(
    { lat: 39.9042, lon: 116.4074, t: t0 },
    { lat: 39.9062, lon: 116.4074, t: t0 + 2000 }), false); // ~222 m / 2 s
  assert.strictEqual(G.plausible(
    { lat: 39.9042, lon: 116.4074, t: t0 },
    { lat: 39.9062, lon: 116.4074, t: t0 + 120000 }), true); // 两分钟走 222 m 合理
});

check('稳健平均：剔除 200 米外离群点，结果贴近真实点', () => {
  const t = 2000000;
  const s = G.stableFix([
    fix(39.90420, 116.40740, 12, t - 5000),
    fix(39.90422, 116.40741, 15, t - 4000),
    fix(39.90421, 116.40739, 20, t - 3000),
    fix(39.90423, 116.40742, 10, t - 2000),
    fix(39.90620, 116.40740, 8, t - 1000), // 200 m 外、精度看似很好
  ], t, { windowMs: 10000 });
  assert(s, '应返回结果');
  assert(Math.abs(s.lat - 39.90421) < 2e-5, 'lat 贴近真实点');
  assert(Math.abs(s.lon - 116.40740) < 2e-5, 'lon 贴近真实点');
  assert(s.n >= 4, '保留了多数一致点');
  assert(s.dropped >= 1, '离群点被剔除');
});

check('稳健平均：精度越高权重越大', () => {
  const t = 3000000;
  const s = G.stableFix([
    fix(39.90420, 116.40740, 10, t - 3000),
    fix(39.90420, 116.40740, 10, t - 2000),
    fix(39.90440, 116.40740, 50, t - 1000), // 约 22 m 外、精度差
  ], t, { windowMs: 10000, maxSpread: 100 });
  assert(Math.abs(s.lat - 39.90420) < 3e-5, '高精度点应主导');
});

check('稳健平均：过期、低精度、空输入返回 null', () => {
  const t = 4000000;
  assert.strictEqual(G.stableFix([], t), null);
  assert.strictEqual(G.stableFix([
    fix(39.9042, 116.4074, 80, t - 1000),
    fix(39.9042, 116.4074, 120, t - 2000),
  ], t, { maxAcc: 60 }), null);
  assert.strictEqual(G.stableFix([
    fix(39.9042, 116.4074, 10, t - 60000),
  ], t, { windowMs: 10000 }), null);
});

check('稳健平均：点集过散时退回最近可信点，不强行平均', () => {
  const t = 5000000;
  const s = G.stableFix([
    fix(39.9042, 116.4074, 15, t - 3000),
    fix(39.90447, 116.4074, 15, t - 2000), // 约 30 m
    fix(39.90474, 116.4074, 15, t - 1000), // 约 60 m
  ], t, { windowMs: 10000, maxSpread: 10 });
  assert.strictEqual(s.fallback, true);
  assert(Math.abs(s.lat - 39.90474) < 1e-6, '退回最近一个点');
});

console.log(`geofix tests passed: ${passed} groups`);
