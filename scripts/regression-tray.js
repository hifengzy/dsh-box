#!/usr/bin/env node
"use strict";

/**
 * regression-tray.js — macOS 菜单栏(Tray)回归测试(真实 Electron 驱动):
 *   1. 菜单栏图标可创建(template image,深浅色自适应);
 *   2. 单击图标 → 触发 onActivate(聚焦/打开主窗口);
 *   3. 右键菜单恰好两个功能项:「打开 DSH Box」「退出」,点击各触发对应回调。
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
    let quitCalled = false;

    const { tray, menu } = createTray({
      onActivate: () => { activated += 1; },
      onQuit: () => { quitCalled = true; },
    });

    // 1. Tray 创建 + tooltip 常量
    if (!tray) throw new Error("Tray 未创建");
    console.log(`[1] Tray 已创建, tooltip = ${JSON.stringify(TOOLTIP)}`);
    if (TOOLTIP !== "DSH Box") throw new Error(`tooltip 应为 "DSH Box"`);

    // 2. 菜单结构:两项功能 + 分隔线,文案与需求一致
    const labels = menu.items
      .filter((i) => i.type !== "separator")
      .map((i) => i.label);
    console.log(`[2] 菜单功能项: ${JSON.stringify(labels)}`);
    if (labels.length !== 2) throw new Error(`应有 2 个功能项,实际 ${labels.length}`);
    if (!labels.includes("打开 DSH Box")) throw new Error("缺少「打开 DSH Box」");
    if (!labels.includes("退出")) throw new Error("缺少「退出」");

    // 3. 模拟单击图标 → onActivate(聚焦窗口)
    tray.emit("click");
    if (activated !== 1) throw new Error("单击未触发 onActivate");
    console.log("[3] 单击图标 → 聚焦回调 ✓");

    // 4. 菜单项点击:打开 / 退出
    menu.items.find((i) => i.label === "打开 DSH Box").click();
    if (activated !== 2) throw new Error("「打开 DSH Box」未触发 onActivate");
    console.log("[4] 「打开 DSH Box」→ 聚焦回调 ✓");

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
