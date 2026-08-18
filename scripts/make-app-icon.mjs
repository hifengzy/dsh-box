/**
 * make-app-icon.mjs — 把任意源图制作成符合 macOS 规范的 1024×1024 主图标
 * assets/icon.png,然后由 electron-builder 在打包时自动转成 icns。
 *
 * 依据 macOS 11+ 至今的 Apple HIG(含 macOS 26/27 对第三方 App 的要求):
 *   - 1024×1024,内容缩放到中心安全区(约 824×824 = 80.5%),四周透明边距;
 *   - 无阴影 / 无反射 / 无边框(系统自带);
 *   - 安全边距 electron-builder 不会自动加,必须在图片里做好,本脚本负责这一步。
 *
 * 用法: node scripts/make-app-icon.mjs <源图.png>
 * (需要 sharp 可用;生成产物已提交,本脚本用于日后换 logo 时重新生成)
 */

import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.argv[2];
if (!SRC) {
  console.error("用法: node scripts/make-app-icon.mjs <源图.png>");
  process.exit(1);
}

const SIZE = 1024;
const CONTENT = 824; // 内容安全区(≈80.5%),Apple HIG 网格
const MARGIN = (SIZE - CONTENT) / 2; // 100
// 圆角半径:Apple Big Sur+ 网格中 824 内容区的圆角约 149px(1024 网格约 185px)
const RADIUS = Math.round(CONTENT * 0.181);

const meta = await sharp(SRC).metadata();
console.log(`源图: ${SRC} (${meta.width}x${meta.height})`);

// 1. 找出源图非透明内容边界框,只裁剪内容再缩放 —— 这样无论源图是
//    满幅图还是已带边距的规范图,输出都一致:内容占 824,圆角,边距 100。
const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 0) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) {
  console.error("源图全透明,无法生成图标");
  process.exit(1);
}
const boxW = maxX - minX + 1;
const boxH = maxY - minY + 1;
console.log(`内容边界框: ${boxW}x${boxH} @ (${minX},${minY})`);

const contentBuf = await sharp(SRC)
  .extract({ left: minX, top: minY, width: boxW, height: boxH })
  .resize({ width: CONTENT, height: CONTENT, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

// 2. 给内容套圆角矩形遮罩 —— 关键:macOS 对带透明边距的图标不再自动裁圆角,
//    圆角必须画进图片内容里,否则 Dock 里会显示直角方形。
const maskSvg = Buffer.from(
  `<svg width="${CONTENT}" height="${CONTENT}"><rect x="0" y="0" width="${CONTENT}" height="${CONTENT}" rx="${RADIUS}" ry="${RADIUS}" fill="white"/></svg>`
);
const maskBuf = await sharp(maskSvg).png().toBuffer();
const roundedBuf = await sharp(contentBuf)
  .composite([{ input: maskBuf, blend: "dest-in" }])
  .png()
  .toBuffer();

// 3. 居中合成到 1024 透明画布
const iconBuf = await sharp({
  create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: roundedBuf, left: MARGIN, top: MARGIN }])
  .png()
  .toBuffer();

const iconPng = join(ROOT, "assets", "icon.png");
mkdirSync(dirname(iconPng), { recursive: true });
writeFileSync(iconPng, iconBuf);
console.log(`生成: ${iconPng} (${SIZE}x${SIZE}, 内容 ${CONTENT}x${CONTENT} 圆角 ${RADIUS}px 居中,边距 ${MARGIN}px)`);
console.log("打包时 electron-builder 会自动从此 png 生成全尺寸 icns。");
