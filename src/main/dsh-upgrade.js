"use strict";

/**
 * dsh-upgrade.js — 应用内升级捆绑的 dsh 到指定版本。
 *
 * 流程(全链路防呆):
 *   1. 从 npm registry 取目标版本的 tarball 地址与 sha512 integrity;
 *   2. 下载 tarball 到缓存目录,校验 sha512(下载损坏/被篡改 → 中止);
 *   3. 解压到 staging 目录(系统 tar),校验解压出的 package.json 版本;
 *   4. 原子替换:当前 dsh 包目录改名 .bak 备份 → 新目录移入;
 *   5. 依赖闭包安装(方案 A3):`npm install --prefix <staging包目录>` 把 dsh 自己
 *      声明的全部依赖装进 staging 包目录内的 node_modules(嵌套自包含闭包,
 *      与 npm 最初安装 rc.6 的布局一致)。背景:App 的 node_modules 是 npm
 *      托举树,dsh 的部分依赖是嵌装的;tarball 不含 node_modules,单包替换后
 *      新包会解析到根树旧版本(commander 5.1.0 缺 addHelpText)→ 启动
 *      TypeError(已发生的事故)。先装 staging 再整体替换——替换窗口毫秒级,
 *      闭包安装期间若 App 退出/中断,线上仍是旧版本,不留坏态;
 *   6. 原子替换:旧包 → .bak 备份;staging 包(含闭包)→ 包目录;
 *   7. 安装后自检:用与真实启动完全相同的运行时(Electron 内置 Node +
 *      --expose-internals)跑一次 `dsh --version`,精确覆盖事故崩溃路径
 *      (parseDshArgs / 顶层 import);失败 → 回滚(restoreDshBackup);
 *   8. 任何一步失败自动回滚,不留下半截状态;主进程启动时还有「启动自愈」
 *      (main.js healInterruptedUpgrade):残留坏态时自动从最新备份恢复。
 *
 * 本模块只做「文件替换 + 依赖调和」,不负责停/启服务 —— 由主进程(main.js)
 * 编排(先停服务再换文件,避免运行中的 dsh 持有旧文件句柄)。
 *
 * 目标目录默认取「打进 App 的 dsh 包目录」(本项目 asar:false,
 * node_modules 是明文目录,可写);测试可用 targetDir 覆盖指向临时目录,
 * 并可注入 runReconcile / verifyBoot(回归不碰真实 npm / 不跑真实进程)。
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { getRuntimeDshInfo } = require("./dsh-version");
const npmCheck = require("./npm-check");
const { resolveNpm } = require("./toolchain");

const DOWNLOAD_TIMEOUT_MS = 60_000;
/** npm 依赖调和超时(全树重算,大仓库/慢网络可达 7 分钟以上,留足余量) */
const RECONCILE_TIMEOUT_MS = 15 * 60_000;
/** 安装后自检(dsh --version)超时 */
const VERIFY_TIMEOUT_MS = 60_000;

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

/** 清理备份与坏目录,保留最近 keep 份(P2-C3:broken 目录不再永久累积) */
function pruneBackups(parentDir, keep = 1) {
  try {
    const names = fs
      .readdirSync(parentDir)
      .filter((name) => /^\.dsh-(?:.*-bak-|broken-)\d+$/.test(name))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      fs.rmSync(path.join(parentDir, name), { recursive: true, force: true });
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 列出全部升级备份,新→旧(自愈可迭代多份;findNewestBackup 只取最新) */
function findBackups(pkgDir) {
  try {
    const parentDir = path.dirname(pkgDir);
    return fs
      .readdirSync(parentDir)
      .filter((name) => /^\.dsh-.*-bak-\d+$/.test(name))
      .sort()
      .reverse()
      .map((name) => path.join(parentDir, name));
  } catch {
    return [];
  }
}

/**
 * 依赖闭包安装(默认实现):`npm install --prefix <staging包目录>` 把 dsh 自己
 * 声明的全部依赖装进包目录内的 node_modules(嵌套闭包),与 npm 最初安装
 * rc.6 的布局一致(commander@15 等嵌装在 dsh/node_modules 里)。
 *
 * 装在 staging(而非线上包目录)的原因:闭包安装耗时数分钟且可能被中途中断
 * (App 退出等);先装进 staging、随后整体原子替换,替换窗口毫秒级,任何中断
 * 都不会留下「换上新版但闭包缺失」的坏态。
 *
 * 为什么不做「应用根目录整树 npm install」:根目录(开发=仓库、打包=Resources/app)
 * 是 npm 托举树,整树 install 会重算 App 全部依赖(数百至上千包)、耗时超长,且
 * reify 中途会临时移除/重排线上包(实测把升级卡死并留下缺包现场)。前缀安装
 * 只装 dsh 的闭包,App 其余树零改动。
 *
 * 可用 DSH_NPM_CMD 覆盖 npm 可执行文件路径(测试/特殊环境)。npm 的选用遵循
 * 需求 3 方案 B(见 toolchain.js):优先用户本地 npm(node ≥ 20),没有则回退
 * 内置运行时(bundledDir,dev=assets/runtime、打包=Resources/runtime),再没有
 * → 明确报错,升级中止并提示(原版本保持可用)。
 * @returns {Promise<{ok: boolean, error?: string, output?: string}>}
 */
async function defaultRunReconcile(version, { packageDir, log, bundledDir = null } = {}) {
  const bin = path.join(packageDir, "lib", "bin.js");
  if (!fs.existsSync(bin)) return { ok: false, error: `缺少 ${bin}(依赖闭包安装前提)` };
  const toolchain = resolveNpm({ env: process.env, bundledDir, log });
  if (!toolchain.ok) return { ok: false, error: toolchain.error };
  const { cmd, argsPrefix, envPath } = toolchain;
  const env = { ...process.env, PATH: envPath };
  log?.log?.(
    `[upgrade] 依赖闭包安装: ${cmd} install --prefix ${packageDir}(仅 dsh 自身依赖;npm 来源=${toolchain.source})`
  );
  const result = await spawnCapture(
    cmd,
    [...argsPrefix,
      "install",
      "--prefix", packageDir,
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--loglevel=error",
    ],
    { cwd: packageDir, env, timeoutMs: RECONCILE_TIMEOUT_MS }
  );
  if (!result.ok) {
    log?.warn?.(`[upgrade] 依赖闭包安装失败: ${result.error}\n${result.output}`);
    return { ok: false, error: `${result.error}${result.output ? ` — ${result.output.slice(-400).trim()}` : ""}` };
  }
  if (result.output.trim()) log?.log?.(`[upgrade] npm 输出尾部: ${result.output.slice(-300).trim()}`);
  return { ok: true };
}

/**
 * 跑一个子进程并收集输出(带超时)。
 * @returns {Promise<{ok: boolean, error?: string, output: string}>}
 */
function spawnCapture(command, args, { cwd, env = process.env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    let timedOut = false;
    const chunks = [];
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* 进程可能已退出 */
      }
    }, timeoutMs);
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      clearTimeout(timer);
      resolve({ ok: false, error: `无法启动 ${command}: ${error.message}`, output: "" });
      return;
    }
    const collect = (chunk) => {
      chunks.push(String(chunk));
      if (chunks.join("").length > 64 * 1024) {
        chunks.length = 0;
        chunks.push("[输出过长,已截断]\n");
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `无法启动 ${command}: ${error.message}`, output: chunks.join("") });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = chunks.join("").slice(-8000);
      if (timedOut) resolve({ ok: false, error: `执行超时(${timeoutMs}ms)`, output });
      else if (code !== 0) resolve({ ok: false, error: `${command} 退出码 ${code}`, output });
      else resolve({ ok: true, output });
    });
  });
}

/**
 * 安装后自检(默认实现):用与真实启动相同的运行时(Electron 内置 Node +
 * --expose-internals)跑一次 `dsh --version`,精确覆盖事故崩溃路径
 * (bin.js 顶层 import + parseDshArgs)。失败 = 这版装上去也起不来。
 * @returns {Promise<{ok: boolean, error?: string, output?: string}>}
 */
async function defaultVerifyBoot({ pkgDir, dshHome, log } = {}) {
  const bin = path.join(pkgDir, "lib", "bin.js");
  if (!fs.existsSync(bin)) return { ok: false, error: `缺少 ${bin}` };
  fs.mkdirSync(dshHome, { recursive: true });
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    DSH_TELEMETRY_DISABLED: "1",
    DSH_HOME: dshHome,
  };
  log?.log?.(`[upgrade] 安装后自检: dsh --version (${bin})`);
  const result = await spawnCapture(
    process.execPath,
    ["--expose-internals", bin, "--version"],
    { env, timeoutMs: VERIFY_TIMEOUT_MS }
  );
  if (!result.ok) {
    log?.warn?.(`[upgrade] 自检失败: ${result.error}\n${result.output}`);
    return { ok: false, error: `${result.error}${result.output ? ` — ${result.output.slice(-400).trim()}` : ""}` };
  }
  return { ok: true, output: result.output.trim() };
}

/**
 * 找最新一份 dsh 升级备份(.dsh-<版本>-bak-<时间戳>)。
 * 启动自愈与手动回滚用;不存在返回 null。
 * @param {string} pkgDir dsh 包目录(取其父目录扫描)
 * @returns {string|null}
 */
function findNewestBackup(pkgDir) {
  try {
    const parentDir = path.dirname(pkgDir);
    const backups = fs
      .readdirSync(parentDir)
      .filter((name) => /^\.dsh-.*-bak-\d+$/.test(name))
      .sort();
    return backups.length ? path.join(parentDir, backups[backups.length - 1]) : null;
  } catch {
    return null;
  }
}

/**
 * 回滚:把当前 pkgDir(可能是半截/坏目录)挪到 .dsh-broken-*,把备份改回 pkgDir。
 * @param {string} pkgDir 当前 dsh 包目录
 * @param {string} backupDir 备份目录(.dsh-<版本>-bak-<时间戳>)
 * @returns {{ok: boolean, error?: string, brokenDir?: string}}
 */
function restoreDshBackup(pkgDir, backupDir) {
  if (!pkgDir || !backupDir) return { ok: false, error: "缺少包目录/备份路径" };
  if (!fs.existsSync(backupDir)) return { ok: false, error: `备份不存在: ${backupDir}` };
  const brokenDir = path.join(path.dirname(pkgDir), `.dsh-broken-${Date.now()}`);
  try {
    if (fs.existsSync(pkgDir)) fs.renameSync(pkgDir, brokenDir);
    fs.renameSync(backupDir, pkgDir);
    return { ok: true, brokenDir };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
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
 * @param {string} [options.bundledDir] 内置 node 运行时目录(dev=assets/runtime、打包=Resources/runtime);
 *   传给默认依赖闭包实现做 npm 兜底;null = 不探测内置
 * @param {(version: string, ctx: {pkgDir: string, log: object, bundledDir: string|null}) => Promise<{ok: boolean, error?: string}>} [options.runReconcile]
 *   依赖闭包安装实现(默认:npm install --prefix 到 dsh 包目录;回归注入 fake)
 * @param {(ctx: {pkgDir: string, dshHome: string, log: object}) => Promise<{ok: boolean, error?: string}>} [options.verifyBoot]
 *   安装后自检实现(默认:Electron 内置 Node 跑 dsh --version;回归注入 fake)
 * @returns {Promise<{ ok: true, previous: string, installed: string, unchanged?: boolean, backupDir: string|null } | { ok: false, error: string }>}
 */
async function upgradeDsh(
  version,
  {
    targetDir = null,
    cacheDir = null,
    registryData = null,
    log = console,
    bundledDir = null,
    runReconcile = null,
    verifyBoot = null,
  } = {}
) {
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

  // 5. 依赖闭包安装:npm install --prefix 到 **staging 包目录**,只装 dsh 自身闭包。
  //    放在原子替换【之前】:闭包安装耗时数分钟且可能被中途中断(App 退出等),
  //    此时线上 pkgDir 仍是旧版本 —— 任何中断都不会留下「换上新版但闭包缺失」的坏态。
  const reconcileImpl = runReconcile || defaultRunReconcile;
  log.log(`[upgrade] 步骤 5:依赖闭包安装(@deepseek-ai/dsh@${version} → staging)`);
  const reconcile = await reconcileImpl(version, { packageDir: extractedPkg, log, bundledDir });
  if (!reconcile.ok) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `依赖闭包安装失败: ${reconcile.error}(目标目录未改动,原版本保持可用)` };
  }
  // 闭包装好后包版本仍是目标版本
  try {
    const check = JSON.parse(fs.readFileSync(path.join(extractedPkg, "package.json"), "utf8")).version;
    if (check !== version) throw new Error(`版本不匹配(${check})`);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `依赖闭包安装后版本校验失败: ${error.message}(目标目录未改动)` };
  }

  // 6. 原子替换:旧包 → 备份;staging 包(含闭包)→ pkgDir。窗口毫秒级。
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

  // 7. 安装后自检:与真实启动同运行时(Electron 内置 Node + --expose-internals)
  //    跑一次 dsh --version,精确覆盖事故崩溃路径;失败 → 回滚
  const verifyImpl = verifyBoot || defaultVerifyBoot;
  log.log("[upgrade] 步骤 7:安装后自检(dsh --version)");
  const probe = await verifyImpl({ pkgDir, dshHome: path.join(base, "boot-probe"), log });
  if (!probe.ok) {
    const rollback = restoreDshBackup(pkgDir, backup);
    fs.rmSync(staging, { recursive: true, force: true });
    return {
      ok: false,
      error: `安装后自检失败: ${probe.error}${rollback.ok ? "(已回滚到原版本)" : `,且回滚失败: ${rollback.error}`}`,
      installed: version,
      backupDir: backup,
    };
  }

  fs.rmSync(staging, { recursive: true, force: true });
  pruneBackups(parentDir);
  log.log(`[upgrade] 完成: ${prevVersion} → ${version}(备份: ${backup})`);
  return { ok: true, previous: prevVersion, installed: version, unchanged: false, reconciled: true, backupDir: backup };
}

module.exports = {
  upgradeDsh,
  verifyIntegrity,
  restoreDshBackup,
  verifyDshBoot: defaultVerifyBoot,
  findNewestBackup,
  findBackups,
};
