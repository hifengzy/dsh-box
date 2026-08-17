#!/usr/bin/env node
"use strict";

/**
 * regression-crash-feedback.js — ISSUE-005 回归测试(真实 main.js 驱动):
 * dsh 子进程运行中崩溃时,App 必须把内容视图切回加载页并展示错误,
 * 点「重试」后服务重启并重新加载 WebUI。
 *
 * 用法: electron scripts/regression-crash-feedback.js --no-sandbox
 */

const { app, webContents } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

// Regression: ISSUE-005 — 崩溃时错误只广播给加载页,用户面对死页面无反馈
// Found by /qa on 2026-08-16
// Report: .gstack/qa-reports/qa-report-dsh-box-2026-08-16.md

const RUNTIME = path.resolve(__dirname, "..", ".runtime", "regression");
fs.mkdirSync(RUNTIME, { recursive: true });

const PORT = 3303;
process.env.DSH_USER_DATA = path.join(RUNTIME, "crash-user");
process.env.DSH_HOME = path.join(RUNTIME, "crash-home");
process.env.DSH_APP_PORT = String(PORT);
process.env.DSH_LOCK_PATH = path.join(RUNTIME, "crash-lock");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
require(path.join(__dirname, "..", "src", "main", "main.js"));

const views = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
const findWebUI = () => views().find((wc) => wc.getURL().startsWith(`http://127.0.0.1:${PORT}`));
const findLoading = () => views().find((wc) => wc.getURL().includes("index.html"));

app.whenReady().then(async () => {
  try {
    // 1. WebUI 就绪
    let cv = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      cv = findWebUI();
      if (cv) break;
    }
    if (!cv) throw new Error("WebUI 未就绪");
    console.log(`[1] WebUI 就绪: ${cv.getURL()}`);

    // 2. SIGKILL dsh 子进程
    const pids = execFileSync("pgrep", ["-f", `bin.js web --port ${PORT}`], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    if (pids.length === 0) throw new Error("找不到 dsh 子进程");
    for (const pid of pids) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    console.log(`[2] 已 SIGKILL dsh 子进程: ${pids.join(",")}`);

    // 3. App 应自动切回加载页并展示错误(而不是停在死页面上)
    let loadingView = null;
    let detail = "";
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      loadingView = findLoading();
      if (loadingView) {
        detail = await loadingView
          .executeJavaScript("document.getElementById('errorDetail') ? document.getElementById('errorDetail').textContent : ''", true)
          .catch(() => "");
        if (detail.includes("意外退出")) break;
      }
    }
    if (!loadingView) throw new Error("崩溃后没有切回加载页");
    console.log(`[3] 已切回加载页,错误详情: ${JSON.stringify(detail.slice(0, 60))}`);
    if (!detail.includes("意外退出")) throw new Error("加载页未展示崩溃错误");

    // 4. 点击重试 → 服务重启 → WebUI 重新加载
    await loadingView.executeJavaScript(`document.getElementById('retryBtn').click()`, true).catch(() => {});
    let recovered = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const wc = findWebUI();
      if (wc) { recovered = true; break; }
    }
    console.log(`[4] 重试后 WebUI 重新加载 = ${recovered}`);
    if (!recovered) throw new Error("重试后未恢复 WebUI");

    console.log("\nPASS ✓ ISSUE-005 回归:崩溃可见、可重试、可恢复");
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ ISSUE-005 回归:", err.message);
    app.exit(1);
  }
});
