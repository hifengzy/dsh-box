"use strict";

/**
 * topbar.js — 自定义顶栏逻辑。
 *
 * - 双击顶栏 = 最大化/还原(macOS 惯例,和原生标题栏行为一致);
 * - 右侧 GitHub 按钮 = 在系统浏览器打开仓库页(经外壳桥,仅 http/https)。
 *   按钮自身双击不冒泡,避免误触顶栏双击最大化。
 */

const GITHUB_URL = "https://github.com/hifengzy/dsh-box";

document.querySelector(".bar").addEventListener("dblclick", () => {
  window.dsh.toggleMaximize();
});

const githubBtn = document.querySelector(".github-btn");
githubBtn.addEventListener("click", () => {
  window.dsh.openExternal(GITHUB_URL);
});
githubBtn.addEventListener("dblclick", (event) => {
  event.stopPropagation();
});
