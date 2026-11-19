/* 定位质量工具（浏览器 + Node 共用）
 *
 * 浏览器的 Geolocation API 只给「经纬度 + accuracy」，拿不到 GPS/基站/Wi-Fi 原始数据。
 * 但可以用同一次定位会话里的多个点做工程处理，接近跑步类 App 的基础做法：
 *   1. 精度分级：≤25 m 好，25–60 m 一般，>60 m 很可能是网络定位；
 *   2. 速度门控：过滤瞬移/漂移点（步行场景默认 3.5 m/s + 抖动容差）；
 *   3. 稳健平均：按 accuracy² 加权，先剔除远离中位数的离群点，再求平均。
 * 这样能减少蓝点跳动和异常点，但不能突破手机/浏览器本身的系统误差。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GEOFIX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RAD = Math.PI / 180;

  function distM(lat1, lon1, lat2, lon2) {
    const latMid = (lat1 + lat2) / 2 * RAD;
    const dy = (lat2 - lat1) * 111320;
    const dx = (lon2 - lon1) * 111320 * Math.cos(latMid);
    return Math.hypot(dx, dy);
  }

  /** 精度分级：good / ok / poor / unknown */
  function gradeAccuracy(acc) {
    if (acc == null || !Number.isFinite(Number(acc))) return 'unknown';
    const a = Number(acc);
    if (a <= 25) return 'good';
    if (a <= 60) return 'ok';
    return 'poor';
  }

  function median(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    const n = a.length;
    if (!n) return 0;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  /**
   * 两个连续定位点是否物理上说得通。
   * @param {{lat,lon,t}} prev
   * @param {{lat,lon,t}} next t = 毫秒
   * @param {{maxSpeed?, tolerance?}} opts
   */
  function plausible(prev, next, opts) {
    if (!prev || !next) return true;
    if (!Number.isFinite(prev.lat) || !Number.isFinite(prev.lon) ||
        !Number.isFinite(next.lat) || !Number.isFinite(next.lon)) return false;
    const maxSpeed = opts && opts.maxSpeed != null ? opts.maxSpeed : 3.5;
    const tolerance = opts && opts.tolerance != null ? opts.tolerance : 25;
    const dt = Math.max(0, ((next.t || 0) - (prev.t || 0)) / 1000);
    const d = distM(prev.lat, prev.lon, next.lat, next.lon);
    return d <= tolerance + maxSpeed * dt;
  }

  /**
   * 从最近一段定位点里求一个稳健位置。
   * fixes: [{lat, lon, acc, t}]，t 为毫秒时间戳。
   * opts: {windowMs, maxAcc, maxSpread}
   * @returns {null|{lat, lon, acc, n, spread, dropped}}
   */
  function stableFix(fixes, now, opts) {
    opts = opts || {};
    const windowMs = opts.windowMs != null ? opts.windowMs : 12000;
    const maxAcc = opts.maxAcc != null ? opts.maxAcc : 60;
    const maxSpread = opts.maxSpread != null ? opts.maxSpread : 45;
    const tNow = Number.isFinite(now) ? now : Date.now();

    const list = (Array.isArray(fixes) ? fixes : []).filter((f) =>
      f && Number.isFinite(f.lat) && Number.isFinite(f.lon) &&
      Number.isFinite(f.t) && Number.isFinite(f.acc) &&
      tNow - f.t >= 0 && tNow - f.t <= windowMs && f.acc <= maxAcc);
    if (!list.length) return null;

    // 以中位数为中心，先去掉明显远离的漂移点
    const mLat = median(list.map((f) => f.lat));
    const mLon = median(list.map((f) => f.lon));
    const ds = list.map((f) => distM(mLat, mLon, f.lat, f.lon));
    const medD = median(ds);
    const gate = Math.max(medD * 3, 20);
    let use = list.filter((f, i) => ds[i] <= gate);
    if (!use.length) use = list.slice();

    // 按 accuracy² 倒数加权平均
    let sw = 0, sx = 0, sy = 0;
    use.forEach((f) => {
      const a = Math.max(1, f.acc);
      const w = 1 / (a * a);
      sw += w;
      sx += w * f.lat;
      sy += w * f.lon;
    });
    const lat = sx / sw;
    const lon = sy / sw;

    let sw2 = 0, spread2 = 0;
    use.forEach((f) => {
      const a = Math.max(1, f.acc);
      const w = 1 / (a * a);
      sw2 += w;
      spread2 += w * distM(lat, lon, f.lat, f.lon) ** 2;
    });
    const spread = Math.sqrt(spread2 / sw2);

    // 点集太散（还在移动/多路径严重）时退回最近一个可信点，避免平均出一个“不存在的位置”
    let result = { lat, lon, acc: Math.min(...use.map((f) => f.acc)), n: use.length, spread, dropped: list.length - use.length };
    if (spread > maxSpread) {
      const last = use.reduce((a, b) => (a.t >= b.t ? a : b));
      result = { lat: last.lat, lon: last.lon, acc: last.acc, n: use.length, spread, dropped: list.length - use.length, fallback: true };
    }
    return result;
  }

  return { distM, gradeAccuracy, plausible, stableFix };
});
