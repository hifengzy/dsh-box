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
const path = require("node:path");
const { DshServer, DEFAULT_PORT } = require("./dsh-server");

const APP_NAME = "DSH Desktop";
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

// 单实例锁:重复启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
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
      const match = raw.match(/^settings\.theme:\s*\n\s*preference:\s*["']?(light|dark|system)["']?/m);
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
    // 内容视图:先显示加载页,服务就绪后切到 dsh UI
    contentView.webContents.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
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
      if (serverUrl && !url.startsWith(serverUrl)) {
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

  // ---------- 状态广播(发给内容视图) ----------
  function broadcastStatus(status) {
    if (contentView && !contentView.webContents.isDestroyed()) {
      contentView.webContents.send("dsh:status", status);
    }
  }

  function getServerInfo() {
    return {
      port,
      url: server ? server.url : `http://127.0.0.1:${port}`,
      dshBin: server?.dshBin ?? null,
      dshHome: server?.dshHome ?? null,
      logFile: server?.logFile ?? null,
      ready: server?.ready ?? false,
    };
  }

  // ---------- dsh 服务生命周期 ----------
  function wireServerEvents() {
    server.on("ready", (url) => {
      broadcastStatus({ state: "ready", message: `服务已就绪: ${url}` });
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.loadURL(url);
      }
    });
    server.on("error", (error) => {
      console.error("[app] dsh 启动失败:", error);
      broadcastStatus({ state: "error", message: error.message });
    });
    server.on("exited", ({ code, signal }) => {
      broadcastStatus({
        state: "error",
        message: `dsh 服务意外退出 (code=${code}, signal=${signal})。点击重试重新启动。`,
      });
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
      if (!server || !wc.getURL().startsWith(server.url)) return;
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

  // ---------- IPC(preload 桥) ----------
  ipcMain.handle("dsh:get-info", () => getServerInfo());
  ipcMain.handle("dsh:retry", async () => {
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
    // 信任三个来源:本机 dsh 服务 + 应用自带的 file:// 页面(加载页/顶栏)
    const isTrustedOrigin = (origin) =>
      origin.startsWith("http://127.0.0.1") ||
      origin.startsWith("http://localhost") ||
      origin.startsWith("file://");
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const origin = webContents.getURL();
      const trusted = isTrustedOrigin(origin);
      if (!trusted) console.warn(`[app] 拒绝权限请求 ${permission} (${origin})`);
      callback(trusted);
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      const trusted = isTrustedOrigin(requestingOrigin);
      // 空来源是 Chromium 页面加载时的内部检查,不构成风险,不打印
      if (!trusted && requestingOrigin) {
        console.warn(`[app] 拒绝权限检查 ${permission} (${requestingOrigin})`);
      }
      return trusted;
    });
  }

  // ---------- 菜单(macOS 惯例) ----------
  function buildMenu() {
    const template = [
      ...(isMac
        ? [
            {
              label: APP_NAME,
              submenu: [
                { role: "about" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ],
            },
          ]
        : []),
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "窗口",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          ...(isMac ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }]),
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // ---------- 生命周期 ----------
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    installPermissionHandlers();
    createWindow();
    installWebUIInjection();
    await startServer();

    // 测试钩子:冒烟测试模式 — 就绪后打印标记并退出(CI / 自检用)
    if (process.env.DSH_SMOKE === "1") {
      if (server.ready) {
        console.log(`[smoke] READY ${server.url}`);
        setTimeout(() => app.quit(), 1500);
      } else {
        console.error("[smoke] FAIL: dsh 服务未就绪");
        app.exit(1);
      }
    }

    // macOS 惯例:关窗不退出,点击 Dock 图标重新开窗
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });

  app.on("will-quit", () => {
    // 尽力清理 dsh 子进程(SIGTERM);进程退出后由 OS 兜底
    if (server) server.stop().catch(() => {});
  });
}
