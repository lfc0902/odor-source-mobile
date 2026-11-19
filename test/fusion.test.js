'use strict';
/* 多条记录概率融合：几何、径向权重、交叠区、矛盾检测 */
const assert = require('assert');
const F = require('../js/fusion.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

console.log('fusion tests');

check('方位/距离：正北 0°、正东 90°', () => {
  const n = F.rel(39.9, 116.4, 39.909, 116.4);
  assert(Math.abs(n.d - 1000) < 5, '北向距离 ~1000 m');
  assert(Math.abs(n.brg - 0) < 0.5, '北向方位 0°');
  const e = F.rel(39.9, 116.4, 39.9, 116.41);
  assert(Math.abs(e.brg - 90) < 0.5, '东向方位 90°');
});

check('径向权重：区间内 1，区间外衰减', () => {
  assert.strictEqual(F.radialWeight(80, 400, 200), 1);
  assert.strictEqual(F.radialWeight(0, 150, 0), 1);
  const out = F.radialWeight(80, 400, 800);
  assert(out > 0 && out < 0.2, '超出 far 后显著衰减');
  const below = F.radialWeight(300, 1200, 50);
  assert(below > 0 && below < 0.3, '低于 near 时衰减');
});

const A = { lat: 39.9042, lon: 116.4074, bearing: 0, near: 80, far: 400, windSpeed: 2, level: 4 };
const B = { lat: 39.9080, lon: 116.4074, bearing: 90, near: 80, far: 400, windSpeed: 2, level: 4 };

check('两条互相垂直的记录：峰值落在东北交叠区', () => {
  const f = F.compute([A, B], { cells: 128, sigmaAng: 25, halfAngle: 25 });
  assert(f && !f.error);
  assert(f.peak.lat > 39.9065, '峰值在 A 以北');
  assert(f.peak.lon > 116.4075, '峰值在 B 以东');
  const minSector = Math.PI * (50 / 360) * (400 * 400 - 80 * 80);
  assert(f.region80.area < 1.6 * minSector, '80% 区小于单个扇形');
  assert.strictEqual(f.confidence, 'medium', '2 条记录最多中等');
  assert(f.region50.area < f.region80.area, '50% 区应小于 80% 区');
});

check('风向相反：判定为低可信并给出提示', () => {
  const C = Object.assign({}, A, { bearing: 180 });
  const f = F.compute([A, C], { cells: 128, sigmaAng: 25, halfAngle: 25 });
  assert(f && !f.error);
  assert.strictEqual(f.confidence, 'low');
  const minSector = Math.PI * (50 / 360) * (400 * 400 - 80 * 80);
  assert(f.region80.area > 1.5 * minSector, '80% 区应明显大于单个扇形');
  assert(f.notes.some((s) => s.includes('矛盾')), '应提示记录矛盾');
});

check('静风记录：可信度降为低', () => {
  const calm = Object.assign({}, B, { windSpeed: 0.2 });
  const f = F.compute([A, calm], { cells: 128, sigmaAng: 25, halfAngle: 25 });
  assert.strictEqual(f.confidence, 'low');
  assert(f.notes.some((s) => s.includes('风速')));
});

check('少于两条记录不融合', () => {
  assert.strictEqual(F.compute([A]), null);
  assert.strictEqual(F.compute([]), null);
});

check('单条记录的风向不确定度可单独放宽', () => {
  const wide = Object.assign({}, B, { sigmaAng: 45 });
  const base = F.compute([A, B], { cells: 128, sigmaAng: 25, halfAngle: 25 });
  const f = F.compute([A, wide], { cells: 128, sigmaAng: 25, halfAngle: 25 });
  assert(f && !f.error);
  assert(f.region80.area > base.region80.area * 1.2, '放宽后 80% 区明显更大');
  assert(f.notes.some((s) => s.includes('风向')), '应提示风场不稳定');
  assert.notStrictEqual(f.confidence, 'high');
});

check('输出分位阈值，probAt 可用于命中判定', () => {
  const f = F.compute([A, B], { cells: 128, sigmaAng: 25, halfAngle: 25 });
  assert(f.thresholds && f.thresholds.p50 > 0 && f.thresholds.p80 > 0);
  assert(f.thresholds.p80 <= f.thresholds.p50, '80% 区阈值不高于 50% 区');
  const pPeak = F.probAt(f, f.peak.lat, f.peak.lon);
  assert(pPeak > 0, '峰值格点概率 > 0');
  assert(pPeak >= f.thresholds.p50, '峰值必在 50% 区内');
  assert.strictEqual(F.probAt(f, 0, 0), 0, '范围外为 0');
});

console.log(`fusion tests passed: ${passed} groups`);
