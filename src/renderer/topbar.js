"use strict";

/**
 * topbar.js — 自定义顶栏逻辑。
 *
 * 双击顶栏 = 最大化/还原(macOS 惯例,和原生标题栏行为一致)。
 * 将来加功能入口(搜索框等)时,对应的事件处理写在这里。
 */

document.querySelector(".bar").addEventListener("dblclick", () => {
  window.dsh.toggleMaximize();
});
