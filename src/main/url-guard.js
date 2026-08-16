"use strict";

/**
 * url-guard.js — URL / 来源信任判断(纯逻辑,不依赖 Electron,可单测)。
 *
 * 背景:之前用字符串前缀匹配判断「是否属于 dsh 服务」,会被
 *   - userinfo 欺骗: http://127.0.0.1:3260@evil.com/
 *   - 端口前缀混淆: http://127.0.0.1:32600/
 * 绕过,把外部页面当成受信任的同源页面放行。这里统一改为解析 URL 后
 * 精确比对 origin(协议 + 主机 + 端口)。
 */

/**
 * 解析 URL 的 origin(如 "http://127.0.0.1:3260");解析失败返回 null。
 * 注意 new URL() 会自动剥离 userinfo,所以 userinfo 欺骗在这里天然失效。
 */
function parseOrigin(input) {
  try {
    return new URL(input).origin;
  } catch {
    return null;
  }
}

/** 是否与 dsh 服务同源(协议 + 主机 + 端口完全一致,忽略路径/查询/哈希)。 */
function isServerOrigin(input, serverUrl) {
  const a = parseOrigin(input);
  const b = parseOrigin(serverUrl);
  return a !== null && a === b;
}

/** 是否属于 App 自带的本地页面(file://,加载页 / 顶栏)。 */
function isAppFilePage(input) {
  return typeof input === "string" && input.startsWith("file://");
}

/**
 * 渲染进程来源是否可信:
 *   - App 自带的 file:// 页面(加载页 / 顶栏);
 *   - 唯一的 dsh 服务 origin(精确匹配)。
 * 其它一律不可信。
 */
function isTrustedOrigin(input, serverUrl) {
  if (!input) return false;
  if (isAppFilePage(input)) return true;
  return isServerOrigin(input, serverUrl);
}

module.exports = { parseOrigin, isServerOrigin, isAppFilePage, isTrustedOrigin };
