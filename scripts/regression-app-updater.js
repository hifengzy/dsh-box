#!/usr/bin/env node
"use strict";

/**
 * regression-app-updater.js — 「应用自更新」状态机回归(纯 Node,零 Electron):
 *   1. dev 守卫:isPackaged=false → disabled,检查/下载/安装均 no-op;
 *   2. 事件映射:checking → update-available(available+version) →
 *      download-progress(downloading+percent) → update-downloaded(downloaded);
 *   3. error → error 态 + 文案;restartDownload 重下(再次调用 downloadUpdate);
 *   4. installUpdate 守卫:非 downloaded 忽略;downloaded 后调 quitAndInstall;
 *   5. 广播:onChange 收到完整状态对象(percent/version/error 均带上)。
 *
 * 用法: node scripts/regression-app-updater.js
 */

const { createAppUpdater } = require("../src/main/app-updater");

const { EventEmitter } = require("node:events");

/** fake autoUpdater:满足 createAppUpdater 需要的全部接口 */
function makeFakeUpdater() {
  const au = new EventEmitter();
  au.checks = 0;
  au.downloads = 0;
  au.installs = 0;
  au.checkForUpdates = async () => {
    au.checks += 1;
    au.emit("checking-for-update");
  };
  au.downloadUpdate = async () => {
    au.downloads += 1;
    // 模拟下载过程:三帧进度 → 完成
    au.emit("download-progress", { percent: 0, transferred: 0, total: 100 });
    au.emit("download-progress", { percent: 47.6, transferred: 76, total: 160 });
    au.emit("download-progress", { percent: 100, transferred: 160, total: 160 });
    au.emit("update-downloaded", { version: "0.2.0" });
  };
  au.quitAndInstall = () => {
    au.installs += 1;
  };
  return au;
}

let failed = 0;
function check(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error(`FAIL ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

(async () => {
  // ========== 1. dev 守卫 ==========
  {
    const au = makeFakeUpdater();
    const states = [];
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: false, onChange: (s) => states.push(s) });
    await upd.init({ checkOnStart: true });
    check(upd.getState().state === "disabled", "[1a] dev 模式(isPackaged=false) → disabled");
    await upd.checkForUpdates();
    await upd.startDownload();
    upd.installUpdate();
    check(au.checks === 0 && au.downloads === 0 && au.installs === 0,
      `[1b] dev 模式检查/下载/安装均 no-op(实际 ${au.checks}/${au.downloads}/${au.installs})`);
    check(states.length === 1 && states[0].state === "disabled", "[1c] dev 模式仅广播一次 disabled");
  }

  // ========== 2. 事件映射(打包环境) ==========
  {
    const au = makeFakeUpdater();
    const states = [];
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true, onChange: (s) => states.push(s) });
    await upd.init({ checkOnStart: false });
    await upd.checkForUpdates(); // fake: only emits checking-for-update
    check(upd.getState().state === "checking", "[2a] checkForUpdates → checking");
    au.emit("update-available", { version: "0.2.0" });
    check(upd.getState().state === "available" && upd.getState().version === "0.2.0",
      `[2b] update-available → available + version(实际 ${JSON.stringify(upd.getState())})`);
    await upd.startDownload();
    check(upd.getState().state === "downloaded", "[2c] 下载完成 → downloaded");
    check(upd.getState().percent === 100, `[2c2] percent 收敛 100(实际 ${upd.getState().percent})`);
    const downloadingStates = states.filter((s) => s.state === "downloading").map((s) => s.percent);
    check(downloadingStates.join(",") === "0,48,100",
      `[2d] 下载进度事件 → downloading + 四舍五入 percent(${downloadingStates.join(",")})`);
  }

  // ========== 3. error + restartDownload ==========
  {
    const au = makeFakeUpdater();
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true });
    await upd.init({ checkOnStart: false });
    au.emit("error", new Error("网络超时"));
    check(upd.getState().state === "error" && upd.getState().error === "网络超时",
      `[3a] error → error 态 + 文案(实际 ${JSON.stringify(upd.getState())})`);
    upd.restartDownload();
    check(au.downloads === 1, `[3b] 重试 → 重新下载(downloadUpdate 再次调用,实际 ${au.downloads} 次)`);
    check(upd.getState().state === "downloaded", "[3c] 重试成功 → downloaded");
  }

  // ========== 4. installUpdate 守卫 ==========
  {
    const au = makeFakeUpdater();
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true });
    await upd.init({ checkOnStart: false });
    upd.installUpdate(); // 未下载完
    check(au.installs === 0, `[4a] 未下载完成时忽略安装(实际 ${au.installs} 次)`);
    au.emit("update-downloaded", { version: "0.2.0" });
    upd.installUpdate();
    check(au.installs === 1, `[4b] downloaded 后安装 → quitAndInstall(实际 ${au.installs} 次)`);
    check(upd.getState().state === "installing", `[4c] 安装中 → installing(实际 ${upd.getState().state})`);
  }

  // ========== 5. 广播完整性 ==========
  {
    const au = makeFakeUpdater();
    const states = [];
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true, onChange: (s) => states.push(s) });
    await upd.init({ checkOnStart: false });
    await upd.checkForUpdates();
    au.emit("update-available", { version: "0.2.0" });
    await upd.startDownload();
    const last = states[states.length - 1];
    check(last.state === "downloaded" && last.percent === 100 && last.version === "0.2.0" && last.error === null,
      `[5] 广播状态对象完整(percent/version/error),实际 ${JSON.stringify(last)}`);
  }

  if (failed) {
    console.error(`\nFAIL ✗ 应用自更新状态机回归: ${failed} 项失败`);
    process.exit(1);
  }
  console.log("\nPASS ✓ 应用自更新状态机回归通过");
})();