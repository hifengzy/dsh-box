/**
 * make-app-icon.mjs — 把源 logo 制作成符合 macOS 规范的 App 主图标。
 *
 * 依据 macOS 11+ 至今的 Apple HIG(含 macOS 26/27 对第三方 App 的要求,
 * Tahoe 的自由形状图标是 Apple 系统级样式,第三方仍用标准圆角矩形):
 *   - 源图 1024×1024,内容缩放到中心安全区(约 824×824 = 80.5%),四周透明边距;
 *   - 无阴影 / 无反射 / 无边框(系统自带);
 *   - 输出 assets/icon.png(1024) 与 assets/icon.icns(16→1024 全尺寸)。
 *
 * 用法: node scripts/make-app-icon.mjs <源图.png>
 * (需要 sharp 可用;生成产物已提交,本脚本用于日后换 logo 时重新生成)
 */

import sharp from "sharp";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.argv[2];
if (!SRC) {
  console.error("用法: node scripts/make-app-icon.mjs <源图.png>");
  process.exit(1);
}

const SIZE = 1024;
const CONTENT = 824; // 内容安全区(≈80.5%),Apple HIG 网格
const MARGIN = (SIZE - CONTENT) / 2; // 100
const ICONSET = join(ROOT, ".runtime", "icon.iconset");

// 1. 读取源图信息
const meta = await sharp(SRC).metadata();
console.log(`源图: ${SRC} (${meta.width}x${meta.height})`);

// 2. 内容缩放进安全区并居中合成到 1024 透明画布
const contentBuf = await sharp(SRC)
  .resize({ width: CONTENT, height: CONTENT, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();
const iconBuf = await sharp({
  create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: contentBuf, left: MARGIN, top: MARGIN }])
  .png()
  .toBuffer();

const iconPng = join(ROOT, "assets", "icon.png");
mkdirSync(dirname(iconPng), { recursive: true });
writeFileSync(iconPng, iconBuf);
console.log(`生成: ${iconPng} (${SIZE}x${SIZE}, 内容 ${CONTENT}x${CONTENT} 居中,边距 ${MARGIN}px)`);

// 3. 生成 iconset 全尺寸并打包 icns
const entries = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];
rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });
for (const [name, px] of entries) {
  const buf = await sharp(iconBuf).resize(px, px).png().toBuffer();
  writeFileSync(join(ICONSET, name), buf);
}
const icns = join(ROOT, "assets", "icon.icns");
execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", icns]);
rmSync(ICONSET, { recursive: true, force: true });
console.log(`生成: ${icns} (${entries.length} 个尺寸)`);
