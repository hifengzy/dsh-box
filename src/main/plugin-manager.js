"use strict";

/**
 * plugin-manager.js — DSH Box 对第三方 Cordis 插件的生命周期管理。
 *
 * 当前托管两个插件,均为 npm 包、装在 dsh web profile:
 *   dsh-better-sidebar(侧边栏)  → <DSH_HOME>/profiles/web/node_modules/dsh-better-sidebar
 *   dshmarket(插件市场)          → <DSH_HOME>/profiles/web/node_modules/dshmarket
 *
 * 安装 / 更新走 dsh CLI(转发 pnpm):
 *   dsh plugin --profile web add <name>[@version]
 *
 * 本模块只做「检测 + 查询 + 触发安装/更新 + 写入开屏偏好」,
 * 不停/启 dsh 服务 —— 由主进程(main.js)编排(先停服务再动包,
 * 完成后重启让新 bundle 生效)。
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const semver = require("semver");
const { resolveDsh } = require("./dsh-server");
const npmCheck = require("./npm-check");

const PROFILE = "web";

/** 托管插件清单:包名(npm 注册名)→ 安装后是否写入 openByDefault 开屏偏好 */
const MANAGED_PLUGINS = {
  "dsh-better-sidebar": { openByDefault: true },
  dshmarket: { openByDefault: false },
};

function isManaged(name) {
  return Object.prototype.hasOwnProperty.call(MANAGED_PLUGINS, name);
}
const FETCH_TIMEOUT_MS = 10_000;
/** pnpm 安装可能较慢(下载依赖),放宽到 5 分钟 */
const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** 插件在 profile 里的安装目录 */
function pluginDir(dshHome, name) {
  return path.join(dshHome, "profiles", PROFILE, "node_modules", name);
}

/**
 * 读取已安装版本;未安装返回 null。
 * @param {string} dshHome DSH_HOME 目录
 * @param {string} name 包名(如 dsh-better-sidebar / dshmarket)
 * @returns {string|null}
 */
function getInstalledVersion(dshHome, name) {
  if (!isManaged(name)) return null;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(pluginDir(dshHome, name), "package.json"), "utf8")
    );
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 查询 npm registry 的 latest 版本号 */
async function fetchLatest(name) {
  const url = `${npmCheck.registryBase()}/${encodeURIComponent(name)}/latest`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`npm registry 请求失败 (HTTP ${res.status})`);
  const data = await res.json();
  return typeof data.version === "string" && data.version ? data.version : null;
}

/**
 * 综合检查:本地版本 + registry 最新版 + 是否有更新(失败不抛,error 字段记录)。
 * @param {string} dshHome
 * @param {string} name 包名(如 dsh-better-sidebar / dshmarket)
 * @returns {Promise<{name: string, installed: string|null, latest: string|null, hasUpdate: boolean, error: string|null}>}
 */
async function checkPlugin(dshHome, name) {
  const installed = getInstalledVersion(dshHome, name);
  let latest = null;
  let error = null;
  try {
    latest = await fetchLatest(name);
  } catch (e) {
    error = e.message || String(e);
  }
  let hasUpdate = false;
  if (installed && latest && semver.valid(installed) && semver.valid(latest)) {
    hasUpdate = semver.gt(latest, installed);
  }
  return { name, installed, latest, hasUpdate, error };
}

/**
 * 在指定 DSH_HOME 下执行 dsh CLI 子命令(与 DshServer 相同的解析/运行方式,
 * script 类型用内置 Node 跑,binary 类型直接执行)。
 * @param {string} dshHome
 * @param {string[]} args dsh CLI 参数(如 ["plugin","--profile","web","add",...])
 * @returns {Promise<{ok: boolean, error?: string, output?: string, code?: number}>}
 */
function runDshCli(dshHome, args) {
  return new Promise((resolve) => {
    const resolved = resolveDsh();
    if (!resolved) {
      resolve({ ok: false, error: "找不到 dsh,无法执行插件管理" });
      return;
    }
    const env = {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: "1",
    };
    let command;
    let cliArgs;
    if (resolved.type === "script") {
      command = process.execPath;
      cliArgs = ["--expose-internals", resolved.path, ...args];
      env.ELECTRON_RUN_AS_NODE = "1";
    } else {
      command = resolved.path;
      cliArgs = args;
    }
    let child;
    try {
      child = spawn(command, cliArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, error: `无法启动 dsh: ${e.message}` });
      return;
    }
    let output = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, error: "插件管理超时(超过 5 分钟)", code: null });
    }, INSTALL_TIMEOUT_MS);
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, output: (output + stderr).trim() });
      } else {
        resolve({
          ok: false,
          code,
          error: (stderr || output).trim() || `dsh plugin 退出码 ${code}`,
        });
      }
    });
  });
}

/**
 * 安装或更新插件到指定版本。
 * @param {string} dshHome
 * @param {string} name 包名(如 dsh-better-sidebar / dshmarket)
 * @param {string} [version] 目标版本;缺省装 latest
 */
async function installPlugin(dshHome, name, version = null) {
  if (!isManaged(name)) return { ok: false, error: `未托管的插件包: ${name}` };
  const spec = version ? `${name}@${version}` : name;
  return runDshCli(dshHome, ["plugin", "--profile", PROFILE, "add", spec]);
}

/**
 * 写入开屏偏好:<DSH_HOME>/settings.yaml 的 dsh-better-sidebar.openByDefault = true
 * (仅侧边栏插件声明)。只用文本级合并(项目无 yaml 依赖),不覆盖文件里其它配置。
 * @param {string} dshHome
 * @returns {boolean} 写入成功与否
 */
function ensureOpenByDefault(dshHome) {
  const file = path.join(dshHome, "settings.yaml");
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    lines = [];
  }
  const out = [];
  let inSection = false;
  let wrote = false;
  const flush = () => {
    if (!wrote) out.push("  openByDefault: true");
    wrote = true;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (trimmed === `${PLUGIN_NAME}:`) {
        inSection = true;
        out.push(line);
        continue;
      }
      out.push(line);
      continue;
    }
    // 块内:遇到新顶层键(非空、无缩进)说明块结束
    if (trimmed !== "" && !/^[ \t]/.test(line)) {
      flush();
      inSection = false;
      out.push(line);
      continue;
    }
    if (/^[ \t]+openByDefault:/.test(line)) {
      out.push("  openByDefault: true");
      wrote = true;
      continue;
    }
    out.push(line);
  }
  if (inSection) flush();
  if (!wrote) {
    // 域不存在 → 追加到文件末尾
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(`${PLUGIN_NAME}:`, "  openByDefault: true");
  }
  try {
    fs.mkdirSync(dshHome, { recursive: true });
    fs.writeFileSync(file, out.join("\n") + "\n");
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  PROFILE,
  MANAGED_PLUGINS,
  isManaged,
  pluginDir,
  getInstalledVersion,
  checkPlugin,
  installPlugin,
  ensureOpenByDefault,
  runDshCli,
};