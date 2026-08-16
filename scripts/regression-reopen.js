#!/usr/bin/env node
"use strict";

/**
 * regression-reopen.js — ISSUE-001 回归测试(真实 main.js 驱动):
 * 关窗后 activate(点 Dock)重开的窗口必须直接加载 WebUI,
 * 且注入(custom.css / pointer 防抖 / 主题同步)随窗口生效。
 *
 * 用法: electron scripts/regression-reopen.js --no-sandbox
 */

const fs = require("node:fs");
const path = require("node:path");
const RUNTIME = path.resolve(__dirname, "..", ".runtime", "regression");
fs.mkdirSync(RUNTIME, { recursive: true });

process.env.DSH_USER_DATA = path.join(RUNTIME, "reopen-user");
process.env.DSH_HOME = path.join(RUNTIME, "reopen-home");
process.env.DSH_APP_PORT = "3301";
process.env.DSH_LOCK_PATH = path.join(RUNTIME, "reopen-lock");

const { app, BrowserWindow, webContents } = require("electron");

// Regression: ISSUE-001 — 注入与导航只绑在第一个窗口,关窗重开卡加载页
// Found by /qa on 2026-08-16
// Report: .gstack/qa-reports/qa-report-dsh-desktop-2026-08-16.md

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
require(path.join(__dirname, "..", "src", "main", "main.js"));

const views = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
const findWebUI = () => views().find((wc) => /^http:\/\/127\.0\.0\.1:3301/.test(wc.getURL()));

app.whenReady().then(async () => {
  try {
    // 1. 首次窗口加载 WebUI 且注入生效
    let cv1 = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      cv1 = findWebUI();
      if (cv1) {
        const g = await cv1.executeJavaScript("!!window.__dshDesktopPointerGuard", true).catch(() => false);
        if (g) break;
      }
    }
    if (!cv1) throw new Error("首次窗口未加载 WebUI");
    const id1 = cv1.id;
    console.log(`[1] 首次窗口 WebUI 就绪 (view id=${id1})`);

    // 2. 关闭窗口(macOS 惯例:关窗不退出 App)
    BrowserWindow.getAllWindows()[0].close();
    await sleep(2500);

    // 3. 模拟点 Dock 图标 → activate 事件
    app.emit("activate");
    await sleep(3000);

    // 4. 找到新窗口的内容视图(id != id1)并断言
    let cv2 = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      cv2 = views().find((wc) => wc.id !== id1 && /^http:\/\/127\.0\.0\.1:3301/.test(wc.getURL()));
      if (cv2) {
        const g = await cv2.executeJavaScript("!!window.__dshDesktopPointerGuard", true).catch(() => false);
        if (g) break;
      }
    }
    if (!cv2) throw new Error("重开窗口未加载 WebUI(仍卡加载页?)");
    const guard = await cv2.executeJavaScript("!!window.__dshDesktopPointerGuard", true);
    const theme = await cv2.executeJavaScript("!!window.__dshDesktopThemeWatcher", true);
    const url = cv2.getURL();
    console.log(`[4] 重开窗口 url=${url} pointerGuard=${guard} themeWatcher=${theme}`);
    if (!/^http:\/\/127\.0\.0\.1:3301/.test(url)) throw new Error("重开窗口没有加载 WebUI");
    if (!guard || !theme) throw new Error("重开窗口缺少注入(pointerGuard/themeWatcher)");
    console.log("\nPASS ✓ ISSUE-001 回归:关窗重开加载 WebUI,注入生效");
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ ISSUE-001 回归:", err.message);
    app.exit(1);
  }
});
