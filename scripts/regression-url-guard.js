#!/usr/bin/env node
"use strict";

/**
 * regression-url-guard.js — ISSUE-004 回归测试(纯 Node,无需 Electron):
 * URL 信任边界必须精确比对 origin,堵住 userinfo / 端口前缀绕过。
 *
 * 用法: node scripts/regression-url-guard.js
 */

const assert = require("node:assert");
const { isServerOrigin, isTrustedOrigin, isAppFilePage } = require("../src/main/url-guard");

// Regression: ISSUE-004 — URL 信任边界用前缀匹配,userinfo/端口前缀可绕过
// Found by /qa on 2026-08-16
// Report: .gstack/qa-reports/qa-report-dsh-desktop-2026-08-16.md

const SERVER = "http://127.0.0.1:3260";

const cases = [
  // [输入, 期望的 isServerOrigin]
  ["http://127.0.0.1:3260/", true],               // 正常同源
  ["http://127.0.0.1:3260/foo?x=1#y", true],       // 同源 + 路径/查询/哈希
  ["http://127.0.0.1:3260@evil.com/", false],      // userinfo 欺骗(必须拦截)
  ["http://127.0.0.1:32600/", false],              // 端口前缀混淆(必须拦截)
  ["http://127.0.0.1:3261/", false],               // 不同端口
  ["http://localhost:3260/", false],               // 不同主机名(origin 不同)
  ["https://127.0.0.1:3260/", false],              // 不同协议
  ["https://evil.com/", false],                    // 外部站点
  ["not-a-url", false],                            // 非法 URL
];

for (const [input, expected] of cases) {
  const actual = isServerOrigin(input, SERVER);
  assert.strictEqual(actual, expected, `isServerOrigin(${input}) 应为 ${expected},实际 ${actual}`);
  console.log(`  ok isServerOrigin(${JSON.stringify(input)}) = ${actual}`);
}

// isTrustedOrigin:file:// 页面始终可信;其余必须精确匹配服务 origin
assert.strictEqual(isTrustedOrigin("file:///app/renderer/index.html", SERVER), true);
assert.strictEqual(isTrustedOrigin("file:///app/renderer/topbar.html", SERVER), true);
assert.strictEqual(isTrustedOrigin(SERVER, SERVER), true);
assert.strictEqual(isTrustedOrigin("http://127.0.0.1:3260@evil.com/", SERVER), false);
assert.strictEqual(isTrustedOrigin("http://127.0.0.1:32600/", SERVER), false);
assert.strictEqual(isTrustedOrigin("", SERVER), false);

assert.strictEqual(isAppFilePage("file:///x"), true);
assert.strictEqual(isAppFilePage("http://127.0.0.1:3260/"), false);

console.log("\nPASS ✓ ISSUE-004 回归:URL 信任边界精确匹配");
process.exit(0);
