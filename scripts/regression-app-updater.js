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
    // 失败开关:模拟下载阶段失败(网络/撤版)
    if (au.failDownloads) {
      au.emit("error", new Error(au.failMessage || "网络超时"));
      return;
    }
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
    // electron-updater 默认 autoDownload=true(发现新版本即自动下载);必须被关闭,
    // 否则「没等点『新版本』就自动下载」(用户实报 bug)
    check(au.autoDownload === false, "[2a1] init 后 autoDownload 已被关闭(=false)");
    await upd.checkForUpdates(); // fake: only emits checking-for-update
    check(upd.getState().state === "checking", "[2a] checkForUpdates → checking");
    au.emit("update-available", { version: "0.2.0" });
    check(upd.getState().state === "available" && upd.getState().version === "0.2.0",
      `[2b] update-available → available + version(实际 ${JSON.stringify(upd.getState())})`);
    await upd.startDownload();
    // 点击即反馈:startDownload 必须先广播「下载中 0%」(不等 electron-updater
    // 首个 progress 事件),顶栏才不会有「点了没反应」的空窗
    const firstDownloading = states.find((s) => s.state === "downloading");
    check(firstDownloading && firstDownloading.percent === 0,
      `[2c0] startDownload 立即广播 downloading 0%(点击即反馈,实际 ${JSON.stringify(firstDownloading)})`);
    check(upd.getState().state === "downloaded", "[2c] 下载完成 → downloaded");
    check(upd.getState().percent === 100, `[2c2] percent 收敛 100(实际 ${upd.getState().percent})`);
    const downloadingStates = states.filter((s) => s.state === "downloading").map((s) => s.percent);
    check(downloadingStates.join(",") === "0,0,48,100",
      `[2d] 下载进度事件 → 点击即 0 + 事件 0/48/100(${downloadingStates.join(",")})`);
  }

  // ========== 2.5. 手动检查 notify:已是最新→回调;失败→回调 error;有新版不回调 ==========
  {
    const au = makeFakeUpdater();
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true });
    await upd.init({ checkOnStart: false });
    let notified = null;
    const p = upd.checkForUpdates({ notify: (o) => { notified = o; } }); // 手动检查(菜单)
    au.emit("update-not-available");
    await p;
    check(notified === "up-to-date",
      `[2e1] 手动检查已是最新 → notify("up-to-date")(实际 ${JSON.stringify(notified)})`);
    check(upd.getState().state === "up-to-date", "[2e2] 手动检查已是最新 → 状态 up-to-date");
  }
  {
    const au = makeFakeUpdater();
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true });
    await upd.init({ checkOnStart: false });
    let notified = null;
    const p = upd.checkForUpdates({ notify: (o) => { notified = o; } });
    au.emit("error", new Error("feed 404"));
    await p;
    check(notified && notified.error === "feed 404",
      `[2e3] 手动检查失败 → notify({error})(实际 ${JSON.stringify(notified)})`);
  }
  {
    const au = makeFakeUpdater();
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true });
    await upd.init({ checkOnStart: false });
    let notified = false;
    const p = upd.checkForUpdates({ notify: () => { notified = true; } });
    au.emit("update-available", { version: "0.2.0" }); // 有新版:顶栏按钮即反馈,不弹窗
    await p;
    check(!notified, `[2e4] 手动检查发现新版本 → 不回调 notify(实际 ${notified})`);
  }
  {
    const au = makeFakeUpdater();
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true });
    await upd.init({ checkOnStart: false });
    let notified = false;
    const p = upd.checkForUpdates({ notify: () => { notified = true; } });
    await p; // fake checkForUpdates 同步 resolve、不发任何终态事件
    check(!notified, `[2e5] 无终态事件 → 暂不回调(等待真实结果,防误弹窗)`);
  }

  // ========== 2.6. 幽灵版本防线(P2-C2):撤版后重试不再死磕下载 ==========
  {
    const au = makeFakeUpdater();
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true });
    await upd.init({ checkOnStart: false });
    au.emit("update-available", { version: "0.2.0" });
    await upd.startDownload();
    check(upd.getState().state === "downloaded", "[2f0] 正常下载完成 → downloaded");
    au.emit("update-not-available");
    check(
      upd.getState().state === "up-to-date" && upd.getState().version === null,
      `[2f1] 已是最新 → version 被清空(实际 ${JSON.stringify(upd.getState())})`
    );
  }
  {
    // 下载失败 1 次 → retry 仍重下;连续 2 次失败 → 降级为重新检查
    const au = makeFakeUpdater();
    au.failDownloads = true;
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true });
    await upd.init({ checkOnStart: false });
    au.emit("update-available", { version: "0.2.0" });
    await upd.startDownload(); // 失败#1(error, version 保留 0.2.0)
    check(upd.getState().state === "error" && upd.getState().version === "0.2.0", "[2f2] 下载失败#1 → error 且保留 version");
    upd.retry(); // restartDownload → 失败#2
    await new Promise((r) => setTimeout(r, 10));
    check(au.downloads === 2, `[2f3] 第 1 次重试仍走重下(downloads=2,实际 ${au.downloads})`);
    check(upd.getState().state === "error", "[2f4] 下载失败#2 → error");
    upd.retry(); // 连续失败 ≥2 → 降级 checkForUpdates
    await new Promise((r) => setTimeout(r, 10));
    check(au.checks === 1, `[2f5] 连续 2 次下载失败 → 重试降级为重新检查(checks=1,实际 ${au.checks})`);
    check(au.downloads === 2, `[2f6] 降级后不再重下(downloads 保持 2,实际 ${au.downloads})`);
  }
  {
    // 404(版本被撤回/资产消失)→ 主动清 version → 重试直接重新检查
    const au = makeFakeUpdater();
    au.failDownloads = true;
    au.failMessage = "404 Not Found: No latest release";
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true });
    await upd.init({ checkOnStart: false });
    au.emit("update-available", { version: "0.2.0" });
    await upd.startDownload();
    check(upd.getState().state === "error" && upd.getState().version === null,
      `[2f7] 404 类下载错误 → version 主动清空(实际 ${JSON.stringify(upd.getState())})`);
    upd.retry();
    await new Promise((r) => setTimeout(r, 10));
    check(au.checks === 1 && au.downloads === 1, `[2f8] 404 后重试走重新检查(checks=1 downloads=1,实际 ${au.checks}/${au.downloads})`);
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

  // ========== 3.5. retry 分流:检查失败(无版本)→ 重新检查;下载失败(有版本)→ 重新下载 ==========
  {
    const au = makeFakeUpdater();
    const upd = createAppUpdater({ autoUpdater: au, isPackaged: true });
    await upd.init({ checkOnStart: false });
    au.emit("error", new Error("feed 404")); // 检查阶段失败,version 仍为 null
    check(upd.getState().state === "error" && upd.getState().version === null,
      `[3d] 检查失败 → error 且无版本(实际 ${JSON.stringify(upd.getState())})`);
    upd.retry();
    check(au.checks === 1, `[3e] 检查失败重试 → 重新检查(checkForUpdates,实际 ${au.checks} 次)`);
    // 下载失败场景:先 available(有版本)再 error → retry 应重新下载
    au.emit("update-available", { version: "0.2.0" });
    au.emit("error", new Error("网络超时"));
    upd.retry();
    check(au.downloads === 1, `[3f] 下载失败重试 → 重新下载(downloadUpdate,实际 ${au.downloads} 次)`);
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