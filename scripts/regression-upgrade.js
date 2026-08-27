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
 *     5. 不存在的版本:升级被拒;
 *     6. 依赖闭包安装失败(替换前中止):目标目录原封不动、无新备份;(闭包
 *        安装/自检注入 fake,回归不碰真实 npm)
 *     9. 启动自愈部件:verifyDshBoot 坏态失败 → findNewestBackup → 恢复 → 通过
 *     7. 安装后自检失败(dsh --version 崩溃路径):升级被拒并自动回滚;
 *     8. restoreDshBackup 单元:坏目录挪走 + 备份回位 + 现场保留;缺备份拒绝。
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
const { upgradeDsh, restoreDshBackup, verifyDshBoot, findNewestBackup, findBackups } = require("../src/main/dsh-upgrade");

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

    // ---------- 用例 2:正常升级(依赖闭包安装 + 自检注入 fake) ----------
    const targetDir = makeFixturePackage(work, "0.1.0-rc.6", "marker-old");
    const r2 = await upgradeDsh("0.2.0", {
      targetDir,
      cacheDir,
      registryData: data,
      runReconcile: async () => ({ ok: true }),
      verifyBoot: async () => ({ ok: true }),
    });
    if (!r2.ok) throw new Error(`升级 0.2.0 失败: ${r2.error}`);
    if (r2.previous !== "0.1.0-rc.6" || r2.installed !== "0.2.0")
      throw new Error(`升级结果错误: ${JSON.stringify(r2)}`);
    if (r2.reconciled !== true) throw new Error(`升级应标记依赖闭包已安装: ${JSON.stringify(r2)}`);
    const installed = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf8"));
    if (installed.version !== "0.2.0") throw new Error(`升级后包版本错误: ${installed.version}`);
    if (!fs.readFileSync(path.join(targetDir, "lib", "bin.js"), "utf8").includes("v0.2.0"))
      throw new Error("升级后的文件内容不对");
    const backups = fs.readdirSync(path.dirname(targetDir)).filter((n) => /^\.dsh-.*-bak-\d+$/.test(n));
    if (!backups.length) throw new Error("升级后应有备份目录");
    console.log(`[2] 正常升级 0.1.0-rc.6 → 0.2.0(依赖闭包安装),备份 ${backups[0]} ✓`);

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

    // ---------- 用例 6:依赖闭包安装失败(替换前)→ 目标目录原封不动 ----------
    const targetDir6 = makeFixturePackage(work, "0.1.0-rc.6", "marker-reconcile-fail");
    const bakBefore6 = fs
      .readdirSync(path.dirname(targetDir6))
      .filter((n) => /^\.dsh-.*-bak-\d+$/.test(n)).length;
    const r6 = await upgradeDsh("0.2.0", {
      targetDir: targetDir6,
      cacheDir,
      registryData: data,
      runReconcile: async () => ({ ok: false, error: "模拟 npm 离线失败" }),
      verifyBoot: async () => ({ ok: true }),
    });
    if (r6.ok) throw new Error(`依赖闭包安装失败应拒绝升级,实际成功: ${JSON.stringify(r6)}`);
    if (!r6.error.includes("依赖闭包安装失败")) throw new Error(`错误应说明闭包安装失败: ${r6.error}`);
    if (!r6.error.includes("目标目录未改动")) throw new Error(`应说明目标目录未改动: ${r6.error}`);
    const ver6 = JSON.parse(fs.readFileSync(path.join(targetDir6, "package.json"), "utf8")).version;
    if (ver6 !== "0.1.0-rc.6") throw new Error(`目标目录应保持 0.1.0-rc.6,实际 ${ver6}`);
    if (!fs.readFileSync(path.join(targetDir6, "lib", "bin.js"), "utf8").includes("marker-reconcile-fail"))
      throw new Error("目标目录文件内容应保持旧版");
    const bakAfter6 = fs
      .readdirSync(path.dirname(targetDir6))
      .filter((n) => /^\.dsh-.*-bak-\d+$/.test(n)).length;
    if (bakAfter6 !== bakBefore6) throw new Error(`闭包失败不应产生新备份(${bakBefore6}→${bakAfter6})`);
    console.log("[6] 依赖闭包安装失败(替换前)→ 目标目录原封不动、无新备份 ✓");

    // ---------- 用例 7:安装后自检失败 → 自动回滚 ----------
    const targetDir7 = makeFixturePackage(work, "0.1.0-rc.6", "marker-verify-fail");
    const r7 = await upgradeDsh("0.2.0", {
      targetDir: targetDir7,
      cacheDir,
      registryData: data,
      runReconcile: async () => ({ ok: true }),
      verifyBoot: async () => ({ ok: false, error: "模拟自检崩溃(.addHelpText is not a function)" }),
    });
    if (r7.ok) throw new Error(`自检失败应拒绝升级,实际成功: ${JSON.stringify(r7)}`);
    if (!r7.error.includes("安装后自检失败")) throw new Error(`错误应说明自检失败: ${r7.error}`);
    if (!r7.error.includes("已回滚")) throw new Error(`应提示已回滚: ${r7.error}`);
    const ver7 = JSON.parse(fs.readFileSync(path.join(targetDir7, "package.json"), "utf8")).version;
    if (ver7 !== "0.1.0-rc.6") throw new Error(`回滚后应回到 0.1.0-rc.6,实际 ${ver7}`);
    console.log("[7] 安装后自检失败 → 自动回滚到旧版本 ✓");

    // ---------- 用例 8:restoreDshBackup 单元 ----------
    const unitDir = path.join(work, "unit");
    fs.mkdirSync(path.join(unitDir, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(unitDir, "pkg", "package.json"), JSON.stringify({ version: "bad" }));
    fs.mkdirSync(path.join(unitDir, "bak"), { recursive: true });
    fs.writeFileSync(path.join(unitDir, "bak", "package.json"), JSON.stringify({ version: "good" }));
    const rb = restoreDshBackup(path.join(unitDir, "pkg"), path.join(unitDir, "bak"));
    if (!rb.ok) throw new Error(`restoreDshBackup 应成功: ${JSON.stringify(rb)}`);
    const restored = JSON.parse(fs.readFileSync(path.join(unitDir, "pkg", "package.json"), "utf8")).version;
    if (restored !== "good") throw new Error(`回滚后应为 good,实际 ${restored}`);
    if (!fs.existsSync(rb.brokenDir)) throw new Error("坏目录应保留为 .dsh-broken 现场");
    const rbMiss = restoreDshBackup(path.join(unitDir, "pkg"), path.join(unitDir, "no-such-bak"));
    if (rbMiss.ok) throw new Error("缺备份应拒绝回滚");
    console.log("[8] restoreDshBackup:坏目录挪走 + 备份回位 + 现场保留;缺备份拒绝 ✓");

    // ---------- 用例 9:启动自愈部件(verifyDshBoot / findNewestBackup / restoreDshBackup) ----------
    const healDir = path.join(work, "heal");
    const pkgDir9 = path.join(healDir, "node_modules", "@deepseek-ai", "dsh");
    fs.mkdirSync(path.join(pkgDir9, "lib"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir9, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "bad" }));
    fs.writeFileSync(path.join(pkgDir9, "lib", "bin.js"), "process.exit(1);\n"); // 坏 dsh:自检必败
    const bakDir9 = path.join(healDir, "node_modules", "@deepseek-ai", ".dsh-0.1.0-rc.6-bak-123");
    fs.mkdirSync(path.join(bakDir9, "lib"), { recursive: true });
    fs.writeFileSync(path.join(bakDir9, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0-rc.6" }));
    fs.writeFileSync(path.join(bakDir9, "lib", "bin.js"), "process.exit(0);\n"); // 好 dsh:自检通过
    const healHome = path.join(work, "heal-home");
    const probeBad = await verifyDshBoot({ pkgDir: pkgDir9, dshHome: healHome });
    if (probeBad.ok) throw new Error("坏 dsh 自检应失败");
    const nb9 = findNewestBackup(pkgDir9);
    if (!nb9 || !nb9.endsWith(".dsh-0.1.0-rc.6-bak-123")) throw new Error(`应找到最新备份,实际 ${nb9}`);
    const rh9 = restoreDshBackup(pkgDir9, nb9);
    if (!rh9.ok) throw new Error(`自愈恢复失败: ${JSON.stringify(rh9)}`);
    const healedVer = JSON.parse(fs.readFileSync(path.join(pkgDir9, "package.json"), "utf8")).version;
    if (healedVer !== "0.1.0-rc.6") throw new Error(`自愈后应为 0.1.0-rc.6,实际 ${healedVer}`);
    const probeGood = await verifyDshBoot({ pkgDir: pkgDir9, dshHome: healHome });
    if (!probeGood.ok) throw new Error(`自愈后自检应通过: ${probeGood.error}`);
    console.log("[9] 启动自愈部件:坏态自检失败 → findNewestBackup → 恢复 → 自检通过 ✓");

    // ---------- 用例 10:自愈「恢复编排」(P0/P1-3):pkgDir 缺失 + 多备份迭代 ----------
    // 覆盖 healInterruptedUpgrade 的编排顺序:包目录缺失(双 rename 窗口被
    // kill -9)→ findBackups(新→旧)→ 逐份 restoreDshBackup + 冒烟,最新
    // 一份失败则迭代更早备份。main.js 的接线由 check-main-integrity 的
    // 「调用点」正则守护(曾因只匹配标识符导致死代码漏网)。
    {
      const healOrchDir = path.join(work, "heal-orch");
      const pkgDir10 = path.join(healOrchDir, "node_modules", "@deepseek-ai", "dsh");
      // 最新备份(bad):恢复后冒烟必败 → 应迭代到更早的好备份
      const bakNew = path.join(healOrchDir, "node_modules", "@deepseek-ai", ".dsh-0.1.0-rc.6-bak-200");
      fs.mkdirSync(path.join(bakNew, "lib"), { recursive: true });
      fs.writeFileSync(path.join(bakNew, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "bad" }));
      fs.writeFileSync(path.join(bakNew, "lib", "bin.js"), "process.exit(1);\n");
      // 更早备份(good):应最终恢复这个
      const bakOld = path.join(healOrchDir, "node_modules", "@deepseek-ai", ".dsh-0.1.0-rc.6-bak-100");
      fs.mkdirSync(path.join(bakOld, "lib"), { recursive: true });
      fs.writeFileSync(path.join(bakOld, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0-rc.6" }));
      fs.writeFileSync(path.join(bakOld, "lib", "bin.js"), "process.exit(0);\n");
      // pkgDir 缺失(模拟 kill -9 落在双 rename 窗口)
      const healHome10 = path.join(work, "heal-orch-home");
      const restored = { ok: false };
      for (const backup of findBackups(pkgDir10)) {
        const rb = restoreDshBackup(pkgDir10, backup);
        if (!rb.ok) continue;
        const probe = await verifyDshBoot({ pkgDir: pkgDir10, dshHome: healHome10 });
        if (probe.ok) {
          restored.ok = true;
          restored.version = JSON.parse(fs.readFileSync(path.join(pkgDir10, "package.json"), "utf8")).version;
          break;
        }
      }
      if (!restored.ok) throw new Error("pkgDir 缺失 + 最新备份坏 → 应迭代到更早备份恢复成功");
      if (restored.version !== "0.1.0-rc.6") throw new Error(`应恢复为 0.1.0-rc.6,实际 ${restored.version}`);
      console.log("[10] 自愈编排:pkgDir 缺失 → findBackups 迭代(最新坏→更早好)→ 恢复成功 ✓");
    }

    server.close();
    console.log("\nPASS ✓ 升级链路回归通过");
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 升级链路回归:", err.message);
    app.exit(1);
  }
});