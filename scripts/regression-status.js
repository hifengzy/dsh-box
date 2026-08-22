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
 *   11. 链接:DSH 版本号 / 插件名 → 仓库链接,悬停下划线(hover 规则存在)。
 *
 * 用法: electron scripts/regression-status.js --no-sandbox
 * 说明:测试固定 nativeTheme=light,断言浅色 token 的具体值,结果确定。
 */

const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const path = require("node:path");

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
// 插件板块夹具:可变状态驱动各组断言
let pluginInstalled = null; // null = 未安装
let pluginLatest = "0.15.2";
let pluginError = null;

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
ipcMain.handle("dsh:get-info", () => ({ ...FIXTURE_INFO, state }));
ipcMain.handle("dsh:check-updates", () => FIXTURE_VERSIONS);
ipcMain.handle("dsh:upgrade", (_e, v) => {
  upgradedVersion = v;
  return { ok: true, previous: "0.1.0-rc.6", installed: v, backupDir: "/tmp/bak" };
});
ipcMain.handle("dsh:retry", async () => {
  retried = true;
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
ipcMain.handle("dsh:plugin-info", () => ({
  name: "dsh-better-sidebar",
  installed: pluginInstalled,
  latest: pluginLatest,
  hasUpdate: pluginInstalled !== null && pluginLatest !== null && verLt(pluginInstalled, pluginLatest),
  error: pluginError,
}));
ipcMain.handle("dsh:plugin-install", async (_e, v) => {
  pluginInstalled = v ?? pluginLatest;
  return { ok: true, installed: pluginInstalled, previouslyInstalled: null, restarted: true };
});
ipcMain.handle("dsh:toggle-plugin-panel", (_e, which) => {
  toggledPluginPanel = which;
  return { ok: true };
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
    if (tbp2.sideTitle !== "折叠侧边栏") throw new Error(`侧栏展开时标题应为「折叠侧边栏」,实际 ${tbp2.sideTitle}`);
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

    console.log("\nPASS ✓ 服务状态与版本面板回归通过");
    win.destroy();
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 服务状态与版本面板回归:", err.message);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});