"use strict";

/**
 * box-settings.js — DSH Box 自己的设置持久化文本级读写。
 *
 * 存到 <DSH_HOME>/settings.yaml 的 `dsh-box:` 自定义域(与 dsh 设置同文件
 * 同备份);项目无 yaml 依赖,这里只做「顶层块 + 单层布尔键」的最小解析,
 * 绝不覆盖文件里其它配置。
 *
 * 当前键:
 *   dsh-box:
 *     marketSidebarEntry: true|false   # 「在 DSH 侧边栏显示插件市场入口」
 */

const fs = require("node:fs");
const path = require("node:path");

const BOX_SETTINGS_KEY = "dsh-box";

/**
 * 读取自定义域的布尔键。
 * @param {string} dshHome DSH_HOME 目录
 * @param {string} key 键名(如 marketSidebarEntry)
 * @returns {boolean} 缺省 false
 */
function readSettingBool(dshHome, key) {
  try {
    const raw = fs.readFileSync(path.join(dshHome, "settings.yaml"), "utf8");
    const dom = raw.match(new RegExp(`^${BOX_SETTINGS_KEY}:\\s*$`, "m"));
    if (!dom) return false;
    const after = raw.slice(dom.index + dom[0].length);
    const line = after.split("\n").find((l) => new RegExp(`^\\s+${key}:`).test(l));
    if (!line) return false;
    return /(?:^|:)\s*true\s*$/i.test(line.trim());
  } catch {
    return false;
  }
}

/**
 * 写入自定义域的布尔键(文本级合并,保留其它配置;幂等)。
 * @param {string} dshHome DSH_HOME 目录
 * @param {string} key 键名
 * @param {boolean} value
 * @returns {boolean} 写入成功与否
 */
function writeSettingBool(dshHome, key, value) {
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
    if (!wrote) out.push(`  ${key}: ${value ? "true" : "false"}`);
    wrote = true;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (trimmed === `${BOX_SETTINGS_KEY}:`) {
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
    if (new RegExp(`^[ \t]+${key}:`).test(line)) {
      out.push(`  ${key}: ${value ? "true" : "false"}`);
      wrote = true;
      continue;
    }
    out.push(line);
  }
  if (inSection) flush();
  if (!wrote) {
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(`${BOX_SETTINGS_KEY}:`, `  ${key}: ${value ? "true" : "false"}`);
  }
  try {
    fs.mkdirSync(dshHome, { recursive: true });
    fs.writeFileSync(file, out.join("\n") + "\n");
    return true;
  } catch {
    return false;
  }
}

module.exports = { BOX_SETTINGS_KEY, readSettingBool, writeSettingBool };