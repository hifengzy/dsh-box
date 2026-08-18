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

const { app, BrowserWindow, Menu, session, shell, ipcMain, WebContentsView, nativeTheme } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DshServer, DEFAULT_PORT } = require("./dsh-server");
const { isServerOrigin, isTrustedOrigin } = require("./url-guard");
const { createTray } = require("./tray");
const { createAppMenu } = require("./menu");
const { showAboutWindow } = require("./about");
const { getRuntimeDshInfo } = require("./dsh-version");
const npmCheck = require("./npm-check");
const { upgradeDsh } = require("./dsh-upgrade");

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
  /** 「dsh 服务与版本」窗口(单例,可关可重开) */
  let statusWindow = null;
  /** 是否正在执行升级(防止并发升级) */
  let upgrading = false;
  /** 最近一次 npm 更新检查结果(顶栏红点用) */
  let lastUpdateCheck = null;

  const port = Number(process.env.DSH_APP_PORT) || DEFAULT_PORT;

  app.setName(APP_NAME);

  // ---------- 启动即应用已持久化的外观主题 ----------
  // dsh UI 的「外观」偏好持久化在 <DSH_HOME>/settings.yaml 的
  // settings.theme.preference(light/dark/system)。窗口创建前读取并设置
  // nativeTheme.themeSource,让启动页(prefers-color-scheme)与毛玻璃
  // 从第一帧就跟随用户已设置的主题,而不是先闪一下系统主题。
  // 之后 dsh UI 加载完成会通过 shell:theme-changed 持续同步。
  (function applyPersistedTheme() {
    try {
      const home = process.env.DSH_HOME || path.join(app.getPath("userData"), "dsh-home");
      const raw = fs.readFileSync(path.join(home, "settings.yaml"), "utf8");
      // 实测 settings.yaml 的键是 ui-theme(settings 命名空间 "settings.theme"
      // 持久化后写作 ui-theme);两种写法都兼容
      const match = raw.match(/^ui-theme:\s*\n\s*preference:\s*["']?(light|dark|system)["']?/m)
        ?? raw.match(/^settings\.theme:\s*\n\s*preference:\s*["']?(light|dark|system)["']?/m);
      const preference = match ? match[1] : null;
      if (preference === "dark" || preference === "light") {
        nativeTheme.themeSource = preference;
        console.log(`[app] 启动应用已持久化的外观主题: ${preference}`);
      }
    } catch {
      /* settings.yaml 不存在或读不到 → 保持跟随系统 */
    }
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

    mainWindow.on("resize", layoutViews);
    mainWindow.on("enter-full-screen", () => setTimeout(layoutViews, 120));
    mainWindow.on("leave-full-screen", () => setTimeout(layoutViews, 120));

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

    mainWindow.on("closed", () => {
      mainWindow = null;
      topBarView = null;
      contentView = null;
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

  /** 按当前窗口尺寸摆放两个视图(顶栏通栏;内容区内缩+圆角)。 */
  function layoutViews() {
    if (!mainWindow || mainWindow.isDestroyed() || !topBarView || !contentView) return;
    const { width, height } = mainWindow.getContentBounds();
    topBarView.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT });
    contentView.setBounds({
      x: CONTENT_INSET,
      y: BAR_HEIGHT + CONTENT_GAP,
      width: Math.max(0, width - CONTENT_INSET * 2),
      height: Math.max(0, height - BAR_HEIGHT - CONTENT_GAP - CONTENT_INSET),
    });
  }

  // ---------- 状态广播(发给内容视图 + 服务状态窗口) ----------
  function broadcastStatus(status) {
    if (contentView && !contentView.webContents.isDestroyed()) {
      contentView.webContents.send("dsh:status", status);
    }
    if (statusWindow && !statusWindow.isDestroyed()) {
      statusWindow.webContents.send("dsh:status", status);
    }
  }

  function getServerInfo() {
    const runtime = getRuntimeDshInfo();
    return {
      version: runtime.version ?? null,
      port,
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
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.loadURL(url);
      }
    });
    server.on("error", (error) => {
      console.error("[app] dsh 启动失败:", error);
      lastError = error.message;
      serviceState = "error";
      broadcastStatus({ state: "error", message: lastError });
    });
    server.on("exited", ({ code, signal }) => {
      lastError = `dsh 服务意外退出 (code=${code}, signal=${signal})。点击重试重新启动。`;
      serviceState = "error";
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

  // 主题同步:dsh UI 设置里切换外观(浅色/深色/跟随系统)时,前端会在
  // document.body 上设置/移除 data-ds-dark-theme(有=深色,无=浅色)。
  // 这里监听该属性并把解析结果上报给主进程,让外壳跟随。
  const THEME_WATCHER_JS = `
    (() => {
      if (window.__dshDesktopThemeWatcher) return;
      window.__dshDesktopThemeWatcher = true;
      const report = () => {
        const dark = document.body ? document.body.hasAttribute('data-ds-dark-theme') : false;
        if (window.dsh && window.dsh.reportTheme) {
          window.dsh.reportTheme(dark ? 'dark' : 'light');
        }
      };
      const start = () => {
        if (!document.body) { setTimeout(start, 100); return; }
        new MutationObserver(report).observe(document.body, {
          attributes: true,
          attributeFilter: ['data-ds-dark-theme']
        });
        report();
      };
      start();
    })();
  `;

  function installWebUIInjection() {
    if (!contentView) return;
    const wc = contentView.webContents;
    wc.on("did-finish-load", () => {
      if (!server || !isServerOrigin(wc.getURL(), server.url)) return;
      wc.executeJavaScript(POINTER_DUP_GUARD_JS, true).catch(() => {});
      wc.executeJavaScript(THEME_WATCHER_JS, true).catch(() => {});
      const css = readCustomCss();
      if (css) wc.insertCSS(css).catch(() => {});
    });
  }

  async function startServer() {
    if (!server) {
      server = new DshServer({ port });
      wireServerEvents();
    }
    if (server.ready || server.child) return;
    lastError = null;
    serviceState = "starting";
    broadcastStatus({ state: "starting", message: "正在启动 dsh 服务…" });

    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });

    try {
      await server.start({
        // dshBin 由 DshServer 内部自动解析(优先用打进 App 的副本)
        // DSH_HOME 默认用 App 自己的目录,与浏览器 WebUI 的 ~/.dsh 隔离:
        // 两个 dsh 服务共享同一会话会互相刷新状态,导致命令面板等
        // 会话级弹层"打开即消失"。设 DSH_HOME 可覆盖(共享时勿双开同会话)。
        dshHome: process.env.DSH_HOME || path.join(app.getPath("userData"), "dsh-home"),
        logDir,
      });
    } catch (error) {
      // error 事件已广播;这里吞掉,避免 unhandled rejection
      if (error.code !== "DSH_NOT_FOUND" && error.code !== "DSH_START_TIMEOUT") {
        console.error("[app] startServer 异常:", error);
      }
    }
  }

  async function restartServer() {
    if (server) await server.stop();
    await startServer();
  }

  // ---------- 「dsh 服务与版本」窗口(单例) ----------
  function openStatusWindow() {
    if (statusWindow && !statusWindow.isDestroyed()) {
      if (statusWindow.isMinimized()) statusWindow.restore();
      statusWindow.show();
      statusWindow.focus();
      return statusWindow;
    }
    statusWindow = new BrowserWindow({
      title: "dsh 服务与版本",
      width: 680,
      height: 640,
      minWidth: 560,
      minHeight: 480,
      show: false,
      // 与主窗口一致的玻璃拟态 + 隐藏标题栏(保留红绿灯),页面自带头部
      ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
      vibrancy: VIBRANCY_MATERIAL,
      visualEffectState: "active",
      backgroundColor: "#00000000",
      webPreferences: VIEW_PRELOAD,
    });
    statusWindow.on("closed", () => {
      statusWindow = null;
    });
    statusWindow.once("ready-to-show", () => statusWindow.show());
    statusWindow.loadFile(path.join(__dirname, "..", "renderer", "dsh-status.html"));
    return statusWindow;
  }

  // ---------- npm 更新检查(启动查一次 → 顶栏红点) ----------
  function broadcastUpdateFlag() {
    if (topBarView && !topBarView.webContents.isDestroyed()) {
      topBarView.webContents.send("dsh:update-flag", lastUpdateCheck);
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

  // ---------- 升级编排:停服 → 换文件 → 恢复服务 → 刷新红点 ----------
  async function performUpgrade(version) {
    const wasReady = server?.ready ?? false;
    broadcastStatus({ state: "starting", message: `正在升级 dsh 至 ${version}…` });
    if (server) await server.stop();
    serviceState = "stopped";
    const result = await upgradeDsh(version, {
      cacheDir: path.join(app.getPath("userData"), "cache"),
      log: console,
    });
    if (!result.ok) {
      if (wasReady) await startServer();
      return result;
    }
    if (wasReady) await startServer();
    await refreshUpdateFlag();
    return result;
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
  // 顶栏红点查询(启动时已静默查过一次)
  ipcMain.handle("dsh:get-update-flag", () => lastUpdateCheck ?? { hasUpdate: false });
  // 打开「dsh 服务与版本」窗口(顶栏入口 / 菜单)
  ipcMain.handle("dsh:open-status", () => {
    openStatusWindow();
    return true;
  });
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
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
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

  // ---------- 主题同步(dsh UI → 外壳) ----------
  // dsh UI 在设置里切换外观(浅色/深色/跟随系统)时,dsh 前端会在
  // document.body 上设置/移除 data-ds-dark-theme;注入脚本把解析结果
  // 报过来,这里镜像到 nativeTheme.themeSource,让毛玻璃材质、红绿灯、
  // 顶栏文字(light-dark())一起跟随 dsh 的主题。
  ipcMain.on("shell:theme-changed", (_event, scheme) => {
    if (scheme !== "dark" && scheme !== "light") return;
    if (nativeTheme.themeSource !== scheme) {
      nativeTheme.themeSource = scheme;
      console.log(`[app] 外壳主题跟随 dsh UI: ${scheme}`);
    }
  });

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
  function buildMenu() {
    appMenu = createAppMenu({
      onAbout: () => showAboutWindow({ parent: mainWindow }),
      onOpenStatus: () => openStatusWindow(),
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
    createWindow();
    // ---------- macOS 菜单栏(Tray)----------
    // 单击图标聚焦窗口;右键弹出「打开 DSH Box / 退出」。仅 macOS。
    if (isMac) {
      try {
        tray = createTray({
          onActivate: focusOrCreateWindow,
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

  app.on("will-quit", () => {
    // 尽力清理 dsh 子进程(SIGTERM);进程退出后由 OS 兜底
    if (server) server.stop().catch(() => {});
  });
}
