#!/usr/bin/env node
"use strict";

/**
 * regression-menu.js — 应用菜单 + 关于弹窗回归测试(真实 Electron 驱动):
 *   1. 中文品牌菜单结构:首菜单「DSH Box」,应用菜单含
 *      「关于 DSH Box / 服务 / 隐藏 DSH Box / 隐藏其他 / 全部显示 / 退出 DSH Box」;
 *   2. 「关于 DSH Box」→ onAbout 回调(主进程接 showAboutWindow),「退出」role=quit;
 *   3. 编辑 / 视图 / 窗口菜单项齐全(role 正确);
 *   4. 关于弹窗真实打开:加载 about.html,logo 存在,版本信息来自主进程注入。
 *
 * 用法: electron scripts/regression-menu.js --no-sandbox
 */

const { app, Menu } = require("electron");
const path = require("node:path");

// 测试不污染用户目录
app.setPath("userData", path.resolve(__dirname, "..", ".runtime", "regression", "menu-user"));

const { createAppMenu, MENU_LABELS } = require("../src/main/menu.js");
const { showAboutWindow } = require("../src/main/about.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    let aboutCalled = 0;
    const menu = createAppMenu({ onAbout: () => { aboutCalled += 1; } });
    const functional = (submenu) => submenu.items.filter((i) => i.type !== "separator");
    const appMenu = menu.items[0];

    // 1. 首菜单 = 应用菜单,label = DSH Box
    console.log(`[1] 首菜单 label = ${JSON.stringify(appMenu.label)}`);
    if (appMenu.label !== MENU_LABELS.appName) {
      throw new Error(`首菜单应为「${MENU_LABELS.appName}」,实际「${appMenu.label}」`);
    }

    // 2. 应用菜单功能项与需求一致
    const labels = functional(appMenu.submenu).map((i) => i.label);
    console.log(`[2] 应用菜单: ${JSON.stringify(labels)}`);
    const expect = [
      "关于 DSH Box",
      "服务",
      "隐藏 DSH Box",
      "隐藏其他",
      "全部显示",
      "退出 DSH Box",
    ];
    if (JSON.stringify(labels) !== JSON.stringify(expect)) {
      throw new Error(`应用菜单应为 ${JSON.stringify(expect)},实际 ${JSON.stringify(labels)}`);
    }

    // 3. 「关于 DSH Box」触发 onAbout;「退出 DSH Box」是原生 quit
    const aboutItem = appMenu.submenu.items.find((i) => i.label === "关于 DSH Box");
    const quitItem = appMenu.submenu.items.find((i) => i.label === "退出 DSH Box");
    if (!aboutItem || !quitItem) throw new Error("缺少「关于 DSH Box」或「退出 DSH Box」");
    aboutItem.click();
    if (aboutCalled !== 1) throw new Error("「关于 DSH Box」未触发 onAbout");
    if (quitItem.role !== "quit") throw new Error("「退出 DSH Box」应为 role=quit");
    console.log("[3] 「关于 DSH Box」→ onAbout ✓,「退出 DSH Box」role=quit ✓");

    // 4. 编辑 / 窗口菜单齐全
    const editLabels = functional(menu.items.find((i) => i.label === "编辑").submenu).map((i) => i.label);
    console.log(`[4] 编辑: ${JSON.stringify(editLabels)}`);
    for (const label of ["撤销", "重做", "剪切", "复制", "粘贴", "全选"]) {
      if (!editLabels.includes(label)) throw new Error(`编辑菜单缺少「${label}」`);
    }
    const windowLabels = functional(menu.items.find((i) => i.label === "窗口").submenu).map((i) => i.label);
    if (!windowLabels.includes("最小化")) throw new Error("窗口菜单缺少「最小化」");

    // 5. 设为应用菜单后可读回
    Menu.setApplicationMenu(menu);
    if (Menu.getApplicationMenu().items[0].label !== MENU_LABELS.appName) {
      throw new Error("setApplicationMenu 后读回不一致");
    }
    console.log("[5] setApplicationMenu 读回 ✓");

    // 6. 关于弹窗:真实打开,验证标题 / logo / 版本信息
    const win = showAboutWindow({});
    await new Promise((resolve, reject) => {
      win.webContents.once("did-finish-load", resolve);
      setTimeout(() => reject(new Error("关于弹窗加载超时")), 8000);
    });
    await sleep(300);
    const title = win.getTitle();
    const text = await win.webContents.executeJavaScript("document.body.innerText", true);
    const logoOk = await win.webContents.executeJavaScript(
      "(() => { const i = document.querySelector('.logo'); return !!i && i.complete && i.naturalWidth > 0; })()",
      true
    );
    console.log(`[6] 关于弹窗 title=${JSON.stringify(title)} logo=${logoOk} 内容=${JSON.stringify(text)}`);
    if (title !== "关于 DSH Box") throw new Error("关于弹窗标题应为「关于 DSH Box」");
    if (!logoOk) throw new Error("关于弹窗 logo 未加载");
    if (!text.includes("版本：")) throw new Error("关于弹窗缺少「版本:」");
    if (!text.includes(process.versions.electron)) throw new Error("关于弹窗缺少 Electron 版本");
    if (!text.includes(process.versions.node)) throw new Error("关于弹窗缺少 Node.js 版本");
    win.close();

    console.log("\nPASS ✓ 应用菜单与关于弹窗回归通过");
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 应用菜单与关于弹窗回归:", err.message);
    app.exit(1);
  }
});
