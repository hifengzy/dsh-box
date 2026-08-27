"use strict";

/**
 * main.js — Electron 主进程入口。
 *
 * 职责:
 *   1. 启动 dsh web 子进程(见 dsh-server.js),等待 HTTP 就绪;
 *   2. 创建窗口:自定义顶栏视图 + 内容视图(WebContentsView),内容区内缩+圆角;
 *   3. 管理应用菜单、权限请求、外链打开、单实例锁;
 *   4. 退出时清理 dsh 子进程。
 *
 * 进程模型:
 *   ┌─ Electron 主进程 (main.js) ───────────────────────┐
 *   │  ├─ spawn ─→ dsh web 子进程 (Node)                │ ← 同一原生进程树,
 *   │  │              └─ spawn ─→ bash/shell            │   继承 App 的 TCC 权限
 *   │  ├─ WebContentsView 顶栏 (topbar.html)            │ 自定义标题栏(拖拽/双击/未来功能)
 *   │  └─ WebContentsView 内容 (加载页 → dsh UI)        │ 内缩 8px + 圆角 10px
 *   └──────────────────────────────────────────────────┘
 *
 * 为什么用 WebContentsView 而不是在 dsh 页面里注入顶栏:
 *   dsh 页面内部用了视口单位(100vh),在页面内做留白/内缩会产生滚动条;
 *   顶栏作为独立的原生级视图,内容区在窗口层内缩,完全不碰页面布局,
 *   并且顶栏里将来可以随意加搜索框等功能入口(纯 HTML)。
 */

const { app, BrowserWindow, Menu, session, shell, dialog, ipcMain, WebContentsView, nativeTheme, Notification } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DshServer, DEFAULT_PORT, bundledDshPath } = require("./dsh-server");
const { isServerOrigin, isTrustedOrigin } = require("./url-guard");
const { createTray } = require("./tray");
const { createAppMenu } = require("./menu");
const { showAboutWindow } = require("./about");
const { getRuntimeDshInfo } = require("./dsh-version");
const npmCheck = require("./npm-check");
const { upgradeDsh, restoreDshBackup, verifyDshBoot, findNewestBackup, findBackups } = require("./dsh-upgrade");
const { computeSidebar, SIDEBAR_GAP } = require("./sidebar-layout");
const { SIDEBAR_ANIM_MS, easeSidebar } = require("./sidebar-anim");
const pluginManager = require("./plugin-manager");
const { readSettingValue, readSettingBool, writeSettingValue, writeSettingBool } = require("./box-settings");
const {
  PLUGIN_BRIDGE_JS,
  PLUGIN_HIDE_CSS,
  MARKET_BRIDGE_JS_FN,
} = require("./plugin-ui-inject");
const {
  STATUS_PANEL_CSS,
  STATUS_BRIDGE_JS_FN,
  STATUS_WIDTH_MIN,
  STATUS_WIDTH_MAX,
  STATUS_WIDTH_DEFAULT,
} = require("./status-ui-inject");
const { runMutualOpen } = require("./status-panel-router");
const { readThemePreference, applyThemePreference, watchThemePreference } = require("./theme-sync");
const { createNotifyWatcher } = require("./notify-watch");
const { createAppUpdater } = require("./app-updater");

const APP_NAME = "DSH Box";
const isMac = process.platform === "darwin";

// 窗口外观常量
const BAR_HEIGHT = 40; // 自定义顶栏高度
const CONTENT_INSET = 4; // 内容区相对窗口边缘的内缩(视觉边框,纤细款)
const CONTENT_GAP = 0; // 顶栏与内容区之间的间隙(0 = 内容紧贴顶栏,顶栏无底边线也不显高)
const CONTENT_RADIUS = 10; // 内容区四角圆角
// 玻璃拟态(参考新版微信 macOS):内容区以外的区域(顶栏+边框)用
// macOS 原生毛玻璃材质。可换材质: 'under-window' | 'sidebar' | 'hud' | 'header'
const VIBRANCY_MATERIAL = "under-window";

// 端口冲突并存:请求端口被其它服务占用时,自动改用 port+1、port+2 …(最多跳过
// MAX_PORT_SKIP 个)。DSH Box 永远不接管、不共享用户已有服务与其 profile。
const MAX_PORT_SKIP = 10;
// 首次启动(需求 4):settings.yaml 的 dsh-box 域存 launchedBefore 标记;
// 首启且窗口就绪后自动展开「服务状态」侧边栏(小延迟,等首屏画完)。
const FIRST_LAUNCH_SETTING_KEY = "launchedBefore";
const FIRST_LAUNCH_DELAY_MS = 800;

// 测试钩子:重定向用户数据目录(冒烟测试/CI 用,避免写 ~/Library)
if (process.env.DSH_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.DSH_USER_DATA));
}

// ---------- 全局单实例锁 ----------
// Electron 的 requestSingleInstanceLock 以 userData 为作用域:dev(npm start)
// 与打包版 userData 不同,两个实例可以同时运行,并争抢同一个端口,导致
// 后启动者的 dsh 绑定失败(EADDRINUSE)→ 启动页误报"服务启动失败"。
// 这里用固定路径的锁文件,让所有实例(无论 userData)共享一把锁。
// 测试/CI 可用 DSH_LOCK_PATH 覆盖,避免与正在运行的实例冲突。
const GLOBAL_LOCK_PATH = process.env.DSH_LOCK_PATH || path.join(os.tmpdir(), "dsh-box.lock");

/**
 * 获取全局锁:成功返回 true;另一实例在跑返回 false;陈旧锁(持有者已死)自动接管。
 * @returns {boolean}
 */
function acquireGlobalLock() {
  try {
    fs.mkdirSync(GLOBAL_LOCK_PATH);
    fs.writeFileSync(path.join(GLOBAL_LOCK_PATH, "pid"), String(process.pid));
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const pid = Number(fs.readFileSync(path.join(GLOBAL_LOCK_PATH, "pid"), "utf8"));
      process.kill(pid, 0); // 持有者存活 → 拒绝
      return false;
    } catch {
      // 陈旧锁(持有者已死):接管
      fs.rmSync(GLOBAL_LOCK_PATH, { recursive: true, force: true });
      return acquireGlobalLock();
    }
  }
}

const gotGlobalLock = acquireGlobalLock();
if (!gotGlobalLock) {
  console.log("[app] 已有 DSH Box 实例在运行,本次启动退出");
  app.quit();
} else {
  app.on("will-quit", () => {
    try {
      fs.rmSync(GLOBAL_LOCK_PATH, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  });
  main();
}

function main() {
  /** @type {BrowserWindow|null} */
  let mainWindow = null;
  /** @type {WebContentsView|null} */
  let topBarView = null;
  /** @type {WebContentsView|null} */
  let contentView = null;
  let server = null;
  /** macOS 菜单栏 Tray(常驻小图标);null = 非 mac 或创建失败 */
  let tray = null;
  /** 应用菜单;null = 构建失败 */
  let appMenu = null;
  /** 最近一次错误消息;加载页加载时会拉取,避免错误只在广播瞬间可见 */
  let lastError = null;
  /** 服务状态机:starting | ready | error | stopped(供状态页与加载页展示) */
  let serviceState = "starting";
  /** 右侧「dsh 服务与版本」面板视图(WebContentsView);null = 未展开 */
  let statusView = null;
  /** 顶栏 tooltip 气泡层(WebContentsView):顶栏自定义 tooltip 的宿主,
   *  由主进程定位到按钮正下方;平时 0×0 隐藏。null = 未创建 */
  let tooltipView = null;
  /** 面板是否展开(顶栏状态按钮的激活态来源) */
  let sidebarOpen = false;
  /** 面板展开/收起动画句柄(帧驱动 setBounds);null = 无动画进行中 */
  let sidebarAnim = null;
  /** 是否正在执行升级(防止并发升级) */
  let upgrading = false;
  /** 最近一次 npm 更新检查结果(顶栏红点用) */
  let lastUpdateCheck = null;
  /** 最近一次插件检查结果(侧边栏插件板块 + 红点) */
  let lastPluginCheck = null;
  /** 是否正在安装/更新插件(防止并发) */
  let pluginInstalling = false;
  /** 插件市场(dshmarket)最近一次检查结果 */
  let lastMarketCheck = null;
  /** 是否正在安装/更新插件市场 */
  let marketInstalling = false;
  /** 「在 DSH 侧边栏显示插件市场入口」开关(启动时读 settings.yaml) */
  let marketSidebarEntry = false;
  /** 「服务状态」共享面板(内容视图注入层)开合镜像;null 语义同 false */
  let statusPanelOpen = false;
  /** 注入桥缺失(executeJavaScript 失败/无返回值)→ 本会话回退 statusView */
  let statusInjectBroken = false;
  /** 插件侧栏/底栏最近一次上报状态(互斥编排用) */
  let lastPluginPanels = null;
  /** 「服务状态」共享面板宽度(拖拽持久化,启动时读 settings.yaml) */
  let statusPanelWidth = STATUS_WIDTH_DEFAULT;
  /** 横幅通知开关(默认关;持久化 dsh-box.notificationBanner) */
  let notifyBanner = false;
  /** 声音通知开关(默认关;持久化 dsh-box.notificationSound) */
  let notifySound = false;
  /** 本次运行是否已发过「开启横幅」测试通知(首次触发 macOS 系统授权弹窗) */
  let notifyPrompted = false;
  /** dsh 服务是否就绪(通知事件流依赖 dsh 服务在线) */
  let notifyReady = false;
  /** 本次运行服务端口是否发生过迁移(端口被占用 → 自动改用下一端口);null = 未迁移 */
  let portMovedFrom = null;
  /** dsh 事件流 watcher(createNotifyWatcher 实例);null = 未运行 */
  let notifyWatcher = null;
  /** 应用自更新状态机(createAppUpdater);null = 未初始化 */
  let appUpdater = null;
  /** 插件/插件市场安装互斥锁:一次只允许一个 pnpm 安装(并发会 store 锁冲突) */
  let pluginOpPending = false;
  /** 提示音文件(随 App 打包的 assets/message.m4a,dev 与打包同相对路径) */
  const NOTIFY_SOUND_PATH = path.join(__dirname, "..", "..", "assets", "message.m4a");

  const port = Number(process.env.DSH_APP_PORT) || DEFAULT_PORT;

  app.setName(APP_NAME);

  // ---------- 外观主题偏好 → nativeTheme.themeSource ----------
  // 只同步「偏好」(light/dark/system),绝不镜像「解析后的浅/深」:镜像会把
  // themeSource 锁死,使 dsh 前端 prefers-color-scheme 永远读不到真实系统
  // 配色(「跟随系统」失效,见 theme-sync.js 说明)。偏好持久化在
  // <DSH_HOME>/settings.yaml(ui-theme.preference):窗口创建前应用一次,让
  // 启动页(prefers-color-scheme)与毛玻璃从第一帧就正确;之后 fs.watchFile
  // 监听文件,用户在 dsh 设置里切换外观时实时生效,无需重启。
  (function initThemeSync() {
    const home = process.env.DSH_HOME || path.join(app.getPath("userData"), "dsh-home");
    const themeSettingsPath = path.join(home, "settings.yaml");
    const preference = readThemePreference(themeSettingsPath);
    if (preference) {
      applyThemePreference(nativeTheme, preference);
      console.log(`[app] 应用外观偏好: ${preference}`);
    }
    watchThemePreference(themeSettingsPath, (next) => {
      if (applyThemePreference(nativeTheme, next)) {
        console.log(`[app] 外观偏好实时同步: ${next}`);
      }
    });
  })();

  const VIEW_PRELOAD = {
    preload: path.join(__dirname, "..", "preload", "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };

  // ---------- 窗口与视图 ----------
  function createWindow() {
    mainWindow = new BrowserWindow({
      title: APP_NAME,
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 600,
      // macOS:未聚焦窗口的首次点击也要传递给 Web 内容。默认 acceptFirstMouse
      // 是 false——首击只激活窗口不派发事件,顶栏按钮(状态/GitHub)会变成
      // 「第一下没反应,第二下才生效」。
      acceptFirstMouse: true,
      // 玻璃拟态:窗口背景用 macOS 原生毛玻璃材质(内容区以外=顶栏+边框
      // 都是它);不设不透明 backgroundColor,让材质透出
      vibrancy: VIBRANCY_MATERIAL,
      visualEffectState: "active", // 窗口失焦时也保持模糊(微信同款观感)
      // 隐藏标题栏但保留 macOS 红绿灯按钮;红绿灯浮在自定义顶栏上
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 14 },
    });

    // 顶栏视图:自定义标题栏(整条可拖动,双击最大化,将来加功能入口)
    topBarView = new WebContentsView({ webPreferences: VIEW_PRELOAD });
    // 顶栏背景透明 → 透出窗口的毛玻璃材质
    topBarView.setBackgroundColor("#00000000");
    // 内容视图:加载页 → dsh UI;内缩 + 圆角(内容本身不透明)
    contentView = new WebContentsView({ webPreferences: VIEW_PRELOAD });
    contentView.setBorderRadius(CONTENT_RADIUS);
    // 页面绘制前透明,避免白闪(加载页/dsh UI 有各自的不透明背景)
    contentView.setBackgroundColor("#00000000");
    // 注入(custom.css / 事件防御 / 主题同步)必须按窗口注册:
    // 之前只在第一个窗口的 webContents 上装了一次,关窗重开(activate)
    // 的新窗口完全没有注入。这里每个窗口各装一份。
    installWebUIInjection();

    mainWindow.contentView.addChildView(topBarView);
    mainWindow.contentView.addChildView(contentView);

    // ---------- 焦点管理(关键修复) ----------
    // WebContentsView 架构下,窗口聚焦不代表内容页聚焦(document.hasFocus()
    // 仍为 false)。页面无焦点时,Chromium 会把点击当"未聚焦窗口的首次点击",
    // macOS 会重复投递 pointerdown,触发 dsh 命令面板等弹层"打开即消失"
    // (它们用 document 捕获期 pointerdown + 点击外部即关闭)。
    // 修复:窗口聚焦时显式把焦点交给内容视图。
    const focusContent = () => {
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.focus();
      }
    };
    mainWindow.on("focus", focusContent);

    mainWindow.setMenuBarVisibility(false);
    layoutViews();

    mainWindow.on("resize", () => {
      layoutViews();
      broadcastSidebarState();
    });
    mainWindow.on("enter-full-screen", () => setTimeout(() => {
      layoutViews();
      broadcastSidebarState();
    }, 120));
    mainWindow.on("leave-full-screen", () => setTimeout(() => {
      layoutViews();
      broadcastSidebarState();
    }, 120));

    // 顶栏内容
    topBarView.webContents.loadFile(path.join(__dirname, "..", "renderer", "topbar.html"));
    // 内容视图:服务已就绪(关窗重开等场景)→ 直接加载 WebUI;
    // 否则先显示加载页,等 dsh 服务就绪后再由 ready 事件切过去。
    if (server && server.ready) {
      contentView.webContents.loadURL(server.url);
    } else {
      contentView.webContents.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    }
    // 初始焦点交给内容视图(同上,防止 document.hasFocus() 一直为 false)
    setTimeout(focusContent, 0);

    // 内容视图的导航与外链处理
    const wc = contentView.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        shell.openExternal(url);
      }
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, url) => {
      const serverUrl = server ? server.url : "";
      // 精确同源判断(解析 URL 比对 origin),避免前缀匹配被
      // userinfo(http://127.0.0.1:3260@evil.com)或端口前缀(32600)绕过
      if (serverUrl && !isServerOrigin(url, serverUrl)) {
        event.preventDefault();
        if (url.startsWith("http://") || url.startsWith("https://")) {
          shell.openExternal(url);
        }
      }
    });
    // did-navigate 兜底(对抗审查 P2-D3):服务端 30x 重定向不触发 will-navigate,
    // 重定向目标可能把内容视图导出同源 —— 主框架每次导航完成都校验一次,
    // 异源直接强制回跳 WebUI。file://(加载页/错误页)是预期内容,放行。
    wc.on("did-navigate", (_event, url) => {
      const serverUrl = server ? server.url : "";
      if (!serverUrl) return;
      if (url.startsWith("file://")) return;
      if (!isServerOrigin(url, serverUrl)) {
        console.warn(`[app] did-navigate 非服务同源(${url}),强制回跳 WebUI`);
        wc.loadURL(serverUrl);
      }
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
      topBarView = null;
      contentView = null;
      statusView = null;
      tooltipView = null;
      sidebarOpen = false;
      // 新窗口语义初值:注入面板开合/桥故障标记/插件面板缓存/错误/端口迁移
      // 全部复位,否则关窗重开(activate)后首击按旧状态处理(对抗审查 P2-A4)
      statusPanelOpen = false;
      statusInjectBroken = false;
      lastPluginPanels = null;
      lastError = null;
      portMovedFrom = null;
    });
  }

  /**
   * 聚焦主窗口;窗口不存在(已关闭)则重新创建。
   * 供 Dock 图标点击(activate)与菜单栏图标单击共用。
   */
  function focusOrCreateWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    createWindow();
  }

  /** 当前窗口内容区宽度(不含两侧内缩),供侧边栏宽度计算 */
  function currentInnerWidth() {
    if (!mainWindow || mainWindow.isDestroyed()) return 0;
    return Math.max(0, mainWindow.getContentBounds().width - CONTENT_INSET * 2);
  }

  /**
   * 按当前窗口尺寸摆放所有视图:顶栏通栏;内容区 = dsh WebUI,右侧(可选)
   * 状态面板展开时按「内容优先」(sidebar-layout.js)拆分为两块圆角视图。
   */
  function layoutViews() {
    if (!mainWindow || mainWindow.isDestroyed() || !topBarView || !contentView) return;
    // 缩放/全屏切换 = 快照布局,取消进行中的展开/收起动画
    cancelSidebarAnimation();
    const { width, height } = mainWindow.getContentBounds();
    topBarView.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT });

    const innerW = currentInnerWidth();
    const innerH = Math.max(0, height - BAR_HEIGHT - CONTENT_GAP - CONTENT_INSET);
    const layout = computeSidebar(innerW, { open: sidebarOpen });

    // 窗口缩窄导致面板放不下(或内容区跌破保底)→ 自动收起(快照,不受 toggle 触发)
    if (sidebarOpen && layout.shouldClose) {
      sidebarOpen = false;
      if (statusView) {
        try {
          mainWindow.contentView.removeChildView(statusView);
        } catch {
          /* 视图可能已被窗口清理 */
        }
        statusView = null;
      }
    }
    // 收起动画进行中遇到缩放 → 直接清理残留视图(动画帧已被取消)
    if (!sidebarOpen && statusView) {
      try {
        mainWindow.contentView.removeChildView(statusView);
      } catch {
        /* 视图可能已被窗口清理 */
      }
      statusView = null;
    }

    const sidebarW = sidebarOpen ? layout.sidebarW : 0;
    const contentW = sidebarOpen ? layout.contentW : innerW;
    contentView.setBounds({
      x: CONTENT_INSET,
      y: BAR_HEIGHT + CONTENT_GAP,
      width: contentW,
      height: innerH,
    });

    if (sidebarOpen && statusView) {
      statusView.setBounds({
        x: CONTENT_INSET + contentW + SIDEBAR_GAP,
        y: BAR_HEIGHT + CONTENT_GAP,
        width: Math.max(0, innerW - contentW - SIDEBAR_GAP),
        height: innerH,
      });
    }
  }

  // ---------- 状态广播(发给内容视图 + 右侧状态面板) ----------
  function broadcastStatus(status) {
    if (contentView && !contentView.webContents.isDestroyed()) {
      contentView.webContents.send("dsh:status", status);
    }
    if (statusView && !statusView.webContents.isDestroyed()) {
      statusView.webContents.send("dsh:status", status);
    }
  }

  function getServerInfo() {
    const runtime = getRuntimeDshInfo();
    return {
      version: runtime.version ?? null,
      // 端口可能因冲突迁移(端口被占 → 自动改用下一端口):始终如实上报当前端口
      port: server?.port ?? port,
      portMovedFrom,
      url: server ? server.url : `http://127.0.0.1:${port}`,
      pid: server?.child?.pid ?? null,
      dshBin: server?.dshBin ?? null,
      dshHome: server?.dshHome ?? null,
      logFile: server?.logFile ?? null,
      ready: server?.ready ?? false,
      state: serviceState,
      message:
        lastError ??
        (serviceState === "ready"
          ? "服务运行中"
          : serviceState === "stopped"
            ? "服务已停止"
            : ""),
    };
  }

  // ---------- dsh 服务生命周期 ----------
  function wireServerEvents() {
    server.on("ready", (url) => {
      lastError = null;
      serviceState = "ready";
      broadcastStatus({ state: "ready", message: `服务已就绪: ${url}` });
      // 通知事件流依赖 dsh 服务:就绪 → 若开关有开启则启动 watcher
      notifyReady = true;
      ensureNotifyWatcher();
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.loadURL(url);
      }
    });
    server.on("error", (error) => {
      console.error("[app] dsh 启动失败:", error);
      lastError = error.message;
      serviceState = "error";
      notifyReady = false;
      stopNotifyWatcher();
      broadcastStatus({ state: "error", message: lastError });
    });
    server.on("exited", ({ code, signal }) => {
      lastError = `dsh 服务意外退出 (code=${code}, signal=${signal})。点击重试重新启动。`;
      serviceState = "error";
      notifyReady = false;
      stopNotifyWatcher();
      broadcastStatus({ state: "error", message: lastError });
      // 若内容视图正显示 WebUI(服务已死,页面已无响应),切回加载页
      // 展示错误与重试入口,而不是让用户对着一块死页面。
      if (
        contentView &&
        !contentView.webContents.isDestroyed() &&
        isServerOrigin(contentView.webContents.getURL(), server.url)
      ) {
        contentView.webContents.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
      }
    });
  }

  // ---------- 页面注入(custom.css + 事件防御) ----------
  // 项目根目录的 custom.css 会被注入到 dsh WebUI,改布局不用写插件。
  // 开发时是项目根目录;打包后在 Resources/app/custom.css。
  function readCustomCss() {
    try {
      return fs.readFileSync(path.join(__dirname, "..", "..", "custom.css"), "utf8");
    } catch {
      return "";
    }
  }

  // 防御:macOS 在"未聚焦窗口的首次点击"时,Chromium 会对同一次物理点击
  // 重复投递 pointerdown(激活 + 实际点击)。dsh 的命令面板/触发菜单等弹层
  // 都监听"document 捕获期 pointerdown + 点击卡片外即关闭",重复投递会让
  // 面板"打开即消失"。这里在捕获期吞掉 60ms/4px 内的重复 pointerdown。
  // 注意:注册时机早于任何弹层的 dismiss 监听(我们在页面加载后注册),
  // 所以捕获期先执行;人类双击间隔远大于 60ms,不会误伤。
  const POINTER_DUP_GUARD_JS = `
    (() => {
      if (window.__dshDesktopPointerGuard) return;
      window.__dshDesktopPointerGuard = true;
      let last = null;
      document.addEventListener('pointerdown', (e) => {
        const now = performance.now();
        if (last !== null && now - last.t < 60 &&
            Math.abs(e.clientX - last.x) <= 4 && Math.abs(e.clientY - last.y) <= 4) {
          e.stopImmediatePropagation();
          e.preventDefault();
          return;
        }
        last = { t: now, x: e.clientX, y: e.clientY };
      }, true);
    })();
  `;

  function installWebUIInjection() {
    if (!contentView) return;
    const wc = contentView.webContents;
    wc.on("did-finish-load", () => {
      if (!server || !isServerOrigin(wc.getURL(), server.url)) return;
      wc.executeJavaScript(POINTER_DUP_GUARD_JS, true).catch(() => {});
      wc.executeJavaScript(PLUGIN_BRIDGE_JS, true).catch(() => {});
      wc.executeJavaScript(MARKET_BRIDGE_JS_FN(marketSidebarEntry), true).catch(() => {});
      wc.executeJavaScript(STATUS_BRIDGE_JS_FN(statusPanelWidth), true).catch(() => {});
      wc.insertCSS(PLUGIN_HIDE_CSS).catch(() => {});
      wc.insertCSS(STATUS_PANEL_CSS).catch(() => {});
      const css = readCustomCss();
      if (css) wc.insertCSS(css).catch(() => {});

      // 无缝移交:首启自动展开的「兜底 statusView」→ 注入共享面板。
      // 场景:首次启动 800ms 时 dsh 尚未就绪 → 走 openStatusSidebar 兜底;
      // 之后 dsh 就绪、WebUI 加载完成、注入桥可用 → 若兜底面板仍开着,
      // 经桥打开注入面板并收起兜底,让顶栏按钮状态与面板保持一致
      // (否则 sidebarState() 在注入模式上报 {open:false},顶栏按钮与可见面板不符)。
      // 桥失败/缺失:保留兜底面板,绝不 markInjectBroken(启动期竞态不误伤注入模式)。
      (async () => {
        if (!sidebarOpen || statusPanelOpen) return;
        try {
          await wc.executeJavaScript(STATUS_BRIDGE_JS_FN(statusPanelWidth), true);
          await new Promise((r) => setTimeout(r, 120)); // 等页面执行完注入脚本
          if (!sidebarOpen || statusPanelOpen) return; // 状态已被用户/其它流程改变
          await execStatusBridge("requestOpen()");
          closeStatusSidebar();
        } catch {
          /* 保留兜底面板 */
        }
      })();
    });
  }

  // ---------- 升级中断自愈 ----------
  // 升级的「下载+闭包安装」阶段不触碰线上 dsh,「原子替换」窗口毫秒级;但历史
  // 版本(根树整树 install)可能留下「换上新版但闭包缺失」的坏态。启动时冒烟
  // 检查当前 dsh 能否运行(与真实启动同运行时跑 dsh --version),失败则自动从
  // 备份恢复,保证 App 永远能回到上次可用的版本。
  // 自愈只针对 App 内置包(用户 DSH_BIN/全局 dsh 是显式意图,不干预);
  // 备份可迭代多份(新旧→),`pkgDir` 被 kill -9 卡在双 rename 窗口而缺失时
  // 同样直接恢复(对抗审查 P1-3 / P2-C3)。
  const RESTORE_TRIES = 3;
  async function healInterruptedUpgrade() {
    try {
      // 定位 App 内置 dsh 包根(bundledDshPath = 内置入口;向上找 package.json),
      // 不依赖 resolveDsh —— 内置目录缺失时 resolveDsh 会落到用户全局 PATH,
      // 拿到的 packageDir 不是内置包,自愈会扑空。
      const bundled = bundledDshPath();
      if (!bundled) return;
      let pkgDir = null;
      {
        let dir = path.dirname(bundled);
        for (let i = 0; i < 8; i++) {
          if (fs.existsSync(path.join(dir, "package.json"))) {
            pkgDir = dir;
            break;
          }
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
      if (!pkgDir) return;
      const probeHome = path.join(app.getPath("userData"), "boot-probe");
      const smoker = async (dir) =>
        verifyDshBoot({ pkgDir: dir, dshHome: probeHome, log: console }).catch(() => ({ ok: false, error: "自检进程异常" }));

      // 1) 包目录缺失(双 rename 窗口被 kill -9)→ 直接从最新备份恢复
      if (!fs.existsSync(path.join(pkgDir, "lib", "bin.js"))) {
        const backups = findBackups(pkgDir);
        if (!backups.length) {
          console.warn("[app] 自愈: 内置 dsh 包缺失且无备份可恢复(由启动流程报错)");
          return;
        }
        for (const backup of backups.slice(0, RESTORE_TRIES)) {
          const rb = restoreDshBackup(pkgDir, backup);
          if (!rb.ok) {
            console.warn(`[app] 自愈: 恢复备份失败(${rb.error}),尝试更早备份…`);
            continue;
          }
          const probe = await smoker(pkgDir);
          if (probe.ok) {
            console.log(`[app] 自愈: 内置 dsh 包缺失,已从备份恢复 → ${backup}`);
            return;
          }
        }
        console.error("[app] 自愈: 内置 dsh 包缺失,所有备份恢复后仍无法启动");
        return;
      }

      // 2) 包在位但冒烟失败(半截包)→ 逐份备份恢复 + 冒烟
      const first = await smoker(pkgDir);
      if (first.ok) return; // 冒烟通过,无需自愈
      const backups = findBackups(pkgDir);
      if (!backups.length) {
        console.warn("[app] 自愈: dsh 自检失败且无备份可恢复(继续,由加载页展示错误)");
        return;
      }
      for (const backup of backups.slice(0, RESTORE_TRIES)) {
        const rb = restoreDshBackup(pkgDir, backup);
        if (!rb.ok) continue;
        const second = await smoker(pkgDir);
        if (second.ok) {
          console.log(`[app] 自愈: dsh 自检失败(${first.error}),已从备份恢复 → ${backup}`);
          return;
        }
        console.warn(`[app] 自愈: 备份 ${backup} 恢复后仍冒烟失败,尝试更早备份…`);
      }
      console.error("[app] 自愈: 所有备份恢复后 dsh 仍无法启动");
    } catch (error) {
      console.warn("[app] 启动自愈检查跳过:", error.message);
    }
  }

  // 端口冲突并存(需求 7):请求端口被其它服务占用时,不接管、不报死,
  // 而是逐候选(port, port+1, …)重试,直到找到可用端口。两条防线:
  //   1. 预检:spawn 前探活,被占直接换下一候选;
  //   2. 竞态:spawn 后仍撞上 EADDRINUSE(或端口恰好此刻被占)→ 也换下一候选。
  // 只有「端口上没有服务在响应」的真实启动失败才维持既有错误展示。
  function isPortConflict(error) {
    const msg = (error && error.message) || "";
    return /EADDRINUSE|address already in use/i.test(msg);
  }

  // 启动中防抖(对抗审查 P2-A2):startServer/restartServer/retry 并发调用时,
  // 只允许一个启动流程,后续调用复用同一 promise —— 不再并发双重 spawn、
  // 不再因竞态无谓进入候选端口循环触发「端口均被占用」误报。
  let serverStartPromise = null;

  /** 启动 dsh 服务(并发安全:已在运行或启动中时直接复用) */
  function startServer() {
    if (server && (server.ready || server.child)) return Promise.resolve(server.url);
    if (serverStartPromise) return serverStartPromise; // 启动中 → 复用同一 promise
    serverStartPromise = (async () => {
      if (!server) {
        server = new DshServer({ port });
        wireServerEvents();
      }
      lastError = null;
      serviceState = "starting";
      portMovedFrom = null;
      broadcastStatus({ state: "starting", message: "正在启动 dsh 服务…" });

      const logDir = path.join(app.getPath("userData"), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      // DSH_HOME 默认用 App 自己的目录,与浏览器 WebUI 的 ~/.dsh 隔离:
      // 两个 dsh 服务共享同一会话会互相刷新状态,导致命令面板等
      // 会话级弹层"打开即消失"。设 DSH_HOME 可覆盖(共享时勿双开同会话)。
      const dshHome = process.env.DSH_HOME || path.join(app.getPath("userData"), "dsh-home");

      for (let attempt = 0; attempt < MAX_PORT_SKIP; attempt++) {
        const cand = port + attempt;
        try {
          // 先清本 App 的孤儿残留(只认 PPID=1 + 带 --no-open 的签名),再探活
          await server.reapStaleServers(cand);
          if (await server.probePort(cand)) {
            console.log(`[app] 端口 ${cand} 已被其他服务占用,DSH Box 自动改用端口 ${cand + 1}`);
            broadcastStatus({
              state: "starting",
              message: `端口 ${cand} 已被其他服务占用,DSH Box 将改用端口 ${cand + 1}`,
            });
            continue;
          }
          await server.start({ port: cand, dshHome, logDir }); // dshBin 由 DshServer 自动解析
          if (attempt > 0) {
            portMovedFrom = port; // 端口迁移过:状态页如实展示(原始端口 → 现端口)
            console.log(`[app] dsh 服务端口已从 ${port} 迁移到 ${cand}(原端口被占用)`);
          }
          return server.url; // serviceState=ready 由 server.on("ready") 设置
        } catch (error) {
          // 竞态占用(spawn 后才发现被占):换下一候选;先探活确认,避免把
          // 真实启动失败(EADDRINUSE 之外的原因)误判为端口冲突
          const nowBusy = await server.probePort(cand).catch(() => false);
          if (nowBusy || isPortConflict(error, cand)) {
            console.log(`[app] 端口 ${cand} 启动 dsh 失败(端口被其他服务占用),自动改用端口 ${cand + 1}`);
            continue;
          }
          // 真实启动失败:错误事件已由 server 广播;这里吞掉,避免 unhandled rejection
          if (error.code !== "DSH_NOT_FOUND" && error.code !== "DSH_START_TIMEOUT") {
            console.error("[app] startServer 异常:", error);
          }
          return undefined;
        }
      }
      // 候选全部被占:进入错误态(与既有错误展示同一路径)
      const allBusy = `端口 ${port} ~ ${port + MAX_PORT_SKIP - 1} 均被其他服务占用,DSH Box 无法启动 dsh 服务。请先关闭占用这些端口的程序后重试。`;
      lastError = allBusy;
      serviceState = "error";
      broadcastStatus({ state: "error", message: allBusy });
    })().finally(() => {
      serverStartPromise = null;
    });
    return serverStartPromise;
  }

  async function restartServer() {
    if (server) await server.stop();
    await startServer();
  }

  // ---------- 右侧「dsh 服务与版本」面板(顶栏按钮/菜单控制开关) ----------
  /**
   * 「服务状态」共享面板(内容视图注入层)是否可用:仅当 dsh 服务就绪且内容
   * 视图正显示 dsh WebUI 时成立。异常态(未启动/崩溃/重启中)内容视图在加载页
   * (file://),注入面板不存在→ 自然回退到 statusView 兜底,两者互不干扰。
   */
  function statusInjectActive() {
    return (
      !statusInjectBroken &&
      !!server &&
      server.ready &&
      contentView &&
      !contentView.webContents.isDestroyed() &&
      isServerOrigin(contentView.webContents.getURL(), server.url)
    );
  }

  /** @returns {{ open: boolean, canOpen: boolean }} 当前面板状态 */
  function sidebarState() {
    // 注入模式:overlay 面板不挤占内容区,不受窗口宽度约束 → 恒可开
    if (statusInjectActive()) {
      return { open: statusPanelOpen, canOpen: true };
    }
    // 兜底模式(独立 statusView):宽度布局滞回判定
    const layout = computeSidebar(currentInnerWidth(), { open: sidebarOpen });
    return { open: sidebarOpen, canOpen: layout.canOpen };
  }

  function broadcastSidebarState() {
    if (topBarView && !topBarView.webContents.isDestroyed()) {
      topBarView.webContents.send("dsh:sidebar-state", sidebarState());
    }
  }

  /**
   * 按给定面板宽度摆位(动画逐帧调用):dsh 内容区占左侧,面板占右侧。
   * 宽度按当前窗口内宽钳制,避免动画帧超过可用范围。
   * @param {number} w 面板目标宽度(px)
   */
  function applySidebarWidth(w) {
    if (!mainWindow || mainWindow.isDestroyed() || !contentView) return;
    const { width, height } = mainWindow.getContentBounds();
    const innerW = currentInnerWidth();
    const innerH = Math.max(0, height - BAR_HEIGHT - CONTENT_GAP - CONTENT_INSET);
    const wClamped = Math.max(0, Math.min(w, innerW - SIDEBAR_GAP));
    // 面板完全收起(w=0)时内容区占满内宽、不留隔离缝——否则右侧会残留
    // 一条 4px 玻璃条,与 4px 窗口内缩叠成「粗边框」
    const contentW =
      wClamped > 0 ? Math.max(0, innerW - wClamped - SIDEBAR_GAP) : innerW;
    contentView.setBounds({
      x: CONTENT_INSET,
      y: BAR_HEIGHT + CONTENT_GAP,
      width: contentW,
      height: innerH,
    });
    if (statusView && !statusView.webContents.isDestroyed()) {
      statusView.setBounds({
        x: CONTENT_INSET + contentW + SIDEBAR_GAP,
        y: BAR_HEIGHT + CONTENT_GAP,
        width: wClamped,
        height: innerH,
      });
    }
  }

  function cancelSidebarAnimation() {
    sidebarAnim = null; // 帧回调按 identity 检查,置空即失效
  }

  /**
   * 启动面板宽度动画(300ms,与 dsh 左侧边栏同款缓动 cubic-bezier(.4,0,.2,1))。
   * @param {number} fromW 起始宽度
   * @param {number} toW 目标宽度
   * @param {() => void} [onDone] 动画结束回调(如收起后移除视图)
   */
  function startSidebarAnimation(fromW, toW, onDone) {
    cancelSidebarAnimation();
    if (Math.abs(toW - fromW) < 1) {
      applySidebarWidth(toW);
      onDone?.();
      return;
    }
    const startAt = Date.now();
    const anim = { startAt, fromW, toW, onDone };
    sidebarAnim = anim;
    const step = () => {
      if (sidebarAnim !== anim) return; // 被新动画/取消/缩放顶替
      const t = Math.min(1, (Date.now() - startAt) / SIDEBAR_ANIM_MS);
      applySidebarWidth(Math.round(fromW + (toW - fromW) * easeSidebar(t)));
      if (t < 1) {
        setTimeout(step, 16);
      } else {
        sidebarAnim = null;
        onDone?.();
      }
    };
    step();
  }

  function openStatusSidebar() {
    if (statusView) {
      // 可能正处于「收起动画」中:取消收起,从当前宽度动画回目标
      if (!sidebarOpen) {
        const from = statusView.getBounds().width;
        cancelSidebarAnimation();
        sidebarOpen = true;
        startSidebarAnimation(from, computeSidebar(currentInnerWidth(), { open: true }).sidebarW);
        broadcastSidebarState();
      }
      return true;
    }
    if (!sidebarState().canOpen) return false; // 窗口太窄,不展开
    sidebarOpen = true;
    statusView = new WebContentsView({ webPreferences: VIEW_PRELOAD });
    // 面板内容不透明,主题适配底色(页面自带同色背景,避免首帧闪色)
    statusView.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#151517" : "#f9fafb");
    statusView.setBorderRadius(CONTENT_RADIUS);
    // 面板里的链接(DSH 仓库 / 插件仓库)一律交系统默认浏览器,绝不在
    // Electron 里开新窗口(target="_blank" 兜底拦截,与内容视图同策略)
    statusView.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        shell.openExternal(url);
      }
      return { action: "deny" };
    });
    mainWindow.contentView.addChildView(statusView);
    // 先按 0 宽摆位,再从 0 动画展开到目标宽度
    applySidebarWidth(0);
    // 每次打开都重建视图 → 进入面板必然重新查 npm(符合需求)
    statusView.webContents.loadFile(path.join(__dirname, "..", "renderer", "dsh-status.html"));
    broadcastSidebarState();
    startSidebarAnimation(0, computeSidebar(currentInnerWidth(), { open: true }).sidebarW);
    return true;
  }

  function closeStatusSidebar() {
    if (!sidebarOpen && !statusView) return;
    sidebarOpen = false;
    broadcastSidebarState();
    if (statusView) {
      const from = statusView.getBounds().width;
      startSidebarAnimation(from, 0, () => {
        // 动画结束:移除视图,并恢复闭合布局——动画帧把内容区宽度停在
        // 「减掉隔离缝」的状态,必须 layoutViews() 让内容区占满全宽,
        // 否则右侧会残留 4px 玻璃条,与窗口边框叠成粗边框
        if (statusView) {
          try {
            mainWindow?.contentView?.removeChildView(statusView);
          } catch {
            /* 视图可能已被窗口清理 */
          }
          statusView = null;
        }
        layoutViews();
      });
    }
  }

  function toggleStatusSidebar() {
    // 注入模式(dsh WebUI 页面内)常态:控制内容视图里的共享面板
    if (statusInjectActive()) {
      const desiredOpen = !statusPanelOpen;
      if (desiredOpen) {
        // 互斥展开:插件侧栏已展开 → 先收起(等动画完成)再展开服务状态;
        // 编排失败(桥缺失等)→ 回退 statusView 兜底,不让按钮失效
        runMutualOpen("open-status", {
          statusOpen: false,
          pluginSideOpen: !!(lastPluginPanels && lastPluginPanels.side),
          closePluginSide: () => closePluginSideWithAnimation(),
          openStatus: () => execStatusBridge("requestOpen()"),
        }).catch(() => markInjectBroken());
      } else {
        execStatusBridge("requestClose()").catch(() => markInjectBroken());
      }
      // 预判翻转结果:按钮即时反馈,真实结果随后经桥上报/broadcast 校正
      return { open: desiredOpen, canOpen: true };
    }
    fallbackStatusSidebar();
    return sidebarState();
  }

  /** 桥调用失败(注入缺失/异常):标记并整会话回退 statusView 兜底 */
  function markInjectBroken() {
    statusInjectBroken = true;
    console.warn("[app] 服务状态注入桥不可用,回退独立状态面板");
  }

  // ---------- 首次启动自动展开「服务状态」侧边栏(需求 4) ----------
  // settings.yaml 的 dsh-box.launchedBefore 标记「是否已经引导过一次」:
  // 首启 → 写标记 + 窗口首屏画完后自动展开侧边栏,让用户第一时间看到
  // 服务状态 / 版本 / 插件市场 / 侧边栏插件。服务未就绪也能展开(状态页
  // 会如实显示启动中/错误),所以不等待 dsh ready。
  // 注意:统一走 openStatusSidebar(独立面板),不走注入桥 —— dsh 若在
  // 800ms 内就绪,注入桥可能尚未挂载完,走桥失败会 markInjectBroken 永久
  // 降级注入模式(竞态误伤);独立面板内容与注入面板一致,后续用户点顶栏
  // 按钮时互斥编排会自动收起它并切回注入面板。
  function maybeAutoOpenFirstLaunch() {
    if (process.env.DSH_SKIP_FIRST_LAUNCH === "1") return;
    if (readSettingBool(appDshHome(), FIRST_LAUNCH_SETTING_KEY)) return;
    setTimeout(() => {
      if (sidebarOpen || statusPanelOpen) return; // 用户已提前打开
      // 打开成功才写标记:首启引导失败(如窗口过窄展开被拒)下次启动再试
      if (openStatusSidebar()) {
        writeSettingBool(appDshHome(), FIRST_LAUNCH_SETTING_KEY, true);
      }
    }, FIRST_LAUNCH_DELAY_MS);
  }

  /** 兜底路径:独立 WebContentsView 状态面板(statusView,异常态用) */
  function fallbackStatusSidebar() {
    if (sidebarOpen) closeStatusSidebar();
    else openStatusSidebar();
  }

  /** 调服务状态桥的异步原语(如 requestOpen()/requestClose());桥缺失/超时抛错 */
  async function execStatusBridge(expr) {
    if (!contentView || contentView.webContents.isDestroyed()) {
      throw new Error("内容视图不可用");
    }
    const res = await contentView.webContents.executeJavaScript(
      `window.__dshBoxStatusBridge && window.__dshBoxStatusBridge.${expr}`,
      true
    );
    if (!res || typeof res.open !== "boolean") throw new Error("桥未响应");
    return res;
  }

  /** 读 dsh 主题的慢速过渡时长(互斥等待插件动画完成用;缺失回退 300ms) */
  async function readThemeSlowMs() {
    if (!contentView || contentView.webContents.isDestroyed()) return 300;
    try {
      const v = await contentView.webContents.executeJavaScript(
        `getComputedStyle(document.documentElement).getPropertyValue('--ds-transition-duration-slow').trim()`,
        true
      );
      const m = /^([\d.]+)(ms|s)$/.exec(v || "");
      if (m) return parseFloat(m[1]) * (m[2] === "s" ? 1000 : 1);
    } catch {
      /* 回退 */
    }
    return 300;
  }

  /** 收起插件侧栏并等待动画完成(读主题时长 + 余量;插件动画无事件可 hook) */
  async function closePluginSideWithAnimation() {
    const slow = await readThemeSlowMs();
    await contentView.webContents.executeJavaScript(
      'window.__dshBoxPluginBridge && window.__dshBoxPluginBridge.toggle("side")',
      true
    );
    await new Promise((resolve) => setTimeout(resolve, slow + 50));
  }

  // ---------- npm 更新检查(启动查一次 → 顶栏红点) ----------
  /** 当前红点标志 = dsh 本体更新 或 侧边栏插件更新,任一为真即亮 */
  function currentUpdateFlag() {
    return {
      ...(lastUpdateCheck ?? { hasUpdate: false }),
      hasUpdate: !!(
        lastUpdateCheck?.hasUpdate ||
        lastPluginCheck?.hasUpdate ||
        lastMarketCheck?.hasUpdate
      ),
      plugin: lastPluginCheck
        ? { hasUpdate: lastPluginCheck.hasUpdate, installed: lastPluginCheck.installed, latest: lastPluginCheck.latest }
        : null,
      market: lastMarketCheck
        ? { hasUpdate: lastMarketCheck.hasUpdate, installed: lastMarketCheck.installed, latest: lastMarketCheck.latest }
        : null,
    };
  }

  function broadcastUpdateFlag() {
    if (topBarView && !topBarView.webContents.isDestroyed()) {
      topBarView.webContents.send("dsh:update-flag", currentUpdateFlag());
    }
  }

  /** 查一次 npm(失败回退缓存),刷新红点并广播;永远不抛错。 */
  async function refreshUpdateFlag() {
    try {
      const { data, fromCache } = await npmCheck.checkOnce();
      const runtime = getRuntimeDshInfo().version ?? null;
      lastUpdateCheck = { ...npmCheck.decorate(data, runtime), fromCache };
      broadcastUpdateFlag();
      return lastUpdateCheck;
    } catch {
      return lastUpdateCheck;
    }
  }

  // ---------- 升级编排:停服 → 换文件+依赖调和 → 恢复服务 → 刷新红点 ----------
  // upgradeDsh 已做依赖调和 + 启动自检并自动回滚;这里再兜底:真实启动仍
  // 失败时用备份回滚,绝不让「升级」把服务留在不可用状态。
  async function performUpgrade(version) {
    const wasReady = server?.ready ?? false;
    broadcastStatus({ state: "starting", message: `正在升级 dsh 至 ${version}…` });
    if (server) await server.stop();
    serviceState = "stopped";
    const result = await upgradeDsh(version, {
      cacheDir: path.join(app.getPath("userData"), "cache"),
      log: console,
      bundledDir: defaultBundledRuntimeDir(),
    });
    if (!result.ok) {
      if (wasReady) await startServer();
      return result;
    }
    if (wasReady) {
      await startServer();
      if (!server.ready && result.backupDir) {
        // 升级成功但真实启动失败 → 回滚到原版本再试
        const bootErr = lastError || "dsh 启动失败";
        const pkgDir = getRuntimeDshInfo().packageDir;
        const rollback = restoreDshBackup(pkgDir, result.backupDir);
        if (rollback.ok) {
          lastError = null;
          serviceState = "stopped";
          await startServer();
          await refreshUpdateFlag();
          if (server.ready) {
            return {
              ok: false,
              error: `升级后服务无法启动(${bootErr});已回滚到原版本 ${result.previous}`,
              previous: result.previous,
            };
          }
          return { ok: false, error: `升级后服务无法启动(${bootErr});已回滚,但原版本也无法启动` };
        }
        return {
          ok: false,
          error: `升级后服务无法启动(${bootErr});且回滚失败(${rollback.error || "文件操作失败"})`,
        };
      }
    }
    await refreshUpdateFlag();
    return result;
  }

  // ---------- 侧边栏插件检查(服务状态页板块 + 红点) ----------
  /** 查一次插件(本地版本 + registry 最新),刷新红点并广播;永远不抛错。 */
  async function refreshPluginCheck() {
    const dshHome = appDshHome();
    try {
      lastPluginCheck = await pluginManager.checkPlugin(dshHome, "dsh-better-sidebar");
    } catch {
      lastPluginCheck = {
        name: "dsh-better-sidebar",
        installed: pluginManager.getInstalledVersion(dshHome, "dsh-better-sidebar"),
        latest: null,
        hasUpdate: false,
        error: "插件检查失败",
      };
    }
    broadcastUpdateFlag();
    return lastPluginCheck;
  }

  // ---------- 插件市场(dshmarket)检查 + 侧边栏入口开关 ----------
  /** 查一次插件市场(本地版本 + registry 最新),刷新红点并广播;永远不抛错。 */
  async function refreshMarketCheck() {
    const dshHome = appDshHome();
    try {
      lastMarketCheck = await pluginManager.checkPlugin(dshHome, "dshmarket");
    } catch {
      lastMarketCheck = {
        name: "dshmarket",
        installed: pluginManager.getInstalledVersion(dshHome, "dshmarket"),
        latest: null,
        hasUpdate: false,
        error: "插件检查失败",
      };
    }
    broadcastUpdateFlag();
    return lastMarketCheck;
  }

  /**
   * 安装(version=null)或更新(version=最新版)侧边栏插件。
   *
   * 编排(0.1.5 修复「点更新→服务停→页面刷新→结果被吞」):
   *   - 服务全程保持在线:pnpm 安装(可能 30s~数分钟)期间 webui 不刷新,
   *     面板 hint 与失败文案可直接展示(旧版先停服,webui 断 40s,面板销毁,
   *     结果被刷掉 — 用户实报 bug);
   *   - 安装成功后一次重启(stop→start)让新 bundle 生效(对齐本体升级
   *     staging「先装后重启」思路;运行中实例不会重读 node_modules);
   *   - 安装失败:服务从未停止,无需任何恢复动作,直接返回错误给面板;
   *   - 并发锁:两次更新不得同时跑 pnpm(store 锁冲突,双双失败)。
   * 安装成功后写入 openByDefault 偏好(与浏览器 WebUI 对齐)。
   */
  async function performPluginInstall(version = null) {
    if (pluginOpPending) {
      return {
        ok: false,
        error: "已有插件安装/更新进行中,请完成后再试",
        previouslyInstalled: pluginManager.getInstalledVersion(appDshHome(), "dsh-better-sidebar"),
      };
    }
    pluginOpPending = true;
    try {
      const dshHome = appDshHome();
      const wasReady = server?.ready ?? false;
      const installedBefore = pluginManager.getInstalledVersion(dshHome, "dsh-better-sidebar");
      const label = installedBefore ? "更新" : "安装";
      const result = await pluginManager.installPlugin(dshHome, "dsh-better-sidebar", version, {
        bundledDir: defaultBundledRuntimeDir(),
      });
      if (!result.ok) {
        return { ...result, previouslyInstalled: installedBefore };
      }
      const installed = pluginManager.getInstalledVersion(dshHome, "dsh-better-sidebar") || version || "unknown";
      // 装包成功后的任何异常(如写入偏好抛错)都不得让服务停着不恢复:
      // wasReady 时无论成败都尝试拉回服务;写偏好失败只记录 warning,不判安装失败。
      let warning = null;
      try {
        pluginManager.ensureOpenByDefault(dshHome);
      } catch (error) {
        warning = `写入开屏偏好失败: ${error.message || error}`;
        console.error("[app] 侧边栏插件写入开屏偏好失败:", error);
      }
      if (wasReady) {
        try {
          await restartServer();
        } catch (error) {
          console.error("[app] 侧边栏插件安装后重启服务失败:", error);
          return {
            ok: false,
            error: `插件已装,但重启服务失败: ${error.message || error}`,
            installed,
            previouslyInstalled: installedBefore,
            restarted: false,
          };
        }
      }
      await refreshPluginCheck();
      return { ok: true, installed, previouslyInstalled: installedBefore, restarted: wasReady, warning };
    } finally {
      pluginOpPending = false;
    }
  }

  /**
   * 安装(version=null)或更新(version=最新版)插件市场。
   * 编排与 performPluginInstall 一致:服务全程在线,装完一次重启,
   * 失败不动服务(见该函数注释)。插件市场无「开屏偏好」配置,不写 openByDefault。
   */
  async function performMarketInstall(version = null) {
    if (pluginOpPending) {
      return {
        ok: false,
        error: "已有插件安装/更新进行中,请完成后再试",
        previouslyInstalled: pluginManager.getInstalledVersion(appDshHome(), "dshmarket"),
      };
    }
    pluginOpPending = true;
    try {
      const dshHome = appDshHome();
      const wasReady = server?.ready ?? false;
      const installedBefore = pluginManager.getInstalledVersion(dshHome, "dshmarket");
      const label = installedBefore ? "更新" : "安装";
      const result = await pluginManager.installPlugin(dshHome, "dshmarket", version, {
        bundledDir: defaultBundledRuntimeDir(),
      });
      if (!result.ok) {
        return { ...result, previouslyInstalled: installedBefore };
      }
      const installed = pluginManager.getInstalledVersion(dshHome, "dshmarket") || version || "unknown";
      if (wasReady) {
        try {
          await restartServer();
        } catch (error) {
          console.error("[app] 插件市场安装后重启服务失败:", error);
          return {
            ok: false,
            error: `插件市场已装,但重启服务失败: ${error.message || error}`,
            installed,
            previouslyInstalled: installedBefore,
            restarted: false,
          };
        }
      }
      await refreshMarketCheck();
      return { ok: true, installed, previouslyInstalled: installedBefore, restarted: wasReady };
    } finally {
      pluginOpPending = false;
    }
  }

  /** DSH_HOME:继承环境变量,否则 App 自己的隔离目录(与启动 dsh 一致) */
  function appDshHome() {
    return process.env.DSH_HOME || path.join(app.getPath("userData"), "dsh-home");
  }

  // ---------- 内置运行时目录(需求 3:升级/装插件的 npm/pnpm 兜底) ----------
  // dev:仓库 assets/runtime/<平台>-<架构>/node;打包:Resources/runtime/<平台>-<架构>/node
  // (electron-builder extraResources 拷贝)。内容由 scripts/fetch-bundled-runtime.mjs
  // 生成,不入 git。DSH_BUNDLED_RUNTIME 可覆盖(测试/特殊环境)。
  function defaultBundledRuntimeDir() {
    if (process.env.DSH_BUNDLED_RUNTIME) return process.env.DSH_BUNDLED_RUNTIME;
    const base = app.isPackaged
      ? path.join(process.resourcesPath, "runtime")
      : path.join(__dirname, "..", "..", "assets", "runtime");
    return path.join(base, `${process.platform}-${process.arch}`, "node");
  }

  // ---------- 消息通知(横幅 / 声音)----------
  /**
   * macOS 通知权限状态探测。
   * Electron 已移除 systemPreferences.getNotificationSettings(早期 API,实测
   * Electron 43 不存在),macOS 也没有可编程读取 TCC 通知权限的同步接口 →
   * 恒返回 "unknown"(未确认)。权限只能由系统在「首条通知」时询问(见
   * showBanner / dsh:notify-settings 的首次开启测试通知)。返回类型保留,
   * 渲染层按「granted / denied / unknown」适配文案。
   * @returns {"granted"|"denied"|"unknown"|"unsupported"}
   */
  function notificationPermission() {
    if (!isMac) return "unsupported";
    return "unknown";
  }

  /** 发一条系统横幅(app 名即系统通知里的标题,正文自定);失败静默但落日志便于诊断 */
  function showBanner(body) {
    try {
      if (!Notification.isSupported()) {
        console.warn("[app] 横幅通知: Notification 不受支持,已跳过");
        return false;
      }
      const n = new Notification({ title: APP_NAME, body, silent: true });
      n.show();
      console.log(`[app] 横幅通知已发送: ${body.slice(0, 60)}(权限=${notificationPermission()})`);
      return true;
    } catch (error) {
      console.warn("[app] 横幅通知发送失败:", error && error.message);
      return false;
    }
  }

  /** 播放提示音(macOS 自带 afplay,播放打包的 message.m4a;失败静默) */
  function playNotifySound() {
    if (!isMac) return;
    try {
      if (!fs.existsSync(NOTIFY_SOUND_PATH)) return;
      const child = spawn("afplay", [NOTIFY_SOUND_PATH]);
      child.on("error", () => { /* afplay 缺失/失败忽略 */ });
    } catch {
      /* 忽略播放失败 */
    }
  }

  /**
   * 事件流归一化事件 → 横幅 / 声音。
   * @param {{kind:string, sessionId?:string, title:string, message:string}} ev
   */
  function deliverNotifyEvent(ev) {
    const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");
    let body = "";
    switch (ev.kind) {
      case "task-end":
        body = ev.title ? `「${ev.title}」任务已完成` : "任务已完成";
        break;
      case "task-fail":
        body = ev.title
          ? `「${ev.title}」任务失败:${ev.message ? " " + ev.message : "异常终止"}`
          : `任务失败:${ev.message ? " " + ev.message : "异常终止"}`;
        break;
      case "question":
        body = `有待回答的问题:${ev.message ? " " + ev.message : ""}`;
        break;
      case "approval":
        body = `请求授权:${ev.message ? " " + ev.message : ""}`;
        break;
      default:
        return;
    }
    body = trunc(body, 180);
    if (notifyBanner) {
      const shown = showBanner(body);
      if (!shown) console.warn(`[app] 事件横幅未显示(kind=${ev.kind}, session=${ev.sessionId ?? "-"})`);
    }
    if (notifySound) playNotifySound();
  }

  /** 停掉事件流 watcher(幂等) */
  function stopNotifyWatcher() {
    if (notifyWatcher) {
      notifyWatcher.stop();
      notifyWatcher = null;
    }
  }

  /** 按「开关开且服务就绪」启停 watcher(开关或服务状态变化后调用) */
  function ensureNotifyWatcher() {
    const shouldRun = (notifyBanner || notifySound) && notifyReady;
    if (shouldRun && !notifyWatcher) {
      const base = (server && server.url ? server.url : `http://127.0.0.1:${port}`).replace(/^http/, "ws");
      notifyWatcher = createNotifyWatcher({
        muxUrl: base + "/api/events.mux",
        hostUrl: base + "/api/events.host",
        onEvent: deliverNotifyEvent,
      });
      notifyWatcher.start();
    } else if (!shouldRun) {
      stopNotifyWatcher();
    }
  }

  // ---------- 应用自更新(DSH Box 自身,与 dsh npm 包升级完全独立) ----------
  // 打包环境:启动后静默查一次 GitHub Releases,有新版本 → 顶栏「新版本」按钮;
  // dev 模式(app.isPackaged=false)由状态机置 disabled,不参与。状态机把
  // electron-updater 事件汇流为稳定状态并经 onChange 广播到顶栏按钮。
  // 环境变量(测试/镜像用):DSH_APP_UPDATE_FEED=自定义 feed URL(provider generic),
  // DSH_APP_UPDATE_DISABLED=1 关闭启动自动检查。
  // DSH_E2E_APP_UPDATE=1 无人值守端到端:启动即查 → available 自动下载 → downloaded
  // 自动安装(quitAndInstall)→ 重启后已是最新 → 打印 APP_UPDATE_DONE 标记退出
  // (供 scripts/e2e-app-update.sh 断言;与 DSH_SMOKE 同级别的测试后门)。
  function initAppUpdateCheck() {
    if (appUpdater) return;
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.logger = console; // 默认 logger 缺 log() 会致 AppUpdater 报 "log is not a function"
      const feed = process.env.DSH_APP_UPDATE_FEED;
      if (feed) autoUpdater.setFeedURL({ provider: "generic", url: feed });
      const e2eAuto = process.env.DSH_E2E_APP_UPDATE === "1";
      appUpdater = createAppUpdater({
        autoUpdater,
        isPackaged: app.isPackaged,
        onChange: (state) => {
          if (topBarView && !topBarView.webContents.isDestroyed()) {
            topBarView.webContents.send("dsh:app-update", state);
          }
          if (e2eAuto) runE2eAutoUpdate(state);
        },
        log: console,
      });
      appUpdater.init({ checkOnStart: e2eAuto || process.env.DSH_APP_UPDATE_DISABLED !== "1" }).catch(() => {});
    } catch (error) {
      console.warn("[app] 应用自更新初始化失败:", error.message);
    }
  }

  /** e2e 无人值守序列:available→下载;downloaded→安装(退出替换重启);重启后 up-to-date→完成标记 */
  function runE2eAutoUpdate(s) {
    const tag = "[e2e-app-update]";
    switch (s.state) {
      case "available":
        console.log(`${tag} available(${s.version}) → 自动下载`);
        appUpdater.startDownload().catch(() => {});
        break;
      case "downloaded":
        console.log(`${tag} downloaded → 自动安装(quitAndInstall)`);
        appUpdater.installUpdate();
        break;
      case "up-to-date":
        {
          const dataOk = fs.existsSync(path.join(app.getPath("userData")));
          console.log(`${tag} APP_UPDATE_DONE version=${app.getVersion()} userData=${dataOk ? "OK" : "MISSING"}`);
          setTimeout(() => app.quit(), 600);
        }
        break;
      case "error":
        console.error(`${tag} APP_UPDATE_ERROR ${s.error}`);
        app.exit(1);
        break;
      default:
        break;
    }
  }

  // ---------- IPC(preload 桥) ----------
  ipcMain.handle("dsh:get-info", () => getServerInfo());
  ipcMain.handle("dsh:retry", async () => {
    lastError = null;
    broadcastStatus({ state: "starting", message: "正在重新启动 dsh 服务…" });
    await restartServer();
    return getServerInfo();
  });
  // 双击顶栏 = 最大化/还原(macOS 惯例)
  ipcMain.handle("window:toggle-maximize", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return true;
  });

  // 顶栏 GitHub 等外链入口:只放行 http/https,交给系统默认浏览器
  ipcMain.handle("shell:open-external", (_event, url) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
    return shell.openExternal(url);
  });

  // ---------- dsh 服务与版本页 ----------
  // 进入页面时查一次 npm(每次都查,返回完整列表),并刷新红点
  ipcMain.handle("dsh:check-updates", async () => {
    const result = await refreshUpdateFlag();
    if (!result) return { error: "无法获取 npm 版本信息", hasUpdate: false, rows: [] };
    return result;
  });
  // 顶栏红点查询(启动时已静默查过一次;含插件更新)
  ipcMain.handle("dsh:get-update-flag", () => currentUpdateFlag());
  // 打开/关闭右侧「dsh 服务与版本」面板(顶栏按钮 / 菜单共用)
  ipcMain.handle("dsh:toggle-sidebar", () => toggleStatusSidebar());
  // 面板当前状态(顶栏按钮激活态/禁用与红点无关)
  ipcMain.handle("dsh:get-sidebar", () => sidebarState());
  // 停止服务(状态页「停止」按钮);停止后加载页与状态页都显示「未运行」
  ipcMain.handle("dsh:stop", async () => {
    if (server) await server.stop();
    serviceState = "stopped";
    lastError = null;
    broadcastStatus({ state: "stopped", message: "服务已停止" });
    return getServerInfo();
  });
  // 应用内升级捆绑的 dsh 到指定版本(单飞:同时只允许一个升级任务)
  ipcMain.handle("dsh:upgrade", async (_event, version) => {
    if (upgrading) return { ok: false, error: "已有升级任务进行中,请稍候" };
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      return { ok: false, error: "版本号格式不正确" };
    }
    upgrading = true;
    try {
      return await performUpgrade(version);
    } catch (error) {
      console.error("[app] 升级失败:", error);
      return { ok: false, error: error.message || String(error) };
    } finally {
      upgrading = false;
    }
  });

  // ---------- 侧边栏插件(dsh-better-sidebar) ----------
  // 服务状态页的「侧边栏插件」板块:每次进入查一次(本地版本 + registry 最新)
  ipcMain.handle("dsh:plugin-info", async () => {
    const info = await refreshPluginCheck();
    return info ?? { name: pluginManager.PLUGIN_NAME, error: "无法获取插件信息" };
  });
  // 安装(version=null) / 更新(version=最新版):单飞,成功后自动重启服务
  ipcMain.handle("dsh:plugin-install", async (_event, version) => {
    if (pluginInstalling) return { ok: false, error: "已有插件安装/更新任务进行中,请稍候" };
    if (version != null && (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))) {
      return { ok: false, error: "版本号格式不正确" };
    }
    pluginInstalling = true;
    try {
      return await performPluginInstall(version ?? null);
    } catch (error) {
      console.error("[app] 插件安装失败:", error);
      return { ok: false, error: error.message || String(error) };
    } finally {
      pluginInstalling = false;
    }
  });
  // 顶栏「侧栏/底栏」切换按钮 → 桥 → 模拟点击插件自己的 toggle 按钮。
  // 互斥:展开「侧栏」时若服务状态面板已展开 → 先收起服务状态(等动画完成)再展开。
  ipcMain.handle("dsh:toggle-plugin-panel", async (_event, which) => {
    if (which !== "side" && which !== "bottom") return { ok: false, error: "参数错误" };
    if (!contentView || contentView.webContents.isDestroyed()) {
      return { ok: false, error: "内容视图不可用" };
    }
    // 本次是「展开侧栏」(当前折叠)且服务状态面板展开 → 先收服务状态
    const sideCollapsed = !(lastPluginPanels && lastPluginPanels.side);
    if (which === "side" && sideCollapsed && statusPanelOpen) {
      try {
        await execStatusBridge("requestClose()");
      } catch (error) {
        markInjectBroken();
        return { ok: false, error: `收起服务状态失败: ${error.message || error}` };
      }
    }
    try {
      const res = await contentView.webContents.executeJavaScript(
        `window.__dshBoxPluginBridge && window.__dshBoxPluginBridge.toggle(${JSON.stringify(which)})`,
        true
      );
      if (res && res.ok) return res;
      return { ok: false, error: (res && res.error) || "插件未挂载" };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });
  // 桥上报的面板开合状态 → 记录(互斥编排用)并转发给顶栏(按钮高亮/灰显)
  ipcMain.on("shell:plugin-panels", (_event, state) => {
    if (!state || typeof state !== "object") return;
    lastPluginPanels = state;
    if (topBarView && !topBarView.webContents.isDestroyed()) {
      topBarView.webContents.send("dsh:plugin-panels", state);
    }
  });

  // ---------- 插件市场(dshmarket) ----------
  // 服务状态页「插件市场」板块:每次进入查一次(本地版本 + registry 最新)
  ipcMain.handle("dsh:market-info", async () => {
    const info = await refreshMarketCheck();
    return info ?? { name: "dshmarket", error: "无法获取插件市场信息" };
  });
  // 安装(version=null) / 更新(version=最新版):单飞,成功后自动重启服务
  ipcMain.handle("dsh:market-install", async (_event, version) => {
    if (marketInstalling) return { ok: false, error: "已有插件市场安装/更新任务进行中,请稍候" };
    if (version != null && (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))) {
      return { ok: false, error: "版本号格式不正确" };
    }
    marketInstalling = true;
    try {
      return await performMarketInstall(version ?? null);
    } catch (error) {
      console.error("[app] 插件市场安装失败:", error);
      return { ok: false, error: error.message || String(error) };
    } finally {
      marketInstalling = false;
    }
  });
  // 「在 DSH 侧边栏显示插件市场入口」开关:读(返回当前值)/写(持久化 + 注入层即时生效)
  ipcMain.handle("dsh:market-switch", (_event, next) => {
    if (next === undefined) {
      return { ok: true, enabled: marketSidebarEntry };
    }
    if (typeof next !== "boolean") return { ok: false, error: "参数错误" };
    marketSidebarEntry = next;
    writeSettingBool(appDshHome(), "marketSidebarEntry", next);
    // 通知注入层即时移除/插入侧边栏入口(Spa 重载后由注入参数兜底)
    if (contentView && !contentView.webContents.isDestroyed()) {
      contentView.webContents
        .executeJavaScript(
          `window.__dshBoxMarketBridge && window.__dshBoxMarketBridge.setEnabled(${next ? "true" : "false"})`,
          true
        )
        .catch(() => {});
    }
    return { ok: true, enabled: marketSidebarEntry };
  });

  // ---------- 「服务状态」共享面板(内容视图注入层) ----------
  // 注入层上报开合:同步顶栏按钮高亮;并复位「桥缺失」标记(桥重新注入成功
  // 即上报,页面重载后注入失败标记随之清除)
  ipcMain.on("shell:status-panel", (_event, state) => {
    if (!state || typeof state.open !== "boolean") return;
    statusInjectBroken = false;
    statusPanelOpen = state.open;
    // 注入面板打开时,异常态 statusView 兜底若还开着(如服务异常时打开过),
    // 一并收起,避免两块面板同时遮挡内容
    if (statusPanelOpen && sidebarOpen && statusView) closeStatusSidebar();
    broadcastSidebarState();
  });
  // 拖拽结束持久化面板宽度(240~640 钳制)
  ipcMain.handle("dsh:status-panel-width", (_event, width) => {
    const w = Math.max(
      STATUS_WIDTH_MIN,
      Math.min(STATUS_WIDTH_MAX, Math.round(Number(width) || STATUS_WIDTH_DEFAULT))
    );
    statusPanelWidth = w;
    writeSettingValue(appDshHome(), "statusPanelWidth", w);
    return { ok: true, width: w };
  });

  // ---------- 消息通知:读/写开关(横幅 / 声音)+ 权限状态 ----------
  // getter(无参)/setter(传 {banner?, sound?}):持久化到 settings.yaml
  // dsh-box.notificationBanner / notificationSound;「横幅」首次开启 → 发一条
  // 测试通知,触发 macOS 系统授权弹窗(需求 5:用户首次开启时引导系统授权);
  // 返回 {banner, sound, permission},面板据此回显开关 + 权限被拒提示。
  ipcMain.handle("dsh:notify-settings", (_event, next) => {
    if (next === undefined || next === null) {
      return { banner: notifyBanner, sound: notifySound, permission: notificationPermission() };
    }
    if (typeof next !== "object") return { ok: false, error: "参数错误" };
    const patch = {};
    if (typeof next.banner === "boolean") patch.banner = next.banner;
    if (typeof next.sound === "boolean") patch.sound = next.sound;
    if (Object.keys(patch).length === 0) return { ok: false, error: "参数错误" };

    if (typeof patch.banner === "boolean") {
      notifyBanner = patch.banner;
      writeSettingBool(appDshHome(), "notificationBanner", notifyBanner);
      // 首次开启横幅 → 发测试通知:macOS 在首条通知时自动弹出系统授权窗
      if (notifyBanner && !notifyPrompted) {
        notifyPrompted = true;
        showBanner("横幅通知已开启:任务完成、失败、提问和授权时会在此提醒你");
      }
    }
    if (typeof patch.sound === "boolean") {
      notifySound = patch.sound;
      writeSettingBool(appDshHome(), "notificationSound", notifySound);
    }
    ensureNotifyWatcher();
    return { banner: notifyBanner, sound: notifySound, permission: notificationPermission() };
  });

  // ---------- 应用自更新(顶栏「新版本」按钮 / 菜单「检查更新…」) ----------
  ipcMain.handle("dsh:app-update-state", () =>
    appUpdater ? appUpdater.getState() : { state: "disabled", percent: 0, version: null, error: null }
  );
  ipcMain.handle("dsh:app-update-check", () => {
    if (appUpdater) appUpdater.checkForUpdates().catch(() => {});
    return true;
  });
  ipcMain.handle("dsh:app-update-download", () => {
    if (appUpdater) appUpdater.startDownload().catch(() => {});
    return true;
  });
  ipcMain.handle("dsh:app-update-install", () => {
    if (appUpdater) appUpdater.installUpdate();
    return true;
  });
  ipcMain.handle("dsh:app-update-retry", () => {
    // 错误态重试:检查失败(无版本)→ 重新检查;下载失败(有版本)→ 重新下载
    if (appUpdater) appUpdater.retry();
    return true;
  });

  // ---------- 顶栏 tooltip(气泡层)----------
  // 根因(0.1.7 实报):顶栏是独立 WebContentsView,原生 title 气泡不显示;
  // 且视图固定 40px 高,视图内 CSS 气泡会被边界裁剪 → 用独立气泡层视图浮在
  // 按钮正下方(平时 0×0 隐藏)。悬停防抖与触发在 topbar.js,这里只负责
  // 创建/定位/显隐(文本注入经 executeJavaScript,懒加载就有延迟安全垫)。
  function ensureTooltipView() {
    if (tooltipView && !tooltipView.webContents.isDestroyed()) return true;
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    tooltipView = new WebContentsView({
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    tooltipView.setBackgroundColor("#00000000");
    mainWindow.contentView.addChildView(tooltipView);
    tooltipView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    tooltipView.webContents.loadFile(path.join(__dirname, "..", "renderer", "tooltip.html"));
    return true;
  }

  function runTooltipJs(js) {
    const wc = tooltipView && tooltipView.webContents;
    if (!wc || wc.isDestroyed()) return;
    const exec = () => wc.executeJavaScript(js, true).catch(() => {});
    if (wc.isLoading()) wc.once("did-finish-load", exec);
    else exec();
  }

  /** 显示气泡:按顶栏视图内按钮中心定位(屏幕内钳制),宽度按文本长度估算 */
  ipcMain.on("dsh:tooltip-show", (_event, payload) => {
    if (!payload || typeof payload.text !== "string" || !payload.text) return;
    if (!ensureTooltipView()) return;
    const rect = payload.rect || {};
    const centerX = Math.round((Number(rect.left) || 0) + (Number(rect.width) || 28) / 2);
    // 中文 ≈13px/字 + 两端 padding;夹在 [40, 220]
    const w = Math.max(40, Math.min(220, Math.round(payload.text.length * 13 + 20)));
    const winW = mainWindow.getContentBounds().width;
    const x = Math.max(0, Math.min(winW - w, centerX - w / 2));
    tooltipView.setBounds({ x, y: BAR_HEIGHT + 1, width: w, height: 30 });
    runTooltipJs(`window.showTooltip && window.showTooltip(${JSON.stringify(payload.text)})`);
  });

  ipcMain.on("dsh:tooltip-hide", () => {
    if (tooltipView && !tooltipView.webContents.isDestroyed()) {
      tooltipView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  });

  // (外观主题同步已上移到 initThemeSync:偏好 → nativeTheme.themeSource,
  //  由 fs.watchFile 监听 settings.yaml 实时生效;不再镜像解析后的浅/深,
  //  避免锁死 prefers-color-scheme 导致「跟随系统」失效,见 theme-sync.js)

  // ---------- 权限:本应用只信任本机 dsh 服务 ----------
  // (必须在 app ready 之后才能访问 session,所以放在 whenReady 里)
  function installPermissionHandlers() {
    // 只信任两个来源:dsh 服务自身的 origin(精确匹配)+ App 自带的 file:// 页面。
    // 之前用 startsWith("http://127.0.0.1") 会把端口上任何本地服务都当可信来源。
    const trustedOrigin = (origin) =>
      isTrustedOrigin(origin, server?.url ?? `http://127.0.0.1:${port}`);
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const origin = webContents.getURL();
      const trusted = trustedOrigin(origin);
      if (!trusted) console.warn(`[app] 拒绝权限请求 ${permission} (${origin})`);
      callback(trusted);
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      // 空来源是 Chromium 页面加载时的内部检查,不构成风险,放行且不打印
      if (!requestingOrigin) return true;
      const trusted = trustedOrigin(requestingOrigin);
      if (!trusted) {
        console.warn(`[app] 拒绝权限检查 ${permission} (${requestingOrigin})`);
      }
      return trusted;
    });
  }

  // ---------- 菜单(macOS 惯例,中文品牌菜单)----------
  // 「关于 DSH Box」打开自定义品牌弹窗(about.js:logo / 应用名 / 版本 / 依赖版本)。
  // 菜单栏左上角的应用名由进程/包名决定,不由这里控制:
  // dev 模式见 scripts/dev-launch.mjs(品牌化 Electron 副本),打包版由
  // electron-builder 的 productName 生成。
  // 「服务状态」面板入口已不在应用菜单(需求:顶栏按钮 + 菜单栏 Tray「服务管理」)。
  function buildMenu() {
    appMenu = createAppMenu({
      onAbout: () => showAboutWindow({ parent: mainWindow }),
      onCheckUpdate: () => {
        if (!appUpdater) return;
        // 手动检查:结果弹窗告知 —— 无新版本 → 「当前没有可用的更新」;
        // 检查失败 → 错误弹窗(自动检查保持静默,不传 notify)。
        const notifyResult = (outcome) => {
          if (outcome === "up-to-date") {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              message: "当前没有可用的更新",
              detail: "DSH Box 已是最新版本。",
            });
          } else if (outcome && outcome.error) {
            dialog.showMessageBox(mainWindow, {
              type: "error",
              message: "检查更新失败",
              detail: String(outcome.error),
            });
          }
        };
        appUpdater.checkForUpdates({ notify: notifyResult }).catch(() => {});
      },
    });
    Menu.setApplicationMenu(appMenu);
  }

  // ---------- 生命周期 ----------
  app.whenReady().then(async () => {
    // 开发模式(npm start)运行的是 Electron 本体,Dock 默认显示 Electron 图标;
    // 这里运行时设置成 App 图标。打包后由 .app bundle 自带图标,无需设置。
    if (!app.isPackaged && process.platform === "darwin" && app.dock) {
      const devIcon = path.join(__dirname, "..", "..", "assets", "icon.png");
      try {
        app.dock.setIcon(devIcon);
        console.log(`[app] 开发模式 Dock 图标: ${devIcon}`);
      } catch (error) {
        console.warn("[app] 设置 Dock 图标失败:", error.message);
      }
    }
    buildMenu();
    installPermissionHandlers();
    // npm 版本缓存目录(userData/cache);启动时静默查一次,有新版 → 顶栏红点
    npmCheck.init(path.join(app.getPath("userData"), "cache"));
    // 应用自更新:打包环境启动后静默查一次 GitHub Releases(dev 模式自动禁用)
    initAppUpdateCheck();
    createWindow();
    // 首次启动(需求 4):窗口建好即挂号,首屏画完后自动展开「服务状态」侧边栏
    maybeAutoOpenFirstLaunch();
    // ---------- macOS 菜单栏(Tray)----------
    // 单击图标聚焦窗口;右键弹出「打开 DSH Box / 服务管理 / 退出」。
    // 「服务管理」= 聚焦应用 + 展开「服务状态」面板(顶栏按钮同款行为)。仅 macOS。
    if (isMac) {
      try {
        tray = createTray({
          onActivate: focusOrCreateWindow,
          onOpenStatus: () => {
            focusOrCreateWindow();
            // 面板未展开才展开(已展开则只聚焦;toggle 会让已展开的面板收起)
            if (!sidebarState().open) toggleStatusSidebar();
          },
          onQuit: () => app.quit(),
        });
        console.log("[app] 菜单栏图标已创建");
      } catch (error) {
        // 图标缺失等 → 只告警,不拖垮 App(菜单栏功能降级)
        console.warn("[app] 创建菜单栏图标失败:", error.message);
      }
    }
    await startServer();

    // 启动时自动查一次 npm(非阻塞,失败静默):有新版 → 顶栏入口红点
    refreshUpdateFlag().catch(() => {});
    // 启动时静默查一次侧边栏插件(本地 + registry):插件有新版同样亮红点
    refreshPluginCheck().catch(() => {});
    // 启动时读「侧边栏显示插件市场入口」开关(注入参数用);并静默查插件市场
    marketSidebarEntry = readSettingBool(appDshHome(), "marketSidebarEntry");
    // 启动时读「服务状态」共享面板宽度(注入参数用;拖拽后持久化)
    {
      const rawW = readSettingValue(appDshHome(), "statusPanelWidth");
      statusPanelWidth = Math.max(
        STATUS_WIDTH_MIN,
        Math.min(STATUS_WIDTH_MAX, Math.round(Number(rawW) || STATUS_WIDTH_DEFAULT))
      );
    }
    // 启动时读「消息通知」开关(横幅 / 声音,默认关;服务就绪后按需启动 watcher)
    notifyBanner = readSettingBool(appDshHome(), "notificationBanner");
    notifySound = readSettingBool(appDshHome(), "notificationSound");
    // 启动读完后补一次编排:服务若已就绪则立即启动 watcher(ready 事件可能先于本段触发)
    ensureNotifyWatcher();
    refreshMarketCheck().catch(() => {});

    // 测试钩子:冒烟测试模式 — 就绪后打印标记并退出(CI / 自检用)
    if (process.env.DSH_SMOKE === "1") {
      console.log(`[smoke] TRAY ${tray ? "ok" : isMac ? "fail" : "skip"}`);
      console.log(`[smoke] MENU ${appMenu ? "ok" : "fail"}`);
      if (server.ready) {
        console.log(`[smoke] READY ${server.url}`);
        setTimeout(() => app.quit(), 1500);
      } else {
        console.error("[smoke] FAIL: dsh 服务未就绪");
        app.exit(1);
      }
    }

    // macOS 惯例:关窗不退出,点击 Dock 图标重新开窗/聚焦
    app.on("activate", focusOrCreateWindow);
  });

  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });

  // 退出清理标记:防止 preventDefault→stop→quit 的循环重入
  let quitCleanupDone = false;
  app.on("will-quit", (event) => {
    // 尽力清理:停掉通知事件流 watcher;dsh 子进程必须等真正退出(stop 内部
    // SIGTERM→5s 宽限→SIGKILL),否则 Squirrel 替换 .app 时旧 dsh 变孤儿占
    // 端口(对抗审查 P2-C4)。preventDefault + 清理完成后置位再 quit。
    stopNotifyWatcher();
    if (quitCleanupDone || !server || !server.child) return; // 无 dsh 或已清理 → 放行
    event.preventDefault();
    server
      .stop()
      .catch(() => {})
      .finally(() => {
        quitCleanupDone = true;
        app.quit();
      });
  });
}
