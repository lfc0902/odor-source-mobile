'use strict';
/* 坐标转换自测：node test/coords.test.js */
const assert = require('assert');
const { wgs84ToGcj02, gcj02ToWgs84, outOfChina } = require('../js/coords.js');

// 1. 参考值（eviltransform 公开用例，上海）
{
  const [gLat, gLon] = wgs84ToGcj02(31.1774276, 121.5272106);
  assert(Math.abs(gLat - 31.17530398364597) < 1e-7, `lat ${gLat}`);
  assert(Math.abs(gLon - 121.531541859215) < 1e-7, `lon ${gLon}`);
}

// 2. 北京偏移量级：纬度 +0.001~0.004°，经度 +0.004~0.008°（约几百米）
{
  const wLat = 39.9042, wLon = 116.4074;
  const [gLat, gLon] = wgs84ToGcj02(wLat, wLon);
  const dLat = gLat - wLat, dLon = gLon - wLon;
  assert(dLat > 0.001 && dLat < 0.004, `dLat=${dLat}`);
  assert(dLon > 0.004 && dLon < 0.008, `dLon=${dLon}`);
}

// 3. 往返精度 < 1e-7°（约 1 厘米级）
{
  for (const [lat, lon] of [
    [39.9042, 116.4074], [31.1774, 121.5272], [23.1291, 113.2644], [45.75, 126.65],
  ]) {
    const [gLat, gLon] = wgs84ToGcj02(lat, lon);
    const [wLat, wLon] = gcj02ToWgs84(gLat, gLon);
    assert(Math.abs(wLat - lat) < 1e-7, `roundtrip lat ${lat}`);
    assert(Math.abs(wLon - lon) < 1e-7, `roundtrip lon ${lon}`);
  }
}

// 4. 境外原样返回
{
  const [lat, lon] = wgs84ToGcj02(48.8566, 2.3522); // 巴黎
  assert(lat === 48.8566 && lon === 2.3522);
  assert(outOfChina(48.8566, 2.3522) === true);
  assert(outOfChina(39.9042, 116.4074) === false);
}

console.log('coords tests passed: 4 groups');
