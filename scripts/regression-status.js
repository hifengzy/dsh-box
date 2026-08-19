#!/usr/bin/env node
"use strict";

/**
 * regression-status.js — 「dsh 服务与版本」页 + 顶栏入口回归测试(真实 Electron):
 *   1. 运行中:绿色状态点 + dsh 版本 + 端口/PID;显示「停止/重启」而非「启动」;
 *   2. 版本列表:按发布时间倒序,「最新/当前」徽标正确,只给比当前新的版本
 *      显示「更新」按钮;有新版时横幅可见;
 *   3. 点「更新」→ 经桥发出 upgrade(目标版本);
 *   4. 启动失败:红色 + 失败原因 + 「启动服务」按钮;点击 → retry;
 *   5. 未运行:灰色 + 「启动服务」按钮;
 *   6. 顶栏:更新标志为真 → 入口红点可见;点入口 → openStatusPage。
 *
 * 用法: electron scripts/regression-status.js --no-sandbox
 * 说明:测试固定 nativeTheme=light,断言浅色 token 的具体值,结果确定。
 */

const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const path = require("node:path");

app.setPath("userData", path.resolve(__dirname, "..", ".runtime", "regression", "status-user"));

const FIXTURE_INFO = {
  version: "0.1.0-rc.6",
  port: 3260,
  url: "http://127.0.0.1:3260",
  pid: 4242,
  dshBin: "/app/node_modules/@deepseek-ai/dsh/lib/bin.js",
  dshHome: "/tmp/dsh-home",
  logFile: "/tmp/dsh-box/dsh-server-1.log",
  ready: true,
  state: "ready",
  message: "服务运行中",
};

const FIXTURE_VERSIONS = {
  latest: "0.2.0",
  runtime: "0.1.0-rc.6",
  hasUpdate: true,
  rows: [
    { version: "0.2.0", publishedAt: "2026-08-20T00:00:00.000Z", isLatest: true, isCurrent: false, hasUpdate: true, tarball: null, integrity: null },
    { version: "0.1.0", publishedAt: "2026-08-01T00:00:00.000Z", isLatest: false, isCurrent: false, hasUpdate: true, tarball: null, integrity: null },
    { version: "0.1.0-rc.6", publishedAt: "2026-07-20T00:00:00.000Z", isLatest: false, isCurrent: true, hasUpdate: false, tarball: null, integrity: null },
  ],
  checkedAt: "2026-08-21T12:00:00.000Z",
  fromCache: false,
};

let state = "ready";
let upgradedVersion = null;
let retried = false;
let stopped = false;
let toggledSidebar = 0;

// 模拟主进程处理器(不真正启动/下载/打开)
ipcMain.handle("dsh:get-info", () => ({ ...FIXTURE_INFO, state }));
ipcMain.handle("dsh:check-updates", () => FIXTURE_VERSIONS);
ipcMain.handle("dsh:upgrade", (_e, v) => {
  upgradedVersion = v;
  return { ok: true, previous: "0.1.0-rc.6", installed: v, backupDir: "/tmp/bak" };
});
ipcMain.handle("dsh:retry", async () => {
  retried = true;
  return { ...FIXTURE_INFO, state };
});
ipcMain.handle("dsh:stop", async () => {
  stopped = true;
  state = "stopped";
  return { ...FIXTURE_INFO, state };
});
ipcMain.handle("dsh:get-update-flag", () => ({ hasUpdate: true, latest: "0.2.0" }));
ipcMain.handle("dsh:get-sidebar", () => ({ open: false, canOpen: true }));
ipcMain.handle("dsh:toggle-sidebar", () => {
  toggledSidebar += 1;
  return { open: true, canOpen: true };
});

const PRELOAD = {
  preload: path.join(__dirname, "..", "src", "preload", "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.whenReady().then(async () => {
  let win;
  try {
    nativeTheme.themeSource = "light"; // 固定浅色,断言浅色 token 确定值
    // ========== 1. 状态页:运行中 ==========
    win = new BrowserWindow({ width: 720, height: 680, show: false, webPreferences: PRELOAD });
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300); // 等初始化 IPC 往返

    const ready = await win.webContents.executeJavaScript(`(() => {
      const cs = (el) => el ? getComputedStyle(el) : null;
      const dot = document.getElementById("statusDot");
      return {
        label: document.getElementById("statusLabel").textContent,
        chip: document.getElementById("versionChip").textContent,
        meta: document.getElementById("metaLine").textContent,
        dotClass: dot.className,
        dotBg: cs(dot).backgroundColor,
        startHidden: document.getElementById("startBtn").hidden,
        stopHidden: document.getElementById("stopBtn").hidden,
        restartHidden: document.getElementById("restartBtn").hidden,
        bannerHidden: document.getElementById("updateBanner").hidden,
        bannerVersion: document.getElementById("bannerVersion").textContent,
      };
    })()`);
    if (ready.label !== "运行中") throw new Error(`运行中状态文案错误: ${ready.label}`);
    if (ready.chip !== "dsh 0.1.0-rc.6") throw new Error(`版本 chip 错误: ${ready.chip}`);
    if (!ready.meta.includes("端口 3260") || !ready.meta.includes("PID 4242"))
      throw new Error(`端口/PID 展示错误: ${ready.meta}`);
    if (ready.dotClass !== "dot ok") throw new Error(`状态点类名错误: ${ready.dotClass}`);
    if (ready.dotBg !== "rgb(34, 197, 94)") throw new Error(`运行中状态点应为绿色,实际 ${ready.dotBg}`);
    if (!ready.startHidden || ready.stopHidden || ready.restartHidden)
      throw new Error("运行中应显示「停止/重启」而不显示「启动」");
    if (ready.bannerHidden || ready.bannerVersion !== "v0.2.0")
      throw new Error("有新版时横幅应可见且显示 v0.2.0");
    console.log("[1] 运行中:绿点 + 版本 + 端口/PID + 停止/重启按钮 + 新版横幅 ✓");

    // ========== 2. 版本列表 ==========
    const list = await win.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll(".vrow")];
      return {
        count: rows.length,
        versions: rows.map((r) => r.querySelector(".v-version").textContent),
        badges: rows.map((r) =>
          [...r.querySelectorAll(".badge")].map((b) => b.textContent + ":" + b.className)
        ),
        dates: rows.map((r) => r.querySelector(".v-date").textContent),
        updates: rows.map((r) => r.querySelector(".v-update")?.textContent ?? null),
      };
    })()`);
    if (list.count !== 3) throw new Error(`版本行数应为 3,实际 ${list.count}`);
    if (JSON.stringify(list.versions) !== JSON.stringify(["0.2.0", "0.1.0", "0.1.0-rc.6"]))
      throw new Error(`应按发布时间倒序,实际 ${list.versions}`);
    if (list.badges[0].length !== 1 || !list.badges[0][0].includes("badge-latest"))
      throw new Error(`0.2.0 应有「最新」徽标,实际 ${list.badges[0]}`);
    if (list.badges[2].length !== 1 || !list.badges[2][0].includes("badge-current"))
      throw new Error(`当前版本应有「当前」徽标,实际 ${list.badges[2]}`);
    if (JSON.stringify(list.updates) !== JSON.stringify(["更新", "更新", null]))
      throw new Error(`「更新」按钮应只出现在比当前新的行,实际 ${list.updates}`);
    if (!list.dates[0].startsWith("2026-08-20")) throw new Error(`发布时间展示错误: ${list.dates}`);
    console.log("[2] 版本列表:倒序 + 徽标 + 仅新版本有「更新」按钮 ✓");

    // ========== 3. 点「更新」→ upgrade(0.2.0) ==========
    // 注:脚本完成值必须是可克隆的(不能是函数),否则 executeJavaScript 报
    // "An object could not be cloned"
    await win.webContents.executeJavaScript(`window.confirm = () => true; undefined;`);
    await win.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll(".vrow")]
        .find((r) => r.querySelector(".v-version").textContent === "0.2.0");
      row.querySelector(".v-update").click();
    })()`);
    await wait(250);
    if (upgradedVersion !== "0.2.0") throw new Error(`点「更新」应请求升级 0.2.0,实际 ${upgradedVersion}`);
    console.log("[3] 点「更新」→ upgrade(0.2.0) ✓");

    // ========== 4. 启动失败:红点 + 失败原因 + 启动服务 ==========
    state = "error";
    win.webContents.send("dsh:status", { state: "error", message: "EADDRINUSE: 端口 3260 被占用" });
    await wait(150);
    const failed = await win.webContents.executeJavaScript(`(() => {
      const cs = (el) => el ? getComputedStyle(el) : null;
      const dot = document.getElementById("statusDot");
      return {
        label: document.getElementById("statusLabel").textContent,
        dotBg: cs(dot).backgroundColor,
        errHidden: document.getElementById("errorBox").hidden,
        errText: document.getElementById("errorDetail").textContent,
        startHidden: document.getElementById("startBtn").hidden,
      };
    })()`);
    if (failed.label !== "启动失败") throw new Error(`失败状态文案错误: ${failed.label}`);
    if (failed.dotBg !== "rgb(236, 19, 19)") throw new Error(`失败状态点应为红色,实际 ${failed.dotBg}`);
    if (failed.errHidden || !failed.errText.includes("EADDRINUSE"))
      throw new Error(`失败原因未展示: ${failed.errText}`);
    if (failed.startHidden) throw new Error("启动失败应显示「启动服务」按钮");
    await win.webContents.executeJavaScript(`document.getElementById("startBtn").click()`);
    await wait(150);
    if (!retried) throw new Error("点「启动服务」应触发 retry");
    console.log("[4] 启动失败:红点 + 失败原因 + 启动服务→retry ✓");

    // ========== 5. 未运行:灰点 + 启动服务 ==========
    state = "stopped";
    win.webContents.send("dsh:status", { state: "stopped", message: "服务已停止" });
    await wait(150);
    const stoppedState = await win.webContents.executeJavaScript(`(() => {
      const cs = (el) => el ? getComputedStyle(el) : null;
      const dot = document.getElementById("statusDot");
      return {
        label: document.getElementById("statusLabel").textContent,
        dotBg: cs(dot).backgroundColor,
        startHidden: document.getElementById("startBtn").hidden,
        stopHidden: document.getElementById("stopBtn").hidden,
      };
    })()`);
    if (stoppedState.label !== "未运行") throw new Error(`未运行文案错误: ${stoppedState.label}`);
    if (stoppedState.dotBg !== "rgb(151, 157, 166)")
      throw new Error(`未运行状态点应为灰色,实际 ${stoppedState.dotBg}`);
    if (stoppedState.startHidden || !stoppedState.stopHidden)
      throw new Error("未运行应显示「启动服务」且不显示「停止」");
    console.log("[5] 未运行:灰点 + 启动服务按钮 ✓");

    // ========== 6. 顶栏:红点可见 + 入口点击开/关面板(同窗口换页) ==========
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "topbar.html"));
    await wait(150);
    const tb = await win.webContents.executeJavaScript(`(() => {
      const dot = document.getElementById("updateDot");
      const icon = document.querySelector(".status-icon");
      return {
        hasDot: !!dot,
        dotHidden: dot.hidden,
        hasIcon: !!document.querySelector(".status-btn"),
        iconBg: icon ? getComputedStyle(icon).backgroundColor : null,
      };
    })()`);
    if (!tb.hasDot || tb.dotHidden) throw new Error("有更新时顶栏红点应可见");
    if (!tb.hasIcon) throw new Error("顶栏缺少 dsh 状态入口按钮");
    await win.webContents.executeJavaScript(`document.getElementById("statusBtn").click()`);
    await wait(100);
    if (toggledSidebar !== 1) throw new Error("点顶栏状态入口应触发 toggle-sidebar(面板开关)");
    console.log("[6] 顶栏:红点可见 + 点击入口 toggle-sidebar ✓");

    console.log("\nPASS ✓ 服务与版本页回归通过");
    win.destroy();
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 服务与版本页回归:", err.message);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});