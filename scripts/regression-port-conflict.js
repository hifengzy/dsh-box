#!/usr/bin/env node
"use strict";

/**
 * regression-port-conflict.js — ISSUE-003 回归测试(真实 main.js 驱动):
 * 端口被非 dsh 的本地服务占用时,健康检查必须识破假服务:
 * 不广播就绪、不把假服务页面当 WebUI 加载,并进入错误状态。
 *
 * 用法: electron scripts/regression-port-conflict.js --no-sandbox
 */

const http = require("node:http");
const fs = require("node:fs");
const { app, webContents } = require("electron");
const path = require("node:path");

// Regression: ISSUE-003 — 健康检查命中端口上任意 2xx 服务即误判就绪
// Found by /qa on 2026-08-16
// Report: .gstack/qa-reports/qa-report-dsh-box-2026-08-16.md

const RUNTIME = path.resolve(__dirname, "..", ".runtime", "regression");
fs.mkdirSync(RUNTIME, { recursive: true });

const PORT = 3302;
process.env.DSH_USER_DATA = path.join(RUNTIME, "port-user");
process.env.DSH_HOME = path.join(RUNTIME, "port-home");
process.env.DSH_APP_PORT = String(PORT);
process.env.DSH_LOCK_PATH = path.join(RUNTIME, "port-lock");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假服务:先占住端口(非 dsh,首页不带 __DSH_BOOT__)
const fake = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body>FAKE_SERVICE_MARKER 这是别的服务</body></html>");
});
const fakeReady = new Promise((resolve) => fake.once("listening", resolve));
fake.listen(PORT, "127.0.0.1");

const views = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());

// 先注册我们的 whenReady,再 require main.js(它的 whenReady 之后执行)
app.whenReady().then(async () => {
  try {
    // 确认假服务已监听
    await fakeReady;

    // 等 App 走完启动流程(假服务会让 dsh 子进程 EADDRINUSE 退出)
    await sleep(12000);

    // 断言 1:任何内容视图都不能加载假服务页面
    const fakeViews = views().filter((wc) => wc.getURL().startsWith(`http://127.0.0.1:${PORT}`));
    console.log(`[1] 加载了假服务页面的视图数 = ${fakeViews.length}(应为 0)`);
    if (fakeViews.length > 0) {
      const body = await fakeViews[0].executeJavaScript("document.body ? document.body.innerText : ''", true).catch(() => "");
      throw new Error(`误把假服务当 WebUI 加载,页面内容: ${body.slice(0, 60)}`);
    }

    // 断言 2:加载页处于错误状态(错误详情非空)
    let errorShown = false;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const loadingView = views().find((wc) => wc.getURL().includes("index.html"));
      if (loadingView) {
        const detail = await loadingView
          .executeJavaScript("document.getElementById('errorDetail') ? document.getElementById('errorDetail').textContent : ''", true)
          .catch(() => "");
        if (detail && detail.trim()) { errorShown = true; break; }
      }
    }
    console.log(`[2] 加载页显示错误详情 = ${errorShown}(应为 true)`);
    if (!errorShown) throw new Error("端口被占用时加载页没有进入错误状态");

    console.log("\nPASS ✓ ISSUE-003 回归:端口被占用时不误判就绪、不加载假服务、进入错误状态");
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ ISSUE-003 回归:", err.message);
    app.exit(1);
  }
});

require(path.join(__dirname, "..", "src", "main", "main.js"));
