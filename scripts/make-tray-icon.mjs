/**
 * make-tray-icon.mjs — 从 App 主图标生成 macOS 菜单栏(状态栏)模板图标:
 *   assets/trayTemplate.png     16×16 (@1x)
 *   assets/trayTemplate@2x.png  32×32 (@2x, Retina 屏)
 *
 * 菜单栏图标规范:
 *   - 模板图(template image):系统只读取 alpha 通道的形状,RGB 任意(惯例纯黑);
 *     macOS 会按菜单栏当前深浅色自动渲染成黑色/白色,无需准备两套图标;
 *   - 尺寸:@1x 16×16、@2x 32×32(Electron 的 nativeImage 会自动加载 @2x 变体);
 *   - 内容顶满画布:实测留边距(14/16)会让图标比系统/其他 App 的菜单栏
 *     图标明显偏小,顶满 16px 视觉才一致(系统图标普遍接近顶满)。
 *
 * 用法: node scripts/make-tray-icon.mjs [源图.png, 默认 assets/icon.png]
 * 产物已提交,本脚本用于日后换图标时重新生成。
 */

import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.argv[2] || join(ROOT, "assets", "icon.png");

const SIZE = 16; // @1x 画布
const CONTENT = SIZE; // 内容顶满画布(与系统菜单栏图标视觉一致)
const MARGIN = (SIZE - CONTENT) / 2;

const meta = await sharp(SRC).metadata();
console.log(`源图: ${SRC} (${meta.width}x${meta.height})`);

// 1. 找出非透明内容边界框,只裁剪内容再缩放 —— 与 make-app-icon 同一逻辑,
//    源图无论满幅还是已带边距,输出都一致。
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
  console.error("源图全透明,无法生成菜单栏图标");
  process.exit(1);
}
const boxW = maxX - minX + 1;
const boxH = maxY - minY + 1;
console.log(`内容边界框: ${boxW}x${boxH} @ (${minX},${minY})`);

// 2. 内容着色为纯黑(模板图惯例;系统只取 alpha,RGB 无关紧要)
const blackShape = await sharp(SRC)
  .extract({ left: minX, top: minY, width: boxW, height: boxH })
  .tint({ r: 0, g: 0, b: 0 })
  .png()
  .toBuffer();

// 3. 按 @1x/@2x 缩放并居中合成到透明画布
for (const scale of [1, 2]) {
  const size = SIZE * scale;
  const contentSize = CONTENT * scale;
  const contentBuf = await sharp(blackShape)
    .resize({
      width: contentSize,
      height: contentSize,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const buf = await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: contentBuf, left: MARGIN * scale, top: MARGIN * scale }])
    .png()
    .toBuffer();
  const name = scale === 1 ? "trayTemplate.png" : "trayTemplate@2x.png";
  writeFileSync(join(ROOT, "assets", name), buf);
  console.log(`生成: assets/${name} (${size}x${size}, 内容 ${contentSize}x${contentSize} 居中, 边距 ${MARGIN * scale}px)`);
}
console.log("运行时用 nativeImage.setTemplateImage(true) 即可让系统按深浅色菜单栏自动渲染。");
