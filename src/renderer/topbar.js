"use strict";

/**
 * topbar.js — 自定义顶栏逻辑。
 *
 * - 双击顶栏 = 最大化/还原(macOS 惯例,和原生标题栏行为一致);
 * - 右侧 GitHub 按钮 = 在系统浏览器打开仓库页(经外壳桥,仅 http/https);
 *   按钮自身双击不冒泡,避免误触顶栏双击最大化;
 * - dsh 状态入口 = 打开「dsh 服务与版本」窗口;有可升级版本时亮红点
 *   (启动时主进程已静默查过一次 npm,红点随 dsh:update-flag 事件实时刷新)。
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

// ---------- dsh 服务与版本入口 ----------
const statusBtn = document.querySelector(".status-btn");
const updateDot = document.getElementById("updateDot");

function renderUpdateDot(flag) {
  updateDot.hidden = !(flag && flag.hasUpdate);
}

statusBtn.addEventListener("click", () => {
  window.dsh.openStatusPage();
});
statusBtn.addEventListener("dblclick", (event) => {
  event.stopPropagation();
});

// 启动时拉取主进程已查过的更新标志;之后订阅实时变化
window.dsh
  .getUpdateFlag()
  .then(renderUpdateDot)
  .catch(() => {});
window.dsh.onUpdateFlag(renderUpdateDot);
