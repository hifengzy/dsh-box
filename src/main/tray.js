"use strict";

/**
 * tray.js — macOS 菜单栏(状态栏)小图标。
 *
 * 交互约定(需求):
 *   1. 菜单栏常驻小图标(模板图,深浅色菜单栏自适应);
 *   2. 单击图标 → 聚焦/打开应用主窗口;
 *   3. 右键图标 → 弹出菜单:「打开 DSH Box」「服务管理」「退出」——
 *      「服务管理」点击后聚焦应用并展开「服务状态」面板。
 *
 * 为什么不用 tray.setContextMenu():
 *   在 macOS 上,一旦设置了 context menu,单击(左键)也会弹出该菜单,
 *   「单击聚焦」与「右键菜单」就无法区分。因此这里不设置 contextMenu,
 *   手动分发:click → 聚焦窗口;right-click → popUpContextMenu。
 */

const { Tray, Menu, nativeImage } = require("electron");
const path = require("node:path");

// 打包后 __dirname = <app>/Contents/Resources/app/src/main,两级向上即
// <app>/Contents/Resources/app/assets(files 已含 assets/**,asar 关闭)
const TRAY_ICON = path.join(__dirname, "..", "..", "assets", "trayTemplate.png");

const TOOLTIP = "DSH Box";

/**
 * 创建菜单栏 Tray。
 * @param {{ onActivate: () => void, onOpenStatus: () => void, onQuit: () => void }} handlers
 *   onActivate:    单击图标或点「打开 DSH Box」→ 聚焦/重建主窗口
 *   onOpenStatus:  点「服务管理」→ 聚焦应用并展开「服务状态」面板
 *   onQuit:        点「退出」→ 退出应用
 * @returns {{ tray: Tray, menu: Menu }}
 * @throws 图标缺失时抛出(由调用方捕获,避免拖垮 App 启动)
 */
function createTray({ onActivate, onOpenStatus, onQuit }) {
  const image = nativeImage.createFromPath(TRAY_ICON);
  if (image.isEmpty()) {
    throw new Error(`菜单栏图标不存在: ${TRAY_ICON} (先运行 npm run make-tray-icon)`);
  }
  image.setTemplateImage(true); // 系统按菜单栏深浅色自动渲染黑/白

  const tray = new Tray(image);
  tray.setToolTip(TOOLTIP);

  const menu = Menu.buildFromTemplate([
    { label: "打开 DSH Box", click: () => onActivate() },
    { label: "服务管理", click: () => onOpenStatus() },
    { type: "separator" },
    { label: "退出", click: () => onQuit() },
  ]);

  tray.on("click", () => onActivate());
  tray.on("right-click", () => tray.popUpContextMenu(menu));

  return { tray, menu };
}

module.exports = { createTray, TOOLTIP, TRAY_ICON };
