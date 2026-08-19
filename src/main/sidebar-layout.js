"use strict";

/**
 * sidebar-layout.js — 「右侧状态面板」的宽度布局纯函数(主进程与测试共用)。
 *
 * 策略(用户定案「内容优先 + 面板拿剩余」):
 *   - dsh 内容区优先,保底 CONTENT_MIN 宽度;
 *   - 面板宽度 = min(内宽 × 20%, 内宽 − 内容保底),并需 ≥ SIDEBAR_MIN 才允许展开;
 *   - 窗口过窄(理想占比面板连 SIDEBAR_MIN 都放不下)→ 不展开(顶栏按钮禁用)。
 *
 * 纯函数,不依赖 Electron —— 单测直接跑(regression-sidebar-layout.js)。
 */

/** 内容区与面板之间的间隙(两个圆角视图之间露出的毛玻璃缝) */
const SIDEBAR_GAP = 8;
/** dsh 内容区保底宽度(实测 dsh 窄宽临界值后校准) */
const CONTENT_MIN = 900;
/** 面板宽度与内宽的理想占比(≈1/5) */
const SIDEBAR_RATIO = 0.2;
/** 面板最小可展开宽度(默认窗口 1280 的 1/5 ≈ 252,状态内容以紧凑竖排适配) */
const SIDEBAR_MIN = 240;
/** 面板可展开的最小内宽(理想占比面板恰好放到 SIDEBAR_MIN) */
const SIDEBAR_OPEN_MIN_INNER = Math.ceil(SIDEBAR_MIN / SIDEBAR_RATIO + SIDEBAR_GAP);

/**
 * 计算窗口内容区(去掉两侧内缩后的可用宽度)的拆分。
 * @param {number} innerWidth 窗口内容区宽度(不含两侧内缩)
 * @returns {{ canOpen: boolean, sidebarW: number, contentW: number }}
 *   canOpen: 当前宽度是否允许展开面板
 *   sidebarW: 面板宽度(不可展开时为 0)
 *   contentW: dsh 内容区宽度(面板关闭时 = innerWidth)
 */
function computeSidebar(innerWidth) {
  const usable = Math.max(0, innerWidth - SIDEBAR_GAP);
  const ideal = Math.floor(usable * SIDEBAR_RATIO);
  const maxAvailable = usable - CONTENT_MIN;
  const sidebarW = Math.min(ideal, maxAvailable);
  const canOpen = sidebarW >= SIDEBAR_MIN;
  return {
    canOpen,
    sidebarW: canOpen ? sidebarW : 0,
    contentW: innerWidth - (canOpen ? sidebarW + SIDEBAR_GAP : 0),
  };
}

module.exports = {
  computeSidebar,
  SIDEBAR_GAP,
  CONTENT_MIN,
  SIDEBAR_RATIO,
  SIDEBAR_MIN,
  SIDEBAR_OPEN_MIN_INNER,
};