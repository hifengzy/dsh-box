#!/usr/bin/env node
"use strict";

/**
 * regression-theme-sync.js — 外观主题同步(theme-sync.js)回归(纯 Node)。
 *
 * 背景:曾存在「跟随系统失效」bug——DSH Box 把 dsh「解析后的浅/深」镜像回
 * nativeTheme.themeSource,锁死了 prefers-color-scheme,导致 dsh 前端把
 * system 偏好解析成上一次的选择(选浅就一直浅、选深就一直深)。修复方向:
 * 只同步「偏好」(light/dark/system),system 显式解锁 themeSource。
 *
 * 覆盖:
 *   1. readThemePreference:light/dark/system / 旧式键 / 缺失 / 非法;
 *   2. applyThemePreference:light/dark 锁定 + system 解锁(修复核心)+ 非法
 *      输入不动 + 幂等;
 *   3. watchThemePreference:改临时 settings.yaml → 短间隔内回调新偏好;
 *   4. 停止监听后不再回调。
 *
 * 用法: node scripts/regression-theme-sync.js
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readThemePreference,
  applyThemePreference,
  watchThemePreference,
} = require("../src/main/theme-sync");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-theme-sync-"));
  const settings = path.join(tmp, "settings.yaml");

  // ---------- 1. readThemePreference ----------
  const write = (yaml) => fs.writeFileSync(settings, yaml);
  write("ui-theme:\n  preference: light\n");
  assert.strictEqual(readThemePreference(settings), "light", "light 读取");
  write("ui-theme:\n  preference: dark\n");
  assert.strictEqual(readThemePreference(settings), "dark", "dark 读取");
  write("ui-theme:\n  preference: system\n");
  assert.strictEqual(readThemePreference(settings), "system", "system 读取");
  // 旧式键兼容
  write("settings.theme:\n  preference: dark\n");
  assert.strictEqual(readThemePreference(settings), "dark", "旧式键读取");
  // 缺失 / 非法
  fs.rmSync(settings, { force: true });
  assert.strictEqual(readThemePreference(settings), null, "文件缺失 → null");
  write("ui-theme:\n  preference: halloween\n");
  assert.strictEqual(readThemePreference(settings), null, "非法值 → null");
  write("other: 1\n");
  assert.strictEqual(readThemePreference(settings), null, "无主题键 → null");
  console.log("[1] readThemePreference:light/dark/system/旧式键/缺失/非法 ✓");

  // ---------- 2. applyThemePreference(核心:system 必须能解锁已锁死的 source) ----------
  const mock = { themeSource: "light" }; // mock.themeSource 模拟 user 先选浅色 → 被锁
  assert.strictEqual(applyThemePreference(mock, "dark"), "dark");
  assert.strictEqual(mock.themeSource, "dark", "dark 应锁定 themeSource");
  // system → 解锁回随系统(修复前旧实现永远不会走到这里)
  assert.strictEqual(applyThemePreference(mock, "system"), "system");
  assert.strictEqual(mock.themeSource, "system", "system 应显式写回 themeSource(解锁)");
  // light/dark 正常锁定
  assert.strictEqual(applyThemePreference(mock, "light"), "light");
  assert.strictEqual(mock.themeSource, "light");
  // 未知偏好不动
  assert.strictEqual(applyThemePreference(mock, "blurple"), null);
  assert.strictEqual(mock.themeSource, "light", "非法偏好不应改动 themeSource");
  // 幂等:相同值不反复触发(第二次返回同 preference,不报错)
  assert.strictEqual(applyThemePreference(mock, "light"), "light");
  console.log("[2] applyThemePreference:light/dark 锁定 + system 解锁 + 非法/幂等 ✓");

  // ---------- 3. watchThemePreference:文件变更 → 回调 ----------
  write("ui-theme:\n  preference: system\n");
  const got = [];
  const stop = watchThemePreference(settings, (p) => got.push(p), 50);
  await wait(150); // 等 watchFile 建立基线,清掉可能的初始回调
  got.length = 0;
  write("ui-theme:\n  preference: dark\n");
  await wait(350);
  assert.ok(got.includes("dark"), `文件写入 dark 后应回调,实际 ${JSON.stringify(got)}`);
  write("ui-theme:\n  preference: system\n");
  await wait(350);
  assert.ok(got.includes("system"), `切回 system 应回调,实际 ${JSON.stringify(got)}`);
  console.log("[3] watchThemePreference:settings.yaml 变更 → 短间隔级回调 ✓");

  // ---------- 4. 停止监听 ----------
  stop();
  got.length = 0;
  write("ui-theme:\n  preference: dark\n");
  await wait(350);
  assert.deepStrictEqual(got, [], `停止后不应再回调,实际 ${JSON.stringify(got)}`);
  console.log("[4] 停止监听后不再回调 ✓");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nPASS ✓ 外观主题同步(偏好→themeSource + 文件监听)回归通过");
})().catch((error) => {
  console.error("\nFAIL ✗ 外观主题同步回归:", error.message);
  process.exit(1);
});