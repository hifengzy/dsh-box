#!/usr/bin/env node
"use strict";

/**
 * fetch-bundled-runtime.mjs — 拉取内置 Node 运行时(需求 3 的「内置兜底」物)。
 *
 * 产物:assets/runtime/<平台>-<架构>/node/
 *   bin/node(+ npx)、lib/node_modules/npm(官方 Node 发行自带)
 *   bin/pnpm(从 npm registry 拉 pnpm 包,提取 bin/pnpm.js + 生成 shim)
 *
 * 用途:干净机器(无 Node/npm/pnpm)上升级 dsh、装插件时兜底工具链;
 * 打包时由 electron-builder extraResources 把 assets/runtime 拷进
 * Resources/runtime(main.js 的 defaultBundledRuntimeDir 据此定位)。
 * 体积大(单平台 ~50MB),产物不入 git(见 .gitignore)。
 *
 * 用法:
 *   node scripts/fetch-bundled-runtime.mjs            # 当前平台/架构
 *   node scripts/fetch-bundled-runtime.mjs --all      # darwin-arm64 + darwin-x64 + win32-x64
 *   PNPM_VERSION=9.x.y node scripts/fetch-bundled-runtime.mjs   # 指定 pnpm 版本
 *
 * 依赖网络(官方 nodejs.org + registry.npmjs.org);可重复执行(断点续期:已存在
 * 且完整标记的跳过)。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOT = path.join(ROOT, "assets", "runtime");

// 官方 Node 发行(仅 arm64 mac / x64 mac / x64 win 三个目标;按需扩展)
const NODE_VERSION = process.env.NODE_VERSION || "22.14.0";
const PNPM_VERSION = process.env.PNPM_VERSION || "9.15.5";

const TARGETS = {
  "darwin-arm64": {
    url: (v) => `https://nodejs.org/dist/v${v}/node-v${v}-darwin-arm64.tar.gz`,
    archiveDir: (v) => `node-v${v}-darwin-arm64`,
    nodeBin: "bin/node",
  },
  "darwin-x64": {
    url: (v) => `https://nodejs.org/dist/v${v}/node-v${v}-darwin-x64.tar.gz`,
    archiveDir: (v) => `node-v${v}-darwin-x64`,
    nodeBin: "bin/node",
  },
  "win32-x64": {
    url: (v) => `https://nodejs.org/dist/v${v}/node-v${v}-win-x64.zip`,
    archiveDir: (v) => `node-v${v}-win-x64`,
    nodeBin: "node.exe",
  },
};

const task = (msg) => console.log(`[runtime] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 下载到临时文件;支持重试 */
async function downloadTo(url, dest) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (error) {
      task(`下载失败(${attempt}/3): ${url} → ${error.message};稍后重试`);
      if (attempt === 3) throw error;
      await sleep(2_000 * attempt);
    }
  }
}

/** pnpm 不需要解 tar:registry tarball 里 bin/pnpm.cjs 可直接当 Node 脚本跑 */
async function fetchPnpm(binDir, isWin) {
  const tarballUrl = `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`;
  const tmp = path.join(RUNTIME_ROOT, `.tmp-pnpm-${PNPM_VERSION}.tgz`);
  task(`拉取 pnpm@${PNPM_VERSION}: ${tarballUrl}`);
  await downloadTo(tarballUrl, tmp);
  fs.mkdirSync(binDir, { recursive: true });
  // 用系统 node(dev 机必有)解 tar 提取 bin/pnpm.cjs
  const { execFileSync } = await import("node:child_process");
  const stage = path.join(RUNTIME_ROOT, `.tmp-pnpm-extract`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage);
  execFileSync("tar", ["-xzf", tmp, "-C", stage], { stdio: "ignore" });
  const cli = path.join(stage, "package", "bin", "pnpm.cjs");
  const dest = path.join(binDir, isWin ? "pnpm.cjs" : "pnpm.js");
  fs.copyFileSync(cli, dest);
  const shim = isWin ? "pnpm.cmd" : "pnpm";
  const shimPath = path.join(binDir, shim);
  if (isWin) {
    fs.writeFileSync(
      shimPath,
      `@echo off\r\n"%~dp0node.exe" "%~dp0pnpm.cjs" %*\r\n`
    );
  } else {
    fs.writeFileSync(shimPath, `#!/usr/bin/env sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/pnpm.js" "$@"\n`);
    fs.chmodSync(shimPath, 0o755);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(stage, { recursive: true, force: true });
  task(`pnpm@${PNPM_VERSION} → ${shimPath}`);
}

async function buildTarget(key) {
  const spec = TARGETS[key];
  if (!spec) throw new Error(`未知目标: ${key}(可用: ${Object.keys(TARGETS).join(", ")})`);
  const destRoot = path.join(RUNTIME_ROOT, key, "node");
  const marker = path.join(destRoot, ".complete");
  if (fs.existsSync(marker)) {
    task(`跳过 ${key}:已在(${destRoot})`);
    return destRoot;
  }
  const isWin = key.startsWith("win32");
  task(`构建 ${key}(node v${NODE_VERSION} + pnpm v${PNPM_VERSION})`);

  const url = spec.url(NODE_VERSION);
  const archive = path.join(RUNTIME_ROOT, `.tmp-${key}${isWin ? ".zip" : ".tar.gz"}`);
  task(`下载 Node: ${url}`);
  await downloadTo(url, archive);

  const stage = path.join(RUNTIME_ROOT, `.tmp-${key}-extract`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage);
  if (isWin) {
    const { execFileSync } = await import("node:child_process");
    execFileSync("ditto", ["-x", "-k", archive, stage], { stdio: "ignore" });
  } else {
    const { execFileSync } = await import("node:child_process");
    execFileSync("tar", ["-xzf", archive, "-C", stage], { stdio: "ignore" });
  }
  const src = path.join(stage, spec.archiveDir(NODE_VERSION));
  if (!fs.existsSync(path.join(src, spec.nodeBin))) throw new Error(`解压后缺少 ${spec.nodeBin}`);
  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destRoot), { recursive: true });
  fs.renameSync(src, destRoot);
  // 去掉官方发行里我们不需要的(节空间不强制,保留即可)

  task(`拉取 pnpm 到 ${key}/node/bin`);
  await fetchPnpm(path.join(destRoot, "bin"), isWin);

  fs.rmSync(archive, { force: true });
  fs.rmSync(stage, { recursive: true, force: true });
  fs.writeFileSync(marker, `node v${NODE_VERSION} + pnpm v${PNPM_VERSION}\n`);
  task(`完成 ${key} → ${destRoot}`);
  return destRoot;
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const keys = all ? Object.keys(TARGETS) : [`${process.platform}-${process.arch}`];
if (!all && !TARGETS[keys[0]]) {
  console.error(`[runtime] 当前平台 ${keys[0]} 不在受支持列表: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

for (const key of keys) {
  try {
    await buildTarget(key);
  } catch (error) {
    console.error(`[runtime] 构建 ${key} 失败:`, error.message);
    process.exitCode = 1;
  }
}
if (process.exitCode) process.exit(process.exitCode);
task(`全部完成 → ${RUNTIME_ROOT}`);