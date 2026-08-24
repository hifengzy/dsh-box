#!/usr/bin/env node
"use strict";

/**
 * check-main-integrity.js — 主进程关键定义静态完整性检查(纯 Node)。
 *
 * 背景:曾发生两起「重写误删函数体/残留符号引用」事故——
 *   1) `performPluginInstall` / `performUpgrade` 被整体顶替丢失(只剩 IPC
 *      调用,运行时才 ReferenceError);
 *   2) plugin-manager 参数化后 `ensureOpenByDefault` 内部残留引用已删除的
 *      `PLUGIN_NAME` 常量(安装插件时抛 ReferenceError)。
 * 这里的检查分三层,专门堵这两类洞:
 *   1) main.js 关键函数定义存在;
 *   2) 已删除的常量不得再被源码引用(如 plugin-manager 的 PLUGIN_NAME);
 *   3) 运行时冒烟:真实调起 plugin-manager 的核心函数(临时目录),
 *      确保不会在执行中抛 ReferenceError。
 *
 * 用法: node scripts/check-main-integrity.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAIN = path.resolve(__dirname, "..", "src", "main", "main.js");
const PM = path.resolve(__dirname, "..", "src", "main", "plugin-manager.js");
const DSH_SERVER = path.resolve(__dirname, "..", "src", "main", "dsh-server.js");
const mainSource = fs.readFileSync(MAIN, "utf8");
const pmSource = fs.readFileSync(PM, "utf8");
const dsSource = fs.readFileSync(DSH_SERVER, "utf8");

/** 名字 → 定义形态(函数声明优先) */
const REQUIRED_MAIN = [
  ["performPluginInstall", /(?:async\s+)?function\s+performPluginInstall\s*\(/],
  ["performMarketInstall", /(?:async\s+)?function\s+performMarketInstall\s*\(/],
  ["performUpgrade", /(?:async\s+)?function\s+performUpgrade\s*\(/],
  ["refreshPluginCheck", /(?:async\s+)?function\s+refreshPluginCheck\s*\(/],
  ["refreshMarketCheck", /(?:async\s+)?function\s+refreshMarketCheck\s*\(/],
  ["startServer", /(?:async\s+)?function\s+startServer\s*\(/],
  ["restartServer", /(?:async\s+)?function\s+restartServer\s*\(/],
  ["appDshHome", /function\s+appDshHome\s*\(/],
  ["currentUpdateFlag", /function\s+currentUpdateFlag\s*\(/],
];

/** main.js 必含的关键片段(主题同步 / 通知事件流 / 升级回滚等关键链路) */
const REQUIRED_MAIN_SNIPPETS = [
  ["theme-sync 接入", /require\(["']\.\/theme-sync["']\)/],
  ["notify-watch 接入", /require\(["']\.\/notify-watch["']\)/],
  ["通知设置 IPC", /ipcMain\.handle\(["']dsh:notify-settings["']/],
  ["通知事件流 watcher 启动", /createNotifyWatcher\s*\(/],
  ["升级回滚工具接入", /restoreDshBackup/],
  ["升级启动自愈接入", /healInterruptedUpgrade/],
  ["升级自检(verifyDshBoot)接入", /verifyDshBoot/],
];

/** dsh-server.js 必含片段:禁用 dsh 自动开浏览器(否则每次服务启动/升级重启弹系统浏览器) */
const REQUIRED_DSH_SERVER_SNIPPETS = [
  ["dsh web --no-open", /--no-open/],
];

/** main.js 不得再出现的符号:解析镜像(shell:theme-changed)会把 themeSource
    锁死,导致 dsh「跟随系统」失效(选浅一直浅、选深一直深)——见 theme-sync.js */
const FORBIDDEN_MAIN = ["shell:theme-changed"];

/** plugin-manager 必选导出与残留符号 */
const REQUIRED_PM_EXPORTS = [
  "isManaged",
  "getInstalledVersion",
  "checkPlugin",
  "installPlugin",
  "ensureOpenByDefault",
  "runDshCli",
];
const FORBIDDEN_PM_SYMBOLS = ["PLUGIN_NAME"]; // 参数化后已删除,不得再被引用

let failed = 0;
const fail = (msg) => { console.error(`FAIL ✗ ${msg}`); failed += 1; };

// 1) main.js 关键函数定义
for (const [name, re] of REQUIRED_MAIN) {
  if (!re.test(mainSource)) fail(`main.js 缺少「${name}」的定义(可能有调用但函数体被误删)`);
}
// 1b) main.js 关键片段 + 禁现符号
for (const [name, re] of REQUIRED_MAIN_SNIPPETS) {
  if (!re.test(mainSource)) fail(`main.js 缺少「${name}」`);
}
// 1c) dsh-server 关键片段(升级链路依赖的启动方式)
for (const [name, re] of REQUIRED_DSH_SERVER_SNIPPETS) {
  if (!re.test(dsSource)) fail(`dsh-server.js 缺少「${name}」`);
}
for (const sym of FORBIDDEN_MAIN) {
  if (mainSource.includes(sym)) fail(`main.js 残留已删除符号「${sym}」(解析镜像会锁死主题跟随系统)`);
}

// 2) plugin-manager 残留符号 + 必选导出定义
for (const sym of FORBIDDEN_PM_SYMBOLS) {
  if (new RegExp(`\\b${sym}\\b`).test(pmSource)) fail(`plugin-manager.js 残留已删除符号「${sym}」的引用`);
}
for (const name of REQUIRED_PM_EXPORTS) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const exp = new RegExp(`\\b${name}\\b`);
  if (!re.test(pmSource) || !new RegExp(`module\\.exports[\\s\\S]*\\b${name}\\b`).test(pmSource)) {
    fail(`plugin-manager.js 缺少导出「${name}」`);
  }
}

// 3) 运行时冒烟:真实调用 plugin-manager 核心函数(临时目录),防 ReferenceError 类执行错误
try {
  const pm = require(PM);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-integrity-"));
  for (const name of REQUIRED_PM_EXPORTS) {
    if (typeof pm[name] !== "function") fail(`plugin-manager 导出「${name}」不是函数`);
  }
  // ensureOpenByDefault:真实写入临时 settings.yaml 后能读回(不抛)
  const wrote = pm.ensureOpenByDefault(home);
  const yaml = fs.readFileSync(path.join(home, "settings.yaml"), "utf8");
  if (!wrote || !yaml.includes("dsh-better-sidebar:") || !yaml.includes("openByDefault: true")) {
    fail("plugin-manager.ensureOpenByDefault 写入结果不正确");
  }
  // getInstalledVersion / isManaged:未安装返回 null、托管判断正确
  if (pm.getInstalledVersion(home, "dsh-better-sidebar") !== null) fail("getInstalledVersion 未装应返回 null");
  if (!pm.isManaged("dshmarket") || pm.isManaged("nope")) fail("isManaged 判断错误");
  fs.rmSync(home, { recursive: true, force: true });
} catch (error) {
  fail(`plugin-manager 运行时冒烟抛出异常: ${error.message}`);
}

if (failed === 0) {
  console.log(`PASS ✓ 主进程完整性检查通过(main.js ${REQUIRED_MAIN.length} 项定义 + plugin-manager ${REQUIRED_PM_EXPORTS.length} 项导出/运行时冒烟)`);
} else {
  console.error(`\nFAIL ✗ 主进程完整性检查:${failed} 项缺失`);
  process.exit(1);
}