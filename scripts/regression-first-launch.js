#!/usr/bin/env node
"use strict";

/**
 * regression-first-launch.js — 首次启动自动展开「服务状态」侧边栏回归(需求 4,
 * 真实 main.js 驱动)。两种模式(环境变量切换,同一脚本):
 *
 *   auto(默认):全新 userData(无 launchedBefore 标记)→ 首启自动展开侧边栏:
 *     出现 dsh-status.html 视图 + 该视图 getSidebar {open:true} +
 *     settings.yaml 写入 launchedBefore: true;
 *   seeded(DSH_FIRST_LAUNCH_SEED=1):预置 launchedBefore: true → 启动后不自动展开:
 *     4s 内无 dsh-status.html 视图 + 顶栏 getSidebar {open:false}。
 *
 * 用法:
 *   electron scripts/regression-first-launch.js --no-sandbox          # auto
 *   DSH_FIRST_LAUNCH_SEED=1 electron scripts/regression-first-launch.js --no-sandbox
 */

const fs = require("node:fs");
const { app, webContents } = require("electron");
const path = require("node:path");

const RUNTIME = path.resolve(__dirname, "..", ".runtime", "regression");
fs.mkdirSync(RUNTIME, { recursive: true });

const SEEDED = process.env.DSH_FIRST_LAUNCH_SEED === "1";
const PORT = 3303;

const userData = path.join(RUNTIME, `first-${SEEDED ? "seeded" : "auto"}-user`);
const dshHome = path.join(RUNTIME, `first-${SEEDED ? "seeded" : "auto"}-home`);
// 每次运行都从全新状态开始(前次运行可能已写入 launchedBefore 标记,
// 会跳过首启展开,造成假失败)
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(dshHome, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(dshHome, { recursive: true });

if (SEEDED) {
  // 预置「已引导过」标记:二次启动不应再自动展开
  fs.writeFileSync(path.join(dshHome, "settings.yaml"), "dsh-box:\n  launchedBefore: true\n");
}

process.env.DSH_USER_DATA = userData;
process.env.DSH_HOME = dshHome;
process.env.DSH_APP_PORT = String(PORT);
process.env.DSH_LOCK_PATH = path.join(RUNTIME, `first-${SEEDED ? "seeded" : "auto"}-lock`);
// 应用自更新与首启侧边栏无关,dev 模式本就禁用,显式关闭排除噪音
process.env.DSH_APP_UPDATE_DISABLED = "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const views = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
const statusView = () => views().find((wc) => wc.getURL().includes("dsh-status.html"));

/** 经任意带桥视图查侧边栏状态(顶栏优先) */
async function readSidebarState() {
  const target = views().find((wc) => wc.getURL().includes("topbar.html")) || statusView();
  if (!target) return null;
  return target
    .executeJavaScript("window.dsh.getSidebar().catch(e => ({ error: String(e) }))", true)
    .catch(() => null);
}

// 先注册我们的 whenReady,再 require main.js(它的 whenReady 之后执行)
app.whenReady().then(async () => {
  try {
    if (!SEEDED) {
      // auto:面板必须「自动展开过」且处于展开态。两种合法的展开形态:
      //   1. 兜底期(dsh 未就绪,800ms 时 openStatusSidebar)→ dsh-status.html 视图;
      //   2. 移交后(dsh 就绪 → 经桥打开注入共享面板并收起兜底)→ 注入面板
      //      statusPanelOpen=true(顶栏窗上报 open:true)。
      // 视图可能在移交瞬间被收起,所以轮询捕获「出现过」即可,状态读顶栏窗。
      let found = null;
      let state = null;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        found = found || statusView();
        state = await readSidebarState();
        if (found && state && state.open === true) break;
        await sleep(200);
      }
      if (!found) throw new Error("首次启动未自动展开「服务状态」侧边栏(无 dsh-status.html 视图)");
      console.log(`[1] 首启自动展开:出现过状态面板视图 + 侧边栏状态 = ${JSON.stringify(state)}`);
      if (!state || state.open !== true) {
        throw new Error(`侧边栏未处于展开态: ${JSON.stringify(state)}`);
      }

      const raw = fs.readFileSync(path.join(dshHome, "settings.yaml"), "utf8");
      const marked = /launchedBefore:\s*true/.test(raw);
      console.log(`[2] settings.yaml 已写入 launchedBefore: true = ${marked}`);
      if (!marked) throw new Error("settings.yaml 未写入 launchedBefore 标记");
    } else {
      // seeded:已引导过 → 不应自动展开
      await sleep(4_000);
      const found = statusView();
      console.log(`[1] 二次启动(已置标记):自动展开视图出现 = ${!!found}(应为 false)`);
      if (found) throw new Error("已有 launchedBefore 标记却仍自动展开侧边栏");

      const sidebar = await readSidebarState();
      console.log(`[2] 二次启动侧边栏状态 = ${JSON.stringify(sidebar)}(应为 open:false)`);
      if (!sidebar || sidebar.open !== false) {
        throw new Error(`二次启动不应自动展开: ${JSON.stringify(sidebar)}`);
      }
    }

    console.log(
      `\nPASS ✓ 需求 4 回归:${SEEDED ? "二次启动不自动展开" : "首次启动自动展开「服务状态」侧边栏"}`
    );
    app.quit();
  } catch (err) {
    console.error(`\nFAIL ✗ 需求 4 回归(${SEEDED ? "seeded" : "auto"}):`, err.message);
    app.exit(1);
  }
});

require(path.join(__dirname, "..", "src", "main", "main.js"));