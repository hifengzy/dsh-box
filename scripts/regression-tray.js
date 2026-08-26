#!/usr/bin/env node
"use strict";

/**
 * regression-tray.js — macOS 菜单栏(Tray)回归测试(真实 Electron 驱动):
 *   1. 菜单栏图标可创建(template image,深浅色自适应);
 *   2. 单击图标 → 触发 onActivate(聚焦/打开主窗口);
 *   3. 右键菜单恰好三个功能项:「打开 DSH Box」「服务管理」「退出」,
 *      点击各触发对应回调(「服务管理」= 聚焦 + 展开服务状态面板)。
 *
 * 用法: electron scripts/regression-tray.js --no-sandbox
 * 前置: 已运行 npm run make-tray-icon(assets/trayTemplate*.png 存在)
 */

const { app } = require("electron");
const path = require("node:path");
const { createTray, TOOLTIP } = require("../src/main/tray.js");

// 测试不污染用户目录:userData 重定向到工作区内
app.setPath("userData", path.resolve(__dirname, "..", ".runtime", "regression", "tray-user"));

app.whenReady().then(() => {
  try {
    let activated = 0;
    let statusCalled = 0;
    let quitCalled = false;

    const { tray, menu } = createTray({
      onActivate: () => { activated += 1; },
      onOpenStatus: () => { statusCalled += 1; },
      onQuit: () => { quitCalled = true; },
    });

    // 1. Tray 创建 + tooltip 常量
    if (!tray) throw new Error("Tray 未创建");
    console.log(`[1] Tray 已创建, tooltip = ${JSON.stringify(TOOLTIP)}`);
    if (TOOLTIP !== "DSH Box") throw new Error(`tooltip 应为 "DSH Box"`);

    // 2. 菜单结构:三个功能项 + 分隔线,文案与需求一致(「服务管理」在「打开」下面)
    const labels = menu.items
      .filter((i) => i.type !== "separator")
      .map((i) => i.label);
    console.log(`[2] 菜单功能项: ${JSON.stringify(labels)}`);
    if (labels.length !== 3) throw new Error(`应有 3 个功能项,实际 ${labels.length}`);
    if (labels[0] !== "打开 DSH Box") throw new Error("第 1 项应为「打开 DSH Box」(位置回归)");
    if (labels[1] !== "服务管理") throw new Error("第 2 项应为「服务管理」(位置:打开 DSH Box 下面)");
    if (!labels.includes("退出")) throw new Error("缺少「退出」");

    // 3. 模拟单击图标 → onActivate(聚焦窗口)
    tray.emit("click");
    if (activated !== 1) throw new Error("单击未触发 onActivate");
    console.log("[3] 单击图标 → 聚焦回调 ✓");

    // 4. 菜单项点击:打开 / 服务管理 / 退出
    menu.items.find((i) => i.label === "打开 DSH Box").click();
    if (activated !== 2) throw new Error("「打开 DSH Box」未触发 onActivate");
    console.log("[4] 「打开 DSH Box」→ 聚焦回调 ✓");

    menu.items.find((i) => i.label === "服务管理").click();
    if (statusCalled !== 1) throw new Error("「服务管理」未触发 onOpenStatus");
    console.log("[4b] 「服务管理」→ 聚焦 + 展开服务状态面板回调 ✓");

    menu.items.find((i) => i.label === "退出").click();
    if (!quitCalled) throw new Error("「退出」未触发回调");
    console.log("[5] 「退出」→ 退出回调 ✓");

    console.log("\nPASS ✓ 菜单栏 Tray 回归通过");
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 菜单栏 Tray 回归:", err.message);
    app.exit(1);
  }
});
