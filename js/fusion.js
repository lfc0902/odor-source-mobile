/* 多条嗅辨记录的粗略概率融合
 * 模型假设：
 *   - 每条记录的"上风向"指向污染源（气象风向 = 风来向）
 *   - 该等级对应的距离区间可视为可信区间，区间内权重 1，区间外按高斯衰减
 *   - 各条记录独立：把每条记录对每个格点的似然相乘
 * 输出归一化的相对概率格点，供前端画热区、算 50%/80% 区域。
 * 注意：这是筛查模型，不是实测置信度。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FUSION = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RAD = Math.PI / 180;

  /** 从 (lat1,lon1) 到 (lat2,lon2) 的平面近似距离（米）与方位角（度，正北=0） */
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

  /** 距离区间内的径向权重：带内为 1，带外按软高斯衰减 */
  function radialWeight(near, far, d) {
    if (!(far > 0)) return 0;
    if (d < near) {
      const soft = Math.max(near * 0.5, 40);
      if (d < near - 4 * soft) return 0; // 远低于区间：不再给概率，避免远处孤立色块
      return Math.exp(-0.5 * Math.pow((near - d) / soft, 2));
    }
    if (d > far) {
      const soft = Math.max(far * 0.45, 40);
      if (d > far + 4 * soft) return 0;
      return Math.exp(-0.5 * Math.pow((d - far) / soft, 2));
    }
    return 1;
  }

  function logLikelihood(rec, lat, lon, sigmaAng) {
    const { d, brg } = rel(rec.lat, rec.lon, lat, lon);
    const da = angDiff(brg, rec.bearing);
    // 每条记录可按其观测期间的风场稳定性单独放宽方位不确定度
    const sig = rec.sigmaAng != null ? rec.sigmaAng : sigmaAng;
    const ang = Math.exp(-0.5 * Math.pow(da / sig, 2));
    const rad = radialWeight(rec.near, rec.far, d);
    if (ang <= 0 || rad <= 0) return -Infinity;
    return Math.log(ang) + Math.log(rad);
  }

  /**
   * @param {Array} records [{lat, lon, bearing, near, far, windSpeed, level}]
   * @param {Object} opts {cells, sigmaAng, halfAngle}
   * @returns {Object|null}
   */
  function compute(records, opts) {
    opts = opts || {};
    const CELLS = opts.cells || 128;
    const sigmaAng = opts.sigmaAng || 25;
    const halfAngle = opts.halfAngle || 25;
    if (!Array.isArray(records) || records.length < 2) return null;

    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    for (const r of records) {
      const reach = Math.max(r.far, 100) * 1.5;
      const dLat = reach / 111320;
      const dLon = reach / (111320 * Math.cos(r.lat * RAD));
      minLat = Math.min(minLat, r.lat - dLat);
      maxLat = Math.max(maxLat, r.lat + dLat);
      minLon = Math.min(minLon, r.lon - dLon);
      maxLon = Math.max(maxLon, r.lon + dLon);
    }
    if (!(maxLat > minLat) || !(maxLon > minLon)) return { error: '计算范围无效' };

    const midLat = (minLat + maxLat) / 2 * RAD;
    const latSpan = maxLat - minLat;
    const lonSpan = maxLon - minLon;
    const nLat = CELLS;
    const nLon = Math.max(24, Math.min(CELLS * 2,
      Math.round(CELLS * (lonSpan * Math.cos(midLat)) / latSpan)));
    const dLat = latSpan / nLat;
    const dLon = lonSpan / nLon;

    const weights = new Float64Array(nLat * nLon);
    let maxLog = -Infinity;
    for (let i = 0; i < nLat; i++) {
      const lat = minLat + (i + 0.5) * dLat;
      for (let j = 0; j < nLon; j++) {
        const lon = minLon + (j + 0.5) * dLon;
        let s = 0;
        for (let k = 0; k < records.length; k++) {
          s += logLikelihood(records[k], lat, lon, sigmaAng);
        }
        const idx = i * nLon + j;
        weights[idx] = s;
        if (s > maxLog) maxLog = s;
      }
    }
    if (!Number.isFinite(maxLog)) return { error: '记录之间没有共同可行区域' };

    let total = 0;
    let peakIdx = 0;
    let peakP = -1;
    for (let idx = 0; idx < weights.length; idx++) {
      const p = Math.exp(weights[idx] - maxLog);
      weights[idx] = p;
      total += p;
      if (p > peakP) { peakP = p; peakIdx = idx; }
    }
    if (!(total > 0)) return { error: '概率归一化失败' };
    for (let idx = 0; idx < weights.length; idx++) weights[idx] /= total;

    // 50% / 80% 概率区域的格点阈值
    const sorted = Array.from(weights).sort((a, b) => b - a);
    let cum = 0, q50 = 0, q80 = 0;
    for (const p of sorted) {
      cum += p;
      if (!q50 && cum >= 0.5) q50 = p;
      if (!q80 && cum >= 0.8) { q80 = p; break; }
    }

    const cellH = dLat * 111320;
    const cellW = dLon * 111320 * Math.cos(midLat);
    const cellArea = cellH * cellW;

    function region(thresh) {
      let count = 0, mass = 0;
      let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
      for (let i = 0; i < nLat; i++) {
        const lat = minLat + (i + 0.5) * dLat;
        for (let j = 0; j < nLon; j++) {
          const p = weights[i * nLon + j];
          if (p <= 0 || p < thresh) continue;
          count++;
          mass += p;
          const lon = minLon + (j + 0.5) * dLon;
          if (lat < minLa) minLa = lat;
          if (lat > maxLa) maxLa = lat;
          if (lon < minLo) minLo = lon;
          if (lon > maxLo) maxLo = lon;
        }
      }
      return {
        count,
        mass,
        area: count * cellArea,
        bounds: count ? { minLat: minLa, maxLat: maxLa, minLon: minLo, maxLon: maxLo } : null,
      };
    }

    const region50 = region(q50);
    const region80 = region(q80);

    const peakRow = Math.floor(peakIdx / nLon);
    const peakCol = peakIdx % nLon;
    const peak = {
      lat: minLat + (peakRow + 0.5) * dLat,
      lon: minLon + (peakCol + 0.5) * dLon,
      p: peakP / total,
    };

    // 可信度：80% 区域相对最小扇形大小；记录少则最多给“中等”
    const sectorArea = (r) =>
      (2 * halfAngle / 360) * Math.PI * (r.far * r.far - r.near * r.near);
    const minSector = Math.min.apply(null, records.map(sectorArea));
    const calm = records.some((r) => r.windSpeed != null && r.windSpeed < 0.5);
    const unstable = records.some((r) => r.sigmaAng != null && r.sigmaAng >= 35);
    const veryUnstable = records.some((r) => r.sigmaAng != null && r.sigmaAng >= 42);

    let confidence = 'medium';
    if (region80.area > 1.6 * minSector) confidence = 'low';
    else if (region80.area <= 0.6 * minSector && records.length >= 3) confidence = 'high';
    if (calm) confidence = 'low';
    // 观测期间风场不稳定：方位不确定度已放宽，可信度不能给太高
    if (unstable) {
      if (confidence === 'high') confidence = 'medium';
      if (veryUnstable) confidence = 'low';
    }

    const notes = [];
    if (records.length === 2) notes.push('仅 2 条记录，建议再增加 1–2 个观测点');
    if (calm) notes.push('存在风速 <0.5 m/s 的记录，风向参考性差');
    if (unstable && !calm) notes.push('部分记录期间风向摆动较大，方位不确定度已放宽');
    if (confidence === 'low' && !calm && !unstable) {
      notes.push('扇形交叠不集中，记录之间可能矛盾，或存在多个污染源');
    }

    return {
      count: records.length,
      nLat,
      nLon,
      minLat,
      maxLat,
      minLon,
      maxLon,
      dLat,
      dLon,
      cellArea,
      weights,
      peak,
      region50,
      region80,
      thresholds: { p50: q50, p80: q80 },
      confidence,
      notes,
    };
  }

  /** 某坐标所在格点的归一化概率（用于对照实验判定是否落在 50%/80% 区） */
  function probAt(f, lat, lon) {
    if (!f || f.error || !f.weights) return 0;
    const i = Math.floor((lat - f.minLat) / f.dLat);
    const j = Math.floor((lon - f.minLon) / f.dLon);
    if (i < 0 || j < 0 || i >= f.nLat || j >= f.nLon) return 0;
    return f.weights[i * f.nLon + j];
  }

  return { rel, angDiff, radialWeight, compute, probAt };
});
