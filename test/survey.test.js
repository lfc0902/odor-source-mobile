'use strict';
/* 巡测梯度 + 风场时间稳定性 */
const assert = require('assert');
const S = require('../js/survey.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

console.log('survey tests');

const P = (lat, lon, level, bearing) => ({ lat, lon, level, bearing });

check('梯度：向北走动气味增强 → 方向 ≈ 北', () => {
  const g = S.gradient([
    P(39.9042, 116.4074, 2, 0),
    P(39.9062, 116.4074, 4, 0),
    P(39.9082, 116.4074, 5, 0),
  ]);
  assert(g.pairs >= 3, '至少有 3 组点对');
  assert(Math.abs(g.brg) < 2 || Math.abs(g.brg - 360) < 2, '方位 ≈ 0°');
  assert(g.R > 0.95, '一致性很高');
  assert.strictEqual(g.reliable, true);
});

check('梯度：等级反向 → 方向相反', () => {
  const g = S.gradient([
    P(39.9042, 116.4074, 5, 0),
    P(39.9062, 116.4074, 3, 0),
    P(39.9082, 116.4074, 1, 0),
  ]);
  assert(Math.abs(g.brg - 180) < 2, '方位 ≈ 180°');
});

check('梯度：两次观测之间风向变化过大 → 忽略该点对', () => {
  const g = S.gradient([
    P(39.9042, 116.4074, 2, 0),
    P(39.9062, 116.4074, 4, 130),
  ]);
  assert.strictEqual(g.pairs, 0);
  assert.strictEqual(g.skippedWind, 1);
  assert.strictEqual(g.brg, null);
});

check('梯度：间距太小 → 该点对被跳过', () => {
  const g = S.gradient([
    P(39.9042, 116.4074, 2, 0),
    P(39.90421, 116.40741, 5, 0), // 约 1.4 m
  ]);
  assert.strictEqual(g.skippedNear, 1, '近点对被跳过');
  assert.strictEqual(g.pairs, 0);
  assert.strictEqual(g.brg, null);
});

check('梯度：等级都相同 → 判断不出方向', () => {
  const g = S.gradient([
    P(39.9042, 116.4074, 3, 0),
    P(39.9060, 116.4074, 3, 0),
    P(39.9080, 116.4074, 3, 0),
  ]);
  assert.strictEqual(g.pairs, 0);
  assert.strictEqual(g.brg, null);
  assert.strictEqual(g.reliable, false);
});

check('风场稳定性：方向一致 → R 接近 1', () => {
  const st = S.windStability({
    wind_direction_10m: [270, 272, 268, 275, 271, 269],
    wind_speed_10m: [3, 3.2, 2.9, 3.1, 3, 3.3],
  });
  assert.strictEqual(st.count, 6);
  assert(st.R > 0.99, 'R 应接近 1');
  assert(st.meanDir > 265 && st.meanDir < 280, '平均风向 ≈ 270°');
  assert(Math.abs(st.meanSpeed - 3.08) < 0.1);
});

check('风场稳定性：南北来回摆 → R 接近 0', () => {
  const st = S.windStability({
    wind_direction_10m: [0, 180, 0, 180, 0, 180],
    wind_speed_10m: [2, 2, 2, 2, 2, 2],
  });
  assert(st.R < 0.05, 'R 应接近 0');
});

check('风场稳定性：空值过滤、静风无方向', () => {
  const st = S.windStability({
    wind_direction_10m: [90, null, 92, 95],
    wind_speed_10m: [2, 3, null, 2.5],
  });
  assert.strictEqual(st.count, 2);
  const calm = S.windStability({
    wind_direction_10m: [90, 100],
    wind_speed_10m: [0, 0],
  });
  assert.strictEqual(calm.count, 2);
  assert.strictEqual(calm.meanDir, null);
  assert.strictEqual(calm.R, 0);
});

check('稳定性 → 方位标准差：25°–50°，静风至少 45°', () => {
  assert.strictEqual(S.sigFromStability(1, 2), 25);
  assert.strictEqual(S.sigFromStability(0, 2), 45);
  assert(S.sigFromStability(0.5, 3) > 30, '半稳定时应放宽');
  assert(S.sigFromStability(1, 0.2) >= 45, '静风至少 45°');
  assert(S.sigFromStability(0, 0) <= 50, '上限 50°');
});

console.log(`survey tests passed: ${passed} groups`);
