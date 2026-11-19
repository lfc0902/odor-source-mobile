/* 数据导出：记录 CSV、GeoJSON、对照评估 CSV
 * 纯函数模块（浏览器与 Node 共用），便于单测；下载动作由 app.js 完成。
 * 坐标为 WGS-84。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EXPORTERS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function isoTime(t) {
    if (t == null) return '';
    const d = t instanceof Date ? t : new Date(t);
    return Number.isFinite(d.getTime()) ? d.toISOString() : '';
  }

  function num(v, digits) {
    if (v == null || !Number.isFinite(Number(v))) return '';
    return digits == null ? String(v) : Number(v).toFixed(digits);
  }

  /** 嗅辨记录 → CSV（带 BOM，Excel 打开中文不乱码） */
  function recordsToCsv(records) {
    const head = [
      'time', 'lat', 'lon', 'level', 'bearing_deg',
      'wind_speed_ms', 'wind_stability_R', 'sigma_deg',
      'accuracy_m', 'survey_id', 'wind_source',
    ];
    const rows = (records || []).map((r) => [
      isoTime(r.time),
      num(r.lat, 6), num(r.lon, 6),
      r.level,
      num(r.bearing, 0),
      num(r.windSpeed, 2),
      num(r.windR, 3),
      num(r.sigmaAng, 0),
      num(r.accuracy, 1),
      r.surveyId == null ? '' : r.surveyId,
      r.windSource || '',
    ].map(csvCell).join(','));
    return '\uFEFF' + [head.join(','), ...rows].join('\r\n') + '\r\n';
  }

  /** 评估结果 → CSV */
  function evalsToCsv(evals) {
    const head = [
      'time', 'truth_lat', 'truth_lon', 'peak_lat', 'peak_lon',
      'prob_at_truth', 'in_region50', 'in_region80',
      'dist_to_peak_m', 'dir_error_deg', 'records',
    ];
    const rows = (evals || []).map((e) => [
      isoTime(e.time),
      num(e.truth && e.truth.lat, 6), num(e.truth && e.truth.lon, 6),
      num(e.peak && e.peak.lat, 6), num(e.peak && e.peak.lon, 6),
      num(e.p, 6),
      e.hit50 ? 1 : 0,
      e.hit80 ? 1 : 0,
      num(e.dPeak, 0),
      num(e.dirErr, 0),
      e.n,
    ].map(csvCell).join(','));
    return '\uFEFF' + [head.join(','), ...rows].join('\r\n') + '\r\n';
  }

  /**
   * 记录 + 融合结果 → GeoJSON（WGS-84）
   * @param {Array} records 记录（无需带 Leaflet 图层）
   * @param {Object|null} fusion FUSION.compute 的结果
   * @param {Object} extra {gradient} 可选
   */
  function recordsToGeoJson(records, fusion, extra) {
    const features = [];
    (records || []).forEach((r) => {
      features.push({
        type: 'Feature',
        properties: {
          kind: 'record',
          id: r.id,
          time: isoTime(r.time),
          level: r.level,
          bearing_deg: num(r.bearing, 0),
          wind_speed_ms: num(r.windSpeed, 2),
          wind_stability_R: num(r.windR, 3),
          sigma_deg: num(r.sigmaAng, 0),
          accuracy_m: num(r.accuracy, 1),
          survey_id: r.surveyId == null ? null : r.surveyId,
        },
        geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      });
    });

    if (fusion && !fusion.error) {
      features.push({
        type: 'Feature',
        properties: {
          kind: 'peak',
          probability: Number(fusion.peak.p.toFixed(6)),
          confidence: fusion.confidence,
        },
        geometry: {
          type: 'Point',
          coordinates: [fusion.peak.lon, fusion.peak.lat],
        },
      });
      const b = fusion.region80.bounds;
      if (b) {
        features.push({
          type: 'Feature',
          properties: {
            kind: 'region80_bbox',
            area_m2: Math.round(fusion.region80.area),
            note: '模型 80% 概率区域的外接矩形，不是精确边界',
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [b.minLon, b.minLat], [b.maxLon, b.minLat],
              [b.maxLon, b.maxLat], [b.minLon, b.maxLat],
              [b.minLon, b.minLat],
            ]],
          },
        });
      }
    }

    const g = extra && extra.gradient;
    if (g && g.brg != null && Number.isFinite(g.brg) &&
        Number.isFinite(extra.lat) && Number.isFinite(extra.lon)) {
      features.push({
        type: 'Feature',
        properties: {
          kind: 'smell_gradient',
          bearing_deg: Math.round(g.brg),
          consistency_R: Number(g.R.toFixed(2)),
          pairs: g.pairs,
        },
        geometry: { type: 'Point', coordinates: [extra.lon, extra.lat] },
      });
    }

    return JSON.stringify({
      type: 'FeatureCollection',
      name: 'odor_survey',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
      features,
    }, null, 2);
  }

  return { recordsToCsv, evalsToCsv, recordsToGeoJson };
});
