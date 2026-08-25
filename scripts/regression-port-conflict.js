#!/usr/bin/env node
"use strict";

/**
 * regression-port-conflict.js — ISSUE-003 + 需求 7 回归(真实 main.js 驱动):
 * 端口被非 dsh 的本地服务占用时:
 *   1. 绝不当 WebUI 加载假服务页面、绝不把假服务误判为就绪(ISSUE-003 原断言);
 *   2. 端口冲突并存:预检发现端口被占 → 自动改用下一端口(DSH_APP_PORT+1)
 *      起 DSH Box 自己的服务,永不接管/共享用户的服务;
 *   3. 状态页信息如实上报迁移后的端口(port=DSH_APP_PORT+1, portMovedFrom=原端口)。
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
// 首启自动展开侧边栏与本测试无关,禁用避免干扰
process.env.DSH_SKIP_FIRST_LAUNCH = "1";

// 端口可能被上一轮测试的残留 dsh 短暂占用(SIGTERM 释放 >2s),应用会自动
// 继续向后找候选端口 —— 断言只要求「迁移到 PORT+1 ~ PORT+9 中第一个空闲端口
// 并就绪」,不硬编码 +1。
const MOVED_MAX = PORT + 10; // 与 main.js MAX_PORT_SKIP(10)一致,闭区间外;

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

    // 轮询:等 DSH Box 迁移端口后服务就绪(真实 dsh 启动需要一些时间)
    let readyInfo = null;
    const deadline = Date.now() + 65_000;
    while (Date.now() < deadline) {
      // 断言 1(贯穿始终):任何内容视图都不能加载假服务页面
      const fakeViews = views().filter((wc) => wc.getURL().startsWith(`http://127.0.0.1:${PORT}`));
      if (fakeViews.length > 0) {
        const body = await fakeViews[0]
          .executeJavaScript("document.body ? document.body.innerText : ''", true)
          .catch(() => "");
        throw new Error(`误把假服务当 WebUI 加载,页面内容: ${body.slice(0, 60)}`);
      }

      // 找顶栏视图(带 preload 桥),查服务信息
      const topbar = views().find((wc) => wc.getURL().includes("topbar.html"));
      if (topbar) {
        const info = await topbar
          .executeJavaScript("window.dsh.getInfo().catch(e => ({ error: String(e) }))", true)
          .catch(() => null);
        if (
          info &&
          info.ready === true &&
          info.portMovedFrom === PORT &&
          info.port > PORT &&
          info.port < MOVED_MAX
        ) {
          readyInfo = info;
          break;
        }
      }
      await sleep(1000);
    }
    if (!readyInfo) {
      throw new Error(
        `服务未在 ${PORT + 1}~${MOVED_MAX - 1} 任一端口就绪(或 port/portMovedFrom 上报不符)`
      );
    }

    console.log(`[1] 假服务(端口 ${PORT})从未被当作 WebUI 加载 (ISSUE-003 保持 ✓)`);
    console.log(
      `[2] 端口冲突并存:服务自动改用端口 ${readyInfo.port} 并就绪 ` +
        `(portMovedFrom=${readyInfo.portMovedFrom}, url=${readyInfo.url})`
    );

    console.log("\nPASS ✓ ISSUE-003 + 需求 7 回归:端口被占不误加载、自动换端口并存、如实上报");
    try { fake.close(); } catch { /* 忽略 */ }
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ ISSUE-003 + 需求 7 回归:", err.message);
    try { fake.close(); } catch { /* 忽略 */ }
    app.exit(1);
  }
});

require(path.join(__dirname, "..", "src", "main", "main.js"));