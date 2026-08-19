#!/usr/bin/env node
"use strict";

/**
 * regression-topbar.js — 自定义顶栏回归测试(真实 Electron 驱动):
 *   1. 顶栏不再显示应用名「DSH Box」(红绿灯右侧留白,无占位文字);
 *   2. 右侧功能入口区有 GitHub 按钮:28×28、图标 20×20 居中、默认透明背景,
 *      且样式表里存在 :hover 背景规则(light/dark 由 light-dark() 自适应);
 *   3. 点击 GitHub 按钮 → 经外壳桥发出 openExternal,URL 为仓库地址;
 *   4. dsh 状态按钮:未激活时无 .status-btn-active;收到 open=true 状态同步
 *      后点亮;点击 → 触发 toggle-sidebar(面板开关由顶栏按钮控制)。
 *
 * 用法: electron scripts/regression-topbar.js --no-sandbox
 * 前置: assets/github.svg 存在(按钮图标)
 */

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

// 测试不污染用户目录:userData 重定向到工作区内
app.setPath("userData", path.resolve(__dirname, "..", ".runtime", "regression", "topbar-user"));

const GITHUB_URL = "https://github.com/hifengzy/dsh-box";
let openedUrl = null;
let toggled = 0;
let sidebarOpenFlag = false; // 与推送事件保持同步,点击 toggle 时翻转

// 模拟主进程:外链 / 更新标志 / 面板方向
ipcMain.handle("shell:open-external", (_event, url) => {
  openedUrl = url;
  return true;
});
ipcMain.handle("dsh:get-update-flag", () => ({ hasUpdate: false }));
ipcMain.handle("dsh:get-sidebar", () => ({ open: sidebarOpenFlag, canOpen: true }));
ipcMain.handle("dsh:toggle-sidebar", () => {
  toggled += 1;
  sidebarOpenFlag = !sidebarOpenFlag;
  return { open: sidebarOpenFlag, canOpen: true };
});

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 480,
      height: 140,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "..", "src", "preload", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "topbar.html"));

    // 1. 结构:无应用名、无占位文字,有按钮与图标
    const dom = await win.webContents.executeJavaScript(`(() => {
      const cs = (el) => (el ? getComputedStyle(el) : null);
      const btn = document.querySelector(".github-btn");
      const icon = document.querySelector(".github-icon");
      const btnStyle = cs(btn);
      const iconStyle = cs(icon);
      return {
        hasTitle: !!document.querySelector(".title"),
        hasPlaceholder: !!document.querySelector(".placeholder"),
        hasBtn: !!btn,
        hasIcon: !!icon,
        btnW: btnStyle ? btnStyle.width : null,
        btnH: btnStyle ? btnStyle.height : null,
        btnBg: btnStyle ? btnStyle.backgroundColor : null,
        iconW: iconStyle ? iconStyle.width : null,
        iconH: iconStyle ? iconStyle.height : null,
      };
    })()`);
    if (dom.hasTitle) throw new Error("顶栏仍显示应用名(.title 未移除)");
    if (dom.hasPlaceholder) throw new Error("顶栏仍显示占位文字");
    console.log("[1] 顶栏已去掉应用名与占位文字 ✓");
    if (!dom.hasBtn || !dom.hasIcon) throw new Error("GitHub 按钮或图标缺失");
    if (dom.btnW !== "28px" || dom.btnH !== "28px")
      throw new Error(`按钮应为 28×28,实际 ${dom.btnW}×${dom.btnH}`);
    if (dom.iconW !== "20px" || dom.iconH !== "20px")
      throw new Error(`图标应为 20×20,实际 ${dom.iconW}×${dom.iconH}`);
    if (dom.btnBg !== "rgba(0, 0, 0, 0)")
      throw new Error(`按钮默认应为透明背景,实际 ${dom.btnBg}`);
    console.log(`[2] GitHub 按钮 28×28 / 图标 20×20 / 默认透明背景 ✓`);

    // 2. 样式表存在 :hover 背景规则(默认无背景 → 悬停显示背景)
    const hasHoverRule = await win.webContents.executeJavaScript(`(() => {
      let text = "";
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) text += rule.cssText + "\\n";
        } catch { /* 跨源样式表忽略 */ }
      }
      return /\\.github-btn:hover[^{]*\\{[^}]*background-color/.test(text);
    })()`);
    if (!hasHoverRule) throw new Error("缺少 .github-btn:hover 背景规则");
    console.log("[3] 悬停显示背景规则存在(light/dark 自适应) ✓");

    // 3. 点击按钮 → openExternal(GITHUB_URL)
    await win.webContents.executeJavaScript(`document.querySelector(".github-btn").click()`);
    if (openedUrl !== GITHUB_URL)
      throw new Error(`点击应请求打开 ${GITHUB_URL},实际 ${openedUrl}`);
    console.log(`[4] 点击 GitHub 按钮 → openExternal(${GITHUB_URL}) ✓`);

    // 4. dsh 状态按钮:初始未激活;状态同步 open=true → 点亮;点击 → toggle
    const btnState = () =>
      win.webContents.executeJavaScript(`(() => {
        const b = document.querySelector(".status-btn");
        return {
          active: b.classList.contains("status-btn-active"),
          pressed: b.getAttribute("aria-pressed"),
          disabled: b.disabled,
        };
      })()`);
    const s0 = await btnState();
    if (s0.active || s0.pressed !== "false" || s0.disabled)
      throw new Error(`初始状态应未激活且可用,实际 ${JSON.stringify(s0)}`);
    // 主进程推送 open=true → 激活
    sidebarOpenFlag = true; // 让桩与推送一致,点击时才能翻回 false
    win.webContents.send("dsh:sidebar-state", { open: true, canOpen: true });
    await new Promise((r) => setTimeout(r, 100));
    const s1 = await btnState();
    if (!s1.active || s1.pressed !== "true")
      throw new Error(`面板展开状态应点亮按钮,实际 ${JSON.stringify(s1)}`);
    // 点击 → toggle-sidebar(面板开关由顶栏按钮控制)
    await win.webContents.executeJavaScript(`document.querySelector(".status-btn").click()`);
    await new Promise((r) => setTimeout(r, 100));
    if (toggled !== 1) throw new Error(`点击状态按钮应触发 toggle-sidebar,实际 ${toggled} 次`);
    const s2 = await btnState();
    if (s2.active) throw new Error("toggle 后 open=false 应熄灭激活态");
    console.log("[5] dsh 状态按钮:激活态同步 + 点击 toggle-sidebar ✓");

    console.log("\nPASS ✓ 顶栏回归通过");
    win.destroy();
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 顶栏回归:", err.message);
    app.exit(1);
  }
});
