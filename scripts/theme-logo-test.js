#!/usr/bin/env node
"use strict";

/**
 * theme-logo-test.js — 回归测试:启动页的深/浅两套 logo 必须随主题只显示一张。
 *
 * 背景:曾出现两套 logo 同时显示的 bug —— .logo { display:block } 按源顺序
 * 覆盖了 .logo-light { display:none }(同优先级后写者胜)。
 * 本测试用真实 Electron 渲染加载页,分别在 dark/light 主题下断言 computed display。
 *
 * 用法: node scripts/theme-logo-test.js
 * (需要 electron;npm 脚本 test:theme)
 */

const { app, BrowserWindow, nativeTheme } = require("electron");
const path = require("node:path");
const os = require("node:os");

app.setPath("userData", path.join(os.tmpdir(), "dsh-box-theme-test"));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = () =>
    win.webContents.executeJavaScript(
      `(() => {
        const g = (sel) => getComputedStyle(document.querySelector(sel)).display;
        return { dark: g('.logo-dark'), light: g('.logo-light') };
      })()`,
      true
    );

  nativeTheme.themeSource = "dark";
  await sleep(300);
  const dark = await check();
  nativeTheme.themeSource = "light";
  await sleep(300);
  const light = await check();

  const okDark = dark.dark === "block" && dark.light === "none";
  const okLight = light.dark === "none" && light.light === "block";
  console.log("dark 主题:", JSON.stringify(dark), okDark ? "✓ 只显示 logo-dark" : "✗ 错误");
  console.log("light 主题:", JSON.stringify(light), okLight ? "✓ 只显示 logo-light" : "✗ 错误");
  console.log(okDark && okLight ? "\nPASS" : "\nFAIL");
  app.exit(okDark && okLight ? 0 : 1);
});
