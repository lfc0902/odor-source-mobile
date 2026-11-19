/* 巡测辅助：气味梯度方向 + 风场时间稳定性
 *
 * 梯度：把巡测中两两观测点比较——气味更强的点方向即"更靠近源"的方向。
 *   只比较间距 ≥ minDist 的点对，并要求两次观测期间风向变化不大，
 *   否则方向信号不可比。输出加权向量平均的方位与一致性 R（0–1）。
 *
 * 稳定性：用近几小时逐时风向/风速做"按风速加权的向量平均"，
 *   合向量长度 / 总权重 = R：1 表示风向完全一致，0 表示来回乱摆。
 *   再把 R 映射为融合模型里的方位角标准差（风越乱，扇形应越宽）。
 *
 * 纯函数模块，浏览器与 Node 共用；不依赖地图/Leaflet。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SURVEY = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RAD = Math.PI / 180;

  /** 平面近似距离（米）与方位角（度，正北=0） */
  function rel(lat1, lon1, lat2, lon2) {
    const latMid = (lat1 + lat2) / 2 * RAD;
    const dy = (lat2 - lat1) * 111320;
    const dx = (lon2 - lon1) * 111320 * Math.cos(latMid);
    let brg = Math.atan2(dx, dy) / RAD;
    if (brg < 0) brg += 360;
    return { d: Math.hypot(dx, dy), brg };
  }

  function angDiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /**
   * 从巡测记录估计气味增强方向（= 靠近源的方向）。
   * @param {Array} points [{lat, lon, level, bearing?, time?}]
   * @param {Object} opts {minDist, maxBearingDiff}
   * @returns {Object} {brg, R, pairs, skippedWind, skippedNear, reliable}
   */
  function gradient(points, opts) {
    opts = opts || {};
    const minDist = opts.minDist != null ? opts.minDist : 40;
    const maxBearingDiff = opts.maxBearingDiff != null ? opts.maxBearingDiff : 60;
    const pts = Array.isArray(points) ? points.filter(
      (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
        Number.isFinite(p.level)
    ) : [];

    let sx = 0, sy = 0, wsum = 0;
    let pairs = 0, skippedWind = 0, skippedNear = 0;

    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i];
        const b = pts[j];
        const { d, brg } = rel(a.lat, a.lon, b.lat, b.lon);
        if (d < minDist) { skippedNear++; continue; }
        const dl = b.level - a.level;
        if (dl === 0) continue; // 等级相同，无法判断哪边更近
        if (a.bearing != null && b.bearing != null &&
            angDiff(a.bearing, b.bearing) > maxBearingDiff) {
          skippedWind++;
          continue;
        }
        // 从等级低的点指向等级高的点
        const dir = dl > 0 ? brg : (brg + 180) % 360;
        // 长基线的点对更能抵抗 GPS 抖动；封顶避免远距离噪声主导
        const w = Math.abs(dl) * Math.min(d, 300);
        sx += w * Math.sin(dir * RAD);
        sy += w * Math.cos(dir * RAD);
        wsum += w;
        pairs++;
      }
    }

    if (wsum <= 0) {
      return {
        brg: null, R: 0, pairs: 0,
        skippedWind, skippedNear, reliable: false,
      };
    }
    let brg = Math.atan2(sx, sy) / RAD;
    if (brg < 0) brg += 360;
    const R = Math.min(1, Math.hypot(sx, sy) / wsum);
    return {
      brg,
      R,
      pairs,
      skippedWind,
      skippedNear,
      reliable: pairs >= 2 && R >= 0.5,
    };
  }

  /**
   * 近几小时风场一致性。
   * @param {Object} hourly {wind_direction_10m: number[], wind_speed_10m: number[]}
   * @returns {Object} {meanDir, R, meanSpeed, count}
   */
  function windStability(hourly) {
    const dirs = (hourly && hourly.wind_direction_10m) || [];
    const spds = (hourly && hourly.wind_speed_10m) || [];
    const n = Math.min(dirs.length, spds.length);
    let sx = 0, sy = 0, wsum = 0, sumSpd = 0, count = 0;

    for (let i = 0; i < n; i++) {
      const dir = dirs[i];
      const spd = spds[i];
      if (dir == null || spd == null) continue;
      if (!Number.isFinite(Number(dir)) || !Number.isFinite(Number(spd))) continue;
      const d = ((Number(dir) % 360) + 360) % 360;
      const s = Math.max(Number(spd), 0);
      sx += s * Math.sin(d * RAD);
      sy += s * Math.cos(d * RAD);
      wsum += s;
      sumSpd += s;
      count++;
    }

    if (!count) return { meanDir: null, R: 0, meanSpeed: 0, count: 0 };
    if (wsum <= 0) {
      // 全部静风：方向无意义
      return { meanDir: null, R: 0, meanSpeed: 0, count };
    }
    let meanDir = Math.atan2(sx, sy) / RAD;
    if (meanDir < 0) meanDir += 360;
    return {
      meanDir,
      R: Math.min(1, Math.hypot(sx, sy) / wsum),
      meanSpeed: sumSpd / count,
      count,
    };
  }

  /** 风场一致性 → 融合模型的方位角标准差（度），25° 为基准 */
  function sigFromStability(R, windSpeed) {
    const r = Number.isFinite(R) ? Math.max(0, Math.min(1, R)) : 0.6;
    let s = 25 + 20 * (1 - r);
    if (Number.isFinite(windSpeed) && windSpeed < 0.5) s = Math.max(s, 45);
    return Math.round(Math.max(25, Math.min(50, s)));
  }

  return { rel, angDiff, gradient, windStability, sigFromStability };
});
