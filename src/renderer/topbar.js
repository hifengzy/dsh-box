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
  // tooltip 固定为「服务管理」(需求指定);禁用/激活态仍由视觉与 aria 表达
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

function bindPanelBtn(btn, which) {
  btn.addEventListener("click", () => {
    window.dsh.togglePluginPanel(which).catch(() => {});
  });
  btn.addEventListener("dblclick", (event) => {
    event.stopPropagation(); // 不触发顶栏双击最大化
  });
}

bindPanelBtn(pluginSideBtn, "side");
bindPanelBtn(pluginBottomBtn, "bottom");

/** 桥上报状态:installed/active=false → 禁用;否则按开合渲染激活态。
    tooltip 固定为「侧栏 / 面板」(需求指定,不随状态变化)。 */
function renderPluginPanels(state) {
  const s = state || {};
  const enabled = s.installed !== false && s.active !== false;
  [pluginSideBtn, pluginBottomBtn].forEach((btn) => {
    btn.disabled = !enabled;
    const open = whichOf(btn) === "side" ? !!s.side : !!s.bottom;
    btn.classList.toggle("panel-btn-active", enabled && open);
    btn.setAttribute("aria-pressed", String(enabled && open));
  });
}

function whichOf(btn) {
  return btn === pluginSideBtn ? "side" : "bottom";
}

// 插件面板状态完全由桥实时上报(内容页加载 → 注入桥 → 上报);
// 页面重载(Spa 导航/服务重启)后桥会重新上报,无需主动轮询。
window.dsh.onPluginPanels(renderPluginPanels);

// ---------- 应用自更新「新版本」按钮 ----------
// 状态机(主进程 app-updater.js):idle/disabled → available → downloading(percent)
// → downloaded → installing;error 可重试。按钮在 github 左侧,仅状态为
// available/downloading/downloaded/installing/error 时可见(hidden 不留空位)。
const appUpdateBtn = document.getElementById("appUpdateBtn");
const appUpdateLabel = document.getElementById("appUpdateLabel");

const APP_UPDATE_LABELS = {
  available: "新版本",
  downloading: (n) => `下载中 ${Math.round(n)}%`,
  downloaded: "安装",
  installing: "安装中…",
  error: "重试",
};

const APP_UPDATE_TITLES = {
  available: "发现新版本,点击下载",
  downloading: (n) => `正在下载新版本 ${Math.round(n)}%`,
  downloaded: "下载完成,点击安装",
  installing: "正在安装…",
  error: "下载失败,点击重试",
};

function renderAppUpdate(state) {
  const st = state || {};
  const s = st.state;
  const show = s === "available" || s === "downloading" || s === "downloaded" || s === "installing" || s === "error";
  appUpdateBtn.hidden = !show;
  if (!show) return;
  appUpdateBtn.dataset.state = s;
  appUpdateBtn.disabled = s === "installing";
  // 进度涂色:下载中填充宽度 = 进度%(available 时 0,download 后 100)
  const pct = s === "downloading" ? (Number(st.percent) || 0) : s === "downloaded" ? 100 : 0;
  document.documentElement.style.setProperty("--app-update-progress", String(Math.max(0, Math.min(100, pct))));
  // 下载中且尚未收到真实进度(0%)→ fill 扫光 loading 动画(点击「新版本」的
  // 即时反馈);首个真实进度到达后取消,由确定性宽度接管。
  appUpdateBtn.classList.toggle("app-update-indeterminate", s === "downloading" && pct <= 0);
  const label = typeof APP_UPDATE_LABELS[s] === "function" ? APP_UPDATE_LABELS[s](st.percent ?? 0) : APP_UPDATE_LABELS[s];
  appUpdateLabel.textContent = label;
  const title = typeof APP_UPDATE_TITLES[s] === "function" ? APP_UPDATE_TITLES[s](st.percent ?? 0) : APP_UPDATE_TITLES[s];
  appUpdateBtn.title = title;
}

appUpdateBtn.addEventListener("click", () => {
  const s = appUpdateBtn.dataset.state;
  // available → 开始下载;downloaded → 安装;error → 重试(检查失败重查/下载失败重下)
  if (s === "available") {
    window.dsh.downloadAppUpdate().catch(() => {});
  } else if (s === "error") {
    window.dsh.retryAppUpdate().catch(() => {});
  } else if (s === "downloaded") {
    window.dsh.installAppUpdate().catch(() => {});
  }
});
appUpdateBtn.addEventListener("dblclick", (event) => {
  event.stopPropagation(); // 不触发顶栏双击最大化
});

// 启动时拉一次当前状态(dev 模式 = disabled 保持隐藏),之后订阅实时变化
window.dsh
  .getAppUpdateState()
  .then(renderAppUpdate)
  .catch(() => {});
window.dsh.onAppUpdate(renderAppUpdate);
