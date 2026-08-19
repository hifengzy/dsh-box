"use strict";

/**
 * about.js — 「关于 DSH Box」品牌弹窗。
 *
 * 需求:把系统默认的 Electron 关于面板换成 DSH Box 品牌弹窗:
 *   1. 应用 logo(assets/icon.png);
 *   2. 应用名 DSH Box;
 *   3. 应用版本(版本:xxx);
 *   4. 依赖版本(Electron / Node.js)。
 *
 * 交互:点菜单栏「关于 DSH Box」打开;单击窗外或按 Esc 关闭
 * (与 macOS 原生关于面板一致)。单例:重复打开只聚焦已有窗口。
 */

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ABOUT_HTML = path.join(__dirname, "..", "renderer", "about.html");
const WIDTH = 340;
const HEIGHT = 440;

/**
 * DeepSeek Harness(dsh)版本 —— 核心依赖,必须展示。
 * 直接解析安装包内的 package.json(当前 dsh 无 exports 限制);
 * 若未来 dsh 加了 exports 限制 ./package.json,退回从主入口向上找包根。
 * @returns {string} 取不到返回空串(界面留空,不报错)
 */
function dshVersion() {
  try {
    const pkgPath = require.resolve("@deepseek-ai/dsh/package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "";
  } catch {
    try {
      const entry = require.resolve("@deepseek-ai/dsh");
      let dir = path.dirname(entry);
      for (let i = 0; i < 8; i++) {
        const pkg = path.join(dir, "package.json");
        if (fs.existsSync(pkg)) {
          return JSON.parse(fs.readFileSync(pkg, "utf8")).version || "";
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      /* 忽略:dsh 缺失时版本留空 */
    }
    return "";
  }
}

/** @type {BrowserWindow|null} */
let aboutWindow = null;

/**
 * 打开(或聚焦已有的)关于弹窗。
 * @param {{ parent?: BrowserWindow|null }} [options] parent: 用于居中定位的主窗口
 * @returns {BrowserWindow}
 */
function showAboutWindow({ parent = null } = {}) {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    if (aboutWindow.isMinimized()) aboutWindow.restore();
    aboutWindow.show();
    aboutWindow.focus();
    return aboutWindow;
  }

  const win = new BrowserWindow({
    title: "关于 DSH Box",
    width: WIDTH,
    height: HEIGHT,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    // 与主窗口一致的玻璃拟态;隐藏标题栏但保留红绿灯(只有一个关闭钮)
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 居中在父窗口(主窗口)上方;无父窗口则屏幕居中
  if (parent && !parent.isDestroyed()) {
    const b = parent.getBounds();
    win.setBounds({
      x: Math.round(b.x + (b.width - WIDTH) / 2),
      y: Math.round(b.y + (b.height - HEIGHT) / 2),
      width: WIDTH,
      height: HEIGHT,
    });
  } else {
    win.center();
  }

  // 单击窗外 / 切到其他窗口 → 关闭(macOS 原生关于面板的行为)
  win.on("blur", () => win.close());
  win.on("closed", () => {
    aboutWindow = null;
  });
  // Esc 关闭
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") win.close();
  });

  // 显示时机:用 did-finish-load 而非 ready-to-show。
  // 同「dsh 服务与版本」窗口的实测结论:show:false + 透明背景的窗口在隐藏
  // 状态下不产出首帧,ready-to-show 可能永远不触发(窗口永远不显示);
  // did-finish-load 在隐藏状态稳定触发,页面就绪后再 show,无闪屏。
  // (keep the vibrancy glass look for this small dialog)
  win.webContents.once("did-finish-load", () => {
    if (!win.isDestroyed()) win.show();
  });

  win.loadFile(ABOUT_HTML, {
    query: {
      appName: "DSH Box",
      version: app.getVersion(),
      dsh: dshVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
    },
  });

  aboutWindow = win;
  return win;
}

module.exports = { showAboutWindow, ABOUT_HTML };
