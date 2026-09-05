"use strict";

/**
 * toolchain.js — 升级/装插件的 npm / pnpm 工具链解析(需求 3,已拍板方案 B)。
 *
 * 背景:DSH Box 的 dsh 服务运行时用 Electron 内置 Node,永不需要系统 Node;
 * 但「升级 dsh 的依赖闭包安装(npm install)」与「插件安装(dsh CLI 转发 pnpm)」
 * 需要外部工具链。策略(方案 B):
 *
 *   1. DSH_NPM_CMD 环境变量 → 原样使用(测试/特殊环境覆盖);
 *   2. 用户本地工具链(尽力探测)→ node ≥ 20 且 npm/pnpm 可用时优先用用户的
 *      (兼容用户自定义 registry/代理/缓存);
 *   3. 内置运行时兜底 → assets/runtime(dev)/Resources/runtime(打包)下的
 *      node + npm(+ pnpm),干净机器开箱即用;
 *   4. 都没有 → 明确报错并给出引导,升级/装插件中止(原版本保持可用)。
 *
 * GUI 应用不继承终端 PATH(macOS Finder 启动只有 /usr/bin:/bin:...),所以
 * 「用户本地」探测基于 shellPath(shell 会话 PATH),尽力重建:
 *   - 优先继承当前进程 PATH;
 *   - macOS 下再尝试 `launchctl getenv PATH`(登录会话注入的 PATH);
 *   - 都没有 → /usr/bin:/bin:/usr/sbin:/sbin 兜底。
 *
 * 本模块刻意不依赖 electron(app.isPackaged 等),保持纯 Node 可单测;
 * 内置运行时目录由调用方(main.js)根据打包态计算后传入。
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/** 用户工具链的 Node 主版本下限(与 package.json engines.node 一致) */
const NODE_MAJOR_REQ = 20;
/** 工具链探测超时(任何 probe 都带超时,不阻塞启动) */
const PROBE_TIMEOUT_MS = 8_000;
/** macOS GUI 会话兜底 PATH */
const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** macOS Homebrew 常见 bin 前缀(Apple Silicon / Intel):GUI 进程 PATH 不含,但
 *  用户 npm/pnpm/node 工具链大多装在这里 —— 0.1.7 实报:插件更新报
 *  「pnpm not found on PATH」(launchctl getenv PATH 为空时 shellPath 兜底
 *  到 /usr/bin:/bin,...,dsh CLI 找不到用户 pnpm)。探测 PATH 时前置合并。 */
const HOMEBREW_BINS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * 把存在的 Homebrew bin 前缀前置进探测 PATH(GUI 启动的 Electron 进程拿不到
 * 用户 shell 的 PATH;Homebrew 前缀是固定的,直接用文件存在性探测零副作用)。
 * @param {string} userPath
 * @returns {string}
 */
function withHomebrewBin(userPath) {
  if (process.platform !== "darwin") return userPath;
  // 回归测试隔离:单测构造 fake bins 验证优先级时,禁用本机 Homebrew 干扰
  if (process.env.DSH_DISABLE_HOMEBREW_PATH === "1") return userPath;
  const existing = String(userPath || "").split(path.delimiter).filter(Boolean);
  const extra = HOMEBREW_BINS.filter((d) => fs.existsSync(d) && !existing.includes(d));
  if (!extra.length) return userPath;
  return extra.join(path.delimiter) + (existing.length ? path.delimiter + existing.join(path.delimiter) : "");
}

/**
 * 解析用于探测用户工具链的 PATH:
 *   1. 环境变量 PATH 非空 → 用之;
 *   2. macOS → `launchctl getenv PATH`(登录会话注入;失败/为空忽略);
 *   3. macOS → Homebrew bin 前缀前置(Apple Silicon /opt/homebrew/bin,
 *      Intel /usr/local/bin)——GUI 启动关键兜底,见 ↑ withHomebrewBin;
 *   4. 兜底 DEFAULT_PATH。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function shellPath(env = process.env) {
  if (env.PATH && env.PATH.trim()) return withHomebrewBin(env.PATH);
  if (process.platform === "darwin") {
    try {
      const r = spawnSync("launchctl", ["getenv", "PATH"], {
        encoding: "utf8",
        timeout: 2_000,
      });
      const out = (r.stdout || "").trim();
      if (out) return withHomebrewBin(out);
    } catch {
      /* 忽略:退回兜底 PATH */
    }
  }
  return withHomebrewBin(DEFAULT_PATH);
}

/** 运行一次命令并返回 stdout 首行(trim);失败/超时返回 null。 */
function probeOut(command, args, env) {
  try {
    const r = spawnSync(command, args, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      env,
    });
    if (r.status !== 0) return null;
    const out = (r.stdout || "").trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 解析 "v20.11.0" → 20;无法解析返回 null。 */
function nodeMajor(versionLine) {
  if (!versionLine) return null;
  const m = /^v?(\d+)/.exec(versionLine.trim());
  return m ? Number(m[1]) : null;
}

/**
 * 探测「用户本地工具链」:在给定 PATH 上找 npm,要求 node ≥ NODE_MAJOR_REQ。
 * @param {string} userPath 探测用 PATH
 * @returns {null | { source: "user", cmd: string, envPath: string, nodeVersion: string|null, npmVersion: string|null }}
 */
function probeUserNpm(userPath) {
  const env = { ...process.env, PATH: userPath };
  const nodeVersion = probeOut("node", ["--version"], env);
  const major = nodeMajor(nodeVersion);
  if (major === null || major < NODE_MAJOR_REQ) return null;
  const npmVersion = probeOut("npm", ["--version"], env);
  if (npmVersion === null) return null;
  return {
    source: "user",
    cmd: "npm",
    envPath: userPath,
    nodeVersion,
    npmVersion,
  };
}

/** 内置运行时目录里的可执行布局(node/bin/{node,npm…} + node/lib/node_modules/npm) */
function bundledRuntimeParts(runtimeDir) {
  if (!runtimeDir) return null;
  const binDir = path.join(runtimeDir, "bin");
  return {
    dir: runtimeDir,
    binDir,
    nodeBin: path.join(binDir, process.platform === "win32" ? "node.exe" : "node"),
    npmCli: path.join(runtimeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    pnpmBin: path.join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
  };
}

/**
 * 探测「内置运行时」完整性(node 可执行 + npm-cli;pnpm 可选)。
 * @param {string|null} runtimeDir 内置 node 目录(assets/runtime/<plat>-<arch>/node 或等价)
 * @returns {null | { source: "bundled", dir: string, binDir: string, cmd: string, argsPrefix: string[], envPath: string, nodeVersion: string|null, npmVersion: string|null }}
 */
function probeBundledNpm(runtimeDir) {
  const parts = bundledRuntimeParts(runtimeDir);
  if (!parts) return null;
  if (!fs.existsSync(parts.nodeBin) || !fs.existsSync(parts.npmCli)) return null;
  const env = { ...process.env, PATH: parts.binDir + path.delimiter + shellPath() };
  const nodeVersion = probeOut(parts.nodeBin, ["--version"], env);
  if (nodeVersion === null) return null;
  const npmVersion = probeOut(parts.nodeBin, [parts.npmCli, "--version"], env);
  if (npmVersion === null) return null;
  return {
    source: "bundled",
    dir: runtimeDir,
    binDir: parts.binDir,
    cmd: parts.nodeBin,
    argsPrefix: [parts.npmCli],
    envPath: env.PATH,
    nodeVersion,
    npmVersion,
  };
}

/**
 * 解析「npm 执行方式」(升级 dsh 依赖闭包安装用)。
 * 优先级:DSH_NPM_CMD(env)→ 用户 npm(node ≥ 20)→ 内置运行时 → 明确报错。
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] 环境(默认 process.env)
 * @param {string} [options.bundledDir] 内置 node 目录;null = 不探测内置
 * @param {object} [options.log]
 * @returns {{ ok: true, source: "env"|"user"|"bundled", cmd: string, argsPrefix: string[], envPath: string, nodeVersion?: string|null, npmVersion?: string|null }
 *         | { ok: false, error: string }}
 */
function resolveNpm({ env = process.env, bundledDir = null, log } = {}) {
  // 1. 显式覆盖(测试/特殊环境):原样使用,不做版本门槛
  const npmCmd = env.DSH_NPM_CMD;
  if (npmCmd && npmCmd.trim()) {
    log?.log?.(`[toolchain] npm: 使用 DSH_NPM_CMD=${npmCmd}(env 覆盖)`);
    return {
      ok: true,
      source: "env",
      cmd: npmCmd,
      argsPrefix: [],
      envPath: env.PATH || DEFAULT_PATH,
      nodeVersion: null,
      npmVersion: null,
    };
  }

  // 2. 用户本地:shell PATH 上找 npm,node ≥ 20
  const userPath = shellPath(env);
  const user = probeUserNpm(userPath);
  if (user) {
    log?.log?.(
      `[toolchain] npm: 优先用户本地(${user.cmd} node=${user.nodeVersion} npm=${user.npmVersion})`
    );
    // argsPrefix 是 ok 返回的契约字段(见 JSDoc ↑);probeUserNpm 不带,必须
    // 补空数组 —— 用户 npm 是直接可执行命令,无前缀(与 env 分支一致)。曾漏
    // 掉导致 dsh-upgrade 的 [...argsPrefix] 展开 undefined → TypeError:
    // argsPrefix is not iterable,升级依赖闭包安装必崩(0.1.9 实报)。
    return { ok: true, ...user, argsPrefix: [] };
  }

  // 3. 内置运行时兜底(干净机器开箱即用)
  const bundled = probeBundledNpm(bundledDir);
  if (bundled) {
    log?.log?.(
      `[toolchain] npm: 使用内置运行时(node=${bundled.nodeVersion} npm=${bundled.npmVersion} @${bundled.dir})`
    );
    return { ok: true, ...bundled };
  }

  // 4. 都没有:明确报错(原版本保持可用)
  return {
    ok: false,
    error:
      `本机没有可用的 npm 工具链(需要 Node ≥ ${NODE_MAJOR_REQ})。` +
      (bundledDir
        ? `内置运行时也未就绪(${bundledDir})。`
        : "未配置内置运行时。") +
      "请安装 Node.js(nodejs.org),或让 DSH Box 使用内置运行时(运行 scripts/fetch-bundled-runtime.mjs)。",
  };
}

/**
 * 解析「pnpm 查找用 PATH」(插件安装:dsh CLI 内部 spawnSync("pnpm") 纯 PATH 解析)。
 * 只返回要注入的 PATH,不直接 spawn pnpm:
 *   - 用户 pnpm 在 shell PATH 上可用 → PATH 原样(用户 pnpm 命中);
 *   - 否则内置运行时含 pnpm → 内置 bin 前置(POSIX 无 shell,直接解析可执行文件);
 *   - 都没有 → PATH 原样,由 dsh CLI 给出「pnpm not found」引导。
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.bundledDir] 内置 node 目录;null = 不探测内置
 * @param {object} [options.log]
 * @returns {{ ok: true, path: string, source: "user"|"bundled"|"none", pnpmVersion?: string|null }}
 */
function resolvePnpmPath({ env = process.env, bundledDir = null, log } = {}) {
  const userPath = shellPath(env);
  const userEnv = { ...env, PATH: userPath };
  const userVersion = probeOut("pnpm", ["--version"], userEnv);
  if (userVersion !== null) {
    log?.log?.(`[toolchain] pnpm: 使用用户本地 pnpm@${userVersion}`);
    return { ok: true, path: userPath, source: "user", pnpmVersion: userVersion };
  }
  const parts = bundledRuntimeParts(bundledDir);
  if (parts && fs.existsSync(parts.pnpmBin)) {
    const pnpmVersion = probeOut(parts.pnpmBin, ["--version"], {
      ...env,
      PATH: parts.binDir + path.delimiter + userPath,
    });
    log?.log?.(
      `[toolchain] pnpm: 使用内置运行时 pnpm${pnpmVersion ? `@${pnpmVersion}` : ""}(${parts.binDir})`
    );
    return {
      ok: true,
      path: parts.binDir + path.delimiter + userPath,
      source: "bundled",
      pnpmVersion,
    };
  }
  log?.log?.("[toolchain] pnpm: 用户与内置均无 pnpm,交给 dsh CLI 报错引导");
  return { ok: true, path: userPath, source: "none", pnpmVersion: null };
}

module.exports = {
  NODE_MAJOR_REQ,
  DEFAULT_PATH,
  shellPath,
  nodeMajor,
  probeUserNpm,
  probeBundledNpm,
  bundledRuntimeParts,
  resolveNpm,
  resolvePnpmPath,
};