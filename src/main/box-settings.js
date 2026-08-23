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
 *     statusPanelWidth: 320            # 「服务状态」共享面板宽度(注入层拖拽后持久化)
 */

const fs = require("node:fs");
const path = require("node:path");

const BOX_SETTINGS_KEY = "dsh-box";

/**
 * 读取自定义域键的原始文本值(未找到返回 null)。
 * @param {string} dshHome DSH_HOME 目录
 * @param {string} key 键名(如 marketSidebarEntry / statusPanelWidth)
 * @returns {string|null} 键值文本;缺失或读取失败为 null
 */
function readSettingValue(dshHome, key) {
  try {
    const raw = fs.readFileSync(path.join(dshHome, "settings.yaml"), "utf8");
    const dom = raw.match(new RegExp(`^${BOX_SETTINGS_KEY}:\\s*$`, "m"));
    if (!dom) return null;
    const after = raw.slice(dom.index + dom[0].length);
    const line = after.split("\n").find((l) => new RegExp(`^\\s+${key}:`).test(l));
    if (!line) return null;
    const m = line.match(/:\s*(.*?)\s*$/);
    return m ? m[1].trim() : "";
  } catch {
    return null;
  }
}

/**
 * 读取自定义域的布尔键。
 * @param {string} dshHome DSH_HOME 目录
 * @param {string} key 键名(如 marketSidebarEntry)
 * @returns {boolean} 缺省 false
 */
function readSettingBool(dshHome, key) {
  const v = readSettingValue(dshHome, key);
  return v !== null && /^true$/i.test(v);
}

/**
 * 写入自定义域键(文本级合并,保留其它配置;幂等)。
 * @param {string} dshHome DSH_HOME 目录
 * @param {string} key 键名
 * @param {boolean|number|string} value boolean → true/false;其余原样文本
 * @returns {boolean} 写入成功与否
 */
function writeSettingValue(dshHome, key, value) {
  const text = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
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
    if (!wrote) out.push(`  ${key}: ${text}`);
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
      out.push(`  ${key}: ${text}`);
      wrote = true;
      continue;
    }
    out.push(line);
  }
  if (inSection) flush();
  if (!wrote) {
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(`${BOX_SETTINGS_KEY}:`, `  ${key}: ${text}`);
  }
  try {
    fs.mkdirSync(dshHome, { recursive: true });
    fs.writeFileSync(file, out.join("\n") + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * 写入自定义域的布尔键(见 writeSettingValue)。
 * @param {string} dshHome DSH_HOME 目录
 * @param {string} key 键名
 * @param {boolean} value
 * @returns {boolean} 写入成功与否
 */
function writeSettingBool(dshHome, key, value) {
  return writeSettingValue(dshHome, key, !!value);
}

module.exports = {
  BOX_SETTINGS_KEY,
  readSettingValue,
  readSettingBool,
  writeSettingValue,
  writeSettingBool,
};