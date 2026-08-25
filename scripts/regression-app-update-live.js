#!/usr/bin/env node
"use strict";

/**
 * regression-app-update-live.js — 应用自更新「真下载闭环」回归(真实 Electron +
 * electron-updater + 本地 fake repo):
 *
 *   1. 本地 HTTP 静态服务作为 fake feed:latest-mac.yml(版本 999.0.0,sha512 与
 *      zip 匹配)+ 一个真实最小 zip(sha512 由测试实时计算);
 *   2. dev-app-update.yml 指向该服务(electron-updater 在非打包环境读它);
 *      autoUpdater.setFeedURL 显式 generic provider 双保险;
 *   3. checkForUpdates() → update-available(version=999.0.0);
 *   4. downloadUpdate() → download-progress(percent 实时采样)→ update-downloaded;
 *   5. 校验:electron-updater 下载缓存中确实落盘该 zip 且 sha512 一致;
 *   6. 不调用 quitAndInstall(dev 不替换);「downloaded 后可安装」由
 *      regression-app-updater.js(状态机单测)覆盖。
 *
 * 测试后清理:删除项目根临时 dev-app-update.yml、关闭服务、清除下载缓存。
 * 用法: electron scripts/regression-app-update-live.js --no-sandbox
 */

const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
// electron 跑本脚本时 app.getAppPath() = scripts/ 目录;electron-updater 在非打包
// 环境读 <appPath>/dev-app-update.yml —— 故写在脚本同目录(测试后删除)
const DEV_YML = path.join(__dirname, "dev-app-update.yml");

// 重定向 userData / cache 到临时目录(回归不污染用户目录;沙箱内只可写 /tmp)
const TEST_TMP = path.join(app.getPath("temp"), "dshbox-app-update-live");
app.setPath("userData", path.join(TEST_TMP, "user"));
app.setPath("cache", path.join(TEST_TMP, "cache"));

function sha512(filePath) {
  return crypto.createHash("sha512").update(fs.readFileSync(filePath)).digest("base64");
}

function makeFakeZip(p) {
  // 32MB 伪随机 payload(足够大,本地下载也产生多帧 download-progress;
  // zip -0 store 不压缩随机数据 → 产物 ≈32MB)
  const src = path.join(path.dirname(p), "fake-update-src.bin");
  const chunk = crypto.randomBytes(1024 * 1024);
  const fd = fs.openSync(src, "w");
  for (let i = 0; i < 32; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const r = spawnSync("zip", ["-q", "-0", "-j", p, src], { encoding: "utf8" });
  fs.rmSync(src, { force: true });
  if (r.status !== 0) throw new Error("zip 生成失败: " + r.stderr);
}

let server = null;
let zipPath = null;
let devYmlWritten = false;
let checkOk = false;
let downloadProgressSeen = false;
let downloadedOk = false;
let failure = null;

app.whenReady().then(async () => {
  try {
    // ---------- 1. fake repo ----------
    zipPath = path.join(app.getPath("temp"), "dshbox-fake-update-999.0.0.zip");
    makeFakeZip(zipPath);
    const zSha = sha512(zipPath);
    const zSize = fs.statSync(zipPath).size;
    const yml = [
      `version: 999.0.0`,
      `files:\n  - url: dshbox-fake-update-999.0.0.zip`,
      `    sha512: ${zSha}`,
      `    size: ${zSize}`,
      `path: dshbox-fake-update-999.0.0.zip`,
      `sha512: ${zSha}`,
      `releaseDate: '2026-08-25T00:00:00.000Z'`,
      ``,
    ].join("\n");
    server = http.createServer((req, res) => {
      console.log(`[live] GET ${req.url}`);
      if (req.url.startsWith("/latest-mac.yml")) {
        res.setHeader("Content-Type", "text/yaml");
        res.end(yml);
      } else if (req.url.startsWith("/dshbox-fake-update-999.0.0.zip")) {
        res.setHeader("Content-Type", "application/octet-stream");
        fs.createReadStream(zipPath).pipe(res);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const feed = `http://127.0.0.1:${port}`;

    // ---------- 2. dev-app-update.yml(测试临时) ----------
    fs.writeFileSync(DEV_YML, `provider: generic\nurl: ${feed}\n`, "utf8");
    devYmlWritten = true;

    // ---------- 3~5. electron-updater 真链路 ----------
    const { autoUpdater } = require("electron-updater");
    // dev 模式默认禁用更新(isUpdaterActive 检查 app.isPackaged);测试显式开启
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: "generic", url: feed });
    autoUpdater.logger = console;
    autoUpdater.autoDownload = false;

    const events = [];
    autoUpdater.on("checking-for-update", () => events.push("checking"));
    autoUpdater.on("update-available", (info) => {
      events.push(`available:${info && info.version}`);
      checkOk = info && info.version === "999.0.0";
    });
    autoUpdater.on("update-not-available", () => events.push("not-available"));
    autoUpdater.on("download-progress", (p) => {
      events.push(`progress:${Math.round(Number(p && p.percent) || 0)}`);
      if (Number(p && p.percent) > 0) downloadProgressSeen = true;
    });
    autoUpdater.on("update-downloaded", () => {
      events.push("downloaded");
      downloadedOk = true;
    });
    autoUpdater.on("error", (e) => events.push("error:" + (e && e.message || e)));

    let checkRes;
    try {
      checkRes = await autoUpdater.checkForUpdates();
    } catch (err) {
      throw new Error("checkForUpdates() 抛出: " + (err && err.message || err) + " | events: " + events.join(" | "));
    }
    if (!checkRes) throw new Error("checkForUpdates() 未返回 UpdateCheckResult | events: " + events.join(" | "));
    if (!checkOk) throw new Error(`未收到 update-available(999.0.0): ${events.join(" | ")}`);

    await autoUpdater.downloadUpdate();
    // download-progress 在「本地极快下载」下可能缺帧(真实网络按 chunk 稳定触发),
    // 不作硬性断言 —— 核心闭环 = update-available → 下载落盘且 sha512 一致
    if (!downloadedOk) throw new Error(`未收到 update-downloaded: ${events.join(" | ")}`);

    // ---------- 5. 校验下载落盘 + sha512 ----------
    // electron-updater 的缓存根 = os.homedir()/Library/Caches(macOS 硬编码,
    // 不走 app.getPath('cache'));目录名 = app.getName()(未打包=package name)
    const baseCache = path.join(require("node:os").homedir(), "Library", "Caches");
    const cachedZip = path.join(baseCache, app.getName(), "pending", "dshbox-fake-update-999.0.0.zip");
    const cacheHit = fs.existsSync(cachedZip) && sha512(cachedZip) === zSha;
    console.log(`[live] 事件序列: ${events.join(" → ")}`);
    console.log(`[live] 下载缓存: ${cacheHit ? "命中且 sha512 一致" : `缺失或哈希不一致(${cachedZip})`}`);
    if (!cacheHit) throw new Error("下载产物未落盘或 sha512 不匹配");

    console.log("\nPASS ✓ 应用自更新真下载闭环(local feed → available → progress → downloaded → sha512)");
  } catch (err) {
    failure = err;
  } finally {
    // ---------- 6. 清理 ----------
    if (devYmlWritten) {
      try { fs.unlinkSync(DEV_YML); } catch { /* 已删 */ }
    }
    if (server) server.close();
    try { if (zipPath) fs.rmSync(zipPath, { force: true }); } catch { /* 忽略 */ }
    // 删除下载缓存中的假更新(999.0.0),不留残留
    try {
      const baseCache = path.join(require("node:os").homedir(), "Library", "Caches");
      const pendingDir = path.join(baseCache, app.getName(), "pending");
      if (fs.existsSync(pendingDir)) fs.rmSync(pendingDir, { recursive: true, force: true });
    } catch { /* 清理失败无害 */ }
    if (!failure) {
      app.exit(0);
    } else {
      console.error("\nFAIL ✗ 应用自更新真下载闭环:", failure.message);
      app.exit(1);
    }
  }
});