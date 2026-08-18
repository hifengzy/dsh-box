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

const meta = await sharp(SRC).metadata();
console.log(`源图: ${SRC} (${meta.width}x${meta.height})`);

// 内容缩放进安全区并居中合成到 1024 透明画布
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
console.log("打包时 electron-builder 会自动从此 png 生成全尺寸 icns。");
