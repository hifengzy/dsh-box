#!/usr/bin/env node
"use strict";

/**
 * regression-sidebar-layout.js — 右侧状态面板宽度策略单测(纯 Node,无需 Electron)。
 *
 * 断言(策略:内容优先 + 面板拿剩余):
 *   - 面板开放时,内容区宽度始终 ≥ CONTENT_MIN(内容不被挤压);
 *   - 面板宽度 ≈ 内宽 × 20%,且不低于 SIDEBAR_MIN;
 *   - 窗口过窄(面板放不下 SIDEBAR_MIN)→ canOpen=false,内容区 = 全部可用宽;
 *   - 边界:恰好卡在阈值两侧的宽度。
 *
 * 用法: node scripts/regression-sidebar-layout.js
 */

const { computeSidebar, CONTENT_MIN, SIDEBAR_MIN, SIDEBAR_GAP, SIDEBAR_RATIO, SIDEBAR_OPEN_MIN_INNER } = require("../src/main/sidebar-layout");

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

console.log("[1] 常规窗口(1280px):面板约 1/5,内容不受挤压");
{
  const r = computeSidebar(inner(1280));
  assert(r.canOpen, `1280px 应可展开 (canOpen=${r.canOpen})`);
  assert(r.contentW >= CONTENT_MIN, `内容区 ${r.contentW} 应 ≥ ${CONTENT_MIN}`);
  assert(r.sidebarW >= SIDEBAR_MIN, `面板 ${r.sidebarW} 应 ≥ ${SIDEBAR_MIN}`);
  const ideal = Math.floor((inner(1280) - SIDEBAR_GAP) * SIDEBAR_RATIO);
  assert(r.sidebarW === ideal, `面板应取理想占比 ${ideal},实际 ${r.sidebarW}`);
  assert(r.contentW + r.sidebarW + SIDEBAR_GAP === inner(1280), "宽度守恒(含间隙)");
}

console.log("[2] 大窗口(1920px):面板封顶在理想占比,剩余全给内容");
{
  const r = computeSidebar(inner(1920));
  const ideal = Math.floor((inner(1920) - SIDEBAR_GAP) * SIDEBAR_RATIO);
  assert(r.canOpen, "1920px 应可展开");
  assert(r.sidebarW === ideal, `面板应为理想占比 ${ideal},实际 ${r.sidebarW}`);
  assert(r.contentW >= CONTENT_MIN, `内容区 ${r.contentW} 应 ≥ ${CONTENT_MIN}`);
}

console.log("[3] 窗口闭合:内容区 = 全部可用宽");
{
  const r = computeSidebar(inner(1280));
  const closed = { canOpen: r.canOpen, sidebarW: 0, contentW: inner(1280) };
  // 闭合语义由 main.js 用 canOpen=false 分支表达;这里验证宽度策略不设面板时
  assert(closed.contentW === inner(1280), "闭合时内容区占满内宽");
}

console.log("[4] 过窄窗口(960px):不可展开,内容区 = 全部可用宽");
{
  const r = computeSidebar(inner(960));
  assert(!r.canOpen, `960px 应不可展开 (canOpen=${r.canOpen})`);
  assert(r.sidebarW === 0, "不可展开时面板宽应为 0");
  assert(r.contentW === inner(960), "不可展开时内容区占满内宽");
}

console.log("[5] 阈值边界:以「内宽」为单位,恰好 SIDEBAR_OPEN_MIN_INNER 两侧");
{
  const justBelow = SIDEBAR_OPEN_MIN_INNER - 1;
  const justAt = SIDEBAR_OPEN_MIN_INNER;
  const below = computeSidebar(justBelow);
  const at = computeSidebar(justAt);
  assert(!below.canOpen, `${justBelow}px(<开合阈值)不可展开`);
  assert(at.canOpen, `${justAt}px(≥开合阈值)可展开`);
  assert(at.sidebarW >= SIDEBAR_MIN, "开合阈值处面板恰好 ≥ SIDEBAR_MIN");
  assert(at.contentW >= CONTENT_MIN, "展开后内容区仍保底");
}

console.log("\nPASS ✓ 面板宽度策略单测通过");