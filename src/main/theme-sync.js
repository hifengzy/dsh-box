"use strict";

/**
 * theme-sync.js — dsh 外观偏好(light/dark/system)与 Electron nativeTheme 的同步。
 *
 * 背景:dsh 前端「跟随系统」在浏览器里的实现就是
 *   matchMedia('(prefers-color-scheme: dark)').matches(见 dsh-client-ui-theme
 *   lib/client.js),而 Electron 渲染进程的该媒体查询由 nativeTheme.themeSource
 *   决定。若把 dsh「解析后的浅/深」镜像回 themeSource(旧实现),themeSource 会被
 *   锁死:媒体查询永远读不到真实系统配色 →「跟随系统」失效(选浅就一直浅、
 *   选深就一直深,只能重启恢复)。
 *
 * 正确做法:只同步「偏好」本身——
 *   - preference=light/dark → themeSource 锁同一值(外壳与 dsh 内容一起锁);
 *   - preference=system     → themeSource='system'(外壳与 dsh 内容分别跟随
 *     同一个 OS 媒体查询,任何时刻二者解析结果一致)。
 * 偏好持久化在 <DSH_HOME>/settings.yaml 的 ui-theme.preference,dsh 本地提供方
 * 每次切换外观都会写回该文件;本模块 fs.watchFile 监听后实时生效(无需重启)。
 *
 * 本模块不依赖 Electron(app),nativeTheme 由调用方注入,便于纯 Node 单测
 * (scripts/regression-theme-sync.js)。
 */

const fs = require("node:fs");

/** dsh 内置外观偏好(与 dsh-client-ui-theme 的 THEME_PREFERENCES 一致) */
const THEME_PREFERENCES = ["light", "dark", "system"];

/**
 * 从 settings.yaml 读取外观偏好(键:ui-theme.preference;兼容旧式
 * settings.theme.preference 写法)。文件缺失/读不到/未设置 → null。
 * @param {string} settingsPath
 * @returns {("light"|"dark"|"system"|null)}
 */
function readThemePreference(settingsPath) {
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const match = raw.match(/^ui-theme:\s*\n\s*preference:\s*["']?(light|dark|system)["']?/m)
      ?? raw.match(/^settings\.theme:\s*\n\s*preference:\s*["']?(light|dark|system)["']?/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * 把偏好应用到 nativeTheme.themeSource;未知/缺失偏好不动(保持现状)。
 * 关键:system 也必须显式写入,以解锁此前被 light/dark 锁死的媒体查询。
 * @param {{ themeSource?: string }} nativeThemeLike 原生 nativeTheme 或测试 mock
 * @param {string|null} preference
 * @returns {("light"|"dark"|"system"|null)} 应用后的偏好;无效输入返回 null
 */
function applyThemePreference(nativeThemeLike, preference) {
  if (!THEME_PREFERENCES.includes(preference)) return null;
  if (nativeThemeLike.themeSource !== preference) {
    nativeThemeLike.themeSource = preference;
  }
  return preference;
}

/**
 * 监听 settings.yaml 变化 → 变更时读偏好并回调 onPreference(preference)。
 * 用 fs.watchFile(按路径轮询 stat):兼容 dsh 整文件重写/原子替换(rename 换
 * inode 不丢监听),也覆盖「文件尚不存在、之后才创建」的场景(stat 从 null
 * 变为有效即触发)。
 * @param {string} settingsPath
 * @param {(preference: "light"|"dark"|"system") => void} onPreference
 * @param {number} [interval] 轮询间隔 ms(测试用短值,生产默认 150)
 * @returns {() => void} 停止监听
 */
function watchThemePreference(settingsPath, onPreference, interval = 150) {
  const handler = () => {
    const preference = readThemePreference(settingsPath);
    if (preference) onPreference(preference);
  };
  fs.watchFile(settingsPath, { interval }, handler);
  return () => fs.unwatchFile(settingsPath, handler);
}

module.exports = {
  THEME_PREFERENCES,
  readThemePreference,
  applyThemePreference,
  watchThemePreference,
};