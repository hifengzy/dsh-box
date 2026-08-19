#!/usr/bin/env node
"use strict";

/**
 * regression-sidebar-layout.js — 右侧状态面板宽度策略单测(纯 Node,无需 Electron)。
 *
 * 策略(2026-08-19 定案):
 *   - 面板「尽量大」:面板 = 内宽 − 间隙(4) − 内容保底(960),上限 480;
 *   - 展开时 dsh 内容区恒 ≥ 960(用户指定「内容 <960 自动收起」的线,构造保证);
 *   - 收起:面板 < 240 或内容 < 960(兜底);
 *   - 重开:内宽 ≥ 关闭阈值(1204)+ 50 缓冲 = 1254(防抖动,带滞回)。
 *
 * 用法: node scripts/regression-sidebar-layout.js
 */

const {
  computeSidebar,
  CONTENT_MIN,
  CONTENT_OPEN_MIN,
  SIDEBAR_GAP,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  SIDEBAR_CLOSE_MIN_INNER,
  SIDEBAR_REOPEN_MIN_INNER,
} = require("../src/main/sidebar-layout");

// 与 main.js 的 CONTENT_INSET 一致:innerWidth = 窗口宽 - 2×4
const INSET = 4;
const inner = (windowWidth) => windowWidth - 2 * INSET;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL ✗ ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

console.log("[1] 默认窗口(1280px):面板尽量大 → 308px,内容 960(≥ 保底)");
{
  const r = computeSidebar(inner(1280), { open: true });
  assert(r.sidebarW === 308, `面板应为 308,实际 ${r.sidebarW}`);
  assert(r.contentW === 960, `内容应为 960,实际 ${r.contentW}`);
  assert(r.contentW >= CONTENT_OPEN_MIN, `内容 ≥ ${CONTENT_OPEN_MIN}`);
  assert(!r.shouldClose, "默认窗口展开态不应自动收起");
  assert(r.sidebarW > 252, "应比旧策略(252px)更大");
}

console.log("[2] 超宽窗口(1920px):面板封顶 480,剩余全给内容");
{
  const r = computeSidebar(inner(1920), { open: true });
  assert(r.sidebarW === SIDEBAR_MAX, `面板应为上限 ${SIDEBAR_MAX},实际 ${r.sidebarW}`);
  assert(r.contentW === inner(1920) - SIDEBAR_MAX - SIDEBAR_GAP, "内容 = 内宽 − 面板 − 间隙");
  assert(!r.shouldClose, "超宽窗口不应收起");
}

console.log("[3] 中间窗口(1440px):面板 468(未触顶),内容 960");
{
  const r = computeSidebar(inner(1440), { open: true });
  assert(r.sidebarW === 468, `面板应为 468,实际 ${r.sidebarW}`);
  assert(r.contentW === 960, `内容应为 960,实际 ${r.contentW}`);
}

console.log("[4] 面板上限切换点:内宽 ≥ CONTENT_OPEN_MIN+SIDEBAR_MAX+GAP 后触顶");
{
  const capInner = CONTENT_OPEN_MIN + SIDEBAR_MAX + SIDEBAR_GAP; // 1444
  const r1 = computeSidebar(capInner - 1, { open: true });
  const r2 = computeSidebar(capInner, { open: true });
  assert(r1.sidebarW === SIDEBAR_MAX - 1, `临界前一格 ${r1.sidebarW}`);
  assert(r2.sidebarW === SIDEBAR_MAX, `触顶 ${r2.sidebarW}`);
}

console.log("[5] 过窄窗口(960px):不可展开,展开态应收起,内容区 = 全部可用宽");
{
  const closed = computeSidebar(inner(960), { open: false });
  assert(!closed.canOpen, "960px 不应可展开");
  const opened = computeSidebar(inner(960), { open: true });
  assert(opened.shouldClose, "960px 展开态应自动收起");
}

console.log("[6] 滞回边界:关闭阈值 1204 / 重开阈值 1254(内宽)");
{
  // 闭合态:1203 不可重开;1254 可重开
  const below = computeSidebar(SIDEBAR_CLOSE_MIN_INNER - 1, { open: false });
  const reopen = computeSidebar(SIDEBAR_REOPEN_MIN_INNER, { open: false });
  const reopenBelow = computeSidebar(SIDEBAR_REOPEN_MIN_INNER - 1, { open: false });
  assert(!below.canOpen, `${SIDEBAR_CLOSE_MIN_INNER - 1}(<关闭阈)不可重开`);
  assert(!reopenBelow.canOpen, `${SIDEBAR_REOPEN_MIN_INNER - 1}(<重开阈)不可重开`);
  assert(reopen.canOpen, `${SIDEBAR_REOPEN_MIN_INNER}(≥重开阈)可重开`);
  // 展开态:1203 应收起;1204 保持
  const openBelow = computeSidebar(SIDEBAR_CLOSE_MIN_INNER - 1, { open: true });
  const openAt = computeSidebar(SIDEBAR_CLOSE_MIN_INNER, { open: true });
  assert(openBelow.shouldClose, `${SIDEBAR_CLOSE_MIN_INNER - 1} 展开态应收起`);
  assert(!openAt.shouldClose, `${SIDEBAR_CLOSE_MIN_INNER} 展开态应保持`);
  // 滞回带:1204~1253 之间,闭合保持闭合、展开保持展开
  const bandClosed = computeSidebar(1230, { open: false });
  const bandOpen = computeSidebar(1230, { open: true });
  assert(!bandClosed.canOpen, "滞回带内闭合不应重开");
  assert(!bandOpen.shouldClose, "滞回带内展开不应收起");
}

console.log("[7] 宽度守恒与下限");
{
  for (const w of [1280, 1440, 1920]) {
    const r = computeSidebar(inner(w), { open: true });
    assert(r.contentW + r.sidebarW + SIDEBAR_GAP === inner(w), `宽度守恒 @${w}`);
    assert(r.contentW >= CONTENT_OPEN_MIN, `内容 ≥ ${CONTENT_OPEN_MIN} @${w}`);
  }
}

console.log("[8] 展开/收起动画规格(与 dsh 左侧边栏一致)");
{
  const { SIDEBAR_ANIM_MS, easeSidebar } = require("../src/main/sidebar-anim");
  assert(SIDEBAR_ANIM_MS === 300, `时长应为 300ms(与 dsh --ds-transition-duration-slow 一致),实际 ${SIDEBAR_ANIM_MS}`);
  assert(easeSidebar(0) === 0 && easeSidebar(1) === 1, "缓动端点 0/1 正确");
  // 单调性(101 个采样)
  let monotonic = true;
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const v = easeSidebar(i / 100);
    if (v < prev - 1e-9) monotonic = false;
    prev = v;
  }
  assert(monotonic, "缓动应单调递增");
  // 中点位与 cubic-bezier(.4,0,.2,1) 解析值一致(y(0.5)≈0.7756,前快后慢)
  const mid = easeSidebar(0.5);
  assert(Math.abs(mid - 0.7756) < 0.001, `ease(0.5) 应为 ≈0.7756(与解析值一致),实际 ${mid}`);
  // 与 CSS 变量值同源:对比直接构造的 cubic-bezier
  const { cubicBezier } = require("../src/main/sidebar-anim");
  const ref = cubicBezier(0.4, 0, 0.2, 1);
  assert(Math.abs(ref(0.5) - easeSidebar(0.5)) < 1e-12, "easeSidebar 即 cubic-bezier(.4,0,.2,1)");
}

console.log("\nPASS ✓ 面板宽度策略单测通过");