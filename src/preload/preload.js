"use strict";

/**
 * preload.js — 在渲染进程与主进程之间搭一座最小、安全的桥。
 *
 * 安全基线:
 *   - contextIsolation: true  → preload 与页面 JS 隔离
 *   - sandbox: true           → preload 运行在沙箱里,只能用 ipcRenderer 等
 *   - nodeIntegration: false  → 页面里没有 Node
 *
 * 这里只暴露 dsh 启动状态相关的只读信息和一个重试动作,
 * 不暴露任何 Node/文件系统能力给页面。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dsh", {
  /** 获取当前服务信息(端口、dsh 路径、日志文件等) */
  getInfo: () => ipcRenderer.invoke("dsh:get-info"),

  /** 订阅服务状态变更;返回取消订阅函数 */
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("dsh:status", listener);
    return () => ipcRenderer.removeListener("dsh:status", listener);
  },

  /** 服务失败后点击重试 */
  retry: () => ipcRenderer.invoke("dsh:retry"),

  /** 双击隐形标题栏:最大化 / 还原 */
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),

  /** 打开外部链接(仅 http/https,主进程校验) */
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),

  /** 上报 dsh UI 当前解析出的主题('dark'|'light'),外壳据此跟随 */
  reportTheme: (scheme) => ipcRenderer.send("shell:theme-changed", scheme),

  /** 查一次 npm 上的 dsh 版本(进入「服务与版本」页时调用),返回完整列表 */
  checkUpdates: () => ipcRenderer.invoke("dsh:check-updates"),

  /** 查询当前更新标志(顶栏红点);启动时已静默查过一次 */
  getUpdateFlag: () => ipcRenderer.invoke("dsh:get-update-flag"),

  /** 订阅更新标志变化(顶栏红点实时刷新);返回取消订阅函数 */
  onUpdateFlag: (callback) => {
    const listener = (_event, flag) => callback(flag);
    ipcRenderer.on("dsh:update-flag", listener);
    return () => ipcRenderer.removeListener("dsh:update-flag", listener);
  },

  /** 应用内升级捆绑的 dsh 到指定版本(主进程会停服→替换→恢复) */
  upgrade: (version) => ipcRenderer.invoke("dsh:upgrade", version),

  /** 停止 dsh 服务(状态页「停止」按钮) */
  stopServer: () => ipcRenderer.invoke("dsh:stop"),

  /** 切换右侧「dsh 服务与版本」面板开/关;返回 { open, canOpen } */
  toggleSidebar: () => ipcRenderer.invoke("dsh:toggle-sidebar"),

  /** 查询面板当前状态(顶栏按钮激活态 / 窗口太窄禁用) */
  getSidebar: () => ipcRenderer.invoke("dsh:get-sidebar"),

  /** 订阅面板状态变化(顶栏按钮实时刷新);返回取消订阅函数 */
  onSidebar: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("dsh:sidebar-state", listener);
    return () => ipcRenderer.removeListener("dsh:sidebar-state", listener);
  },
});
