"use strict";

/**
 * sidebar-anim.js — 「右侧状态面板」展开/收起动画规格(与 dsh 左侧边栏一致)。
 *
 * 实测 dsh WebUI 主框架(.pI_x6G_frame)的 transition:
 *   grid-template-columns 0.3s cubic-bezier(0.4, 0, 0.2, 1)
 * 即 --ds-transition-duration-slow: .3s + --ds-ease-in-out:
 * cubic-bezier(0.4, 0, 0.2, 1)(Material 标准缓动)。
 * 这里把同一规格抽成纯函数:主进程按帧 setBounds 动画两个视图的宽度,
 * 观感与 dsh 左边栏一致(300ms、同一缓动曲线)。
 */

/** 动画时长(与 dsh 的 --ds-transition-duration-slow 一致) */
const SIDEBAR_ANIM_MS = 300;

/**
 * 构造 cubic-bezier 采样函数(标准 Newton-Raphson 求解,取自 bezier-easing)。
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @returns {(t: number) => number} 输入归一化时间 0..1,输出进度 0..1
 */
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const sampleDerivX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const xErr = sampleX(t) - x;
      if (Math.abs(xErr) < 1e-6) return t;
      const d = sampleDerivX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= xErr / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    while (hi - lo > 1e-6) {
      const mid = (lo + hi) / 2;
      if (sampleX(mid) < x) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  return (t) => sampleY(solveX(Math.max(0, Math.min(1, t))));
}

/** 面板动画缓动(与 dsh 的 --ds-ease-in-out 一致) */
const easeSidebar = cubicBezier(0.4, 0, 0.2, 1);

module.exports = { SIDEBAR_ANIM_MS, cubicBezier, easeSidebar };