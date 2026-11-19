'use strict';
/* 导出：CSV / GeoJSON / 评估 CSV */
const assert = require('assert');
const E = require('../js/exporters.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

console.log('exporters tests');

const records = [
  {
    id: 1, time: new Date('2026-11-19T08:00:00Z'), lat: 39.9042, lon: 116.4074,
    level: 4, bearing: 90, windSpeed: 3.2, windR: 0.9, sigmaAng: 27,
    accuracy: 15, surveyId: 123, windSource: 'Open-Meteo',
  },
  {
    id: 2, time: new Date('2026-11-19T08:05:00Z'), lat: 39.908, lon: 116.4074,
    level: 3, bearing: 90, windSpeed: 2.5, windR: null, sigmaAng: 25,
    accuracy: 8, surveyId: null, windSource: '手动,输入',
  },
];

check('记录 CSV：BOM、表头、行数、逗号转义', () => {
  const csv = E.recordsToCsv(records);
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF, 'Excel 需要的 BOM');
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.strictEqual(lines.length, 3);
  assert(lines[0].startsWith('time,lat,lon,level,bearing_deg'));
  assert(lines[1].includes('2026-11-19T08:00:00.000Z'));
  assert(lines[1].includes('39.904200,116.407400'));
  assert(lines[2].includes('"手动,输入"'), '含逗号字段应加引号');
});

check('记录 CSV：空输入只有表头', () => {
  const lines = E.recordsToCsv([]).trim().split('\r\n');
  assert.strictEqual(lines.length, 1);
});

const fusion = {
  error: null,
  peak: { lat: 39.9078, lon: 116.4083, p: 0.0038 },
  confidence: 'medium',
  region80: {
    area: 102188,
    bounds: { minLat: 39.906, maxLat: 39.909, minLon: 116.407, maxLon: 116.41 },
  },
};

check('GeoJSON：记录点 + 峰值 + 80% 外接矩形', () => {
  const gj = JSON.parse(E.recordsToGeoJson(records, fusion));
  assert.strictEqual(gj.type, 'FeatureCollection');
  const kinds = gj.features.map((f) => f.properties.kind);
  assert.strictEqual(kinds.filter((k) => k === 'record').length, 2);
  assert(kinds.includes('peak'));
  assert(kinds.includes('region80_bbox'));
  const p = gj.features.find((f) => f.properties.kind === 'peak');
  assert.deepStrictEqual(p.geometry.coordinates, [116.4083, 39.9078], 'GeoJSON 用 [lon,lat]');
  const poly = gj.features.find((f) => f.properties.kind === 'region80_bbox');
  const ring = poly.geometry.coordinates[0];
  assert.strictEqual(ring.length, 5);
  assert.deepStrictEqual(ring[0], ring[4], '多边形闭合');
});

check('GeoJSON：无融合结果时只导出记录', () => {
  const gj = JSON.parse(E.recordsToGeoJson(records, null));
  assert.strictEqual(gj.features.length, 2);
});

check('评估 CSV：表头与命中字段', () => {
  const csv = E.evalsToCsv([{
    time: new Date('2026-11-19T09:00:00Z'),
    truth: { lat: 39.9079, lon: 116.4083 },
    peak: { lat: 39.9078, lon: 116.4083 },
    p: 0.0038, hit50: true, hit80: true,
    dPeak: 11, dirErr: 3, n: 2,
  }]);
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.strictEqual(lines.length, 2);
  assert(lines[0].includes('in_region80'));
  assert(lines[1].includes(',1,1,'), '两个命中标记为 1');
});

console.log(`exporters tests passed: ${passed} groups`);
