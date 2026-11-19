/* 地理计算工具：可在浏览器与 Node 中共用（便于单测） */
(function (root) {
  'use strict';

  const EARTH_R = 6371000;

  /** 从 (lat, lon) 沿方位角 bearingDeg 走 distM 米后的坐标 [lat, lon] */
  function destination(lat, lon, bearingDeg, distM) {
    const d = distM / EARTH_R;
    const b = (bearingDeg * Math.PI) / 180;
    const p1 = (lat * Math.PI) / 180;
    const l1 = (lon * Math.PI) / 180;
    const p2 = Math.asin(
      Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b)
    );
    const l2 =
      l1 +
      Math.atan2(
        Math.sin(b) * Math.sin(d) * Math.cos(p1),
        Math.cos(d) - Math.sin(p1) * Math.sin(p2)
      );
    return [(p2 * 180) / Math.PI, (l2 * 180) / Math.PI];
  }

  /** 环形扇形的多边形顶点：外弧正向 + 内弧反向 */
  function sectorPolygon(lat, lon, bearing, halfAngle, rNear, rFar, steps = 28) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const b = bearing - halfAngle + (2 * halfAngle * i) / steps;
      pts.push(destination(lat, lon, b, rFar));
    }
    for (let i = steps; i >= 0; i--) {
      const b = bearing - halfAngle + (2 * halfAngle * i) / steps;
      pts.push(destination(lat, lon, b, Math.max(rNear, 0.001)));
    }
    return pts;
  }

  /** 角度 → 16 方位中文名 */
  function dirName(deg) {
    const names = [
      '北', '东北偏北', '东北', '东北偏东',
      '东', '东南偏东', '东南', '东南偏南',
      '南', '西南偏南', '西南', '西南偏西',
      '西', '西北偏西', '西北', '西北偏北',
    ];
    const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
    return names[i];
  }

  const GEO = { EARTH_R, destination, sectorPolygon, dirName };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GEO;
  } else {
    root.GEO = GEO;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
