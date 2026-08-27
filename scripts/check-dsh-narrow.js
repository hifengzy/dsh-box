#!/usr/bin/env node
"use strict";

/**
 * check-dsh-narrow.js — 实测 dsh WebUI 在窄宽度下的可用性(校准 CONTENT_OPEN_MIN)。
 *
 * 启动真实 dsh 服务 → 用裸 BrowserWindow 逐档缩窄窗口 → 测每个宽度下
 * dsh 页面是否出现横向滚动(horizontal overflow)与视口几何。
 *
 * 用法: electron scripts/check-dsh-narrow.js --no-sandbox
 * 结果人工判读:取「无横向滚动」的最大实用宽度,CONTENT_MIN 取它 + 余量。
 */

const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { DshServer } = require("../src/main/dsh-server");

app.setPath("userData", path.resolve(__dirname, "..", ".runtime", "narrow-check", "user"));

const PORT = 3299;
const WIDTHS = [1280, 1100, 1000, 960, 900, 860, 820, 780, 760, 720];
const SETTLE_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const base = path.resolve(__dirname, "..", ".runtime", "narrow-check");
  fs.mkdirSync(base, { recursive: true });
  const server = new DshServer({ port: PORT });
  try {
    await server.start({
      dshHome: path.join(base, "dsh-home"),
      logDir: path.join(base, "logs"),
    });
    console.log(`[narrow] dsh 就绪: ${server.url}`);
  } catch (err) {
    console.error("[narrow] dsh 启动失败:", err.message);
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({ width: 1280, height: 820, show: false });
  await win.loadURL(server.url);
  await sleep(1200); // 等 WebUI 首帧与布局稳定

  console.log("[narrow] 宽度扫描(横向溢出 = html.scrollWidth > clientWidth):");
  for (const w of WIDTHS) {
    win.setContentSize(w, 820);
    await sleep(SETTLE_MS);
    const m = await win.webContents.executeJavaScript(`(() => {
      const de = document.documentElement;
      return {
        sw: de.scrollWidth,
        cw: de.clientWidth,
        bodySw: document.body.scrollWidth,
        overflowX: de.scrollWidth > de.clientWidth + 1,
      };
    })()`);
    console.log(
      `  W=${String(w).padStart(4)}  scrollW=${String(m.sw).padStart(5)}  clientW=${String(m.cw).padStart(5)}  ` +
        (m.overflowX ? "⚠ 横向滚动" : "✓ 无横向滚动")
    );
  }

  win.destroy();
  await server.stop();
  console.log("[narrow] 完成。无横向滚动的最大实用宽度附近的数值用于校准 CONTENT_OPEN_MIN。");
  app.quit();
});