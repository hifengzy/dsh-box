#!/usr/bin/env node
"use strict";

/**
 * regression-plugin-live.js — 真实插件环境端到端回归(真实 dsh web + dsh-better-sidebar):
 *
 *   1. 准备隔离 DSH_HOME(缺插件时真实联网安装 dsh-better-sidebar);
 *   2. 真实启动 dsh web 子进程(与 DSH Box 相同方式);
 *   3. 用 BrowserWindow 加载真实 WebUI,注入 PLUGIN_BRIDGE_JS + PLUGIN_HIDE_CSS
 *      (与 main.js installWebUIInjection 完全相同的注入),挂真实 preload;
 *   4. 断言:插件真实挂载(cluster 出现)、无会话时按钮 disabled 且桥报告
 *      active=false、隐藏 CSS 生效、桥 state 信号与插件布局钩子一致、
 *      toggle 在无会话下无效且不报错、状态经 shell:plugin-panels 上报;
 *   5. 反向断言:未挂载时 toggle 返回 plugin-not-mounted。
 *
 * 说明:dsh 侧栏 per-session,只有活跃会话下 toggle 才有效;自动化环境无法
 * 创建活跃会话(需真实调用模型),因此双向翻转是实机验收项(见 README),
 * 本测试覆盖无会话真实场景 + 全部注入/信号/上报链路。
 *
 * 用法: electron scripts/regression-plugin-live.js --no-sandbox
 * 说明:默认联网安装插件(仅首次);可用 DSH_E2E_HOME 指定已就绪的隔离 home。
 */

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const { resolveDsh } = require(path.join(ROOT, "src", "main", "dsh-server"));
const pluginManager = require(path.join(ROOT, "src", "main", "plugin-manager"));
const { PLUGIN_BRIDGE_JS, PLUGIN_HIDE_CSS } = require(path.join(ROOT, "src", "main", "plugin-ui-inject"));

const E2E_HOME = process.env.DSH_E2E_HOME || "/tmp/dsh-box-plugin-e2e";
const PORT = Number(process.env.DSH_E2E_PORT) || 3967;
const WAIT_MS = 400;
const MOUNT_TIMEOUT_MS = 30_000;

const PRELOAD = {
  preload: path.join(ROOT, "src", "preload", "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等待 http 就绪 */
async function waitServerReady(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* 未就绪 */ }
    await wait(500);
  }
  return false;
}

/** 与 DSH Box 同款方式启动 dsh web 子进程 */
function spawnWeb() {
  const resolved = resolveDsh();
  if (!resolved) throw new Error("找不到 dsh");
  const env = { ...process.env, DSH_HOME: E2E_HOME, DSH_TELEMETRY_DISABLED: "1" };
  let command;
  let args;
  if (resolved.type === "script") {
    command = process.execPath;
    args = ["--expose-internals", resolved.path, "web", "--port", String(PORT)];
    env.ELECTRON_RUN_AS_NODE = "1";
  } else {
    command = resolved.path;
    args = ["web", "--port", String(PORT)];
  }
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (c) => process.stderr.write(`[dsh:err] ${c}`));
  return child;
}

/** 等待插件 cluster 出现在 DOM(插件 mount 晚于页面加载) */
async function waitCluster(win, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await win.webContents.executeJavaScript(
      `!!document.querySelector('[data-dsh-toggle-cluster]')`
    );
    if (found) return true;
    await wait(500);
  }
  return false;
}

let dshProcess = null;
let panelReports = [];

app.whenReady().then(async () => {
  let win = null;
  try {
    // ---------- 1+2. 准备隔离 home(缺插件先装)+ 启动 dsh web ----------
    fs.mkdirSync(E2E_HOME, { recursive: true });
    if (!pluginManager.getInstalledVersion(E2E_HOME, "dsh-better-sidebar")) {
      console.log("[e2e] 隔离 home 缺 dsh-better-sidebar,联网安装(仅首次)…");
      const installed = await pluginManager.installPlugin(E2E_HOME, "dsh-better-sidebar", null);
      if (!installed.ok) throw new Error(`插件安装失败: ${installed.error}`);
      console.log("[e2e] 插件已安装");
    }
    console.log(`[e2e] 已装插件版本: ${pluginManager.getInstalledVersion(E2E_HOME, "dsh-better-sidebar")}`);

    dshProcess = spawnWeb();
    const url = `http://127.0.0.1:${PORT}`;
    if (!(await waitServerReady(url))) throw new Error("dsh web 未就绪");

    // ---------- 3. 加载真实 WebUI + 注入桥与隐藏 CSS + 真实 preload ----------
    ipcMain.on("shell:plugin-panels", (_e, state) => {
      panelReports.push(state);
    });
    win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: PRELOAD });
    win.webContents.on("did-finish-load", () => {
      win.webContents.executeJavaScript(PLUGIN_BRIDGE_JS, true).catch(() => {});
      win.webContents.insertCSS(PLUGIN_HIDE_CSS).catch(() => {});
    });
    await win.loadURL(url);

    // ---------- 4a. 插件真实挂载 ----------
    if (!(await waitCluster(win, MOUNT_TIMEOUT_MS))) {
      throw new Error("插件未挂载:页面里没有 [data-dsh-toggle-cluster]");
    }
    const bridge = await win.webContents.executeJavaScript(
      `typeof window.__dshBoxPluginBridge === 'object'`
    );
    if (!bridge) throw new Error("桥未注入(window.__dshBoxPluginBridge 缺失)");
    console.log("[1] 插件真实挂载 + 桥注入 ✓");

    // ---------- 4a2. 无会话场景:插件 toggle 按钮 disabled,桥报告 active=false ----------
    // dsh 侧栏 per-session:无活跃会话时插件禁用自身的 toggle 按钮(侧栏
    // 无可挂载的会话)。首页会话是消息驱动的,自动化环境无法创建活跃会话
    // (会真实调用模型)→ 真实页面上按钮 disabled + 桥 active=false +
    // toggle 点击无效且不报错,DSH Box 顶栏按钮据此禁用。双向翻转需活跃
    // 会话,列为实机验收项(见 README)。
    const noSession = await win.webContents.executeJavaScript(`(() => {
      const btns = document.querySelectorAll('[data-dsh-toggle-cluster] button');
      const state = window.__dshBoxPluginBridge.state();
      return {
        allDisabled: btns.length > 0 && [...btns].every((b) => b.disabled),
        active: state.active,
      };
    })()`);
    if (!noSession.allDisabled) throw new Error("无会话时插件按钮应全部 disabled");
    if (noSession.active !== false) throw new Error(`无会话时桥应报告 active=false,实际 ${noSession.active}`);
    const tNoop = await win.webContents.executeJavaScript(
      `window.__dshBoxPluginBridge.toggle('side')`
    );
    if (!tNoop.ok) throw new Error(`无会话时 toggle 不应报错: ${JSON.stringify(tNoop)}`);
    const stNoop = await win.webContents.executeJavaScript(
      `window.__dshBoxPluginBridge.state()`
    );
    if (stNoop.side !== false || stNoop.bottom !== false)
      throw new Error(`无会话时状态不应变化: ${JSON.stringify(stNoop)}`);
    console.log("[1b] 无会话:按钮 disabled + active=false + toggle 无效不报错 ✓");

    // ---------- 4b. 隐藏 CSS 生效 ----------
    const hideState = await win.webContents.executeJavaScript(`(() => {
      const cluster = document.querySelector('[data-dsh-toggle-cluster]');
      const cs = getComputedStyle(cluster);
      return { visibility: cs.visibility, opacity: cs.opacity, pointerEvents: cs.pointerEvents };
    })()`);
    if (hideState.visibility !== "hidden" || hideState.pointerEvents !== "none")
      throw new Error(`隐藏规则未生效: ${JSON.stringify(hideState)}`);
    console.log("[2] 原入口隐藏(visibility:hidden, 保留空位) ✓");

    // ---------- 4c. 状态信号与上报 ----------
    const st0 = await win.webContents.executeJavaScript(
      `window.__dshBoxPluginBridge.state()`
    );
    if (st0.installed !== true) throw new Error(`installed 应为 true,实际 ${st0.installed}`);
    if (st0.active !== false) throw new Error(`无会话时 active 应为 false,实际 ${st0.active}`);
    await wait(WAIT_MS);
    if (panelReports.length === 0) throw new Error("桥未上报初始面板状态");
    const lastReport = panelReports[panelReports.length - 1];
    if (lastReport.active !== false || lastReport.installed !== true)
      throw new Error(`上报状态字段缺失: ${JSON.stringify(lastReport)}`);
    console.log(`[3] 桥状态与上报正确(installed=true, active=false, side=${st0.side}, bottom=${st0.bottom}) ✓`);

    // ---------- 4d. 未挂载防呆 ----------
    const unmounted = await win.webContents.executeJavaScript(`(() => {
      const cluster = document.querySelector('[data-dsh-toggle-cluster]');
      cluster.remove();
      const res = window.__dshBoxPluginBridge.toggle('side');
      document.body.appendChild(cluster);
      return res;
    })()`);
    if (unmounted.ok !== false || !unmounted.error)
      throw new Error(`未挂载时应返回 {ok:false},实际 ${JSON.stringify(unmounted)}`);
    console.log("[4] 未挂载防呆:返回 plugin-not-mounted ✓");

    // ---------- 4e. 双向翻转(活跃会话)是实机验收项 ----------
    console.log("[5] 双向翻转需活跃会话,由实机验收(见 README 验收指引) ✓");

    console.log("\nPASS ✓ 侧边栏插件真实环境端到端回归通过");
    win.destroy();
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 侧边栏插件真实环境端到端回归:", err.message);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  } finally {
    if (dshProcess) {
      try { dshProcess.kill("SIGTERM"); } catch { /* 已退出 */ }
    }
  }
});

app.on("window-all-closed", () => {
  app.quit();
});