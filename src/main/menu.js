"use strict";

/**
 * menu.js — 应用菜单(macOS 菜单栏)。
 *
 * 品牌化要点:
 *   1. 首菜单(应用菜单)标题与「退出」使用应用名「DSH Box」;
 *   2. 「关于 DSH Box」打开自定义品牌弹窗(about.js:logo / 应用名 / 版本 /
 *      依赖版本),而不是系统默认的 Electron 关于面板;
 *   3. 全部菜单项中文(macOS 惯例:关于 / 服务 / 隐藏 / 退出 / 编辑 / 视图 / 窗口)。
 *
 * 注意:菜单栏左上角显示的应用名(macOS 由进程/包名决定)**不**由这里控制 ——
 * 开发模式由 scripts/dev-launch.mjs 的品牌化副本决定,打包版由
 * electron-builder 的 productName 生成。
 */

const { Menu } = require("electron");

const MENU_LABELS = {
  appName: "DSH Box",
  about: "关于 DSH Box",
  dshStatus: "dsh 服务与版本…",
  services: "服务",
  hide: "隐藏 DSH Box",
  hideOthers: "隐藏其他",
  showAll: "全部显示",
  quit: "退出 DSH Box",
  file: "文件",
  closeWindow: "关闭窗口",
  edit: "编辑",
  undo: "撤销",
  redo: "重做",
  cut: "剪切",
  copy: "复制",
  paste: "粘贴",
  selectAll: "全选",
  view: "视图",
  reload: "重新加载",
  forceReload: "强制重新加载",
  devTools: "开发者工具",
  actualSize: "实际大小",
  zoomIn: "放大",
  zoomOut: "缩小",
  toggleFullScreen: "切换全屏",
  window: "窗口",
  minimize: "最小化",
  zoom: "缩放",
  front: "前置全部窗口",
};

/**
 * 构建应用菜单。
 * @param {{ onAbout?: () => void, onOpenStatus?: () => void }} [handlers]
 *   onAbout: 点「关于 DSH Box」→ 打开品牌弹窗
 *   onOpenStatus: 点「dsh 服务与版本…」→ 打开服务状态/版本窗口
 * @returns {Menu}
 */
function createAppMenu({ onAbout = () => {}, onOpenStatus = () => {} } = {}) {
  const isMac = process.platform === "darwin";

  const template = [
    // macOS 专属:应用菜单(关于 / 服务 / 隐藏 / 退出)
    ...(isMac
      ? [
          {
            label: MENU_LABELS.appName,
            submenu: [
              { label: MENU_LABELS.about, click: () => onAbout() },
              { label: MENU_LABELS.dshStatus, click: () => onOpenStatus() },
              { type: "separator" },
              { label: MENU_LABELS.services, role: "services" },
              { type: "separator" },
              { label: MENU_LABELS.hide, role: "hide" },
              { label: MENU_LABELS.hideOthers, role: "hideOthers" },
              { label: MENU_LABELS.showAll, role: "unhide" },
              { type: "separator" },
              { label: MENU_LABELS.quit, role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: MENU_LABELS.file,
      submenu: [{ label: MENU_LABELS.closeWindow, role: "close" }],
    },
    {
      label: MENU_LABELS.edit,
      submenu: [
        { label: MENU_LABELS.undo, role: "undo" },
        { label: MENU_LABELS.redo, role: "redo" },
        { type: "separator" },
        { label: MENU_LABELS.cut, role: "cut" },
        { label: MENU_LABELS.copy, role: "copy" },
        { label: MENU_LABELS.paste, role: "paste" },
        { label: MENU_LABELS.selectAll, role: "selectAll" },
      ],
    },
    {
      label: MENU_LABELS.view,
      submenu: [
        { label: MENU_LABELS.reload, role: "reload" },
        { label: MENU_LABELS.forceReload, role: "forceReload" },
        { label: MENU_LABELS.devTools, role: "toggleDevTools" },
        { type: "separator" },
        { label: MENU_LABELS.actualSize, role: "resetZoom" },
        { label: MENU_LABELS.zoomIn, role: "zoomIn" },
        { label: MENU_LABELS.zoomOut, role: "zoomOut" },
        { type: "separator" },
        { label: MENU_LABELS.toggleFullScreen, role: "togglefullscreen" },
      ],
    },
    {
      label: MENU_LABELS.window,
      submenu: [
        { label: MENU_LABELS.minimize, role: "minimize" },
        { label: MENU_LABELS.zoom, role: "zoom" },
        ...(isMac
          ? [{ type: "separator" }, { label: MENU_LABELS.front, role: "front" }]
          : [{ label: MENU_LABELS.closeWindow, role: "close" }]),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { createAppMenu, MENU_LABELS };
