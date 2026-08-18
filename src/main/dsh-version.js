"use strict";

/**
 * dsh-version.js — 解析当前「真正在运行」的 dsh 版本(单一事实来源)。
 *
 * 不直接 require.resolve("@deepseek-ai/dsh/package.json"),而是从
 * DshServer.resolveDsh() 解析出的实际入口(bin.js)向上找包根读版本:
 *   - 应用内升级后(resolveDsh 指向的目录已被替换)自动读到新版本;
 *   - 若用户用 DSH_BIN 显式指定了别的 dsh,展示的是真实运行的那一份;
 *   - 打包版(asar:false)与开发模式走同一套逻辑。
 */

const fs = require("node:fs");
const path = require("node:path");
const { resolveDsh } = require("./dsh-server");

/**
 * 从 dsh 入口脚本(bin.js)向上找包根目录(node_modules/@deepseek-ai/dsh)。
 * @param {string} binPath dsh 入口脚本绝对路径
 * @returns {string|null} 包根目录,找不到返回 null
 */
function packageDirOf(binPath) {
  let dir = path.dirname(binPath);
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 读取 dsh 运行时信息。
 * @returns {{ version: string|null, bin: string|null, packageDir: string|null, type: "script"|"binary"|null }}
 */
function getRuntimeDshInfo() {
  const resolved = resolveDsh();
  if (resolved && resolved.path) {
    const packageDir = packageDirOf(resolved.path);
    let version = null;
    if (packageDir) {
      try {
        version = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).version ?? null;
      } catch {
        /* 读不到版本按未知处理 */
      }
    }
    return { version, bin: resolved.path, packageDir, type: resolved.type };
  }
  // 兜底:require.resolve(理论上 resolveDsh 总能解析到,这里保底)
  try {
    const pkgPath = require.resolve("@deepseek-ai/dsh/package.json");
    const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? null;
    return { version, bin: null, packageDir: path.dirname(pkgPath), type: "script" };
  } catch {
    return { version: null, bin: null, packageDir: null, type: null };
  }
}

module.exports = { getRuntimeDshInfo, packageDirOf };
