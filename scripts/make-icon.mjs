/**
 * make-icon.mjs — 生成应用图标占位图 assets/icon.png (1024x1024)。
 *
 * 纯 Node 实现(不依赖第三方库):直接编码 PNG。
 * 图案:深色圆角方块背景 + 蓝色圆环 + 右下角圆点,先占位,
 * 之后可以用 Figma / Sketch 出正式图标替换此文件。
 *
 * 用法: npm run make-icon
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "icon.png");

const BG_TOP = [31, 41, 55]; // #1f2937
const BG_BOTTOM = [17, 24, 39]; // #111827
const ACCENT = [77, 107, 254]; // #4d6bfe
const CORNER = 200; // 圆角半径

/** 判断点 (x,y) 是否落在圆角矩形内 */
function inRoundedRect(x, y, size, radius) {
  const x0 = radius, y0 = radius, x1 = size - radius, y1 = size - radius;
  if (x >= x0 && x <= x1) return y >= 0 && y < size;
  if (y >= y0 && y <= y1) return x >= 0 && x < size;
  const dx = x < x0 ? x0 - x : x - x1;
  const dy = y < y0 ? y0 - y : y - y1;
  return dx * dx + dy * dy <= radius * radius;
}

/** 圆环内判断 */
function inRing(x, y, cx, cy, outer, inner) {
  const d2 = (x - cx) ** 2 + (y - cy) ** 2;
  return d2 <= outer ** 2 && d2 >= inner ** 2;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));

for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const i = rowStart + 1 + x * 4;
    if (!inRoundedRect(x, y, SIZE, CORNER)) {
      raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 0; raw[i + 3] = 0; // 透明
      continue;
    }
    const t = y / SIZE;
    let r = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t;
    let g = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t;
    let b = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t;

    const cx = SIZE / 2, cy = SIZE / 2;
    if (inRing(x, y, cx, cy, 240, 196)) {
      r = ACCENT[0]; g = ACCENT[1]; b = ACCENT[2];
    }
    if ((x - cx - 60) ** 2 + (y - cy - 60) ** 2 <= 64 ** 2) {
      r = ACCENT[0]; g = ACCENT[1]; b = ACCENT[2];
    }
    raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
  }
}

// ---- PNG 编码 ----
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  let crc = 0xffffffff;
  for (const buf of [typeBuf, data]) {
    for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// compression/filter/interlace = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`已生成图标: ${OUT} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(0)} KB)`);
