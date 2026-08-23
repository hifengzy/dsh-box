#!/usr/bin/env node
"use strict";

/**
 * regression-status-inline.js — 「服务状态」共享面板(路径 A:内容视图内注入
 * 右侧滑入面板,与 dsh-better-sidebar 侧栏互斥展开)回归测试(真实 Electron):
 *
 *   1. 注入:桥挂载 window.__dshBoxStatusBridge;初始上报 {open:false};
 *   2. toggle 开:面板出现 + .dshbox-st-open(滑入动画态) + 四板块渲染
 *      (运行中 / DSH 最新+「最新」+「更新」 / 插件「安装」 / 市场「安装」)
 *      + #root 被挤压(margin-right = 面板宽);上报 {open:true};
 *   3. toggle 关:滑出动画后面板移除 + #root 挤压回收(margin-right 0);
 *   4. 宽度:setWidth 钳制(500→500, 10→240, 999→640);面板宽度 + #root
 *      挤压跟随;setStatusPanelWidth(持久化通道)收到钳制后值;
 *   5. 主题:body[data-ds-dark-theme] 增删 → 面板 .dshbox-st-dark 类跟随;
 *   6. 状态机:插件已装==最新 →「已安装」绿字无按钮;已装<最新 →「更新」;
 *      市场已装 →「已安装」+「侧边栏入口」开关(打开时回显已持久化值);
 *      每次打开重新查询(mock 查询计数递增);
 *   7. 操作:插件安装按钮 → installPlugin(latest) + hint;市场安装;
 *      DSH「更新」→ upgrade;失败一键复位;
 *   8. 链接:点 DSH 版本链接 / 插件名链接 → openExternal(http),页面不导航;
 *   9. 关闭:面板右上角 ✕ → 滑出动画后移除 + 上报 {open:false};
 *  10. 常驻:dsh:status 推送 → 状态行/徽标/按钮实时刷新;
 *  11. 互斥原语(与主进程编排同款序列):插件侧栏展开时开服务状态 →
 *      先收插件侧栏再滑入服务状态;反向同理.requestClose() 等动画完成才 resolve。
 *
 * 面板内的 window.dsh.* 全部由 fixture 页面 mock(记录调用),独立于真实
 * preload;注入体与主进程 GENUINE 产物同源(require status-ui-inject.js /
 * plugin-ui-inject.js)。
 *
 * 用法: electron scripts/regression-status-inline.js --no-sandbox
 */

const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { STATUS_BRIDGE_JS_FN, STATUS_PANEL_CSS } = require("../src/main/status-ui-inject");
const { PLUGIN_BRIDGE_JS } = require("../src/main/plugin-ui-inject");

app.setPath("userData", path.resolve(__dirname, "..", ".runtime", "regression", "status-inline-user"));

const FIXTURE_DIR = path.join(app.getPath("userData"), "fixture");
const FIXTURE_HTML = path.join(FIXTURE_DIR, "page.html");

// fixture 页面:模拟 dsh WebUI(#root 布局锚 + 插件 toggle cluster)+ window.dsh mock
const FIXTURE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8" /><title>dsh web</title></head>
<body>
  <div id="root">
    <div data-dsh-frame>
      <div data-pane="conversation">conversation</div>
    </div>
  </div>
  <!-- 插件 toggle cluster(mock):最后一个按钮 = 侧栏,第一个 = 底栏 -->
  <div data-dsh-toggle-cluster>
    <button type="button" data-mock="bottom">bottom</button>
    <button type="button" data-mock="side">side</button>
  </div>
  <script>
    window.__fix = {
      pluginInstalled: null,
      pluginLatest: "0.15.2",
      pluginError: null,
      marketInstalled: null,
      marketLatest: "1.18.1",
      marketError: null,
      marketSwitchOn: false,
      versionsLatest: "0.1.0-rc.12",
      versionsHasUpdate: true,
      serviceState: "ready",
    };
    window.__rec = {
      reports: [],        // reportStatusPanel 收到的 {open}
      widths: [],         // setStatusPanelWidth 收到的值
      pluginCalls: [],    // installPlugin 收到的版本
      marketCalls: [],    // installMarket 收到的版本
      upgradeCalls: [],   // upgrade 收到的版本
      pluginQueries: 0,   // getPluginInfo 调用次数(验证「每次打开重查」)
      marketQueries: 0,   // getMarketInfo 调用次数
      openExternal: [],   // openExternal 收到的 URL
      retries: 0,
      statusSubs: [],     // onStatus 订阅的回调
    };
    window.confirm = () => true;
    // mock 插件行为:点 toggle 按钮 → 翻转 body 属性(与真实插件一致)
    document.querySelector('[data-dsh-toggle-cluster] button[data-mock="side"]')
      .addEventListener("click", () => {
        document.body.toggleAttribute("data-dsh-sidebar-collapsed");
      });
    document.querySelector('[data-dsh-toggle-cluster] button[data-mock="bottom"]')
      .addEventListener("click", () => {
        const h = document.documentElement.style.getPropertyValue("--dsh-sidebar-height");
        document.documentElement.style.setProperty("--dsh-sidebar-height", h && h !== "0px" ? "0px" : "240px");
      });
    const info = () => ({
      version: "0.1.0-rc.6",
      port: 3260,
      url: "http://127.0.0.1:3260",
      pid: 4242,
      ready: window.__fix.serviceState === "ready",
      state: window.__fix.serviceState,
      message: window.__fix.serviceState === "ready" ? "服务运行中" : "服务已停止",
    });
    window.dsh = {
      getInfo: async () => info(),
      checkUpdates: async () => ({
        latest: window.__fix.versionsLatest,
        runtime: "0.1.0-rc.6",
        hasUpdate: window.__fix.versionsHasUpdate,
        rows: [
          { version: "0.1.0-rc.12", publishedAt: "2026-08-01T00:00:00.000Z", isLatest: true },
          { version: "0.1.0-rc.6", publishedAt: "2026-07-26T00:00:00.000Z", isCurrent: true },
        ],
        fromCache: false,
      }),
      getPluginInfo: async () => {
        window.__rec.pluginQueries += 1;
        return {
          name: "dsh-better-sidebar",
          installed: window.__fix.pluginInstalled,
          latest: window.__fix.pluginLatest,
          error: window.__fix.pluginError,
        };
      },
      installPlugin: async (v) => {
        window.__rec.pluginCalls.push(v);
        if (window.__fix.pluginInstallFail) return { ok: false, error: window.__fix.pluginInstallFail };
        window.__fix.pluginInstalled = v || window.__fix.pluginLatest;
        return { ok: true, installed: window.__fix.pluginInstalled, previouslyInstalled: null, restarted: true };
      },
      getMarketInfo: async () => {
        window.__rec.marketQueries += 1;
        return {
          name: "dshmarket",
          installed: window.__fix.marketInstalled,
          latest: window.__fix.marketLatest,
          error: window.__fix.marketError,
        };
      },
      installMarket: async (v) => {
        window.__rec.marketCalls.push(v);
        if (window.__fix.marketInstallFail) return { ok: false, error: window.__fix.marketInstallFail };
        window.__fix.marketInstalled = v || window.__fix.marketLatest;
        return { ok: true, installed: window.__fix.marketInstalled, previouslyInstalled: null, restarted: true };
      },
      getMarketSwitch: async () => ({ ok: true, enabled: window.__fix.marketSwitchOn }),
      setMarketSwitch: async (v) => {
        window.__fix.marketSwitchOn = !!v;
        return { ok: true, enabled: window.__fix.marketSwitchOn };
      },
      upgrade: async (v) => {
        window.__rec.upgradeCalls.push(v);
        if (window.__fix.upgradeFail) return { ok: false, error: window.__fix.upgradeFail };
        return { ok: true, installed: v, previous: "0.1.0-rc.6", backupDir: "/tmp/bak" };
      },
      retry: async () => {
        window.__rec.retries += 1;
        return info();
      },
      openExternal: async (url) => { window.__rec.openExternal.push(url); },
      onStatus: (cb) => { window.__rec.statusSubs.push(cb); return () => {}; },
      reportStatusPanel: (s) => window.__rec.reports.push({ ...s }),
      setStatusPanelWidth: async (w) => {
        window.__rec.widths.push(w);
        return { ok: true, width: w };
      },
    };
  </script>
</body>
</html>`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 断言辅助(与既有回归脚本一致:throw 即失败)
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

app.whenReady().then(async () => {
  let win;
  try {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(FIXTURE_HTML, FIXTURE);

    win = new BrowserWindow({ width: 1024, height: 720, show: false });
    win.webContents.on("console-message", (...args) => {
      const msg = args.length >= 3 ? args[2] : args[0]?.message;
      if (msg && !msg.includes("Electron Security Warning")) console.log("[renderer]", msg);
    });
    await win.loadFile(FIXTURE_HTML);
    await wait(150);
    // 注入真实产物(did-finish-load 同款顺序:插件桥 → 服务状态桥 → 面板样式)
    await win.webContents.executeJavaScript(PLUGIN_BRIDGE_JS, true);
    await win.webContents.executeJavaScript(STATUS_BRIDGE_JS_FN(320), true);
    await win.webContents.insertCSS(STATUS_PANEL_CSS);

    // ========== 1. 注入 + 初始上报 ==========
    const inj = await win.webContents.executeJavaScript(`(() => ({
      bridge: !!window.__dshBoxStatusBridge,
      pluginBridge: !!window.__dshBoxPluginBridge,
      panelExists: !!document.getElementById("dshbox-status-panel"),
      reports: window.__rec.reports,
    }))()`);
    check(inj.bridge, "桥应挂载 window.__dshBoxStatusBridge");
    check(inj.pluginBridge, "插件桥应挂载(互斥编排依赖)");
    check(!inj.panelExists, "初始不应创建面板");
    check(inj.reports.length === 1 && inj.reports[0].open === false,
      `初始应上报一次 {open:false},实际 ${JSON.stringify(inj.reports)}`);
    console.log("[1] 注入:双桥挂载 + 初始上报 {open:false} ✓");

    // ========== 2. toggle 开:面板滑入 + 四板块 + #root 挤压 ==========
    await win.webContents.executeJavaScript(`window.__dshBoxStatusBridge.toggle(); undefined;`);
    await wait(450); // rAF → 动画(300ms 回退) → 数据
    const open1 = await win.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById("dshbox-status-panel");
      const conv = document.querySelector('#root [data-dsh-frame] > [data-pane="conversation"]');
      const root = document.getElementById("root");
      return {
        panel: !!panel,
        openClass: panel ? panel.classList.contains("dshbox-st-open") : false,
        visible: panel ? getComputedStyle(panel).visibility : null,
        widthVar: document.documentElement.style.getPropertyValue("--dshbox-status-panel-width"),
        convMarginRight: conv ? getComputedStyle(conv).marginRight : null,
        rootMarginRight: root ? getComputedStyle(root).marginRight : null,
        pill: panel ? document.getElementById("stStatePill").classList.contains("dshbox-st-running") : false,
        versionLink: panel ? document.getElementById("stDshVersionLink").textContent : null,
        badges: panel ? [...document.querySelectorAll("#stDshRow .dshbox-st-v-badge")].map((b) => b.textContent) : [],
        updateHidden: panel ? document.getElementById("stDshUpdateBtn").hidden : true,
        pluginBtnHidden: panel ? document.getElementById("stPluginActionBtn").hidden : true,
        pluginBtnText: panel ? document.getElementById("stPluginActionBtn").textContent : null,
        marketBtnHidden: panel ? document.getElementById("stMarketActionBtn").hidden : true,
        reports: window.__rec.reports.length,
      };
    })()`);
    check(open1.panel, "toggle 后面板应出现");
    check(open1.openClass, "面板应处于滑入态(dshbox-st-open)");
    check(open1.visible === "visible", `面板应可见,实际 ${open1.visible}`);
    check(open1.widthVar === "320px", `挤压变量应为 320px,实际 ${open1.widthVar}`);
    check(open1.convMarginRight === "320px", `对话区应被挤压 320px,实际 ${open1.convMarginRight}`);
    check(open1.rootMarginRight === "0px", `#root 不应被挤压(左侧栏锚点稳定),实际 ${open1.rootMarginRight}`);
    check(open1.pill, "服务状态应显示「运行中」徽标");
    check(open1.versionLink === "0.1.0-rc.12", `DSH 应展示最新一条,实际 ${open1.versionLink}`);
    check(open1.badges.length === 1 && open1.badges[0] === "最新", `应有「最新」徽标,实际 ${open1.badges}`);
    check(!open1.updateHidden, "有更新时应显示「更新」按钮");
    check(!open1.pluginBtnHidden && open1.pluginBtnText === "安装", "侧边栏未安装应显示「安装」按钮");
    check(!open1.marketBtnHidden, "插件市场未安装应显示「安装」按钮");
    check(open1.reports >= 2, "打开应再次上报(含 {open:true})");
    // 打开/关闭动画全程 document 不应出现横向滚动(面板 fixed,不扩展滚动区域)
    const noHScroll = await win.webContents.executeJavaScript(
      `document.documentElement.scrollWidth <= window.innerWidth + 1`
    );
    check(noHScroll, "面板展开后不应产生横向滚动条");
    console.log("[2] toggle 开:滑入 + 四板块渲染 + 对话区挤压 320px(#root 不动) + 无横向滚动条 ✓");

    // ========== 3. toggle 关:滑出动画中无横向滚动条 → 动画后移除 + 挤压回收 ==========
    await win.webContents.executeJavaScript(`window.__dshBoxStatusBridge.toggle(); undefined;`);
    await wait(120); // 滑出动画中段(此前 absolute 面板此处 scrollWidth 暴涨)
    const midScroll = await win.webContents.executeJavaScript(`(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
    }))()`);
    check(midScroll.sw <= midScroll.iw + 1,
      `滑出动画期间不应出现横向滚动条(sw=${midScroll.sw}, iw=${midScroll.iw})`);
    await wait(500);
    const closed = await win.webContents.executeJavaScript(`(() => ({
      panelExists: !!document.getElementById("dshbox-status-panel"),
      widthVar: document.documentElement.style.getPropertyValue("--dshbox-status-panel-width"),
      convMarginRight: getComputedStyle(document.querySelector('#root [data-dsh-frame] > [data-pane="conversation"]')).marginRight,
      last: window.__rec.reports[window.__rec.reports.length - 1],
    }))()`);
    check(!closed.panelExists, "滑出动画后应移除面板");
    check(closed.widthVar === "0px" && closed.convMarginRight === "0px",
      `挤压应回收为 0,实际 var=${closed.widthVar} conv=${closed.convMarginRight}`);
    check(closed.last.open === false, `关闭应上报 {open:false},实际 ${JSON.stringify(closed.last)}`);
    console.log("[3] toggle 关:滑出移除 + 挤压回收 0 + 上报 {open:false} ✓");

    // ========== 4. 宽度:setWidth 钳制 + 挤压跟随 + 持久化通道 ==========
    const widths = await win.webContents.executeJavaScript(`(async () => {
      const b = window.__dshBoxStatusBridge;
      b.toggle(); // 打开
      await new Promise((r) => setTimeout(r, 400));
      const read = () => ({
        panelW: document.getElementById("dshbox-status-panel").style.width,
        convMR: getComputedStyle(document.querySelector('#root [data-dsh-frame] > [data-pane="conversation"]')).marginRight,
      });
      const w500 = read();
      b.setWidth(500); await new Promise((r) => setTimeout(r, 400)); const r500 = read();
      b.setWidth(10);  await new Promise((r) => setTimeout(r, 400)); const r10 = read();
      b.setWidth(999); await new Promise((r) => setTimeout(r, 400)); const r999 = read();
      return { w500, r500, r10, r999, widths: window.__rec.widths.slice() };
    })()`);
    check(widths.r500.panelW === "500px" && widths.r500.convMR === "500px",
      `setWidth(500) 应生效且对话区挤压 500px,实际 ${JSON.stringify(widths.r500)}`);
    check(widths.r10.panelW === "240px" && widths.r10.convMR === "240px",
      `setWidth(10) 应钳到 240,实际 ${JSON.stringify(widths.r10)}`);
    check(widths.r999.panelW === "640px" && widths.r999.convMR === "640px",
      `setWidth(999) 应钳到 640,实际 ${JSON.stringify(widths.r999)}`);
    check(widths.widths[0] === 500 && widths.widths[1] === 240 && widths.widths[2] === 640,
      `持久化通道应收到钳制后宽度,实际 ${JSON.stringify(widths.widths)}`);
    console.log("[4] 宽度:500/240/640 钳制 + 对话区挤压跟随 + 持久化通道 ✓");

    // ========== 5. 主题:body 属性 → 面板类切换 ==========
    const darkOn = await win.webContents.executeJavaScript(`(() => {
      document.body.setAttribute("data-ds-dark-theme", "");
      return new Promise((resolve) => setTimeout(() => resolve(
        document.getElementById("dshbox-status-panel").classList.contains("dshbox-st-dark")
      ), 60));
    })()`);
    check(darkOn, "深色主题时面板应带 dshbox-st-dark 类");
    const darkOff = await win.webContents.executeJavaScript(`(() => {
      document.body.removeAttribute("data-ds-dark-theme");
      return new Promise((resolve) => setTimeout(() => resolve(
        document.getElementById("dshbox-status-panel").classList.contains("dshbox-st-dark")
      ), 60));
    })()`);
    check(!darkOff, "浅色主题时面板不应带 dshbox-st-dark 类");
    console.log("[5] 主题:body[data-ds-dark-theme] 增删 → 面板类跟随 ✓");

    // ========== 6. 状态机 + 每次打开重查 ==========
    await win.webContents.executeJavaScript(`(async () => {
      window.__fix.pluginInstalled = "0.15.2";
      window.__fix.marketInstalled = "1.18.1";
      window.__fix.marketSwitchOn = true;
      const s = window.__dshBoxStatusBridge;
      await s.requestClose();
      await s.requestOpen(); // = 重查
    })()`);
    await wait(200);
    const stateA = await win.webContents.executeJavaScript(`(() => ({
      pluginInstalledLabelHidden: document.getElementById("stPluginInstalledLabel").hidden,
      pluginInstalledText: document.getElementById("stPluginInstalledLabel").textContent,
      pluginBtnHidden: document.getElementById("stPluginActionBtn").hidden,
      pluginBadge: document.getElementById("stPluginVersionBadge").textContent,
      marketInstalledLabelHidden: document.getElementById("stMarketInstalledLabel").hidden,
      marketBtnHidden: document.getElementById("stMarketActionBtn").hidden,
      switchRowHidden: document.getElementById("stMarketSwitchRow").hidden,
      switchOn: document.getElementById("stMarketSwitch").classList.contains("dshbox-st-on"),
    }))()`);
    check(!stateA.pluginInstalledLabelHidden && stateA.pluginInstalledText === "已安装",
      `插件已装==最新应显示「已安装」,实际 ${JSON.stringify(stateA)}`);
    check(stateA.pluginBtnHidden, "已安装不应有按钮");
    check(stateA.pluginBadge === "0.15.2", `徽标应显示最新版本,实际 ${stateA.pluginBadge}`);
    check(!stateA.marketInstalledLabelHidden && stateA.marketBtnHidden, "市场已装应显示「已安装」无按钮");
    check(!stateA.switchRowHidden && stateA.switchOn, "市场已装应显示已开启的侧边栏入口开关");
    console.log("[6a] 已安装态:插件/市场「已安装」绿字 + 市场开关回显 ✓");

    await win.webContents.executeJavaScript(`(async () => {
      window.__fix.pluginInstalled = "0.15.1";
      await window.__dshBoxStatusBridge.requestClose();
      await window.__dshBoxStatusBridge.requestOpen();
    })()`);
    await wait(200);
    const stateB = await win.webContents.executeJavaScript(`(() => ({
      btnHidden: document.getElementById("stPluginActionBtn").hidden,
      btnText: document.getElementById("stPluginActionBtn").textContent,
      installedLabelHidden: document.getElementById("stPluginInstalledLabel").hidden,
    }))()`);
    check(!stateB.btnHidden && stateB.btnText === "更新", `已装<最新应显示「更新」,实际 ${JSON.stringify(stateB)}`);
    check(stateB.installedLabelHidden, "有更新时不应显示「已安装」");
    await win.webContents.executeJavaScript(`document.getElementById("stPluginActionBtn").click(); undefined;`);
    await wait(200);
    const afterInstall = await win.webContents.executeJavaScript(`(() => ({
      calls: window.__rec.pluginCalls.slice(),
      hintHidden: document.getElementById("stPluginHint").hidden,
      hint: document.getElementById("stPluginHint").textContent,
      label: document.getElementById("stPluginInstalledLabel").textContent,
    }))()`);
    check(afterInstall.calls.length === 1 && afterInstall.calls[0] === "0.15.2",
      `安装应经 installPlugin(latest=0.15.2),实际 ${JSON.stringify(afterInstall.calls)}`);
    check(afterInstall.label === "已安装", "安装成功后应回到「已安装」态");
    console.log("[6b] 更新态 + 安装走 installPlugin(latest) + 成功后回「已安装」 ✓");

    const q1 = await win.webContents.executeJavaScript(`window.__rec.pluginQueries`);
    await win.webContents.executeJavaScript(`(async () => {
      await window.__dshBoxStatusBridge.requestClose();
      await window.__dshBoxStatusBridge.requestOpen();
    })()`);
    await wait(200);
    const q2 = await win.webContents.executeJavaScript(`window.__rec.pluginQueries`);
    check(q2 === q1 + 1, `重新打开应重查插件(q1=${q1}, q2=${q2})`);
    console.log("[6c] 每次打开重新查询(与「进入即查」语义一致) ✓");

    // ========== 7. 操作:DSH 升级 + 失败复位 ==========
    await win.webContents.executeJavaScript(`document.getElementById("stDshUpdateBtn").click(); undefined;`);
    await wait(450);
    const upOk = await win.webContents.executeJavaScript(`(() => ({
      calls: window.__rec.upgradeCalls.slice(),
      versionLink: document.getElementById("stDshVersionLink").textContent,
    }))()`);
    check(upOk.calls.length === 1 && upOk.calls[0] === "0.1.0-rc.12",
      `升级应经 upgrade(latest),实际 ${JSON.stringify(upOk.calls)}`);
    check(upOk.versionLink === "0.1.0-rc.12", `升级后版本行应保持最新,实际 ${upOk.versionLink}`);
    // 失败复位:独立场景(重开面板 → 新 DOM 按钮可用)
    await win.webContents.executeJavaScript(`(async () => {
      window.__fix.upgradeFail = "模拟失败";
      await window.__dshBoxStatusBridge.requestClose();
      await window.__dshBoxStatusBridge.requestOpen();
    })()`);
    await wait(200);
    const dbgBefore = await win.webContents.executeJavaScript(`window.__dshBoxStatusBridge._debug()`);
    const upFail = await win.webContents.executeJavaScript(`(async () => {
      const btn = document.getElementById("stDshUpdateBtn");
      window.__diagBtn = null;
      btn.addEventListener("click", () => { window.__diagBtn = "clicked"; }, { capture: true });
      btn.click();
      await new Promise((r) => setTimeout(r, 450));
      return {
        diag: window.__diagBtn,
        dbg: window.__dshBoxStatusBridge._debug(),
        text: btn.textContent,
        disabled: btn.disabled,
        hint: document.getElementById("stUpgradeHint").textContent,
      };
    })()`);
    check(dbgBefore.upgrading === false, `前提:升级锁应空闲,实际 ${JSON.stringify(dbgBefore)}`);
    check(upFail.diag === "clicked", "点击应派发(按钮可用)");
    check(upFail.text === "更新" && !upFail.disabled && upFail.hint.includes("升级失败"),
      `升级失败应复位按钮,实际 ${JSON.stringify(upFail)}`);
    await win.webContents.executeJavaScript(`window.__fix.upgradeFail = null; undefined;`);
    console.log("[7] 操作:DSH 升级链路 + 失败复位「更新」 ✓");

    // ========== 8. 链接 → openExternal,页面不导航 ==========
    await win.webContents.executeJavaScript(`document.getElementById("stDshVersionLink").click(); undefined;`);
    await win.webContents.executeJavaScript(`document.getElementById("stPluginNameLink").click(); undefined;`);
    await wait(100);
    const links = await win.webContents.executeJavaScript(`(() => ({
      urls: window.__rec.openExternal.slice(),
      url: location.href,
    }))()`);
    check(links.urls.length === 2, `两个链接都应走 openExternal,实际 ${JSON.stringify(links.urls)}`);
    check(links.urls[0] === "https://github.com/deepseek-ai/deepseek-harness/", `版本链接错误: ${links.urls[0]}`);
    check(links.urls[1] === "https://github.com/omdsh-dev/DSH-better-sidebar", `插件链接错误: ${links.urls[1]}`);
    check(links.url.startsWith("file:"), `页面不应被导航走,实际 ${links.url}`);
    console.log("[8] 链接:版本/插件链接 → openExternal,页面不导航 ✓");

    // ========== 9. 关闭按钮 ✕(滑出动画后移除) ==========
    await win.webContents.executeJavaScript(`document.querySelector(".dshbox-st-close").click(); undefined;`);
    await wait(500);
    const x = await win.webContents.executeJavaScript(`(() => ({
      panelExists: !!document.getElementById("dshbox-status-panel"),
      last: window.__rec.reports[window.__rec.reports.length - 1],
    }))()`);
    check(!x.panelExists, "✕ 应在滑出动画后移除面板");
    check(x.last.open === false, `✕ 关闭应上报 {open:false},实际 ${JSON.stringify(x.last)}`);
    console.log("[9] 关闭按钮:✕ → 滑出移除 + 上报 {open:false} ✓");

    // ========== 10. 常驻:服务状态推送(dsh:status)实时刷新面板 ==========
    await win.webContents.executeJavaScript(`window.__dshBoxStatusBridge.toggle(); undefined;`);
    await wait(450);
    const pushed = await win.webContents.executeJavaScript(`(() => {
      const cb = window.__rec.statusSubs[window.__rec.statusSubs.length - 1];
      cb({ state: "stopped", message: "服务已停止" });
      return new Promise((resolve) => setTimeout(() => resolve({
        label: document.getElementById("stStateLabel").textContent,
        running: document.getElementById("stStatePill").classList.contains("dshbox-st-running"),
        startHidden: document.getElementById("stStartBtn").hidden,
      }), 60));
    })()`);
    check(pushed.label === "停止", `推送停服后状态文案应为「停止」,实际 ${pushed.label}`);
    check(!pushed.running, "推送停服后徽标不应为运行态");
    check(!pushed.startHidden, "推送停服后应显示「启动服务」按钮");
    const pushedBack = await win.webContents.executeJavaScript(`(() => {
      const cb = window.__rec.statusSubs[window.__rec.statusSubs.length - 1];
      cb({ state: "ready", message: "服务运行中" });
      return new Promise((resolve) => setTimeout(() => resolve({
        label: document.getElementById("stStateLabel").textContent,
        startHidden: document.getElementById("stStartBtn").hidden,
      }), 60));
    })()`);
    check(pushedBack.label === "运行中" && pushedBack.startHidden, "推送恢复后应回到运行中且隐藏启动按钮");
    console.log("[10] 常驻:dsh:status 推送 → 状态行/徽标/按钮实时刷新 ✓");

    // ========== 11. 互斥:与主进程编排同款「并行换边」 ==========
    // 11a. 插件侧栏展开 → 开服务状态:收起插件与展开服务状态同帧发起
    //      (动画重叠 → 总时长 = 单侧动画,不再串行 ≈ 700ms);
    //      目标:切换不产生「#root 先回全宽再收窄」的中间态。
    const mutualA = await win.webContents.executeJavaScript(`(async () => {
      const p = window.__dshBoxPluginBridge;
      const s = window.__dshBoxStatusBridge;
      // 先确保插件侧栏展开 + 服务状态关闭
      if (document.body.hasAttribute("data-dsh-sidebar-collapsed")) p.toggle("side");
      if (s.state().open) await s.requestClose();
      await new Promise((r) => setTimeout(r, 400));
      const before = {
        pluginCollapsed: document.body.hasAttribute("data-dsh-sidebar-collapsed"),
        statusOpen: s.state().open,
      };
      // 并行换边:两条动作同帧发起(与主进程 runMutualOpen 的 Promise.all 同语义)
      const t0 = performance.now();
      await Promise.all([
        (async () => { p.toggle("side"); await new Promise((r) => setTimeout(r, 400)); })(),
        (async () => { await s.requestOpen(); })(),
      ]);
      const elapsed = performance.now() - t0;
      const after = {
        pluginCollapsed: document.body.hasAttribute("data-dsh-sidebar-collapsed"),
        statusOpen: s.state().open,
        statusPanelOpen: !!document.getElementById("dshbox-status-panel"),
      };
      return { before, after, elapsed };
    })()`);
    check(!mutualA.before.pluginCollapsed && !mutualA.before.statusOpen,
      `前提:插件侧栏应展开、服务状态应关闭,实际 ${JSON.stringify(mutualA.before)}`);
    check(mutualA.after.pluginCollapsed && mutualA.after.statusOpen && mutualA.after.statusPanelOpen,
      `互斥结果:插件侧栏应已收起 + 服务状态应已展开,实际 ${JSON.stringify(mutualA.after)}`);
    check(mutualA.elapsed < 650,
      `并行换边总时长应明显短于串行(≈700ms),实际 ${Math.round(mutualA.elapsed)}ms`);
    console.log(`[11a] 互斥:插件展开时开服务状态 → 并行换边(${Math.round(mutualA.elapsed)}ms, 串行≈700ms) ✓`);

    // 11b. 服务状态展开 → 开插件侧栏:requestClose 与插件展开同帧发起
    const mutualB = await win.webContents.executeJavaScript(`(async () => {
      const p = window.__dshBoxPluginBridge;
      const s = window.__dshBoxStatusBridge;
      // 当前状态:服务状态开(11a 结果)+ 插件侧栏折叠
      const before = { statusOpen: s.state().open, pluginCollapsed: document.body.hasAttribute("data-dsh-sidebar-collapsed") };
      const t0 = performance.now();
      await Promise.all([
        (async () => { await s.requestClose(); })(),
        (async () => { p.toggle("side"); await new Promise((r) => setTimeout(r, 400)); })(),
      ]);
      const elapsed = performance.now() - t0;
      const after = {
        statusOpen: s.state().open,
        statusPanelExists: !!document.getElementById("dshbox-status-panel"),
        pluginCollapsed: document.body.hasAttribute("data-dsh-sidebar-collapsed"),
      };
      return { before, after, elapsed };
    })()`);
    check(mutualB.before.statusOpen && mutualB.before.pluginCollapsed,
      `前提:服务状态应展开、插件侧栏应折叠,实际 ${JSON.stringify(mutualB.before)}`);
    check(!mutualB.after.statusOpen && !mutualB.after.statusPanelExists && !mutualB.after.pluginCollapsed,
      `互斥结果:服务状态应已移除 + 插件侧栏应已展开,实际 ${JSON.stringify(mutualB.after)}`);
    check(mutualB.elapsed < 650,
      `并行换边总时长应明显短于串行(≈650ms),实际 ${Math.round(mutualB.elapsed)}ms`);
    console.log(`[11b] 互斥:服务状态展开时开插件侧栏 → 并行换边(${Math.round(mutualB.elapsed)}ms) ✓`);

    console.log("\nPASS ✓ 「服务状态」共享面板(注入式,右滑+互斥)回归通过");
    win.destroy();
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 「服务状态」共享面板(注入式,右滑+互斥)回归:", err.message);
    if (err.stack) console.error(err.stack.split("\n").slice(0, 4).join("\n"));
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});