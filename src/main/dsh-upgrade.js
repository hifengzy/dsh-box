"use strict";

/**
 * dsh-upgrade.js — 应用内升级捆绑的 dsh 到指定版本。
 *
 * 流程(全链路防呆):
 *   1. 从 npm registry 取目标版本的 tarball 地址与 sha512 integrity;
 *   2. 下载 tarball 到缓存目录,校验 sha512(下载损坏/被篡改 → 中止);
 *   3. 解压到 staging 目录(系统 tar),校验解压出的 package.json 版本;
 *   4. 原子替换:当前 dsh 包目录改名 .bak 备份 → 新目录移入;
 *   5. 任何一步失败自动回滚,不留下半截状态;成功后保留最近一份备份。
 *
 * 本模块只做「文件替换」,不负责停/启服务 —— 由主进程(main.js)编排
 * (先停服务再换文件,避免运行中的 dsh 持有旧文件句柄)。
 *
 * 目标目录默认取「打进 App 的 dsh 包目录」(本项目 asar:false,
 * node_modules 是明文目录,可写);测试可用 targetDir 覆盖指向临时目录。
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getRuntimeDshInfo } = require("./dsh-version");
const npmCheck = require("./npm-check");

const DOWNLOAD_TIMEOUT_MS = 60_000;

/** 校验 npm 的 sha512-<base64> integrity */
function verifyIntegrity(buffer, integrity) {
  if (!integrity) return true; // registry 未提供 integrity 时不强制
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!m) return false;
  const actual = crypto.createHash("sha512").update(buffer).digest("base64");
  return actual === m[1];
}

async function downloadTarball(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`下载失败 (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** 清理旧备份,保留最近一份(手动回滚用) */
function pruneBackups(parentDir) {
  try {
    const backups = fs
      .readdirSync(parentDir)
      .filter((name) => /^\.dsh-.*-bak-\d+$/.test(name))
      .sort();
    for (const name of backups.slice(0, Math.max(0, backups.length - 1))) {
      fs.rmSync(path.join(parentDir, name), { recursive: true, force: true });
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/**
 * 升级捆绑的 dsh 到指定版本。
 * @param {string} version 目标版本号
 * @param {object} [options]
 * @param {string} [options.targetDir] 覆盖目标包目录(测试用);默认取运行时 dsh 包目录
 * @param {string} [options.cacheDir] 下载/解压缓存目录;默认 userData/cache
 * @param {object} [options.registryData] 已获取的 registry 数据(避免重复拉取);缺省自动拉
 * @param {object} [options.log] 日志对象(默认 console)
 * @returns {Promise<{ ok: true, previous: string, installed: string, unchanged?: boolean, backupDir: string|null } | { ok: false, error: string }>}
 */
async function upgradeDsh(version, { targetDir = null, cacheDir = null, registryData = null, log = console } = {}) {
  // 1. registry 数据(目标版本的 tarball + integrity)
  let data = registryData;
  if (!data) {
    try {
      data = (await npmCheck.checkOnce()).data;
    } catch (error) {
      return { ok: false, error: `无法获取 npm 版本信息: ${error.message}` };
    }
  }
  const entry = data.list.find((r) => r.version === version);
  if (!entry || !entry.tarball) {
    return { ok: false, error: `registry 中没有版本 ${version} 的下载地址` };
  }

  // 2. 目标目录与当前版本
  const info = getRuntimeDshInfo();
  const pkgDir = targetDir || info.packageDir;
  if (!pkgDir) return { ok: false, error: "找不到当前 dsh 包目录,无法升级" };
  let prevVersion = null;
  try {
    prevVersion = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version ?? null;
  } catch {
    return { ok: false, error: `目标目录不是有效的 dsh 包: ${pkgDir}` };
  }
  if (prevVersion === version) {
    return { ok: true, previous: prevVersion, installed: version, unchanged: true, backupDir: null };
  }

  // 3. 下载 + sha512 校验
  const base = cacheDir || npmCheck.cachePath() || path.dirname(path.dirname(pkgDir));
  fs.mkdirSync(base, { recursive: true });
  const tgzPath = path.join(base, `dsh-${version}.tgz`);
  log.log(`[upgrade] 下载 ${version}: ${entry.tarball}`);
  let tarball;
  try {
    tarball = await downloadTarball(entry.tarball);
  } catch (error) {
    return { ok: false, error: `下载失败: ${error.message}` };
  }
  if (!verifyIntegrity(tarball, entry.integrity)) {
    return { ok: false, error: "sha512 校验失败,已中止(下载可能损坏或被篡改)" };
  }
  fs.writeFileSync(tgzPath, tarball);

  // 4. 解压 + 校验包内容
  const staging = path.join(base, `dsh-staging-${version}-${Date.now()}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", tgzPath, "-C", staging], { encoding: "utf8" });
  if (tar.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `解压失败: ${(tar.stderr || "").trim() || "tar 异常"}` };
  }
  const extractedPkg = path.join(staging, "package");
  let installedVersion = null;
  try {
    installedVersion = JSON.parse(fs.readFileSync(path.join(extractedPkg, "package.json"), "utf8")).version ?? null;
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: "解压结果不是有效的 npm 包(package.json 缺失)" };
  }
  if (installedVersion !== version) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `解压出的版本 ${installedVersion} 与目标 ${version} 不一致` };
  }

  // 5. 原子替换(失败自动回滚)
  const parentDir = path.dirname(pkgDir);
  const backup = path.join(parentDir, `.dsh-${prevVersion}-bak-${Date.now()}`);
  try {
    fs.renameSync(pkgDir, backup);
    fs.renameSync(extractedPkg, pkgDir);
  } catch (error) {
    // 回滚:目标位置若有半截目录先清掉,再把备份改回
    try {
      if (fs.existsSync(pkgDir) && !fs.existsSync(path.join(pkgDir, "package.json"))) {
        fs.rmSync(pkgDir, { recursive: true, force: true });
      }
      if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
        fs.renameSync(backup, pkgDir);
      }
    } catch {
      /* 回滚失败时保留 .bak 目录,不丢数据 */
    }
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `替换失败: ${error.message}(已回滚)` };
  }

  // 6. 安装后校验:新目录必须可读且版本正确,否则回滚
  try {
    const check = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
    if (check !== version) throw new Error(`版本不匹配(${check})`);
  } catch (error) {
    try {
      const broken = path.join(parentDir, `.dsh-broken-${Date.now()}`);
      fs.renameSync(pkgDir, broken);
      fs.renameSync(backup, pkgDir);
    } catch {
      /* 保留现场 */
    }
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `安装后校验失败: ${error.message}(已回滚)` };
  }

  fs.rmSync(staging, { recursive: true, force: true });
  pruneBackups(parentDir);
  log.log(`[upgrade] 完成: ${prevVersion} → ${version}(备份: ${backup})`);
  return { ok: true, previous: prevVersion, installed: version, unchanged: false, backupDir: backup };
}

module.exports = { upgradeDsh, verifyIntegrity };
