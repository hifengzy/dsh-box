"use strict";

/**
 * main.js — Electron 主进程入口。
 *
 * 职责:
 *   1. 启动 dsh web 子进程(见 dsh-server.js),等待 HTTP 就绪;
 *   2. 创建 BrowserWindow 显示启动页,就绪后切换到 dsh Web UI;
 *   3. 管理应用菜单、权限请求、外链打开、单实例锁;
 *   4. 退出时清理 dsh 子进程。
 *
 * 进程模型:
 *   ┌─ Electron 主进程 (main.js) ──────────────┐
 *   │  ├─ spawn ─→ dsh web 子进程 (Node)        │ ← 同一原生进程树,
 *   │  │              └─ spawn ─→ bash/shell    │   继承 App 的 TCC 权限
 *   │  └─ BrowserWindow ─→ preload ─→ dsh UI    │
 *   └──────────────────────────────────────────┘
 */

const { app, BrowserWindow, Menu, session, shell, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { DshServer, DEFAULT_PORT } = require("./dsh-server");

const APP_NAME = "DSH Desktop";
const isMac = process.platform === "darwin";

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
  let server = null;

  const port = Number(process.env.DSH_APP_PORT) || DEFAULT_PORT;

  app.setName(APP_NAME);

  // ---------- 窗口 ----------
  function createWindow() {
    mainWindow = new BrowserWindow({
      title: APP_NAME,
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 600,
      backgroundColor: "#0d1117",
      // 隐藏标题栏但保留 macOS 红绿灯按钮(原生实现,不是去掉窗口边框)
      titleBarStyle: "hiddenInset",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

    // 禁止窗口内导航离开本应用,外部链接交给系统浏览器
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        shell.openExternal(url);
      }
      return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
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
    });
  }

  // ---------- 启动页 / 状态广播 ----------
  function broadcastStatus(status) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("dsh:status", status);
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
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(url);
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

  // ---------- 隐形标题栏(dsh UI 注入) ----------
  // Discord 风格:内容全出血、不预留顶部空间(避免 100vh 布局出现滚动条、
  // 也避免侧边栏和标题栏区域产生色界)。红绿灯浮在内容左上角,
  // 顶部 32px 注入透明拖拽条用于拖动窗口,双击=最大化。
  const TOP_STRIP_JS = `
    (() => {
      if (document.getElementById('__dshDesktopDragStrip')) return;
      const strip = document.createElement('div');
      strip.id = '__dshDesktopDragStrip';
      strip.style.cssText =
        'position:fixed;top:0;left:0;right:0;height:32px;z-index:2147483647;-webkit-app-region:drag;';
      strip.addEventListener('dblclick', () => {
        if (window.dsh && window.dsh.toggleMaximize) window.dsh.toggleMaximize();
      });
      document.documentElement.appendChild(strip);
    })();
  `;

  // ---------- custom.css(用户自定义样式) ----------
  // 项目根目录的 custom.css 会被注入到 dsh WebUI,改布局不用写插件。
  // 开发时是项目根目录;打包后在 Resources/app/custom.css。
  function readCustomCss() {
    try {
      return fs.readFileSync(path.join(__dirname, "..", "..", "custom.css"), "utf8");
    } catch {
      return "";
    }
  }

  function installHiddenTitleBarForWebUI() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    wc.on("did-finish-load", () => {
      if (!server || !wc.getURL().startsWith(server.url)) return;
      wc.executeJavaScript(TOP_STRIP_JS, true).catch(() => {});
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
        dshHome: process.env.DSH_HOME,
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
  // 双击隐形标题栏 = 最大化/还原(macOS 惯例)
  ipcMain.handle("window:toggle-maximize", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return true;
  });

  // ---------- 权限:本应用只信任本机 dsh 服务 ----------
  // (必须在 app ready 之后才能访问 session,所以放在 whenReady 里)
  function installPermissionHandlers() {
    // 信任两个来源:本机 dsh 服务 + 应用自带的 file:// 页面(加载页)
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
    installHiddenTitleBarForWebUI();
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
