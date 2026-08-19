"use strict";

/**
 * topbar.js — 自定义顶栏逻辑。
 *
 * - 双击顶栏 = 最大化/还原(macOS 惯例,和原生标题栏行为一致);
 * - 右侧 GitHub 按钮 = 在系统浏览器打开仓库页(经外壳桥,仅 http/https);
 *   按钮自身双击不冒泡,避免误触顶栏双击最大化;
 * - dsh 状态入口 = 开/关右侧「dsh 服务与版本」面板(激活态 = 面板展开;
 *   窗口过窄时禁用 = 提示);有可升级版本时亮红点
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

// ---------- dsh 服务与版本入口(右侧面板开/关) ----------
// 仅由顶栏按钮(和菜单)控制面板开合;面板自身不提供关闭按钮。
const statusBtn = document.querySelector(".status-btn");
const updateDot = document.getElementById("updateDot");

function renderUpdateDot(flag) {
  updateDot.hidden = !(flag && flag.hasUpdate);
}

function syncSidebar(state) {
  const st = state || {};
  const open = !!st.open;
  const canOpen = st.canOpen !== false;
  statusBtn.classList.toggle("status-btn-active", open);
  statusBtn.setAttribute("aria-pressed", String(open));
  // 展开时始终可点(用于关闭);闭合时才按 canOpen 决定是否禁用(窗口太窄)
  statusBtn.disabled = !open && !canOpen;
  statusBtn.title = open
    ? "关闭 dsh 服务与版本"
    : canOpen
      ? "dsh 服务与版本"
      : "窗口太窄,无法展开 dsh 服务面板";
}

statusBtn.addEventListener("click", async () => {
  try {
    syncSidebar(await window.dsh.toggleSidebar());
  } catch {
    /* IPC 失败忽略 */
  }
});
statusBtn.addEventListener("dblclick", (event) => {
  event.stopPropagation();
});

// 启动时拉取当前面板状态;之后订阅实时变化(菜单开合/窗口缩放都同步)
window.dsh
  .getSidebar()
  .then(syncSidebar)
  .catch(() => {});
window.dsh.onSidebar(syncSidebar);

// ---------- 更新红点(有可升级版本时,状态按钮右上角亮起) ----------
window.dsh
  .getUpdateFlag()
  .then(renderUpdateDot)
  .catch(() => {});
window.dsh.onUpdateFlag(renderUpdateDot);
