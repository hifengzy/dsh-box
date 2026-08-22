"use strict";

/**
 * topbar.js — 自定义顶栏逻辑。
 *
 * - 双击顶栏 = 最大化/还原(macOS 惯例,和原生标题栏行为一致);
 * - 右侧 GitHub 按钮 = 在系统浏览器打开仓库页(经外壳桥,仅 http/https);
 *   按钮自身双击不冒泡,避免误触顶栏双击最大化;
 * - dsh 状态入口 = 开/关右侧「dsh 服务与版本」面板(激活态 = 面板展开;
 *   窗口过窄时禁用 = 提示);有可升级版本时亮红点
 *   (启动时主进程已静默查过一次 npm,红点随 dsh:update-flag 事件实时刷新);
 * - 侧边栏插件两个面板开关(侧栏 / 底栏)= 经桥切换 dsh 页面内插件的开合;
 *   插件未安装/未挂载时禁用,开合状态随页面实时回显(激活态 = 面板展开)。
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

// ---------- 侧边栏插件面板开关(侧栏 / 底栏) ----------
// 按钮只负责把命令发给主进程 → 桥模拟点击插件自己的 toggle 按钮;
// 开合状态由桥经 shell:plugin-panels 上报,这里渲染高亮/禁用。
const pluginSideBtn = document.querySelector("#pluginSideBtn");
const pluginBottomBtn = document.querySelector("#pluginBottomBtn");

function bindPanelBtn(btn, which, labelOpen, labelClosed) {
  btn.addEventListener("click", () => {
    window.dsh.togglePluginPanel(which).catch(() => {});
  });
  btn.addEventListener("dblclick", (event) => {
    event.stopPropagation(); // 不触发顶栏双击最大化
  });
  btn._labels = { open: labelOpen, closed: labelClosed };
}

bindPanelBtn(pluginSideBtn, "side", "折叠侧边栏", "展开侧边栏");
bindPanelBtn(pluginBottomBtn, "bottom", "折叠底部面板", "展开底部面板");

/** 桥上报状态:installed/active=false → 禁用;否则按开合渲染激活态 + 标题 */
function renderPluginPanels(state) {
  const s = state || {};
  const enabled = s.installed !== false && s.active !== false;
  [pluginSideBtn, pluginBottomBtn].forEach((btn) => {
    btn.disabled = !enabled;
    const open = whichOf(btn) === "side" ? !!s.side : !!s.bottom;
    btn.classList.toggle("panel-btn-active", enabled && open);
    btn.setAttribute("aria-pressed", String(enabled && open));
    if (!enabled) {
      btn.title = s.installed === false ? "侧边栏插件未安装" : "打开会话后可切换侧边栏";
    } else {
      btn.title = open ? btn._labels.open : btn._labels.closed;
    }
  });
}

function whichOf(btn) {
  return btn === pluginSideBtn ? "side" : "bottom";
}

// 插件面板状态完全由桥实时上报(内容页加载 → 注入桥 → 上报);
// 页面重载(Spa 导航/服务重启)后桥会重新上报,无需主动轮询。
window.dsh.onPluginPanels(renderPluginPanels);
