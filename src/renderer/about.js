"use strict";

/**
 * about.js — 「关于 DSH Box」页面填充脚本。
 * 主进程通过 loadFile 的 query 注入版本信息,这里写入页面。
 * 关闭由主进程处理(单击窗外 / Esc),页面本身无交互。
 */
(() => {
  const q = new URLSearchParams(location.search);

  const appNameEl = document.getElementById("appName");
  if (appNameEl && q.get("appName")) appNameEl.textContent = q.get("appName");

  const versionEl = document.getElementById("version");
  if (versionEl) versionEl.textContent = "版本：" + (q.get("version") || "");

  const set = (id) => {
    const el = document.getElementById(id);
    if (el && q.get(id)) el.textContent = q.get(id);
  };
  set("electron");
  set("node");
})();
