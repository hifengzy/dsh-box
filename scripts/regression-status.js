#!/usr/bin/env node
"use strict";

/**
 * regression-status.js — 「服务状态 + DSH + 侧边栏」面板 + 顶栏入口回归测试(真实 Electron):
 *   1. 运行中:「运行中」徽标(绿) + DSH 版本 + 端口/PID;不显示「启动服务」;
 *   2. DSH 板块:只展示最新一条版本(版本链接 + 「最新」徽标 + 发布日期),
 *      当前版本 < 最新 → 「更新」按钮;一致 → 「当前」文案;
 *   4. 查询失败:「网络服务异常」+「重试」;
 *   5. 点「更新」→ 经桥发出 upgrade(最新版本);
 *   6. 停止:灰「停止」徽标 + 「启动服务」按钮(不显示停止/重启);点击 → retry;
 *   8. 顶栏:更新标志为真 → 入口红点可见;点入口 → toggleSidebar;
 *   9. 顶栏插件按钮:未安装禁用;状态上报后启用+高亮;点击 → toggle-plugin-panel;
 *   10. 侧边栏板块:未安装→「安装」;已装==最新→「已安装」;已装<最新→「更新」;
 *      查询失败→「网络服务异常」+「重试」;安装/更新闭环;版本徽标 = 最新版本;
 *   11. 链接:DSH 版本号 / 插件名 → 仓库链接,悬停下划线(hover 规则存在);
 *   12. 插件市场板块:未安装→说明+「安装」;已装→「已安装」+「侧边栏入口」开关
 *      (默认关,点击翻转持久化);有更新→「更新」;失败→「网络服务异常」+「重试」。
 *
 * 用法: electron scripts/regression-status.js --no-sandbox
 * 说明:测试固定 nativeTheme=light,断言浅色 token 的具体值,结果确定。
 */

const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

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

// 版本行(发布时间倒序):首行 = rc.12 = 最新;rc.6 为当前运行版本
const VERSIONS = [];
for (let i = 12; i >= 1; i--) {
  const isCurrent = i === 6;
  const version = isCurrent ? "0.1.0-rc.6" : `0.1.0-rc.${i}`;
  VERSIONS.push({
    version,
    // 越界日期(Date.UTC 自动进位),保证按序递增;首行 rc.12 → 2026-08-01
    publishedAt: new Date(Date.UTC(2026, 6, 20 + i)).toISOString(),
    isLatest: i === 12,
    isCurrent,
    hasUpdate: i > 6,
    tarball: null,
    integrity: null,
  });
}

const FIXTURE_VERSIONS = {
  latest: "0.1.0-rc.12",
  runtime: "0.1.0-rc.6",
  hasUpdate: true,
  rows: VERSIONS,
  checkedAt: "2026-08-21T12:00:00.000Z",
  fromCache: false,
};

let state = "ready";
let upgradedVersion = null;
let retried = false;
let stopped = false;
let toggledSidebar = 0;
let toggledPluginPanel = null;
let openedExternal = null;
let marketInstalled = null; // null = 未安装
let marketLatest = "1.18.1";
let marketError = null;
let marketSwitchOn = false;
// 通知夹具(模拟主进程 dsh:notify-settings)
let notifyBanner = false;
let notifySound = false;
let notifyPermission = "unknown";
let notifySets = []; // 记录 set 调用
// 失败注入:非 null 时对应 action 返回失败(mock 真实主进程异常/失败)
let pluginInstallFail = null;
let marketInstallFail = null;
let upgradeFail = null;
let retryFail = false;
// 插件板块夹具:可变状态驱动各组断言
let pluginInstalled = null; // null = 未安装
let pluginLatest = "0.15.2";
let pluginError = null;
// 骨架屏测试:各查询方延迟(ms,0=立即)模拟不同数据源速度
let queryDelays = { info: 0, versions: 0, plugin: 0, market: 0, notify: 0 };
const sleepQ = async (key) => {
  if (queryDelays[key]) await new Promise((r) => setTimeout(r, queryDelays[key]));
};

/** 版本号大小比较(简单实现,夹具只用于 0.15.x) */
function verLt(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va < vb;
  }
  return false;
}

// 模拟主进程处理器(不真正启动/下载/打开)
ipcMain.handle("dsh:get-info", async () => {
  await sleepQ("info");
  return { ...FIXTURE_INFO, state };
});
ipcMain.handle("dsh:check-updates", async () => {
  await sleepQ("versions");
  return FIXTURE_VERSIONS;
});
ipcMain.handle("dsh:upgrade", (_e, v) => {
  upgradedVersion = v;
  if (upgradeFail) return { ok: false, error: upgradeFail };
  return { ok: true, previous: "0.1.0-rc.6", installed: v, backupDir: "/tmp/bak" };
});
ipcMain.handle("dsh:retry", async () => {
  retried = true;
  if (retryFail) { throw new Error("端口被占用(EADDRINUSE)"); }
  return { ...FIXTURE_INFO, state };
});
ipcMain.handle("dsh:stop", async () => {
  stopped = true;
  state = "stopped";
  return { ...FIXTURE_INFO, state };
});
ipcMain.handle("dsh:get-update-flag", () => ({ hasUpdate: true, latest: "0.1.0-rc.12" }));
ipcMain.handle("dsh:get-sidebar", () => ({ open: false, canOpen: true }));
ipcMain.handle("dsh:toggle-sidebar", () => {
  toggledSidebar += 1;
  return { open: true, canOpen: true };
});
// 侧边栏插件:查询(可变夹具)/安装(记录并更新已装版本)/顶栏面板切换
ipcMain.handle("dsh:plugin-info", async () => {
  await sleepQ("plugin");
  return {
    name: "dsh-better-sidebar",
    installed: pluginInstalled,
    latest: pluginLatest,
    hasUpdate: pluginInstalled !== null && pluginLatest !== null && verLt(pluginInstalled, pluginLatest),
    error: pluginError,
  };
});
ipcMain.handle("dsh:plugin-install", async (_e, v) => {
  if (pluginInstallFail) return { ok: false, error: pluginInstallFail };
  pluginInstalled = v ?? pluginLatest;
  return { ok: true, installed: pluginInstalled, previouslyInstalled: null, restarted: true };
});
ipcMain.handle("dsh:toggle-plugin-panel", (_e, which) => {
  toggledPluginPanel = which;
  return { ok: true };
});
// 插件市场:查询(可变夹具)/安装/侧边栏入口开关
ipcMain.handle("dsh:market-info", async () => {
  await sleepQ("market");
  return {
    name: "dshmarket",
    installed: marketInstalled,
    latest: marketLatest,
    hasUpdate: marketInstalled !== null && marketLatest !== null && verLt(marketInstalled, marketLatest),
    error: marketError,
  };
});
ipcMain.handle("dsh:market-install", async (_e, v) => {
  if (marketInstallFail) return { ok: false, error: marketInstallFail };
  marketInstalled = v ?? marketLatest;
  return { ok: true, installed: marketInstalled, previouslyInstalled: null, restarted: true };
});
ipcMain.handle("dsh:market-switch", (_e, next) => {
  if (next === undefined) return { ok: true, enabled: marketSwitchOn };
  marketSwitchOn = !!next;
  return { ok: true, enabled: marketSwitchOn };
});
// 通知:读/写开关 + 权限(模拟主进程;首次开启横幅无系统弹窗副作用)
ipcMain.handle("dsh:notify-settings", async (_e, next) => {
  if (next === undefined || next === null) {
    await sleepQ("notify");
    return { banner: notifyBanner, sound: notifySound, permission: notifyPermission };
  }
  if (typeof next.banner === "boolean") {
    notifyBanner = next.banner;
    notifySets.push({ banner: next.banner });
  }
  if (typeof next.sound === "boolean") {
    notifySound = next.sound;
    notifySets.push({ sound: next.sound });
  }
  return { banner: notifyBanner, sound: notifySound, permission: notifyPermission };
});
// 链接 → 系统浏览器(记录 URL 供断言)
ipcMain.handle("shell:open-external", (_e, url) => {
  openedExternal = url;
  return true;
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
    // ========== 1. 面板:运行中 ==========
    win = new BrowserWindow({ width: 720, height: 680, show: false, webPreferences: PRELOAD });
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300); // 等初始化 IPC 往返

    const ready = await win.webContents.executeJavaScript(`(() => {
      const cs = (el) => el ? getComputedStyle(el) : null;
      const pill = document.getElementById("statePill");
      return {
        label: document.getElementById("stateLabel").textContent,
        versionLine: document.getElementById("versionLine").textContent,
        meta: document.getElementById("metaLine").textContent,
        pillRunning: pill.classList.contains("state-running"),
        pillColor: cs(pill).color,
        startHidden: document.getElementById("startBtn").hidden,
      };
    })()`);
    if (ready.label !== "运行中") throw new Error(`运行中状态文案错误: ${ready.label}`);
    if (ready.versionLine !== "DSH 0.1.0-rc.6") throw new Error(`版本号展示错误: ${ready.versionLine}`);
    if (!ready.meta.includes("端口 3260") || !ready.meta.includes("PID 4242"))
      throw new Error(`端口/PID 展示错误: ${ready.meta}`);
    if (!ready.pillRunning) throw new Error("运行中徽标应带 state-running");
    if (ready.pillColor !== "rgb(34, 197, 94)") throw new Error(`运行中徽标应为绿色,实际 ${ready.pillColor}`);
    if (!ready.startHidden) throw new Error("运行中不应显示「启动服务」");
    console.log("[1] 运行中:绿徽标 + DSH 版本 + 端口/PID,无启动按钮 ✓");

    // ========== 2. DSH 板块:仅最新一条 + 最新徽标 + 更新按钮 ==========
    const dsh = await win.webContents.executeJavaScript(`(() => {
      const link = document.getElementById("dshVersionLink");
      return {
        rowHidden: document.getElementById("dshRow").hidden,
        version: link.textContent,
        linkHref: link.getAttribute("href"),
        badges: [...document.querySelectorAll("#dshRow .v-badge")].map((b) => b.textContent),
        updateHidden: document.getElementById("dshUpdateBtn").hidden,
        updateText: document.getElementById("dshUpdateBtn").textContent,
        currentHidden: document.getElementById("dshCurrentLabel").hidden,
        date: document.getElementById("dshDate").textContent,
        dateHidden: document.getElementById("dshDate").hidden,
      };
    })()`);
    if (dsh.rowHidden) throw new Error("DSH 板块应显示版本行");
    if (dsh.version !== "0.1.0-rc.12") throw new Error(`应只展示最新版本,实际 ${dsh.version}`);
    if (dsh.linkHref !== "https://github.com/deepseek-ai/deepseek-harness/")
      throw new Error(`DSH 版本链接错误: ${dsh.linkHref}`);
    if (dsh.badges.length !== 1 || dsh.badges[0] !== "最新")
      throw new Error(`应有「最新」徽标,实际 ${dsh.badges}`);
    if (dsh.updateHidden || dsh.updateText !== "更新")
      throw new Error("当前版本低于最新时应显示「更新」按钮");
    if (!dsh.currentHidden) throw new Error("有更新时不应显示「当前」");
    if (dsh.date !== "2026-08-01") throw new Error(`发布日期应为最新行日期,实际 ${dsh.date}`);
    if (dsh.dateHidden) throw new Error("应显示发布日期");
    console.log("[2] DSH 板块:只展示最新版本 0.1.0-rc.12 + 「最新」徽标 + 「更新」按钮 + 日期 ✓");

    // ========== 3. DSH 板块:「当前」态(运行版本 == 最新) ==========
    FIXTURE_VERSIONS.latest = "0.1.0-rc.6";
    FIXTURE_VERSIONS.hasUpdate = false;
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html")); // 重载触发重新查询
    await wait(300);
    const dshCur = await win.webContents.executeJavaScript(`(() => {
      const link = document.getElementById("dshVersionLink");
      return {
        version: link.textContent,
        updateHidden: document.getElementById("dshUpdateBtn").hidden,
        currentText: document.getElementById("dshCurrentLabel").textContent,
        currentHidden: document.getElementById("dshCurrentLabel").hidden,
        currentColor: getComputedStyle(document.getElementById("dshCurrentLabel")).color,
        badges: [...document.querySelectorAll("#dshRow .v-badge")].map((b) => b.textContent),
      };
    })()`);
    if (dshCur.version !== "0.1.0-rc.6") throw new Error(`无更新时仍展示最新版本,实际 ${dshCur.version}`);
    if (!dshCur.updateHidden) throw new Error("一致时不应显示「更新」按钮");
    if (dshCur.currentHidden || dshCur.currentText !== "当前")
      throw new Error(`一致时应显示「当前」,实际 ${dshCur.currentText}`);
    if (dshCur.currentColor !== "rgb(34, 197, 94)")
      throw new Error(`「当前」应为绿色,实际 ${dshCur.currentColor}`);
    if (dshCur.badges[0] !== "最新") throw new Error("「最新」徽标始终显示");
    console.log("[3] DSH 「当前」态:版本一致 → 绿色「当前」文案,无更新按钮 ✓");

    // ========== 4. DSH 查询失败:「网络服务异常」+「重试」 ==========
    FIXTURE_VERSIONS.error = "fetch failed";
    FIXTURE_VERSIONS.latest = "0.1.0-rc.12";
    FIXTURE_VERSIONS.hasUpdate = true;
    FIXTURE_VERSIONS.rows = [];
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300);
    const errState = await win.webContents.executeJavaScript(`(() => {
      return {
        errHidden: document.getElementById("dshError").hidden,
        errText: document.querySelector("#dshError .error-text").textContent,
        retryText: document.getElementById("dshRetryBtn").textContent,
        rowHidden: document.getElementById("dshRow").hidden,
      };
    })()`);
    if (errState.errHidden) throw new Error("查询失败应显示错误容器");
    if (errState.errText !== "网络服务异常") throw new Error(`错误文案应为「网络服务异常」,实际 ${errState.errText}`);
    if (errState.retryText !== "重试") throw new Error("应有「重试」按钮");
    if (!errState.rowHidden) throw new Error("失败时不应显示版本行");
    FIXTURE_VERSIONS.error = undefined;
    FIXTURE_VERSIONS.rows = VERSIONS;
    await win.webContents.executeJavaScript(`document.getElementById("dshRetryBtn").click(); undefined;`);
    await wait(250);
    const errRecover = await win.webContents.executeJavaScript(`(() => ({
      errHidden: document.getElementById("dshError").hidden,
      version: document.getElementById("dshVersionLink").textContent,
    }))()`);
    if (!errRecover.errHidden || errRecover.version !== "0.1.0-rc.12")
      throw new Error("重试后应恢复最新版本展示");
    console.log("[4] DSH 查询失败:「网络服务异常」+「重试」恢复 ✓");

    // ========== 5. 点「更新」→ upgrade(最新版本) ==========
    await win.webContents.executeJavaScript(`window.confirm = () => true; undefined;`);
    await win.webContents.executeJavaScript(`document.getElementById("dshUpdateBtn").click(); undefined;`);
    await wait(250);
    if (upgradedVersion !== "0.1.0-rc.12") throw new Error(`点「更新」应请求升级 0.1.0-rc.12,实际 ${upgradedVersion}`);
    console.log("[5] 点「更新」→ upgrade(0.1.0-rc.12) ✓");

    // ========== 6. 停止:灰「停止」+「启动服务」(无停止/重启按钮) ==========
    state = "stopped";
    win.webContents.send("dsh:status", { state: "stopped", message: "服务已停止" });
    await wait(150);
    const stoppedState = await win.webContents.executeJavaScript(`(() => {
      const cs = (el) => el ? getComputedStyle(el) : null;
      const pill = document.getElementById("statePill");
      return {
        label: document.getElementById("stateLabel").textContent,
        pillRunning: pill.classList.contains("state-running"),
        pillColor: cs(pill).color,
        meta: document.getElementById("metaLine").textContent,
        startHidden: document.getElementById("startBtn").hidden,
        startText: document.getElementById("startBtn").textContent,
        hasStopBtn: !!document.getElementById("stopBtn"),
        hasRestartBtn: !!document.getElementById("restartBtn"),
      };
    })()`);
    if (stoppedState.label !== "停止") throw new Error(`停止状态文案错误: ${stoppedState.label}`);
    if (stoppedState.pillRunning) throw new Error("停止时不应带 state-running");
    if (stoppedState.pillColor !== "rgb(129, 133, 140)")
      throw new Error(`停止徽标应为灰色,实际 ${stoppedState.pillColor}`);
    if (!stoppedState.meta.includes("端口 -") || !stoppedState.meta.includes("PID -"))
      throw new Error(`停止时端口/PID 应为 - ,实际 ${stoppedState.meta}`);
    if (stoppedState.startHidden || stoppedState.startText !== "启动服务")
      throw new Error("停止时应显示「启动服务」按钮");
    if (stoppedState.hasStopBtn || stoppedState.hasRestartBtn)
      throw new Error("新设计下不应存在停止/重启按钮");
    await win.webContents.executeJavaScript(`document.getElementById("startBtn").click(); undefined;`);
    await wait(150);
    if (!retried) throw new Error("点「启动服务」应触发 retry");
    console.log("[6] 停止:灰徽标 + 端口/PID 为 - + 仅「启动服务」→ retry ✓");

    // ========== 7. 版本号超长截断(服务状态区) ==========
    state = "ready";
    win.webContents.send("dsh:status", { state: "ready", message: "服务运行中" });
    await wait(100);
    const trunc = await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById("versionLine");
      return {
        css: getComputedStyle(el),
        title: el.title,
      };
    })()`);
    if (trunc.css.textOverflow !== "ellipsis" || trunc.css.whiteSpace !== "nowrap" || trunc.css.overflow !== "hidden")
      throw new Error("版本号应配置超长截断(ellipsis)");
    if (trunc.title !== "DSH 0.1.0-rc.6") throw new Error("版本号完整值应放入 title");
    console.log("[7] 版本号超长截断(ellipsis + title) ✓");

    // ========== 8. 顶栏:红点可见 + 入口点击开/关面板(同窗口换页) ==========
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
    await win.webContents.executeJavaScript(`document.getElementById("statusBtn").click(); undefined;`);
    await wait(100);
    if (toggledSidebar !== 1) throw new Error("点顶栏状态入口应触发 toggle-sidebar(面板开关)");
    console.log("[8] 顶栏:红点可见 + 点击入口 toggle-sidebar ✓");

    // ========== 9. 顶栏插件按钮:未安装禁用 → 状态上报启用+高亮 → 点击转发 ==========
    const tbp = await win.webContents.executeJavaScript(`(() => {
      const side = document.getElementById("pluginSideBtn");
      const bottom = document.getElementById("pluginBottomBtn");
      return {
        sideDisabled: side.disabled,
        bottomDisabled: bottom.disabled,
        sideActive: side.classList.contains("panel-btn-active"),
      };
    })()`);
    if (!tbp.sideDisabled || !tbp.bottomDisabled)
      throw new Error("插件未安装时顶栏面板按钮应禁用");
    if (tbp.sideActive) throw new Error("初始不应有激活态");
    // 主进程广播 plugin-panels 状态:两个按钮启用,侧栏展开 → 侧栏按钮高亮
    win.webContents.send("dsh:plugin-panels", { installed: true, active: true, side: true, bottom: false });
    await wait(100);
    const tbp2 = await win.webContents.executeJavaScript(`(() => {
      const side = document.getElementById("pluginSideBtn");
      const bottom = document.getElementById("pluginBottomBtn");
      return {
        sideDisabled: side.disabled,
        bottomDisabled: bottom.disabled,
        sideActive: side.classList.contains("panel-btn-active"),
        bottomActive: bottom.classList.contains("panel-btn-active"),
        sidePressed: side.getAttribute("aria-pressed"),
        sideTitle: side.title,
      };
    })()`);
    if (tbp2.sideDisabled || tbp2.bottomDisabled) throw new Error("插件已装时应启用两个按钮");
    if (!tbp2.sideActive) throw new Error("侧栏展开时侧栏按钮应高亮");
    if (tbp2.bottomActive) throw new Error("底栏折叠时底栏按钮不应高亮");
    if (tbp2.sidePressed !== "true") throw new Error("aria-pressed 应同步为 true");
    // tooltip 固定(需求:点个Star 🤩/服务管理/面板/侧栏,不随开合状态变化)
    if (tbp2.sideTitle !== "侧栏") throw new Error(`侧栏按钮 tooltip 应为「侧栏」,实际 ${tbp2.sideTitle}`);
    const bottomTitle = await win.webContents.executeJavaScript(
      `document.getElementById("pluginBottomBtn").title`
    );
    if (bottomTitle !== "面板") throw new Error(`底栏按钮 tooltip 应为「面板」,实际 ${bottomTitle}`);
    await win.webContents.executeJavaScript(`document.getElementById("pluginSideBtn").click(); undefined;`);
    await wait(100);
    if (toggledPluginPanel !== "side") throw new Error("点侧栏按钮应触发 toggle-plugin-panel('side')");
    // 状态闭合 → 高亮取消
    win.webContents.send("dsh:plugin-panels", { installed: true, active: true, side: false, bottom: false });
    await wait(100);
    const tbp3 = await win.webContents.executeJavaScript(
      `document.getElementById("pluginSideBtn").classList.contains("panel-btn-active")`
    );
    if (tbp3) throw new Error("侧栏闭合后按钮高亮应取消");
    console.log("[9] 顶栏插件按钮:禁用→启用+高亮→点击转发→闭合取消 ✓");

    // ========== 10. 侧边栏板块:四态 + 安装/更新闭环 + 版本徽标 ==========
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300);

    // 10a. 未安装:名称 + 版本徽标(最新)+ 说明 + 「安装」
    pluginInstalled = null;
    pluginLatest = "0.15.2";
    pluginError = null;
    await win.webContents.executeJavaScript(`document.getElementById("pluginHint"); undefined;`);
    await wait(120);
    const pi1 = await win.webContents.executeJavaScript(`(() => {
      const row = document.getElementById("pluginRow");
      return {
        rowHidden: row.hidden,
        name: document.getElementById("pluginNameLink").textContent,
        nameHref: document.getElementById("pluginNameLink").getAttribute("href"),
        badge: document.getElementById("pluginVersionBadge").textContent,
        badgeHidden: document.getElementById("pluginVersionBadge").hidden,
        actionHidden: document.getElementById("pluginActionBtn").hidden,
        actionText: document.getElementById("pluginActionBtn").textContent,
        installedHidden: document.getElementById("pluginInstalledLabel").hidden,
        descHidden: document.getElementById("pluginDesc").hidden,
        desc: document.getElementById("pluginDesc").textContent,
      };
    })()`);
    if (pi1.rowHidden) throw new Error("插件行应显示");
    if (pi1.name !== "dsh-better-sidebar") throw new Error(`插件名错误: ${pi1.name}`);
    if (pi1.nameHref !== "https://github.com/omdsh-dev/DSH-better-sidebar")
      throw new Error(`插件名链接错误: ${pi1.nameHref}`);
    if (pi1.badge !== "0.15.2" || pi1.badgeHidden)
      throw new Error(`版本徽标应显示最新版本 0.15.2,实际 ${pi1.badge}`);
    if (pi1.actionHidden || pi1.actionText !== "安装")
      throw new Error(`未安装应显示「安装」按钮,实际 hidden=${pi1.actionHidden} text=${pi1.actionText}`);
    if (!pi1.installedHidden) throw new Error("未安装时不应显示「已安装」");
    if (pi1.descHidden || !pi1.desc.includes("文件渲染编辑"))
      throw new Error(`应显示说明文案,实际 ${pi1.desc}`);
    console.log("[10a] 侧边栏:未安装 → 版本徽标 0.15.2 + 说明 + 「安装」 ✓");

    // 10b. 点「安装」→ install 闭环 → 已安装(绿字)+ 无按钮
    await win.webContents.executeJavaScript(`window.confirm = () => true; undefined;`);
    await win.webContents.executeJavaScript(`document.getElementById("pluginActionBtn").click(); undefined;`);
    await wait(280);
    if (pluginInstalled !== "0.15.2") throw new Error(`点「安装」应 install 0.15.2,实际 ${pluginInstalled}`);
    const pi2 = await win.webContents.executeJavaScript(`(() => {
      return {
        badge: document.getElementById("pluginVersionBadge").textContent,
        actionHidden: document.getElementById("pluginActionBtn").hidden,
        installedText: document.getElementById("pluginInstalledLabel").textContent,
        installedHidden: document.getElementById("pluginInstalledLabel").hidden,
        installedColor: getComputedStyle(document.getElementById("pluginInstalledLabel")).color,
      };
    })()`);
    if (!pi2.actionHidden) throw new Error("已装且无更新应隐藏按钮");
    if (pi2.installedHidden || pi2.installedText !== "已安装")
      throw new Error(`装完应显示「已安装」,实际 ${pi2.installedText}`);
    if (pi2.installedColor !== "rgb(34, 197, 94)") throw new Error("「已安装」应为绿色");
    if (pi2.badge !== "0.15.2") throw new Error(`版本徽标应为最新,实际 ${pi2.badge}`);
    console.log("[10b] 安装闭环:装完 → 「已安装」绿字 + 无按钮,徽标最新 ✓");

    // 10c. 已装但低于最新 → 「更新」;点更新 → 安装最新 → 已安装
    pluginInstalled = "0.15.0";
    pluginLatest = "0.15.1";
    pluginError = null;
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html")); // 重载触发重新查询
    await wait(300);
    const pi3 = await win.webContents.executeJavaScript(`(() => {
      return {
        badge: document.getElementById("pluginVersionBadge").textContent,
        actionHidden: document.getElementById("pluginActionBtn").hidden,
        actionText: document.getElementById("pluginActionBtn").textContent,
        installedHidden: document.getElementById("pluginInstalledLabel").hidden,
      };
    })()`);
    if (pi3.badge !== "0.15.1") throw new Error(`版本徽标应显示最新 0.15.1,实际 ${pi3.badge}`);
    if (pi3.actionHidden || pi3.actionText !== "更新")
      throw new Error(`有更新应显示「更新」按钮,实际 hidden=${pi3.actionHidden} text=${pi3.actionText}`);
    if (!pi3.installedHidden) throw new Error("有更新时不应显示「已安装」");
    // 10c 重载过页面 → confirm 又变回原生对话框,必须重新置真
    await win.webContents.executeJavaScript(`window.confirm = () => true; undefined;`);
    await win.webContents.executeJavaScript(`document.getElementById("pluginActionBtn").click(); undefined;`);
    await wait(280);
    if (pluginInstalled !== "0.15.1") throw new Error(`点「更新」应 install 最新,实际 ${pluginInstalled}`);
    const pi4 = await win.webContents.executeJavaScript(`(() => ({
      actionHidden: document.getElementById("pluginActionBtn").hidden,
      installedHidden: document.getElementById("pluginInstalledLabel").hidden,
    }))()`);
    if (!pi4.actionHidden || pi4.installedHidden)
      throw new Error("更新到最新后应显示「已安装」且隐藏按钮");
    console.log("[10c] 更新闭环:已装 0.15.0 < 最新 0.15.1 → 「更新」 → 装完「已安装」 ✓");

    // 10d. 查询失败(未安装):「网络服务异常」+「重试」;点重试恢复
    pluginInstalled = null;
    pluginError = "fetch failed";
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html")); // 重载触发重新查询
    await wait(300);
    const pi5 = await win.webContents.executeJavaScript(`(() => {
      return {
        rowHidden: document.getElementById("pluginRow").hidden,
        errText: document.querySelector("#pluginError .error-text").textContent,
        buttons: [...document.querySelectorAll("#pluginError button")].map((b) => b.textContent),
      };
    })()`);
    if (!pi5.rowHidden) throw new Error("失败时插件行应隐藏");
    if (pi5.errText !== "网络服务异常") throw new Error(`失败态应有「网络服务异常」,实际 ${pi5.errText}`);
    if (pi5.buttons.length !== 1 || pi5.buttons[0] !== "重试")
      throw new Error(`失败态应只有「重试」,实际 ${pi5.buttons}`);
    // 10d.2 已装 + 失败:行显示本地版本 + 「网络异常,无法检查更新」+ 重试
    pluginInstalled = "0.15.0";
    pluginError = "fetch failed";
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300);
    const pi5b = await win.webContents.executeJavaScript(`(() => {
      return {
        badge: document.getElementById("pluginVersionBadge").textContent,
        errText: document.querySelector("#pluginError .error-text").textContent,
        buttons: [...document.querySelectorAll("#pluginError button")].map((b) => b.textContent),
        actionHidden: document.getElementById("pluginActionBtn").hidden,
      };
    })()`);
    if (pi5b.badge !== "0.15.0") throw new Error(`已装+失败时徽标应回退本地版本,实际 ${pi5b.badge}`);
    if (pi5b.errText !== "网络异常,无法检查更新")
      throw new Error(`已装+失败文案错误: ${pi5b.errText}`);
    if (!pi5b.actionHidden) throw new Error("已装+失败时不应有安装/更新按钮");
    if (pi5b.buttons.length !== 1 || pi5b.buttons[0] !== "重试")
      throw new Error(`已装+失败应只有「重试」,实际 ${pi5b.buttons}`);
    // 恢复 → 点重试 → 回到「更新」态(0.15.0 < 0.15.1)
    pluginError = null;
    pluginLatest = "0.15.1";
    await win.webContents.executeJavaScript(`document.getElementById("pluginRetryBtn").click(); undefined;`);
    await wait(250);
    const pi6 = await win.webContents.executeJavaScript(`(() => ({
      errHidden: document.getElementById("pluginError").hidden,
      badge: document.getElementById("pluginVersionBadge").textContent,
      actionHidden: document.getElementById("pluginActionBtn").hidden,
      actionText: document.getElementById("pluginActionBtn").textContent,
    }))()`);
    if (!pi6.errHidden || pi6.actionHidden || pi6.actionText !== "更新")
      throw new Error("重试后应恢复「更新」态");
    console.log("[10d] 查询失败:未装→错误+重试;已装→本地版本+警示+重试;重试恢复 ✓");

    // ========== 11. 链接悬停下划线(hover 规则存在) ==========
    const linkRules = await win.webContents.executeJavaScript(`(() => {
      const hoverOK = (selector) => {
        for (const sh of document.styleSheets) {
          try {
            for (const r of sh.cssRules) {
              if (r.selectorText === selector) {
                return r.style.textDecoration === 'underline' || r.style.textDecorationLine === 'underline';
              }
            }
          } catch { /* 跨域样式表跳过 */ }
        }
        return false;
      };
      const cs = (el) => {
        const s = getComputedStyle(el);
        return { color: s.color, deco: s.textDecorationLine, cursor: s.cursor };
      };
      return {
        dshLink: cs(document.getElementById("dshVersionLink")),
        pluginLink: cs(document.getElementById("pluginNameLink")),
        hoverRule: hoverOK(".row-link:hover"),
      };
    })()`);
    if (!linkRules.hoverRule) throw new Error(".row-link:hover 应有 text-decoration: underline 规则");
    if (linkRules.dshLink.deco !== "none") throw new Error("链接默认不应有下划线");
    if (linkRules.pluginLink.cursor !== "pointer") throw new Error("插件名链接应可点击(cursor:pointer)");
    // 点击 → 系统浏览器(openExternal),页面不导航
    await win.webContents.executeJavaScript(`document.getElementById("dshVersionLink").click(); undefined;`);
    await wait(100);
    if (openedExternal !== "https://github.com/deepseek-ai/deepseek-harness/")
      throw new Error(`DSH 版本链接应走 openExternal,实际 ${openedExternal}`);
    const urlAfterDshClick = win.webContents.getURL();
    await win.webContents.executeJavaScript(`document.getElementById("pluginNameLink").click(); undefined;`);
    await wait(100);
    if (openedExternal !== "https://github.com/omdsh-dev/DSH-better-sidebar")
      throw new Error(`插件名链接应走 openExternal,实际 ${openedExternal}`);
    const urlAfterPluginClick = win.webContents.getURL();
    if (!urlAfterDshClick.startsWith("file:") || !urlAfterPluginClick.startsWith("file:"))
      throw new Error("点击链接不应在 Electron 内导航(应保持 file:// 面板)");
    console.log("[11] 链接:仓库链接 + hover 下划线 + 点击走系统浏览器(不导航) ✓");

    // ========== 12. 插件市场板块:四态 + 安装闭环 + 开关 ==========
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300);

    // 12a. 未安装:名称 + 版本徽标 + 说明 + 「安装」;无开关行
    marketInstalled = null;
    marketLatest = "1.18.1";
    marketError = null;
    marketSwitchOn = false;
    await win.webContents.executeJavaScript(`document.getElementById("marketHint"); undefined;`);
    await wait(120);
    const mk1 = await win.webContents.executeJavaScript(`(() => {
      const row = document.getElementById("marketRow");
      return {
        rowHidden: row.hidden,
        name: document.getElementById("marketName").textContent,
        badge: document.getElementById("marketVersionBadge").textContent,
        badgeHidden: document.getElementById("marketVersionBadge").hidden,
        actionText: document.getElementById("marketActionBtn").textContent,
        actionHidden: document.getElementById("marketActionBtn").hidden,
        installedHidden: document.getElementById("marketInstalledLabel").hidden,
        descHidden: document.getElementById("marketDesc").hidden,
        desc: document.getElementById("marketDesc").textContent,
        switchHidden: document.getElementById("marketSwitchRow").hidden,
      };
    })()`);
    if (mk1.rowHidden) throw new Error("插件市场行应显示");
    if (mk1.name !== "dsh-market") throw new Error(`名称应为 dsh-market,实际 ${mk1.name}`);
    // 市场名链接 → 系统浏览器(openExternal),页面不导航
    await win.webContents.executeJavaScript(`document.getElementById("marketName").click(); undefined;`);
    await wait(100);
    if (openedExternal !== "https://github.com/dsh-market/dsh-market")
      throw new Error(`市场名链接应走 openExternal,实际 ${openedExternal}`);
    const urlAfterMarketClick = win.webContents.getURL();
    if (!urlAfterMarketClick.startsWith("file:"))
      throw new Error("点击市场链接不应在 Electron 内导航(应保持 file:// 面板)");
    if (mk1.badge !== "1.18.1" || mk1.badgeHidden)
      throw new Error(`版本徽标应显示最新 1.18.1,实际 ${mk1.badge}`);
    if (mk1.actionHidden || mk1.actionText !== "安装")
      throw new Error("未安装应显示「安装」按钮");
    if (!mk1.installedHidden) throw new Error("未安装不应显示「已安装」");
    if (mk1.descHidden || !mk1.desc.includes("浏览、搜索、安装、更新、卸载"))
      throw new Error(`未安装应显示说明文案,实际 ${mk1.desc}`);
    if (!mk1.switchHidden) throw new Error("未安装不应显示开关行");
    console.log("[12a] 插件市场:未安装 → 名称+徽标 1.18.1+说明+「安装」,无开关 ✓");

    // 12b. 点「安装」→ 已安装(绿字)+ 开关行(默认关);点开关 → 持久化 on
    await win.webContents.executeJavaScript(`window.confirm = () => true; undefined;`);
    await win.webContents.executeJavaScript(`document.getElementById("marketActionBtn").click(); undefined;`);
    await wait(280);
    if (marketInstalled !== "1.18.1") throw new Error(`点「安装」应 install 1.18.1,实际 ${marketInstalled}`);
    const mk2 = await win.webContents.executeJavaScript(`(() => {
      const sw = document.getElementById("marketSwitch");
      return {
        badge: document.getElementById("marketVersionBadge").textContent,
        actionHidden: document.getElementById("marketActionBtn").hidden,
        installedText: document.getElementById("marketInstalledLabel").textContent,
        installedHidden: document.getElementById("marketInstalledLabel").hidden,
        installedColor: getComputedStyle(document.getElementById("marketInstalledLabel")).color,
        descHidden: document.getElementById("marketDesc").hidden,
        switchHidden: document.getElementById("marketSwitchRow").hidden,
        switchChecked: sw.getAttribute("aria-checked"),
        switchOn: sw.classList.contains("switch-on"),
      };
    })()`);
    if (!mk2.actionHidden || mk2.installedHidden || mk2.installedText !== "已安装")
      throw new Error("装完应显示「已安装」且无按钮");
    if (mk2.installedColor !== "rgb(34, 197, 94)") throw new Error("「已安装」应为绿色");
    if (!mk2.descHidden) throw new Error("已安装后应隐藏说明文案");
    if (mk2.switchHidden) throw new Error("已安装后应显示开关行");
    if (mk2.switchChecked !== "false" || mk2.switchOn)
      throw new Error("开关应默认关闭");
    // 点击开关 → on
    await win.webContents.executeJavaScript(`document.getElementById("marketSwitch").click(); undefined;`);
    await wait(150);
    if (marketSwitchOn !== true) throw new Error("点开关应 setMarketSwitch(true)");
    const mk2b = await win.webContents.executeJavaScript(`(() => {
      const sw = document.getElementById("marketSwitch");
      return { checked: sw.getAttribute("aria-checked"), on: sw.classList.contains("switch-on") };
    })()`);
    if (mk2b.checked !== "true" || !mk2b.on) throw new Error("开关点击后应呈现开态");
    console.log("[12b] 插件市场:安装闭环 → 「已安装」+ 开关(默认关,点击开) ✓");

    // 12c. 已装但低于最新 → 「更新」;点更新 → 装完已安装
    marketInstalled = "1.17.0";
    marketLatest = "1.18.0";
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html")); // 重载触发重新查询
    await wait(300);
    const mk3 = await win.webContents.executeJavaScript(`(() => ({
      badge: document.getElementById("marketVersionBadge").textContent,
      actionHidden: document.getElementById("marketActionBtn").hidden,
      actionText: document.getElementById("marketActionBtn").textContent,
      installedHidden: document.getElementById("marketInstalledLabel").hidden,
      switchHidden: document.getElementById("marketSwitchRow").hidden,
    }))()`);
    if (mk3.badge !== "1.18.0") throw new Error(`版本徽标应显示最新 1.18.0,实际 ${mk3.badge}`);
    if (mk3.actionHidden || mk3.actionText !== "更新")
      throw new Error("有更新应显示「更新」按钮");
    if (!mk3.installedHidden) throw new Error("有更新不应显示「已安装」");
    if (mk3.switchHidden) throw new Error("已装态应显示开关行");
    await win.webContents.executeJavaScript(`window.confirm = () => true; undefined;`);
    await win.webContents.executeJavaScript(`document.getElementById("marketActionBtn").click(); undefined;`);
    await wait(280);
    if (marketInstalled !== "1.18.0") throw new Error(`点「更新」应 install 最新,实际 ${marketInstalled}`);
    const mk4 = await win.webContents.executeJavaScript(`(() => ({
      actionHidden: document.getElementById("marketActionBtn").hidden,
      installedHidden: document.getElementById("marketInstalledLabel").hidden,
    }))()`);
    if (!mk4.actionHidden || mk4.installedHidden) throw new Error("更新后应「已安装」");
    console.log("[12c] 插件市场:已装 1.17.0 < 最新 1.18.0 → 「更新」 → 装完「已安装」 ✓");

    // 12d. 查询失败:未装→错误+重试;已装→警示+重试;恢复
    marketInstalled = null;
    marketError = "fetch failed";
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300);
    const mk5 = await win.webContents.executeJavaScript(`(() => ({
      rowHidden: document.getElementById("marketRow").hidden,
      errText: document.querySelector("#marketError .error-text").textContent,
      retryBtns: [...document.querySelectorAll("#marketError button")].map((b) => b.textContent),
    }))()`);
    if (!mk5.rowHidden || mk5.errText !== "网络服务异常" || mk5.retryBtns[0] !== "重试")
      throw new Error("未装+失败应显示错误+重试");
    marketInstalled = "1.17.0";
    marketError = "fetch failed";
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300);
    const mk5b = await win.webContents.executeJavaScript(`(() => ({
      badge: document.getElementById("marketVersionBadge").textContent,
      errText: document.querySelector("#marketError .error-text").textContent,
      actionHidden: document.getElementById("marketActionBtn").hidden,
    }))()`);
    if (mk5b.badge !== "1.17.0" || mk5b.errText !== "网络异常,无法检查更新" || !mk5b.actionHidden)
      throw new Error("已装+失败应回退本地版本+警示");
    marketError = null;
    marketLatest = "1.18.1";
    await win.webContents.executeJavaScript(`document.getElementById("marketRetryBtn").click(); undefined;`);
    await wait(250);
    const mk6 = await win.webContents.executeJavaScript(`(() => ({
      errHidden: document.getElementById("marketError").hidden,
      actionText: document.getElementById("marketActionBtn").textContent,
      actionHidden: document.getElementById("marketActionBtn").hidden,
    }))()`);
    if (!mk6.errHidden || mk6.actionHidden || mk6.actionText !== "更新")
      throw new Error("重试后应恢复「更新」态");
    console.log("[12d] 插件市场:查询失败(未装/已装)+ 重试恢复 ✓");

    // ========== 13. 失败重置:安装/更新/启动失败后按钮不得卡在「××中…」 ==========
    // 13a. 侧边栏插件安装失败 → 按钮重置「安装」+ hint 展示错误
    pluginInstalled = null;
    pluginLatest = "0.15.2";
    pluginError = null;
    pluginInstallFail = "模拟安装失败";
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300);
    await win.webContents.executeJavaScript(`window.confirm = () => true; undefined;`);
    await win.webContents.executeJavaScript(`document.getElementById("pluginActionBtn").click(); undefined;`);
    await wait(280);
    const f1 = await win.webContents.executeJavaScript(`(() => ({
      actionHidden: document.getElementById("pluginActionBtn").hidden,
      actionText: document.getElementById("pluginActionBtn").textContent,
      actionDisabled: document.getElementById("pluginActionBtn").disabled,
      hint: document.getElementById("pluginHint").textContent,
    }))()`);
    if (f1.actionHidden || f1.actionText !== "安装" || f1.actionDisabled)
      throw new Error(`安装失败后按钮应重置为「安装」,实际 ${JSON.stringify(f1)}`);
    const f1h = await win.webContents.executeJavaScript(`(() => ({
      hidden: document.getElementById("pluginHint").hidden,
      text: document.getElementById("pluginHint").textContent,
    }))()`);
    if (f1h.hidden || !f1h.text.includes("安装失败") || !f1h.text.includes("模拟安装失败"))
      throw new Error(`应展示失败原因且可见,实际 ${JSON.stringify(f1h)}`);
    pluginInstallFail = null;
    console.log("[13a] 插件安装失败:按钮重置「安装」+ 展示错误 ✓");

    // 13b. 插件市场安装失败 → 按钮重置「安装」
    marketInstalled = null;
    marketLatest = "1.18.1";
    marketError = null;
    marketInstallFail = "模拟市场失败";
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300);
    await win.webContents.executeJavaScript(`window.confirm = () => true; undefined;`);
    await win.webContents.executeJavaScript(`document.getElementById("marketActionBtn").click(); undefined;`);
    await wait(280);
    const f2 = await win.webContents.executeJavaScript(`(() => ({
      actionText: document.getElementById("marketActionBtn").textContent,
      actionDisabled: document.getElementById("marketActionBtn").disabled,
      hint: document.getElementById("marketHint").textContent,
    }))()`);
    const f2h = await win.webContents.executeJavaScript(`(() => ({
      hidden: document.getElementById("marketHint").hidden,
      text: document.getElementById("marketHint").textContent,
    }))()`);
    if (f2.actionText !== "安装" || f2.actionDisabled || f2h.hidden || !f2h.text.includes("安装失败"))
      throw new Error(`市场安装失败后按钮应重置,实际 ${JSON.stringify(f2)} hint=${JSON.stringify(f2h)}`);
    marketInstallFail = null;
    console.log("[13b] 插件市场安装失败:按钮重置「安装」+ 展示错误 ✓");

    // 13c. DSH 升级失败 → 按钮重置「更新」
    FIXTURE_VERSIONS.error = undefined;
    FIXTURE_VERSIONS.latest = "0.1.0-rc.12";
    FIXTURE_VERSIONS.hasUpdate = true;
    FIXTURE_VERSIONS.rows = VERSIONS;
    upgradeFail = "模拟升级失败";
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300);
    await win.webContents.executeJavaScript(`window.confirm = () => true; undefined;`);
    await win.webContents.executeJavaScript(`document.getElementById("dshUpdateBtn").click(); undefined;`);
    await wait(280);
    const f3 = await win.webContents.executeJavaScript(`(() => ({
      btnText: document.getElementById("dshUpdateBtn").textContent,
      btnDisabled: document.getElementById("dshUpdateBtn").disabled,
      hint: document.getElementById("upgradeHint").textContent,
    }))()`);
    if (f3.btnText !== "更新" || f3.btnDisabled || !f3.hint.includes("升级失败"))
      throw new Error(`升级失败后按钮应重置「更新」,实际 ${JSON.stringify(f3)}`);
    upgradeFail = null;
    console.log("[13c] DSH 升级失败:按钮重置「更新」+ 展示错误 ✓");

    // 13d. 服务启动失败 → 按钮重置「启动服务」+ 「服务启动失败」文案
    state = "stopped";
    win.webContents.send("dsh:status", { state: "stopped", message: "服务已停止" });
    await wait(150);
    retryFail = true;
    await win.webContents.executeJavaScript(`document.getElementById("startBtn").click(); undefined;`);
    await wait(200);
    const f4 = await win.webContents.executeJavaScript(`(() => {
      const btn = document.getElementById("startBtn");
      return {
        hidden: btn.hidden,
        btnText: btn.textContent,
        btnDisabled: btn.disabled,
        hint: document.getElementById("serviceHint").textContent,
        hintHidden: document.getElementById("serviceHint").hidden,
      };
    })()`);
    if (f4.hidden || f4.btnText !== "启动服务" || f4.btnDisabled)
      throw new Error(`启动失败后按钮应重置「启动服务」,实际 ${JSON.stringify(f4)}`);
    if (f4.hintHidden || !f4.hint.includes("服务启动失败"))
      throw new Error(`应展示「服务启动失败」原因,实际 ${f4.hint}`);
    retryFail = false;
    console.log("[13d] 服务启动失败:按钮重置「启动服务」+「服务启动失败:原因」 ✓");

    // ========== 14. 通知板块:横幅/声音开关 + 权限提示 ==========
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300);
    const n14a = await win.webContents.executeJavaScript(`(() => ({
      titles: [...document.querySelectorAll(".section-title")].map((h) => h.textContent),
      desc: document.getElementById("notifySection").querySelector(".plugin-desc").textContent,
      bannerAria: document.getElementById("notifyBanner").getAttribute("aria-checked"),
      soundAria: document.getElementById("notifySound").getAttribute("aria-checked"),
      hintHidden: document.getElementById("notifyHint").hidden,
    }))()`);
    if (n14a.titles.join(",") !== "服务状态,DSH,通知,插件市场,侧边栏")
      throw new Error(`板块顺序应为 服务状态,DSH,通知,插件市场,侧边栏,实际 ${n14a.titles}`);
    if (!n14a.desc.includes("允许 DSH 在任务完成")) throw new Error("通知板块应有说明文案");
    if (n14a.bannerAria !== "false" || n14a.soundAria !== "false")
      throw new Error("两个开关默认应为关");
    if (!n14a.hintHidden) throw new Error("权限未拒时不应显示提示");
    console.log("[14a] 通知板块:顺序 + 说明文案 + 双开关默认关 ✓");

    await win.webContents.executeJavaScript(`document.getElementById("notifyBanner").click(); undefined;`);
    await wait(200);
    const n14b = await win.webContents.executeJavaScript(`(() => ({
      bannerAria: document.getElementById("notifyBanner").getAttribute("aria-checked"),
      bannerOn: document.getElementById("notifyBanner").classList.contains("switch-on"),
    }))()`);
    if (n14b.bannerAria !== "true" || !n14b.bannerOn)
      throw new Error(`开启横幅后开关应翻转(乐观 + 回显),实际 ${JSON.stringify(n14b)}`);
    if (notifyBanner !== true || !notifySets.some((s) => s.banner === true))
      throw new Error("横幅开启应经 IPC 持久化");
    await win.webContents.executeJavaScript(`document.getElementById("notifySound").click(); undefined;`);
    await wait(200);
    if (notifySound !== true || !notifySets.some((s) => s.sound === true))
      throw new Error("声音开启应经 IPC 持久化");
    console.log("[14b] 通知开关:横幅/声音切换 → 乐观翻转 + IPC 持久化 ✓");

    // 权限被拒(系统设置里关了)→ 重载后面板给出引导提示
    notifyPermission = "denied";
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(300);
    const n14c = await win.webContents.executeJavaScript(`(() => ({
      hintHidden: document.getElementById("notifyHint").hidden,
      hint: document.getElementById("notifyHint").textContent,
    }))()`);
    if (n14c.hintHidden || !n14c.hint.includes("系统设置"))
      throw new Error(`横幅开 + 权限被拒应显示引导提示,实际 ${JSON.stringify(n14c)}`);
    console.log("[14c] 权限引导:横幅开 + 通知权限被拒 → 提示去系统设置开启 ✓");

    // ========== 15. 骨架屏:加载中灰色占位 → 数据替换(各板块独立) ==========
    // (5 个动态板块各自展示骨架,数据到达先到先换,互不影响;无「正在检查…」文字)
    // 15a. 全部查询慢 → 五板块全部骨架,数据区隐藏
    queryDelays = { info: 250, versions: 250, plugin: 250, market: 250, notify: 250 };
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(70);
    const sk15a = await win.webContents.executeJavaScript(`(() => ({
      service: !document.getElementById("skService").hidden,
      dsh: !document.getElementById("skDsh").hidden,
      notify: !document.getElementById("skNotify").hidden,
      market: !document.getElementById("skMarket").hidden,
      plugin: !document.getElementById("skPlugin").hidden,
      statusInfoHidden: document.getElementById("statusInfo").hidden,
      dshRowHidden: document.getElementById("dshRow").hidden,
      pluginRowHidden: document.getElementById("pluginRow").hidden,
      marketRowHidden: document.getElementById("marketRow").hidden,
      notifySwHidden: document.getElementById("notifyBanner").closest("label").hidden,
      animName: getComputedStyle(document.querySelector(".sk"), "::after").animationName,
      animDur: getComputedStyle(document.querySelector(".sk"), "::after").animationDuration,
      skColor: getComputedStyle(document.querySelector(".sk")).backgroundColor,
    }))()`);
    if (!sk15a.service || !sk15a.dsh || !sk15a.notify || !sk15a.market || !sk15a.plugin)
      throw new Error(`慢查询时五个板块骨架都应可见,实际 ${JSON.stringify(sk15a)}`);
    if (!sk15a.statusInfoHidden || !sk15a.dshRowHidden || !sk15a.pluginRowHidden || !sk15a.marketRowHidden || !sk15a.notifySwHidden)
      throw new Error("骨架期间数据区应隐藏(骨架替代加载中)");
    if (sk15a.animName !== "sk-sweep" || sk15a.animDur === "0s")
      throw new Error(`骨架块应有扫光动画,实际 ${sk15a.animName} ${sk15a.animDur}`);
    if (!sk15a.skColor || sk15a.skColor === "rgba(0, 0, 0, 0)")
      throw new Error(`骨架块应有灰色底,实际 ${sk15a.skColor}`);
    await wait(450);
    const sk15b = await win.webContents.executeJavaScript(`(() => ({
      dshSk: document.getElementById("skDsh").hidden,
      pluginSk: document.getElementById("skPlugin").hidden,
      notifySk: document.getElementById("skNotify").hidden,
      dshRowHidden: document.getElementById("dshRow").hidden,
      pluginRowHidden: document.getElementById("pluginRow").hidden,
      notifySwHidden: document.getElementById("notifyBanner").closest("label").hidden,
      statusInfoHidden: document.getElementById("statusInfo").hidden,
    }))()`);
    if (!sk15b.dshSk || !sk15b.pluginSk || !sk15b.notifySk)
      throw new Error("数据到达后骨架应全部隐藏");
    if (sk15b.dshRowHidden || sk15b.pluginRowHidden || sk15b.notifySwHidden || sk15b.statusInfoHidden)
      throw new Error("数据到达后真实数据应显示(含服务状态/通知开关行)");
    console.log("[15a] 骨架屏:五板块加载中占位 + 扫光动画 + 数据到达整体替换 ✓");

    // 15b. 仅 DSH 慢 → 只有 DSH 骨架,其它板块已显示数据(互补影响)
    queryDelays = { info: 0, versions: 300, plugin: 0, market: 0, notify: 0 };
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(70);
    const sk15c = await win.webContents.executeJavaScript(`(() => ({
      dsh: !document.getElementById("skDsh").hidden,
      plugin: !document.getElementById("skPlugin").hidden,
      market: !document.getElementById("skMarket").hidden,
      service: !document.getElementById("skService").hidden,
      dshRowHidden: document.getElementById("dshRow").hidden,
      pluginRowHidden: document.getElementById("pluginRow").hidden,
      marketRowHidden: document.getElementById("marketRow").hidden,
      statusInfoHidden: document.getElementById("statusInfo").hidden,
    }))()`);
    if (!sk15c.dsh || sk15c.plugin || sk15c.market || sk15c.service)
      throw new Error(`仅 DSH 慢时只有 DSH 骨架(独立替换),实际 ${JSON.stringify(sk15c)}`);
    if (!sk15c.dshRowHidden || sk15c.pluginRowHidden || sk15c.marketRowHidden || sk15c.statusInfoHidden)
      throw new Error("DSH 数据未到(骨架)、其它板块数据已到(真实内容)——各板块互补影响");
    await wait(450);
    const sk15d = await win.webContents.executeJavaScript(`(() => ({
      dshSk: document.getElementById("skDsh").hidden,
      dshRowHidden: document.getElementById("dshRow").hidden,
    }))()`);
    if (!sk15d.dshSk || sk15d.dshRowHidden)
      throw new Error("DSH 查询完成后骨架应替换为真实数据");
    queryDelays = { info: 0, versions: 0, plugin: 0, market: 0, notify: 0 };
    console.log("[15b] 骨架屏:仅 DSH 慢 → 只有 DSH 骨架,其它板块已显示(独立替换) ✓");

    // ========== 16. 滚动条:dsh 会话区同款规格 + 默认隐藏 + 面板内任意位置 hover 显示 ==========
    // 规格来自 @deepseek-ai/dsh-client-ui-theme scrollbar.css(8px/透明 track/4px 圆角
    // thumb/thumb 色 = 主题中性色)。Chromium scrollbar 伪元素不认祖先限定选择器
    // (含 :hover/类,实测),故显示/隐藏走「变量 rebind」:body(面板)默认把
    // --st-sb-thumb 置透明(隐藏),body:hover(鼠标位于页面区域内任意位置,不必滑到
    // 滚动条上)时置 dsh 中性色;离开立刻回透明。全局伪元素规则读变量。
    const statusCss = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "dsh-status.css"), "utf8");
    if (!statusCss.includes("width: 8px") || !statusCss.includes("height: 8px"))
      throw new Error("滚动条应为 dsh 规格 8px 宽高");
    if (!statusCss.includes("::-webkit-scrollbar-track,") || !statusCss.includes("::-webkit-scrollbar-corner"))
      throw new Error("track/corner 应透明(dsh 规格)");
    if (!/::-webkit-scrollbar-thumb \{\n[^}]*border-radius: 4px;[^}]*background: var\(--st-sb-thumb\);/.test(statusCss))
      throw new Error("thumb 应 4px 圆角且读变量(--st-sb-thumb)");
    if (!statusCss.includes("--st-sb-thumb: transparent;"))
      throw new Error("默认应把 thumb 变量置透明(隐藏,哪怕内容超出)");
    if (!statusCss.includes("body:hover {\n  --st-sb-thumb: light-dark(rgb(229, 229, 229), rgb(60, 60, 61));"))
      throw new Error("面板任意位置 hover 应显示 thumb(dsh neutral 亮/暗)");
    if (!statusCss.includes("--st-sb-thumb-hover: light-dark(rgb(212, 212, 212), rgb(84, 85, 87));"))
      throw new Error("thumb 悬停应加深(dsh neutral-300/600)");
    // 运行态:thumb 默认透明(即使滚动条存在也不可见)
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "dsh-status.html"));
    await wait(200);
    const sb16 = await win.webContents.executeJavaScript(
      `(() => {
        const cs = getComputedStyle(document.body, "::-webkit-scrollbar-thumb");
        return { bg: cs.backgroundColor, w: getComputedStyle(document.body, "::-webkit-scrollbar").width };
      })()`
    );
    if (!(sb16.bg === "rgba(0, 0, 0, 0)" || sb16.bg === "transparent"))
      throw new Error(`运行态 thumb 默认应透明,实际 ${sb16.bg}`);
    if (sb16.w !== "8px") throw new Error(`滚动条宽度应为 8px,实际 ${sb16.w}`);
    console.log("[16] 滚动条:dsh 规格 8px/透明 track + 变量方案默认隐藏、面板内任意位置 hover 显示 ✓");

    console.log("\nPASS ✓ 服务状态与版本面板回归通过");
    win.destroy();
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 服务状态与版本面板回归:", err.message);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});