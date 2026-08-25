#!/usr/bin/env node
"use strict";

/**
 * regression-status-refresh.js — 「每次打开状态页自动查询」回归(需求 5)。
 *
 * 验证契约:状态页每次加载都必须同时发起三处 registry 查询 ——
 *   dsh 最新版(dsh:check-updates)、侧边栏插件(dsh:plugin-info)、
 *   插件市场(dsh:market-info);
 *   主进程对应 handler 每次被调都重新查 registry(refreshUpdateFlag /
 *   refreshPluginCheck / refreshMarketCheck,见 main.js),页面重载 = 重新打开
 *   面板(openStatusSidebar 每次重建视图重载页面)→ 三个查询必须再次发起。
 *
 * 方法:真实 dsh-status.html + 真实 preload,主进程注册「计数型」IPC 夹具,
 * 断言:首次加载三处各 ≥1 次;重载后三处均严格递增。
 *
 * 用法: electron scripts/regression-status-refresh.js --no-sandbox
 */

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const PRELOAD = {
  preload: path.join(__dirname, "..", "src", "preload", "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

// 版本行(发布时间倒序):首行 = rc.12 = 最新;rc.6 为当前运行版本
const VERSIONS = [];
for (let i = 12; i >= 1; i--) {
  const isCurrent = i === 6;
  const version = isCurrent ? "0.1.0-rc.6" : `0.1.0-rc.${i}`;
  VERSIONS.push({
    version,
    publishedAt: new Date(Date.UTC(2026, 6, 20 + i)).toISOString(),
    isLatest: i === 12,
    isCurrent,
    hasUpdate: i > 6,
    tarball: null,
    integrity: null,
  });
}

const FIXTURE_DSH = {
  latest: "0.1.0-rc.12",
  runtime: "0.1.0-rc.6",
  hasUpdate: true,
  rows: VERSIONS,
  checkedAt: "2026-08-21T12:00:00.000Z",
  fromCache: false,
};
const FIXTURE_PLUGIN = {
  name: "dsh-better-sidebar",
  installed: "1.0.0",
  latest: "1.1.0",
  hasUpdate: true,
};
const FIXTURE_MARKET = {
  name: "dshmarket",
  installed: null,
  latest: "1.18.1",
  hasUpdate: true,
};
const FIXTURE_INFO = {
  version: "0.1.0-rc.6",
  port: 3260,
  url: "http://127.0.0.1:3260",
  pid: 4242,
  ready: true,
  state: "ready",
  message: "服务运行中",
  portMovedFrom: null,
};
const FIXTURE_SWITCH = { ok: true, enabled: false };
const FIXTURE_NOTIFY = { banner: false, sound: false, permission: "unknown" };

// 三处查询的计数(页面每次加载各发一次)
const counts = { dsh: 0, plugin: 0, market: 0 };

ipcMain.handle("dsh:check-updates", async () => {
  counts.dsh++;
  return FIXTURE_DSH;
});
ipcMain.handle("dsh:plugin-info", async () => {
  counts.plugin++;
  return FIXTURE_PLUGIN;
});
ipcMain.handle("dsh:market-info", async () => {
  counts.market++;
  return FIXTURE_MARKET;
});
ipcMain.handle("dsh:get-info", () => FIXTURE_INFO);
ipcMain.handle("dsh:get-update-flag", () => ({ hasUpdate: true }));
ipcMain.handle("dsh:market-switch", () => FIXTURE_SWITCH);
ipcMain.handle("dsh:notify-settings", () => FIXTURE_NOTIFY);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等条件成立(带超时) */
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await wait(150);
  }
  throw new Error(`等待超时: ${label}`);
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 720, height: 680, show: false, webPreferences: PRELOAD });
    const html = path.join(__dirname, "..", "src", "renderer", "dsh-status.html");

    // 第一次「打开」= 页面加载:三处必须各查一次
    await win.loadFile(html);
    await waitFor(
      () => counts.dsh >= 1 && counts.plugin >= 1 && counts.market >= 1,
      10_000,
      "首次加载后三处查询"
    );
    const first = { ...counts };
    console.log(
      `[1] 首次加载: dsh=${first.dsh} 插件=${first.plugin} 市场=${first.market}(均 ≥1 次查询)`
    );
    if (first.dsh < 1 || first.plugin < 1 || first.market < 1) {
      throw new Error(`首次加载三处查询未同时发起: ${JSON.stringify(first)}`);
    }

    // 第二次「打开」= 重载页面(openStatusSidebar 每次重建视图重载):
    // 三处必须再次发起(严格递增)
    await win.loadFile(html);
    await waitFor(
      () => counts.dsh > first.dsh && counts.plugin > first.plugin && counts.market > first.market,
      10_000,
      "重载后三处查询递增"
    );
    console.log(
      `[2] 重载后: dsh=${counts.dsh}(+${counts.dsh - first.dsh}) ` +
        `插件=${counts.plugin}(+${counts.plugin - first.plugin}) ` +
        `市场=${counts.market}(+${counts.market - first.market})(均 > 首次)`
    );
    if (counts.dsh <= first.dsh || counts.plugin <= first.plugin || counts.market <= first.market) {
      throw new Error(`重载后三处查询未递增: ${JSON.stringify({ first, now: counts })}`);
    }

    console.log("\nPASS ✓ 需求 5 回归:每次打开状态页,dsh/侧边栏插件/插件市场三处均重新查询");
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 需求 5 回归:", err.message);
    app.exit(1);
  }
});