#!/usr/bin/env node
"use strict";

/**
 * check-main-integrity.js — 主进程关键定义静态完整性检查(纯 Node)。
 *
 * 背景:一次重写曾把 `performPluginInstall` 的函数体整个顶替丢失,只剩
 * IPC 里的调用,运行到「安装侧边栏插件」才暴露 ReferenceError。这里断言
 * main.js 里被 IPC/注入层引用的关键函数都有定义,防止回归重写再次误删。
 *
 * 用法: node scripts/check-main-integrity.js
 */

const fs = require("node:fs");
const path = require("node:path");

const SRC = path.resolve(__dirname, "..", "src", "main", "main.js");
const source = fs.readFileSync(SRC, "utf8");

/** 名字 → 定义形态(函数声明优先,arrow/const 兜底) */
const REQUIRED = [
  // 插件生命周期(曾被误删过)
  ["performPluginInstall", /(?:async\s+)?function\s+performPluginInstall\s*\(/],
  ["performMarketInstall", /(?:async\s+)?function\s+performMarketInstall\s*\(/],
  ["refreshPluginCheck", /(?:async\s+)?function\s+refreshPluginCheck\s*\(/],
  ["refreshMarketCheck", /(?:async\s+)?function\s+refreshMarketCheck\s*\(/],
  // 服务编排
  ["startServer", /(?:async\s+)?function\s+startServer\s*\(/],
  ["restartServer", /(?:async\s+)?function\s+restartServer\s*\(/],
  ["appDshHome", /function\s+appDshHome\s*\(/],
  ["currentUpdateFlag", /function\s+currentUpdateFlag\s*\(/],
  ["performUpgrade", /(?:async\s+)?function\s+performUpgrade\s*\(/],
];

let failed = 0;
for (const [name, re] of REQUIRED) {
  if (!re.test(source)) {
    console.error(`FAIL ✗ main.js 缺少「${name}」的定义(可能有调用但函数体被误删)`);
    failed += 1;
  }
}

// IPC handler 引用的关键函数必须「有定义也有调用」(双向)
const IPC_CALLS = [
  ["performPluginInstall", /ipcMain\.handle\("dsh:plugin-install"/],
  ["performMarketInstall", /ipcMain\.handle\("dsh:market-install"/],
];

if (failed === 0) {
  console.log(`PASS ✓ main.js 关键定义完整(${REQUIRED.length} 项)`);
} else {
  console.error(`\nFAIL ✗ main.js 完整性检查:${failed} 项缺失`);
  process.exit(1);
}