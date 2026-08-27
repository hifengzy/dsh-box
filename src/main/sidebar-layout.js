"use strict";

/**
 * sidebar-layout.js — 「右侧状态面板」的宽度布局纯函数(主进程与测试共用)。
 *
 * 策略(用户定案,2026-08-19):
 *   - 面板宽度「尽量大」:面板 = 内宽 − 间隙 − 内容保底,上限 SIDEBAR_MAX;
 *   - 面板展开时,dsh 内容区保底 CONTENT_OPEN_MIN=960(用户指定「内容 <960
 *     自动收起」的触发线;按此构造,展开时内容区恒 ≥960,线不会真正触发,
 *     收起实际由「面板放不下 SIDEBAR_MIN」驱动,语义一致);
 *   - 收起后重新展开需窗口拉宽出缓冲(SIDEBAR_REOPEN_PAD),防临界宽度抖动。
 *
 * 纯函数,不依赖 Electron —— 单测直接跑(regression-sidebar-layout.js)。
 * 注意:canOpen / shouldClose 依赖当前开合状态(带滞回),调用方需传入 open。
 */

/** 内容区与面板之间的间隙(与窗口左右内缩一致,视觉统一) */
const SIDEBAR_GAP = 4;
/** 面板展开时 dsh 内容区保底宽度(低于此视为「内容区被挤爆」→ 收起) */
const CONTENT_OPEN_MIN = 960;
/** 面板宽度上限(避免超宽窗口下面板过大) */
const SIDEBAR_MAX = 480;
/** 面板存在的最小宽度(低于此放不下状态内容 → 收起) */
const SIDEBAR_MIN = 240;
/** 收起后重新展开的窗口(内宽)缓冲,防临界宽度反复开合 */
const SIDEBAR_REOPEN_PAD = 50;
/** 面板关闭的内宽阈值:内宽 < 此值 → 收起 */
const SIDEBAR_CLOSE_MIN_INNER = CONTENT_OPEN_MIN + SIDEBAR_GAP + SIDEBAR_MIN; // 1204
/** 面板重新展开所需内宽(关闭阈值 + 缓冲) */
const SIDEBAR_REOPEN_MIN_INNER = SIDEBAR_CLOSE_MIN_INNER + SIDEBAR_REOPEN_PAD; // 1254

/**
 * 计算窗口内容区(去掉两侧内缩后的可用宽度)的拆分。
 * @param {number} innerWidth 窗口内容区宽度(不含两侧内缩)
 * @param {object} [options]
 * @param {boolean} [options.open=false] 面板当前是否展开(滞回判定用)
 * @returns {{ canOpen: boolean, shouldClose: boolean, sidebarW: number, contentW: number }}
 *   canOpen:     面板当前是否允许展开(仅闭合时才有意义;展开时为 false)
 *   shouldClose: 面板展开中是否应自动收起
 *   sidebarW:    展开时面板宽度(太窄时可能 < SIDEBAR_MIN)
 *   contentW:    展开时 dsh 内容区宽度(构造上恒 ≥ CONTENT_OPEN_MIN)
 */
function computeSidebar(innerWidth, { open = false } = {}) {
  const usable = Math.max(0, innerWidth - SIDEBAR_GAP);
  // 尽量大:面板 = 内宽 − 间隙 − 内容保底(960),上限 480
  const sidebarW = Math.min(Math.max(0, usable - CONTENT_OPEN_MIN), SIDEBAR_MAX);
  const contentW = innerWidth - sidebarW - SIDEBAR_GAP;

  const canOpen = !open && sidebarW >= SIDEBAR_MIN && innerWidth >= SIDEBAR_REOPEN_MIN_INNER;
  const shouldClose = open && (sidebarW < SIDEBAR_MIN || contentW < CONTENT_OPEN_MIN);

  return { canOpen, shouldClose, sidebarW, contentW };
}

module.exports = {
  computeSidebar,
  SIDEBAR_GAP,
  CONTENT_OPEN_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_REOPEN_PAD,
  SIDEBAR_CLOSE_MIN_INNER,
  SIDEBAR_REOPEN_MIN_INNER,
};