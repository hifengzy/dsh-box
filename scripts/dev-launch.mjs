#!/usr/bin/env node
"use strict";

/**
 * dev-launch.mjs — 品牌化开发启动(npm start)。
 *
 * 问题:dev 模式 `electron .` 跑的是 Electron 本体,macOS 菜单栏左上角
 * 显示的是进程/包名「Electron」—— `app.setName()` 和菜单 label 都改不了它
 * (打包版由 electron-builder 的 productName 生成 CFBundleName,天然正确)。
 *
 * 解决:把 node_modules/electron/dist/Electron.app 克隆一份到
 * `.runtime/dev/DSH Box.app`,用 plutil 把 Info.plist 的
 * CFBundleName / CFBundleDisplayName 改成「DSH Box」、CFBundleIdentifier
 * 改成 com.pixtames.dshbox,再从该副本启动 —— dev 模式菜单栏即显示
 * 「DSH Box」,与打包版一致。
 *
 * 说明:
 *   - 副本按 electron 版本缓存(distro 的 version 文件做标记),只有换版本才重新拷贝;
 *   - 首次拷贝约 1-2 秒(APFS 克隆,之后增量无感);
 *   - 任何一步失败都会回退到原生 `electron .`(菜单栏显示 Electron,功能不受影响);
 *   - 需要调试原始 Electron 环境时用 `npm run start:electron`。
 *
 * 用法: node scripts/dev-launch.mjs [额外参数...](透传给 Electron)
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ELECTRON_DIST = path.join(ROOT, "node_modules", "electron", "dist");
const DIST_APP = path.join(ELECTRON_DIST, "Electron.app");
const DIST_BIN = path.join(DIST_APP, "Contents", "MacOS", "Electron");
const VERSION_FILE = path.join(ELECTRON_DIST, "version");

const TARGET_DIR = path.join(ROOT, ".runtime", "dev");
const TARGET = path.join(TARGET_DIR, "DSH Box.app");
const TARGET_BIN = path.join(TARGET, "Contents", "MacOS", "Electron");
const MARKER = path.join(TARGET_DIR, ".source-version");

/** 当前 electron 版本(缓存标记用) */
function electronVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, "utf8").trim();
  } catch {
    return "unknown";
  }
}

/** 用 plutil 改 Info.plist 的应用名/标识 */
function patchPlist() {
  const plist = path.join(TARGET, "Contents", "Info.plist");
  const patches = [
    ["CFBundleName", "DSH Box"],
    ["CFBundleDisplayName", "DSH Box"],
    ["CFBundleIdentifier", "com.pixtames.dshbox"],
  ];
  for (const [key, value] of patches) {
    const r = spawnSync("plutil", ["-replace", key, "-string", value, plist], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`plutil -replace ${key} 失败: ${(r.stderr || r.stdout || "").trim()}`);
    }
  }
}

/** 克隆 Electron.app → 品牌化副本(ditto 原生拷贝,保留符号链接) */
function cloneApp() {
  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  const r = spawnSync("ditto", [DIST_APP, TARGET], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`ditto 拷贝 Electron.app 失败: ${(r.stderr || r.stdout || "").trim()}`);
  }
}

/** 确保品牌化副本存在且与当前 electron 版本一致 */
function ensureBrandedApp() {
  const version = electronVersion();
  if (
    fs.existsSync(TARGET) &&
    fs.existsSync(MARKER) &&
    fs.readFileSync(MARKER, "utf8").trim() === version
  ) {
    return; // 已有最新副本
  }
  console.log("[dev-launch] 准备品牌化 Electron 副本(首次会拷贝 Electron.app,约 1-2 秒)…");
  cloneApp();
  patchPlist();
  fs.writeFileSync(MARKER, version);
  console.log(`[dev-launch] 品牌化副本就绪: ${TARGET}`);
}

/** 启动 Electron(品牌副本或原生),退出码跟随子进程 */
function launch(bin, label) {
  console.log(`[dev-launch] 启动 ${label}`);
  const child = spawn(bin, [ROOT, ...process.argv.slice(2)], { stdio: "inherit" });
  // Ctrl+C / kill 时把信号转给 Electron,避免留下孤儿进程
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("exit", (code, signal) => {
    process.exit(signal ? 128 + (signal === "SIGINT" ? 2 : 15) : code ?? 0);
  });
  child.on("error", (err) => {
    console.error(`[dev-launch] 启动失败: ${err.message}`);
    process.exit(1);
  });
}

/** 回退:直接跑原生 Electron(菜单栏显示 Electron,功能不受影响) */
function fallbackToPlainElectron() {
  if (!fs.existsSync(DIST_BIN)) {
    console.error(`[dev-launch] 找不到 Electron: ${DIST_BIN} (请先 npm install)`);
    process.exit(1);
  }
  launch(DIST_BIN, "原生 Electron(菜单栏将显示 Electron)");
}

if (process.platform !== "darwin") {
  console.warn("[dev-launch] 品牌化启动仅支持 macOS,回退原生 Electron");
  fallbackToPlainElectron();
} else if (!fs.existsSync(DIST_APP)) {
  console.warn(`[dev-launch] 未找到 ${DIST_APP},回退原生 Electron`);
  fallbackToPlainElectron();
} else {
  try {
    ensureBrandedApp();
    launch(TARGET_BIN, "品牌化 DSH Box(菜单栏显示「DSH Box」)");
  } catch (err) {
    console.warn(`[dev-launch] 品牌化启动失败(${err.message}),回退原生 Electron`);
    fallbackToPlainElectron();
  }
}
