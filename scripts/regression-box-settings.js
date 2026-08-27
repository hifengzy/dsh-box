#!/usr/bin/env node
"use strict";

/**
 * regression-box-settings.js — settings.yaml 文本级读写回归(纯 Node)。
 *
 * 覆盖对抗审查 P1-4 的两个写入者:
 *   - box-settings.writeSettingValue:保留 dsh 配置 / 原子写无 tmp 残留 /
 *     读失败(非 ENOENT)中止 / ENOENT 首建;
 *   - plugin-manager.ensureOpenByDefault:同款语义(原子写 + 读失败中止 +
 *     保留其它配置)。
 *
 * 用法: node scripts/regression-box-settings.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bs = require("../src/main/box-settings.js");
const pm = require("../src/main/plugin-manager.js");

let failed = 0;
const check = (cond, msg) => {
  if (!cond) {
    failed += 1;
    console.error(`FAIL ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
};

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "box-settings-reg-"));
const cleanup = (home) => fs.rmSync(home, { recursive: true, force: true });

// ---------- box-settings ----------
{
  console.log("[1] box-settings.writeSettingValue");
  const home = tmpHome();
  const file = path.join(home, "settings.yaml");
  // 1a. 保留 dsh 侧配置,只改 dsh-box 域
  fs.writeFileSync(file, "host: 0.0.0.0\nport: 3260\ndsh-box:\n  marketSidebarEntry: true\n");
  check(bs.writeSettingValue(home, "marketSidebarEntry", false) === true, "写入返回 true");
  const after = fs.readFileSync(file, "utf8");
  check(after.includes("host: 0.0.0.0") && after.includes("port: 3260"), "dsh 侧配置保留");
  check(after.includes("marketSidebarEntry: false"), "dsh-box 域键已更新");
  // 1b. 原子写:无 tmp 残留
  check(fs.readdirSync(home).filter((f) => f.includes(".tmp")).length === 0, "无 tmp 残留(原子 rename)");
  // 1c. 读失败(目录只读,非 ENOENT)→ 中止写入、返回 false、文件不变
  fs.chmodSync(home, 0o500);
  const before = fs.readFileSync(file, "utf8");
  check(bs.writeSettingValue(home, "statusPanelWidth", 400) === false, "读失败(非 ENOENT)→ 中止返回 false");
  check(fs.readFileSync(file, "utf8") === before, "读失败时文件未被覆盖");
  fs.chmodSync(home, 0o700);
  // 1d. ENOENT 首建(全新目录)
  const home2 = tmpHome();
  check(bs.writeSettingValue(home2, "statusPanelWidth", 400) === true, "ENOENT 首建返回 true");
  check(fs.existsSync(path.join(home2, "settings.yaml")), "ENOENT 首建生成文件");
  cleanup(home);
  cleanup(home2);
}

// ---------- plugin-manager.ensureOpenByDefault ----------
{
  console.log("[2] plugin-manager.ensureOpenByDefault(与 box-settings 同款 P1-4 语义)");
  const home = tmpHome();
  const file = path.join(home, "settings.yaml");
  // 2a. 保留其它配置,只写 dsh-better-sidebar 域
  fs.writeFileSync(file, "host: 0.0.0.0\nport: 3260\ndsh-better-sidebar:\n  openByDefault: false\n");
  check(pm.ensureOpenByDefault(home) === true, "写入返回 true");
  const after = fs.readFileSync(file, "utf8");
  check(after.includes("host: 0.0.0.0") && after.includes("port: 3260"), "其它配置保留");
  check(after.includes("openByDefault: true"), "openByDefault 已置 true");
  // 2b. 原子写无 tmp 残留
  check(fs.readdirSync(home).filter((f) => f.includes(".tmp")).length === 0, "无 tmp 残留(原子 rename)");
  // 2c. 读失败(非 ENOENT)→ 中止写入、返回 false、文件不变
  fs.chmodSync(home, 0o500);
  const before = fs.readFileSync(file, "utf8");
  check(pm.ensureOpenByDefault(home) === false, "读失败(非 ENOENT)→ 中止返回 false");
  check(fs.readFileSync(file, "utf8") === before, "读失败时文件未被覆盖");
  fs.chmodSync(home, 0o700);
  // 2d. ENOENT 首建
  const home2 = tmpHome();
  check(pm.ensureOpenByDefault(home2) === true, "ENOENT 首建返回 true");
  check(fs.existsSync(path.join(home2, "settings.yaml")), "ENOENT 首建生成文件");
  cleanup(home);
  cleanup(home2);
}

if (failed) {
  console.error(`\nFAIL ✗ settings.yaml 读写回归: ${failed} 项失败`);
  process.exit(1);
}
console.log("\nPASS ✓ settings.yaml 读写回归通过(box-settings + plugin-manager 原子写/读失败中止)");
