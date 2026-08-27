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
let appUpdateDownloads = 0; // 应用更新:下载/安装/重试 IPC 调用计数
let appUpdateInstalls = 0;
let appUpdateRetries = 0;
let tooltipShown = null; // 顶栏 tooltip:显示载荷({text,rect})
let tooltipHidden = 0; // 顶栏 tooltip:隐藏次数

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
ipcMain.handle("dsh:app-update-state", () => ({ state: "disabled", percent: 0, version: null, error: null }));
ipcMain.handle("dsh:app-update-download", () => {
  appUpdateDownloads += 1;
  return true;
});
ipcMain.handle("dsh:app-update-install", () => {
  appUpdateInstalls += 1;
  return true;
});
ipcMain.handle("dsh:app-update-retry", () => {
  appUpdateRetries += 1;
  return true;
});
// 顶栏 tooltip(气泡层):显示=记录载荷,隐藏=计数
ipcMain.on("dsh:tooltip-show", (_event, payload) => {
  tooltipShown = payload;
});
ipcMain.on("dsh:tooltip-hide", () => {
  tooltipHidden += 1;
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
        btnRadius: btnStyle ? btnStyle.borderRadius : null,
        iconW: iconStyle ? iconStyle.width : null,
        iconH: iconStyle ? iconStyle.height : null,
      };
    })()`);
    if (dom.hasTitle) throw new Error("顶栏仍显示应用名(.title 未移除)");
    if (dom.hasPlaceholder) throw new Error("顶栏仍显示占位文字");
    console.log("[1] 顶栏已去掉应用名与占位文字 ✓");

    // 1b. 按钮顺序(左→右:github、服务状态、底部面板、侧边栏)+ 固定 tooltips + 间距
    const order = await win.webContents.executeJavaScript(`(() => {
      const ids = ["githubBtn", "statusBtn", "pluginBottomBtn", "pluginSideBtn"];
      const els = ids.map((id) => document.getElementById(id));
      const rects = els.map((el) => el.getBoundingClientRect());
      const seq = ids.slice().sort((a, b) => rects[ids.indexOf(a)].left - rects[ids.indexOf(b)].left);
      const titles = ids.map((id) => document.getElementById(id).getAttribute("title"));
      const gaps = [];
      const spans = [];
      for (let i = 0; i < rects.length - 1; i++) {
        gaps.push(Math.round(rects[i + 1].left - rects[i].right));
        spans.push(Math.round(rects[i + 1].right - rects[i].left));
      }
      return { seq, titles, gaps, spans };
    })()`);
    const expectOrder = ["githubBtn", "statusBtn", "pluginBottomBtn", "pluginSideBtn"];
    if (JSON.stringify(order.seq) !== JSON.stringify(expectOrder))
      throw new Error(`按钮顺序应为 ${expectOrder},实际 ${order.seq}`);
    const expectTitles = ["点个Star 🤩", "服务管理", "面板", "侧栏"];
    if (JSON.stringify(order.titles) !== JSON.stringify(expectTitles))
      throw new Error(`tooltips 应为 ${JSON.stringify(expectTitles)},实际 ${JSON.stringify(order.titles)}`);
    // 间距定义:按钮背景 28×28,相邻间隙 4 → A 最左侧到 B 最右侧 = 60
    if (order.gaps.some((g) => g !== 4))
      throw new Error(`相邻按钮间距应为 4px,实际 ${JSON.stringify(order.gaps)}`);
    if (order.spans.some((s) => s !== 60))
      throw new Error(`相邻按钮跨度(A.left→B.right)应为 60(28+4+28),实际 ${JSON.stringify(order.spans)}`);
    console.log("[1b] 按钮顺序 github→服务管理→面板→侧栏 + tooltips(点个Star 🤩/服务管理/面板/侧栏) + 间距 4(A→B 跨度 60) ✓");
    if (!dom.hasBtn || !dom.hasIcon) throw new Error("GitHub 按钮或图标缺失");
    if (dom.btnW !== "28px" || dom.btnH !== "28px")
      throw new Error(`按钮应为 28×28,实际 ${dom.btnW}×${dom.btnH}`);
    if (dom.btnRadius !== "50%")
      throw new Error(`按钮应为正圆(border-radius 50%),实际 ${dom.btnRadius}`);
    if (dom.iconW !== "16px" || dom.iconH !== "16px")
      throw new Error(`图标应为 16×16,实际 ${dom.iconW}×${dom.iconH}`);
    if (dom.btnBg !== "rgba(0, 0, 0, 0)")
      throw new Error(`按钮默认应为透明背景,实际 ${dom.btnBg}`);
    console.log(`[2] 按钮 28×28 正圆 / 图标 16×16 / 默认透明背景 ✓`);

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

    // 4b. icon 素材:常态为线框素材;激活类存在时替换为 -1 实心素材(github 无激活态)
    const maskOf = (sel) =>
      win.webContents.executeJavaScript(`(() => {
        const cs = getComputedStyle(document.querySelector(${JSON.stringify(sel)}));
        return cs.webkitMaskImage || cs.maskImage || "";
      })()`);
    const icons = {
      github: await maskOf(".github-icon"),
      status: await maskOf(".status-icon"),
      bottom: await maskOf(".panel-icon-bottom"),
      side: await maskOf(".panel-icon-side"),
    };
    for (const [name, mask] of Object.entries(icons))
      if (!mask) throw new Error(`icon 样式缺 mask(webkitMaskImage 为空): ${name}`);
    const expectMask = (name, file) => {
      if (!icons[name].includes(file))
        throw new Error(`「${name}」常态 icon 应指向 ${file},实际 ${icons[name]}`);
    };
    expectMask("github", "github.svg");
    expectMask("status", "dashboard.svg");
    expectMask("bottom", "bottom.svg");
    expectMask("side", "sidebar.svg");
    console.log("[4b] icon 素材:github/dashboard/bottom/sidebar 常态 mask 正确 ✓");

    // 切激活类 → mask 换成 -1 实心素材(交互由「改颜色」改为「换素材」);
    // 且激活态不再常亮背景色(背景仅 hover) —— 断言激活时按钮背景透明
    const activeMasks = await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector(".status-btn");
      const pb = document.querySelector(".panel-icon-bottom");
      const ps = document.querySelector(".panel-icon-side");
      b.classList.add("status-btn-active");
      pb.parentElement.classList.add("panel-btn-active");
      ps.parentElement.classList.add("panel-btn-active");
      const read = (el) => getComputedStyle(el).webkitMaskImage || getComputedStyle(el).maskImage || "";
      const out = {
        status: read(b.querySelector(".status-icon")),
        bottom: read(pb),
        side: read(ps),
        statusBtnBg: getComputedStyle(b).backgroundColor,
        panelBtnBg: getComputedStyle(pb.parentElement).backgroundColor,
      };
      b.classList.remove("status-btn-active");
      pb.parentElement.classList.remove("panel-btn-active");
      ps.parentElement.classList.remove("panel-btn-active");
      return out;
    })()`);
    if (!activeMasks.status.includes("dashboard-1.svg"))
      throw new Error(`状态按钮激活应换 dashboard-1.svg,实际 ${activeMasks.status}`);
    if (!activeMasks.bottom.includes("bottom-1.svg"))
      throw new Error(`底部面板激活应换 bottom-1.svg,实际 ${activeMasks.bottom}`);
    if (!activeMasks.side.includes("sidebar-1.svg"))
      throw new Error(`侧边栏激活应换 sidebar-1.svg,实际 ${activeMasks.side}`);
    if (activeMasks.statusBtnBg !== "rgba(0, 0, 0, 0)" || activeMasks.panelBtnBg !== "rgba(0, 0, 0, 0)")
      throw new Error(`激活态不应常亮背景(仅 hover),实际 status=${activeMasks.statusBtnBg} panel=${activeMasks.panelBtnBg}`);
    console.log("[4c] 激活交互:激活类 → icon 替换为 -1 素材,且无常亮背景 ✓");

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

    // ========== 6. 更新红点:直径 = 原 9px 的一半(4.5px,等比缩放) ==========
    const dot = await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById("updateDot");
      if (!el) return null;
      const s = getComputedStyle(el);
      return { w: s.width, h: s.height, radius: s.borderRadius, pos: { top: s.top, right: s.right } };
    })()`);
    if (!dot) throw new Error("缺少 updateDot 红点元素");
    if (dot.w !== "4.5px" || dot.h !== "4.5px")
      throw new Error(`红点直径应为原 9px 的一半(4.5px),实际 ${dot.w}×${dot.h}`);
    if (dot.radius !== "50%") throw new Error(`红点应为正圆,实际 ${dot.radius}`);
    if (dot.pos.top !== "1.5px" || dot.pos.right !== "1.5px")
      throw new Error(`红点贴角位置应等比缩为 1.5px,实际 ${JSON.stringify(dot.pos)}`);
    console.log("[6] 更新红点:直径 4.5px(= 原 9px 一半)+ 正圆 + 贴角 1.5px ✓");

    // ========== 7. 应用自更新「新版本」按钮(github 左侧,≥30 间距 + 涂色进度) ==========
    const updRead = () => win.webContents.executeJavaScript(`(() => {
      const btn = document.getElementById("appUpdateBtn");
      const fill = document.getElementById("appUpdateFill");
      const github = document.getElementById("githubBtn");
      // hidden 属性 + 计算样式双读:hidden 属性可能被作者 CSS display 规则覆盖
      // (幽灵按钮回归 —— JS 设 hidden 但浏览器仍渲染),必须断言 computed display。
      const base = { hidden: btn.hidden, display: getComputedStyle(btn).display };
      if (btn.hidden) return base;
      const btnR = btn.getBoundingClientRect();
      const gR = github.getBoundingClientRect();
      const fR = fill.getBoundingClientRect();
      return {
        ...base,
        state: btn.dataset.state || "",
        label: document.getElementById("appUpdateLabel").textContent,
        title: btn.title,
        height: btnR.height,
        fontSize: getComputedStyle(document.getElementById("appUpdateLabel")).fontSize,
        gap: Math.round((gR.left - btnR.right) * 10) / 10,
        fillPct: Math.round((fR.width / btnR.width) * 1000) / 10,
        disabled: btn.disabled,
        indeterminate: btn.classList.contains("app-update-indeterminate"),
      };
    })()`);
    // 初始(disabled):按钮隐藏,不留空位;计算样式必须为 display:none(防幽灵按钮)
    const upd0 = await updRead();
    if (!upd0.hidden) throw new Error(`初始(disabled)按钮应隐藏,实际 ${JSON.stringify(upd0)}`);
    if (upd0.display !== "none")
      throw new Error(`初始(disabled)按钮计算样式应为 display:none,实际 ${upd0.display}(幽灵按钮回归)`);
    // available → 显示「新版本」,与 github 间距 ≥30
    win.webContents.send("dsh:app-update", { state: "available", percent: 0, version: "0.2.0", error: null });
    await new Promise((r) => setTimeout(r, 100));
    const upd1 = await updRead();
    if (upd1.hidden || upd1.state !== "available" || upd1.label !== "新版本")
      throw new Error(`available 态应显示「新版本」,实际 ${JSON.stringify(upd1)}`);
    if (upd1.gap < 30) throw new Error(`「新版本」按钮与 github 间距应 ≥30px,实际 ${upd1.gap}px`);
    // 高度 18px + 字号适配(10px)
    if (Math.round(upd1.height) !== 18)
      throw new Error(`「新版本」按钮高度应为 18px,实际 ${upd1.height}px`);
    if (upd1.fontSize !== "10px")
      throw new Error(`「新版本」按钮字号应适配 10px,实际 ${upd1.fontSize}`);
    // available → 点击开始下载
    await win.webContents.executeJavaScript(`document.getElementById("appUpdateBtn").click()`);
    await new Promise((r) => setTimeout(r, 100));
    if (appUpdateDownloads !== 1) throw new Error("点「新版本」应触发下载 IPC");
    // downloading 0%(点击后首个 progress 事件到达前)→「下载中 0%」+ 扫光 loading 态
    win.webContents.send("dsh:app-update", { state: "downloading", percent: 0, version: "0.2.0", error: null });
    await new Promise((r) => setTimeout(r, 100));
    const upd1b = await updRead();
    if (upd1b.label !== "下载中 0%") throw new Error(`点击后应即时显示「下载中 0%」,实际 ${upd1b.label}`);
    if (!upd1b.indeterminate)
      throw new Error(`0% 静默期应处于扫光 loading 态(indeterminate),实际 ${JSON.stringify(upd1b)}`);
    // downloading 47% → 文案「下载中 47%」+ 涂色 ≈47% + 扫光态被真实进度接管
    win.webContents.send("dsh:app-update", { state: "downloading", percent: 47, version: "0.2.0", error: null });
    await new Promise((r) => setTimeout(r, 250)); // > 涂色 transition 0.12s
    const upd2 = await updRead();
    if (upd2.label !== "下载中 47%") throw new Error(`下载中应显示「下载中 47%」,实际 ${upd2.label}`);
    if (Math.abs(upd2.fillPct - 47) > 2) throw new Error(`涂色宽度应 ≈47%,实际 ${upd2.fillPct}%`);
    if (upd2.indeterminate) throw new Error("首个真实进度到达后应取消扫光 loading 态");
    // 下载完成 → 「安装」+ 涂满 100%
    win.webContents.send("dsh:app-update", { state: "downloaded", percent: 100, version: "0.2.0", error: null });
    await new Promise((r) => setTimeout(r, 250)); // 从 47% 平滑涂满
    const upd3 = await updRead();
    if (upd3.label !== "安装") throw new Error(`下载完成应显示「安装」,实际 ${upd3.label}`);
    if (Math.abs(upd3.fillPct - 100) > 2) throw new Error(`下载完成涂色应涂满 100%,实际 ${upd3.fillPct}%`);
    // 安装 → 点击触发 install IPC
    await win.webContents.executeJavaScript(`document.getElementById("appUpdateBtn").click()`);
    await new Promise((r) => setTimeout(r, 100));
    if (appUpdateInstalls !== 1) throw new Error("点「安装」应触发 install IPC");
    // installing → 禁用
    win.webContents.send("dsh:app-update", { state: "installing", percent: 100, version: "0.2.0", error: null });
    await new Promise((r) => setTimeout(r, 100));
    const upd4 = await updRead();
    if (upd4.label !== "安装中…" || !upd4.disabled) throw new Error(`安装中应禁用「安装中…」,实际 ${JSON.stringify(upd4)}`);
    // error → 「重试」+ 点击触发 retry IPC(检查失败重查/下载失败重下,状态机分流)
    win.webContents.send("dsh:app-update", { state: "error", percent: 0, version: "0.2.0", error: "网络超时" });
    await new Promise((r) => setTimeout(r, 100));
    const upd5 = await updRead();
    if (upd5.label !== "重试") throw new Error(`错误应显示「重试」,实际 ${upd5.label}`);
    await win.webContents.executeJavaScript(`document.getElementById("appUpdateBtn").click()`);
    await new Promise((r) => setTimeout(r, 100));
    if (appUpdateRetries !== 1) throw new Error("点「重试」应触发 retry IPC");
    // up-to-date / disabled → 隐藏(不留空位)+ 计算样式 display:none(防幽灵按钮)
    win.webContents.send("dsh:app-update", { state: "up-to-date", percent: 0, version: null, error: null });
    await new Promise((r) => setTimeout(r, 100));
    const upd6 = await updRead();
    if (!upd6.hidden) throw new Error("已是最新后按钮应隐藏");
    if (upd6.display !== "none")
      throw new Error(`已是最新后按钮计算样式应为 display:none,实际 ${upd6.display}(幽灵按钮回归)`);
    console.log("[7] 应用更新按钮:available/下载中 47%+涂色/安装+涂满/安装中/重试/隐藏 + github 间距 ≥30 ✓");

    // ========== 8. 入口 tooltip:悬停防抖 250ms → tooltipShow(文案+按钮坐标);移出 → hide ==========
    const fire = (type) => win.webContents.executeJavaScript(
      `document.getElementById("pluginSideBtn").dispatchEvent(new MouseEvent(${JSON.stringify(type)})); true`
    );
    tooltipShown = null;
    tooltipHidden = 0;
    await fire("mouseenter");
    await new Promise((r) => setTimeout(r, 60));
    if (tooltipShown !== null)
      throw new Error(`防抖期内(60ms<250ms)不应 show,实际 ${JSON.stringify(tooltipShown)}`);
    await new Promise((r) => setTimeout(r, 260));
    if (!tooltipShown || tooltipShown.text !== "侧栏")
      throw new Error(`悬停应 tooltipShow('侧栏'),实际 ${JSON.stringify(tooltipShown)}`);
    if (!tooltipShown.rect || !tooltipShown.rect.left || !tooltipShown.rect.width)
      throw new Error(`tooltipShow 应携带按钮坐标 rect,实际 ${JSON.stringify(tooltipShown)}`);
    await fire("mouseleave");
    await new Promise((r) => setTimeout(r, 60));
    if (tooltipHidden !== 1) throw new Error(`移出应 tooltipHide,实际 ${tooltipHidden} 次`);
    // 防抖:再次悬停 60ms 后立刻移出 → 不 show 也不 hide 新的
    await fire("mouseenter");
    await new Promise((r) => setTimeout(r, 60));
    await fire("mouseleave");
    await new Promise((r) => setTimeout(r, 60));
    if (tooltipHidden !== 1) throw new Error(`防抖取消后不应再 hide,实际 ${tooltipHidden} 次`);
    console.log("[8] 入口 tooltip:悬停防抖→tooltipShow(文案+坐标),移出→hide,防抖取消 ✓");

    console.log("\nPASS ✓ 顶栏回归通过");
    win.destroy();
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 顶栏回归:", err.message);
    app.exit(1);
  }
});
