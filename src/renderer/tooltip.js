"use strict";

/* tooltip.js — 气泡层脚本:文本注入与显隐(由主进程 executeJavaScript 调用)。
 * 视图尺寸由主进程按文本宽估,这里只负责填字 + 淡入。 */

/** 显示气泡(替换文本并淡入) */
window.showTooltip = function (text) {
  const el = document.getElementById("tooltipTip");
  if (!el) return;
  el.textContent = String(text ?? "");
  el.classList.add("tip-visible");
};