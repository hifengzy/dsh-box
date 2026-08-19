#!/usr/bin/env node
"use strict";

/**
 * regression-upgrade.js — 应用内升级全链路回归(真实 Electron 主进程,不碰真实网络):
 *   本地起一个 HTTP 服务器扮演 npm registry(DSH_NPM_REGISTRY 指向它):
 *     - GET /@deepseek-ai/dsh → 版本 JSON(dist-tags / time / versions,
 *       含 tarball 地址与 sha512 integrity);
 *     - GET /dsh-<version>.tgz → 真实 tarball(测试现场用系统 tar 打包)。
 *   用例:
 *     1. 版本比较与排序:npm-check 解析本地 registry,hasUpdate/倒序正确;
 *     2. 正常升级:临时目录里的 dsh 0.1.0-rc.6 → 0.2.0,备份目录存在,
 *        新包可读、版本正确;
 *     3. 同版本升级:返回 unchanged,不动文件;
 *     4. integrity 不匹配:升级被拒(sha512 校验失败),目标目录原封不动,
 *        不产生多余备份/半截状态;
 *     5. 不存在的版本:升级被拒。
 *
 * 用法: electron scripts/regression-upgrade.js --no-sandbox
 */

const { app } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

// 在主进程里直接驱动业务模块(不走 IPC,更快更直接)
const npmCheck = require("../src/main/npm-check");
const { upgradeDsh } = require("../src/main/dsh-upgrade");

app.setPath("userData", path.resolve(__dirname, "..", ".runtime", "regression", "upgrade-user"));

/** sha512-<base64> integrity,与 npm registry 格式一致 */
function integrityOf(buffer) {
  return `sha512-${crypto.createHash("sha512").update(buffer).digest("base64")}`;
}

function makeFixturePackage(dir, version, marker) {
  const pkgDir = path.join(dir, "node_modules", "@deepseek-ai", "dsh");
  fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version }, null, 2)
  );
  fs.writeFileSync(path.join(pkgDir, "lib", "bin.js"), `// fixture dsh v${version}\n${marker}\n`);
  return pkgDir;
}

app.whenReady().then(async () => {
  const work = path.resolve(__dirname, "..", ".runtime", "regression", "upgrade-work");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  try {
    // ---------- 准备 fixture:0.2.0 的真 tarball ----------
    const pkgSrc = path.join(work, "pkg-src", "package");
    fs.mkdirSync(path.join(pkgSrc, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgSrc, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.0" }, null, 2)
    );
    fs.writeFileSync(path.join(pkgSrc, "lib", "bin.js"), "// fixture dsh v0.2.0\n");
    const tgzPath = path.join(work, "dsh-0.2.0.tgz");
    const tar = spawnSync("tar", ["-czf", tgzPath, "-C", path.join(work, "pkg-src"), "package"], {
      encoding: "utf8",
    });
    if (tar.status !== 0) throw new Error(`tar 打包 fixture 失败: ${tar.stderr}`);
    const tgzBuffer = fs.readFileSync(tgzPath);

    // ---------- 本地 registry 服务器 ----------
    let registryPort = null;
    const server = http.createServer((req, res) => {
      if (req.url === "/@deepseek-ai/dsh") {
        const base = `http://127.0.0.1:${registryPort}`;
        const payload = {
          "dist-tags": { latest: "0.2.0" },
          time: {
            "0.1.0-rc.6": "2026-07-20T00:00:00.000Z",
            "0.2.0": "2026-08-20T00:00:00.000Z",
            "0.3.0-bad": "2026-08-19T00:00:00.000Z",
          },
          versions: {
            "0.1.0-rc.6": {
              dist: { tarball: `${base}/dsh-0.1.0-rc.6.tgz`, integrity: integrityOf(tgzBuffer) },
            },
            "0.2.0": { dist: { tarball: `${base}/dsh-0.2.0.tgz`, integrity: integrityOf(tgzBuffer) } },
            // 故意给错的 integrity:用它验证「校验失败即拒绝」
            "0.3.0-bad": { dist: { tarball: `${base}/dsh-0.2.0.tgz`, integrity: "sha512-dGVybmFvdG1NjYWRUlxZEx0TQyL1C8Fl5l2ci9OOUTy5B4uHaZk5UQQgAq0I9q0F9U4ogHqGBKyVWT2v4n9yg==" } },
          },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      if (req.url === "/dsh-0.2.0.tgz") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(tgzBuffer);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    registryPort = server.address().port;
    process.env.DSH_NPM_REGISTRY = `http://127.0.0.1:${registryPort}`;
    console.log(`[fixture] 本地 registry: ${process.env.DSH_NPM_REGISTRY}`);

    const cacheDir = path.join(work, "cache");
    npmCheck.init(cacheDir);

    // ---------- 用例 1:版本比较与排序 ----------
    const { data } = await npmCheck.checkOnce();
    if (data.distTags.latest !== "0.2.0") throw new Error("dist-tags.latest 解析错误");
    const deco = npmCheck.decorate(data, "0.1.0-rc.6");
    if (!deco.hasUpdate) throw new Error("0.2.0 相对 0.1.0-rc.6 应判定为有更新");
    if (deco.rows[0].version !== "0.2.0") throw new Error(`应按发布时间倒序,实际首位 ${deco.rows[0].version}`);
    const cur = deco.rows.find((r) => r.version === "0.1.0-rc.6");
    if (!cur || !cur.isCurrent) throw new Error("当前版本行应标 isCurrent");
    if (!deco.rows.find((r) => r.version === "0.2.0").hasUpdate) throw new Error("比当前新的行应 hasUpdate");
    console.log("[1] npm-check:latest/倒序/徽标/有更新判定 ✓");

    // ---------- 用例 2:正常升级 ----------
    const targetDir = makeFixturePackage(work, "0.1.0-rc.6", "marker-old");
    const r2 = await upgradeDsh("0.2.0", { targetDir, cacheDir, registryData: data });
    if (!r2.ok) throw new Error(`升级 0.2.0 失败: ${r2.error}`);
    if (r2.previous !== "0.1.0-rc.6" || r2.installed !== "0.2.0")
      throw new Error(`升级结果错误: ${JSON.stringify(r2)}`);
    const installed = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf8"));
    if (installed.version !== "0.2.0") throw new Error(`升级后包版本错误: ${installed.version}`);
    if (!fs.readFileSync(path.join(targetDir, "lib", "bin.js"), "utf8").includes("v0.2.0"))
      throw new Error("升级后的文件内容不对");
    const backups = fs.readdirSync(path.dirname(targetDir)).filter((n) => /^\.dsh-.*-bak-\d+$/.test(n));
    if (!backups.length) throw new Error("升级后应有备份目录");
    console.log(`[2] 正常升级 0.1.0-rc.6 → 0.2.0,备份 ${backups[0]} ✓`);

    // ---------- 用例 3:同版本升级 → unchanged ----------
    const r3 = await upgradeDsh("0.2.0", { targetDir, cacheDir, registryData: data });
    if (!r3.ok || !r3.unchanged) throw new Error(`同版本升级应返回 unchanged: ${JSON.stringify(r3)}`);
    console.log("[3] 同版本升级 → unchanged ✓");

    // ---------- 用例 4:integrity 不匹配 → 拒绝且不破坏现状 ----------
    const beforeBackups = fs.readdirSync(path.dirname(targetDir)).filter((n) => /^\.dsh-.*-bak-\d+$/.test(n)).length;
    const r4 = await upgradeDsh("0.3.0-bad", { targetDir, cacheDir, registryData: data });
    if (r4.ok) throw new Error(`integrity 错误应拒绝升级,实际成功: ${JSON.stringify(r4)}`);
    if (!r4.error.includes("sha512")) throw new Error(`拒绝原因应为 sha512 校验失败: ${r4.error}`);
    const after = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf8"));
    if (after.version !== "0.2.0") throw new Error(`校验失败后目标目录不应变化,实际 ${after.version}`);
    const afterBackups = fs.readdirSync(path.dirname(targetDir)).filter((n) => /^\.dsh-.*-bak-\d+$/.test(n)).length;
    if (afterBackups !== beforeBackups) throw new Error("校验失败不应产生新备份");
    console.log("[4] integrity 不匹配 → sha512 拒绝,目录原封不动 ✓");

    // ---------- 用例 5:不存在的版本 ----------
    const r5 = await upgradeDsh("9.9.9", { targetDir, cacheDir, registryData: data });
    if (r5.ok) throw new Error("不存在的版本应被拒绝");
    console.log("[5] 不存在的版本 → 拒绝 ✓");

    server.close();
    console.log("\nPASS ✓ 升级链路回归通过");
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 升级链路回归:", err.message);
    app.exit(1);
  }
});