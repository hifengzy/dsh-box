"use strict";

/**
 * status-panel-router.js — 「服务状态」共享面板 ↔ dsh-better-sidebar 侧栏
 * 互斥展开的编排纯函数(主进程与单测共用)。
 *
 * 规则(用户定案):
 *   - 两者互斥,不能同时展开;
 *   - 只约束「展开」路径:展开 A 时若 B 已展开 → 收起 B 的同时展开 A;
 *     收起方向不触发互斥;
 *   - 切换采用「并行换边」:关旧 + 开新 同帧发起,两侧动画重叠进行——总
 *     时长 = 单侧动画(≈300ms,原来是串行 ≈700ms),且 #root 挤压不会先
 *     回到全宽再收窄(避免 dsh 左侧边栏随之「展开→折叠」来回晃动);
 *   - 按钮状态同步由两侧桥的上报机制负责(本模块只管顺序)。
 *
 * 纯函数:不依赖 Electron/IPC/DOM,回调由调用方(主进程)注入,便于单测。
 */

/**
 * 执行一次互斥展开编排。
 * @param {"open-status"|"open-plugin-side"} action 本次要展开的一方
 * @param {object} ctx 需要展开的一方的编排上下文,含当前状态与动作回调:
 *   { statusOpen: boolean,           // 服务状态面板是否已展开
 *     pluginSideOpen: boolean,       // 插件侧栏是否已展开
 *     closeStatus: () => Promise,    // 收起服务状态(动画完成 resolve)
 *     openStatus: () => Promise,     // 展开服务状态(动画完成 resolve)
 *     closePluginSide: () => Promise,// 收起插件侧栏(动画完成 resolve)
 *     openPluginSide: () => Promise, // 展开插件侧栏(动画完成 resolve) }
 * @returns {Promise<void>}
 */
async function runMutualOpen(action, ctx) {
  switch (action) {
    case "open-status":
      if (ctx.pluginSideOpen) {
        // 并行换边:收起插件侧栏与展开服务状态同帧发起(动画重叠缩短总时长)
        await Promise.all([ctx.closePluginSide(), ctx.openStatus()]);
      } else {
        await ctx.openStatus();
      }
      return;
    case "open-plugin-side":
      if (ctx.statusOpen) {
        await Promise.all([ctx.closeStatus(), ctx.openPluginSide()]);
      } else {
        await ctx.openPluginSide();
      }
      return;
    default:
      throw new Error(`未知编排动作: ${action}`);
  }
}

module.exports = { runMutualOpen };