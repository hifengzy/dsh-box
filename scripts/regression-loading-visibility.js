#!/usr/bin/env node
"use strict";

/**
 * regression-loading-visibility.js — ISSUE-002 回归测试(真实 Electron 渲染):
 * 加载页的 #loading / #error / #retryBtn 必须遵守 hidden 属性,
 * 「服务启动失败」不能与加载动画同时可见。
 *
 * 用法: electron scripts/regression-loading-visibility.js --no-sandbox
 */

const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const os = require("node:os");

// Regression: ISSUE-002 — .error/.loading 的 display 覆盖了 [hidden],错误常显
// Found by /qa on 2026-08-16
// Report: .gstack/qa-reports/qa-report-dsh-desktop-2026-08-16.md

app.setPath("userData", path.join(os.tmpdir(), "dsh-desktop-regression-loading-visibility"));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const readState = () =>
    js(`(() => {
      const g = (el) => ({ hiddenAttr: el.hasAttribute('hidden'), display: getComputedStyle(el).display });
      return {
        loading: g(document.getElementById('loading')),
        error: g(document.getElementById('error')),
        retry: g(document.getElementById('retryBtn')),
      };
    })()`);

  // 初始状态(与 index.html 的 hidden 属性一致):loading 可见,error/retry 隐藏
  const init = await readState();
  const initOk =
    init.loading.display === "flex" &&
    init.error.display === "none" &&
    init.retry.display === "none";
  console.log("初始状态:", JSON.stringify(init), initOk ? "✓" : "✗");

  // 错误状态(renderer.js showError 的等价操作):error 可见,loading 隐藏
  await js(`(() => {
    document.getElementById('error').hidden = false;
    document.getElementById('loading').hidden = true;
    document.getElementById('retryBtn').hidden = false;
  })()`);
  await sleep(200);
  const err = await readState();
  const errOk = err.error.display === "flex" && err.loading.display === "none" && err.retry.display === "block";
  console.log("错误状态:", JSON.stringify(err), errOk ? "✓" : "✗");

  // 加载状态(showLoading 的等价操作):loading 可见,error/retry 隐藏
  await js(`(() => {
    document.getElementById('error').hidden = true;
    document.getElementById('loading').hidden = false;
    document.getElementById('retryBtn').hidden = true;
  })()`);
  await sleep(200);
  const load = await readState();
  const loadOk = load.loading.display === "flex" && load.error.display === "none" && load.retry.display === "none";
  console.log("加载状态:", JSON.stringify(load), loadOk ? "✓" : "✗");

  const pass = initOk && errOk && loadOk;
  console.log(pass ? "\nPASS ✓ ISSUE-002 回归:hidden 可见性契约正常" : "\nFAIL ✗ hidden 契约被破坏");
  app.exit(pass ? 0 : 1);
});
