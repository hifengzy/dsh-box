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

  /** 查询应用自更新状态({state,percent,version,error});dev 模式为 disabled */
  getAppUpdateState: () => ipcRenderer.invoke("dsh:app-update-state"),

  /** 订阅应用自更新状态变化(顶栏「新版本」按钮);返回取消订阅函数 */
  onAppUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("dsh:app-update", listener);
    return () => ipcRenderer.removeListener("dsh:app-update", listener);
  },

  /** 主动检查应用更新(菜单「检查更新…」) */
  checkAppUpdate: () => ipcRenderer.invoke("dsh:app-update-check"),

  /** 开始下载应用新版本(顶栏「新版本」→ 下载中) */
  downloadAppUpdate: () => ipcRenderer.invoke("dsh:app-update-download"),

  /** 安装已下载的应用新版本(顶栏「安装」→ Squirrel 退出+替换+重启) */
  installAppUpdate: () => ipcRenderer.invoke("dsh:app-update-install"),

  /** 错误态重试(顶栏「重试」):检查失败→重新检查;下载失败→重新下载 */
  retryAppUpdate: () => ipcRenderer.invoke("dsh:app-update-retry"),

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

  /** 查询侧边栏插件信息(本地版本 + registry 最新);进入状态页时调用 */
  getPluginInfo: () => ipcRenderer.invoke("dsh:plugin-info"),

  /** 安装(version=null)或更新(version=最新版)侧边栏插件;成功后自动重启服务 */
  installPlugin: (version) => ipcRenderer.invoke("dsh:plugin-install", version ?? null),

  /** 顶栏「侧栏/底栏」切换:经桥模拟点击插件自己的 toggle 按钮 */
  togglePluginPanel: (which) => ipcRenderer.invoke("dsh:toggle-plugin-panel", which),

  /** 订阅插件面板开合状态(顶栏按钮高亮/灰显);返回取消订阅函数 */
  onPluginPanels: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("dsh:plugin-panels", listener);
    return () => ipcRenderer.removeListener("dsh:plugin-panels", listener);
  },

  /** 内容页里注入的桥脚本上报插件面板状态(仅内容视图实际调用) */
  reportPluginPanels: (state) => ipcRenderer.send("shell:plugin-panels", state),

  /** 查询插件市场信息(本地版本 + registry 最新);进入状态页时调用 */
  getMarketInfo: () => ipcRenderer.invoke("dsh:market-info"),

  /** 安装(version=null)或更新(version=最新版)插件市场;成功后自动重启服务 */
  installMarket: (version) => ipcRenderer.invoke("dsh:market-install", version ?? null),

  /** 读「在 DSH 侧边栏显示插件市场入口」开关(返回 { ok, enabled }) */
  getMarketSwitch: () => ipcRenderer.invoke("dsh:market-switch"),

  /** 写开关(true/false):持久化到 settings.yaml + 注入层即时生效 */
  setMarketSwitch: (enabled) => ipcRenderer.invoke("dsh:market-switch", !!enabled),

  /** 「服务状态」共享面板:注入层上报开合状态(仅内容视图实际调用) */
  reportStatusPanel: (state) => ipcRenderer.send("shell:status-panel", state),

  /** 「服务状态」共享面板:拖拽结束持久化宽度(仅内容视图注入层调用) */
  setStatusPanelWidth: (width) => ipcRenderer.invoke("dsh:status-panel-width", width),

  /** 读通知开关 + macOS 通知权限:返回 { banner, sound, permission } */
  getNotificationSettings: () => ipcRenderer.invoke("dsh:notify-settings"),

  /** 写通知开关(传 { banner?, sound? }):持久化 + 首次开启横幅触发系统授权 */
  setNotificationSettings: (next) => ipcRenderer.invoke("dsh:notify-settings", next ?? {}),
});
