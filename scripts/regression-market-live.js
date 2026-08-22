#!/usr/bin/env node
"use strict";

/**
 * regression-market-live.js — 插件市场(dshmarket)真实环境端到端回归:
 *
 *   1. 复用隔离 DSH_HOME(缺插件时联网安装 dshmarket);
 *   2. 真实启动 dsh web,加载真实 WebUI,注入 MARKET_BRIDGE_JS_FN(true) + MARKET_INJECT_CSS
 *      (与 main.js installWebUIInjection 相同的注入);
 *   3. 断言:侧边栏「插件」入口出现在「设置」按钮上方(chajian 图标+文本);
 *      点击入口 → 设置弹窗打开并激活「插件市场」页;
 *      设置弹窗导航里「插件市场」按钮的默认图标被替换为 chajian 方块网格;
 *      开关 setEnabled(false) → 入口移除;setEnabled(true) → 恢复。
 *
 * 用法: electron scripts/regression-market-live.js --no-sandbox
 * 说明:默认联网安装插件(仅首次);可用 DSH_E2E_HOME 指定已就绪的隔离 home。
 */

const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const { resolveDsh } = require(path.join(ROOT, "src", "main", "dsh-server"));
const { MARKET_BRIDGE_JS_FN, MARKET_INJECT_CSS } = require(path.join(ROOT, "src", "main", "plugin-ui-inject"));

const E2E_HOME = process.env.DSH_E2E_HOME || "/tmp/dsh-box-plugin-e2e";
const PORT = Number(process.env.DSH_E2E_PORT) || 3974;
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

let dshProcess = null;

app.whenReady().then(async () => {
  let win = null;
  try {
    // ---------- 1. 准备隔离 home + 启动 web ----------
    fs.mkdirSync(E2E_HOME, { recursive: true });
    const fs2 = require("node:fs");
    const marketVersion = (() => {
      try {
        return JSON.parse(fs2.readFileSync(
          path.join(E2E_HOME, "profiles", "web", "node_modules", "dshmarket", "package.json"), "utf8"
        )).version ?? null;
      } catch { return null; }
    })();
    if (!marketVersion) {
      const { runDshCli } = require(path.join(ROOT, "src", "main", "plugin-manager"));
      const res = await runDshCli(E2E_HOME, ["plugin", "--profile", "web", "add", "dshmarket"]);
      if (!res.ok) throw new Error(`插件市场安装失败: ${res.error}`);
    }
    console.log(`[e2e] dshmarket ${marketVersion} 就绪`);

    dshProcess = spawnWeb();
    const url = `http://127.0.0.1:${PORT}`;
    if (!(await waitServerReady(url))) throw new Error("dsh web 未就绪");

    // ---------- 2. 加载真实 WebUI + 注入市场桥与入口样式 ----------
    win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: PRELOAD });
    win.webContents.on("did-finish-load", () => {
      win.webContents.executeJavaScript(MARKET_BRIDGE_JS_FN(true), true).catch(() => {});
      win.webContents.insertCSS(MARKET_INJECT_CSS).catch(() => {});
    });
    await win.loadURL(url);
    await wait(WAIT_MS);

    // ---------- 3a. 侧边栏「插件」入口出现在「设置」上方 ----------
    const entry = await (async () => {
      const start = Date.now();
      while (Date.now() - start < MOUNT_TIMEOUT_MS) {
        const r = await win.webContents.executeJavaScript(`(() => {
          const settings = document.querySelector('[data-slot="sidebar.settings"]');
          if (!settings) return null;
          const marketWrap = document.querySelector('[data-slot="sidebar.market"]');
          if (!marketWrap) return null;
          const btn = marketWrap.querySelector('button.dshbox-market-entry');
          const beforeSettings = settings.compareDocumentPosition(marketWrap) & Node.DOCUMENT_POSITION_PRECEDING;
          return {
            before: !!beforeSettings,
            text: btn ? btn.textContent.trim() : null,
            iconCount: btn ? btn.querySelectorAll('svg rect').length : 0,
            aria: btn ? btn.getAttribute('aria-label') : null,
          };
        })()`);
        if (r && r.text === "插件") return r;
        await wait(500);
      }
      return null;
    })();
    if (!entry) throw new Error("侧边栏「插件」入口未出现或不在「设置」上方");
    if (!entry.before) throw new Error("「插件」入口应在「设置」按钮上方");
    if (entry.text !== "插件" || entry.aria !== "插件") throw new Error(`入口文案错误: ${JSON.stringify(entry)}`);
    if (entry.iconCount < 8) throw new Error(`入口图标应为 chajian 方块网格,实际 rect=${entry.iconCount}`);
    console.log("[1] 侧边栏「插件」入口:设置上方,chajian 图标 + 文本 ✓");

    // ---------- 3b. 点击「插件」→ 设置弹窗打开并激活插件市场页 ----------
    await win.webContents.executeJavaScript(`document.querySelector('[data-slot="sidebar.market"] button.dshbox-market-entry').click(); undefined;`);
    const marketActivated = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        const r = await win.webContents.executeJavaScript(`(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return null;
          const marketBtn = [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '插件市场');
          if (!marketBtn) return null;
          const isCurrent = marketBtn.getAttribute('aria-current') === 'true';
          const active = dialog.querySelector('[data-section-id="market"], [class*="sectionOn"], [aria-selected="true"]');
          return { dialog: true, isCurrent, activeNow: !!active };
        })()`);
        if (r && r.dialog && (r.isCurrent || r.activeNow)) return r;
        // 弹窗已开但尚未激活 → 继续等(可能点击时序差一拍)
        await wait(500);
      }
      return null;
    })();
    if (!marketActivated?.dialog) throw new Error("点击「插件」应打开设置弹窗");
    if (!marketActivated.isCurrent && !marketActivated.activeNow)
      throw new Error("设置弹窗应激活「插件市场」页");
    console.log("[2] 点「插件」 → 设置弹窗打开并激活插件市场页 ✓");

    // ---------- 3c. 设置弹窗导航图标替换为 chajian ----------
    const icon = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const r = await win.webContents.executeJavaScript(`(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return null;
          const marketBtn = [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '插件市场');
          if (!marketBtn) return null;
          const holder = marketBtn.querySelector('.dshbox-market-icon');
          const defaultSvg = marketBtn.querySelector('svg:not(.dshbox-market-icon)') || marketBtn.querySelector('svg');
          return {
            holder: !!holder,
            holderRects: holder ? holder.querySelectorAll('svg rect').length : 0,
            defaultSvgGone: holder ? (defaultSvg === null || defaultSvg === undefined || defaultSvg.closest('.dshbox-market-icon')) : false,
          };
        })()`);
        if (r && r.holder) return r;
        await wait(500);
      }
      return null;
    })();
    if (!icon) throw new Error("设置弹窗里「插件市场」按钮图标未替换");
    if (!icon.holder || icon.holderRects < 8) throw new Error("替换图标应为 chajian 方块网格");
    if (!icon.defaultSvgGone) throw new Error("默认齿轮图标应被移除");
    console.log("[3] 设置弹窗「插件市场」导航图标:默认齿轮 → chajian ✓");

    // ---------- 3d. 开关门控:setEnabled(false) 移除入口,true 恢复 ----------
    await win.webContents.executeJavaScript(`window.__dshBoxMarketBridge.setEnabled(false); undefined;`);
    await wait(300);
    const gone = await win.webContents.executeJavaScript(`!document.querySelector('[data-slot="sidebar.market"]')`);
    if (!gone) throw new Error("setEnabled(false) 后入口应移除");
    await win.webContents.executeJavaScript(`window.__dshBoxMarketBridge.setEnabled(true); undefined;`);
    await wait(300);
    const back = await win.webContents.executeJavaScript(`!!document.querySelector('[data-slot="sidebar.market"]')`);
    if (!back) throw new Error("setEnabled(true) 后入口应恢复");
    console.log("[4] 开关门控:关 → 入口移除;开 → 恢复 ✓");

    console.log("\nPASS ✓ 插件市场真实环境端到端回归通过");
    win.destroy();
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 插件市场真实环境端到端回归:", err.message);
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