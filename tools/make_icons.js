'use strict';
/* 生成 PWA 图标（无第三方依赖）：node tools/make_icons.js */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');
fs.mkdirSync(OUT, { recursive: true });

/* ---------- 基础颜色 ---------- */
const BG = [15, 23, 42];
const SKY = [56, 189, 248];

function blend(dst, src, a) {
  dst[0] = Math.round(src[0] * a + dst[0] * (1 - a));
  dst[1] = Math.round(src[1] * a + dst[1] * (1 - a));
  dst[2] = Math.round(src[2] * a + dst[2] * (1 - a));
}

/* ---------- 在 512 设计空间中判断每个采样点 ---------- */
function sampleAt(dx, dy) {
  const px = [BG[0], BG[1], BG[2]];

  // 上风向扇形：中心 (256,352)，半径 200，半角 30°
  const cx = 256, cy = 352, R = 200, HALF = 30;
  const rx = dx - cx, ry = dy - cy;
  const r = Math.hypot(rx, ry);
  let phi = (Math.atan2(rx, -ry) * 180) / Math.PI; // 0=正北，顺时针

  const inWedge = r <= R && Math.abs(phi) <= HALF;
  if (inWedge) blend(px, SKY, 0.45);

  // 扇形描边
  const outerArc = Math.abs(r - R) <= 4 && Math.abs(phi) <= HALF;
  const radial = r <= R && r > 10 &&
    Math.min(Math.abs(phi - HALF), Math.abs(phi + HALF)) <= (4 / r) * (180 / Math.PI);
  if (outerArc || radial) {
    px[0] = SKY[0]; px[1] = SKY[1]; px[2] = SKY[2];
  }

  // 估算位置虚线圆：中心 (256,218)，半径 46
  const dcx = 256, dcy = 218, dr = 46;
  const rr = Math.hypot(dx - dcx, dy - dcy);
  let dphi = (Math.atan2(dx - dcx, -(dy - dcy)) * 180) / Math.PI;
  dphi = ((dphi % 360) + 360) % 360;
  if (Math.abs(rr - dr) <= 3.5 && (dphi % 20) < 12) {
    px[0] = SKY[0]; px[1] = SKY[1]; px[2] = SKY[2];
  }

  // 观测点：白圈 + 蓝心
  if (r <= 30) { px[0] = 255; px[1] = 255; px[2] = 255; }
  if (r <= 18) { px[0] = SKY[0]; px[1] = SKY[1]; px[2] = SKY[2]; }

  return px;
}

/* ---------- 渲染（4x 超采样抗锯齿） ---------- */
const SS = 4;
function render(size, motifScale = 1) {
  const R = size * SS;
  const K = (R / 512) * motifScale;
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0, sg = 0, sb = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const pxr = x * SS + sx + 0.5;
          const pyr = y * SS + sy + 0.5;
          const dx = (pxr - R / 2) / K + 256;
          const dy = (pyr - R / 2) / K + 256;
          const c = sampleAt(dx, dy);
          sr += c[0]; sg += c[1]; sb += c[2];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      buf[o] = Math.round(sr / n);
      buf[o + 1] = Math.round(sg / n);
      buf[o + 2] = Math.round(sb / n);
      buf[o + 3] = 255;
    }
  }
  return buf;
}

/* ---------- 最小 PNG 编码器 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 输出 ---------- */
function save(name, size, motifScale) {
  const png = encodePNG(size, size, render(size, motifScale));
  const p = path.join(OUT, name);
  fs.writeFileSync(p, png);
  console.log(`${name}: ${size}x${size}, ${png.length} bytes`);
}

save('icon-512.png', 512, 1);
save('icon-192.png', 192, 1);
save('icon-180.png', 180, 1);
save('icon-maskable-512.png', 512, 0.78);
