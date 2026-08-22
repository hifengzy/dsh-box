"use strict";

/**
 * dsh-status.js — 「服务状态 + DSH + 侧边栏」右侧面板逻辑。
 *
 * 面板由顶栏状态按钮(或菜单)开关,自身不提供关闭按钮。
 * 数据全部经 preload 桥(window.dsh.*):
 *
 * 服务状态:
 *   - 只展示 DSH 版本号、端口、PID 三项;
 *   - 状态只有「运行中 / 停止」两态(ready → 运行中,其余 → 停止),
 *     仅「停止」时显示「启动服务」按钮;
 *   - 版本号超长自动截断为 …(title 完整值)。
 *
 * DSH 板块(原「DSH 版本」列表,已精简为单条):
 *   - 只展示最新一条版本(发布时间最新):版本号(链接,悬停下划线)
 *     + 「最新」徽标 + 发布日期;
 *   - 当前运行版本 < 最新 → 「更新」按钮;一致 → 「当前」绿色文案;
 *   - 网络查询失败 → 「网络服务异常」+「重试」;有缓存时回退展示并提示。
 *
 * 侧边栏板块(dsh-better-sidebar):
 *   - 名称(链接,悬停下划线)+ 最新版本徽标 + 说明文案;
 *   - 未安装 → 「安装」按钮;已装且版本 == 最新 → 「已安装」绿色文案;
 *     已装但版本 < 最新 → 「更新」按钮;查询失败 → 「网络服务异常」+「重试」;
 *   - 安装/更新由主进程完成(停服 → dsh plugin add → 恢复服务)。
 */

const $ = (id) => document.getElementById(id);

const els = {
  // 服务状态
  versionLine: $("versionLine"),
  metaLine: $("metaLine"),
  statePill: $("statePill"),
  stateLabel: $("stateLabel"),
  startBtn: $("startBtn"),
  serviceHint: $("serviceHint"),
  // DSH(最新一条)
  dshRow: $("dshRow"),
  dshVersionLink: $("dshVersionLink"),
  dshUpdateBtn: $("dshUpdateBtn"),
  dshCurrentLabel: $("dshCurrentLabel"),
  dshDate: $("dshDate"),
  dshError: $("dshError"),
  dshRetryBtn: $("dshRetryBtn"),
  dshCacheNote: $("dshCacheNote"),
  upgradeHint: $("upgradeHint"),
  // 侧边栏插件
  pluginRow: $("pluginRow"),
  pluginNameLink: $("pluginNameLink"),
  pluginVersionBadge: $("pluginVersionBadge"),
  pluginActionBtn: $("pluginActionBtn"),
  pluginInstalledLabel: $("pluginInstalledLabel"),
  pluginDesc: $("pluginDesc"),
  pluginError: $("pluginError"),
  pluginRetryBtn: $("pluginRetryBtn"),
  pluginHint: $("pluginHint"),
};

let currentInfo = null;
let upgrading = false;
let pluginInstalling = false;
/** 最近一次插件查询信息(供安装/更新成功后刷新对照) */
let lastPluginInfo = null;

// ---------- 服务状态 ----------

/** 渲染服务状态(两态:运行中 / 停止) */
function renderStatus(info) {
  if (!info) return;
  currentInfo = info;

  const versionText = info.version ? `DSH ${info.version}` : "DSH(版本未知)";
  els.versionLine.textContent = versionText;
  els.versionLine.title = versionText;

  const running = info.state === "ready";
  els.metaLine.textContent = running
    ? `端口 ${info.port} · PID ${info.pid ?? "-"}`
    : "端口 - · PID -";

  els.statePill.classList.toggle("state-running", running);
  els.stateLabel.textContent = running ? "运行中" : "停止";

  els.startBtn.hidden = running;
  els.startBtn.disabled = info.state === "starting";
  els.startBtn.textContent = info.state === "starting" ? "启动中…" : "启动服务";
}

async function refreshInfo() {
  try {
    renderStatus(await window.dsh.getInfo());
  } catch (error) {
    els.serviceHint.hidden = false;
    els.serviceHint.textContent = `获取服务信息失败: ${error}`;
  }
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

// ---------- DSH(最新一条) ----------

/**
 * 渲染 DSH 板块:只展示最新一条版本。
 * res 来自 window.dsh.checkUpdates()(完整列表已由主进程 decorate,
 * 含 latest / runtime / hasUpdate / rows;rows 按发布时间倒序)。
 */
function renderDsh(res) {
  // 无最新版本可用 → 失败态
  if (res.error || !res.latest || !res.rows || !res.rows.length) {
    els.dshError.hidden = false;
    els.dshCacheNote.hidden = true;
    els.dshRow.hidden = true;
    els.dshDate.hidden = true;
    return;
  }

  // 最新版本行:dist-tag latest 精确匹配优先,再回退 isLatest 标记/首行
  const latestRow =
    res.rows.find((r) => r.version === res.latest) ??
    res.rows.find((r) => r.isLatest) ??
    res.rows[0];
  const latestVersion = latestRow.version;

  els.dshError.hidden = true;
  els.dshCacheNote.hidden = !res.fromCache;

  els.dshRow.hidden = false;
  els.dshVersionLink.textContent = latestVersion;
  els.dshVersionLink.title = latestVersion;

  // 当前运行版本 < 最新 → 更新按钮;一致(或无法比较)→ 「当前」文案
  const hasUpdate = !!res.hasUpdate;
  els.dshUpdateBtn.hidden = !hasUpdate;
  els.dshCurrentLabel.hidden = hasUpdate;
  if (hasUpdate) els.dshUpdateBtn.textContent = "更新";

  els.dshDate.hidden = false;
  els.dshDate.textContent = fmtDate(latestRow.publishedAt) || String(latestVersion);
}

/** 查一次 npm 并渲染(每次进入页面都查) */
async function loadVersions() {
  els.upgradeHint.hidden = false;
  els.upgradeHint.textContent = "正在检查…";
  try {
    renderDsh(await window.dsh.checkUpdates());
    els.upgradeHint.hidden = true;
  } catch (error) {
    els.upgradeHint.hidden = true;
    renderDsh({ error: String(error), rows: [] });
  }
}

// ---------- 侧边栏插件(dsh-better-sidebar) ----------
// 状态机:未安装 →「安装」;已装 == 最新 →「已安装」(绿字,无按钮);
// 已装 < 最新 →「更新」;查询失败 →「网络服务异常」+「重试」。

/** 渲染插件板块(info = getPluginInfo 结果) */
function renderPlugin(info) {
  lastPluginInfo = info;
  const installed = info.installed;
  const failed = !!info.error;
  const latest = info.latest;

  // 名称行内容固定(链接 href 静态),只需控制显隐与徽标/按钮
  els.pluginRow.hidden = false;

  // 版本徽标:正常时展示「查询到的最新版本号」;查询失败时 latest 不可靠,
  // 回退本地已装版本(未装则隐藏)
  const badgeText = failed ? (installed || latest) : (latest || installed);
  if (badgeText) {
    els.pluginVersionBadge.textContent = badgeText;
    els.pluginVersionBadge.hidden = false;
  } else {
    els.pluginVersionBadge.hidden = true;
  }

  // 未安装 + 查询失败:隐藏行,只显示错误态
  if (failed && !installed) {
    els.pluginRow.hidden = true;
    els.pluginDesc.hidden = true;
    els.pluginError.hidden = false;
    els.pluginError.querySelector(".error-text").textContent = "网络服务异常";
    return;
  }

  // 已安装 + 查询失败:显示本地已装版本 + 警示 + 重试(无法判断更新)
  if (failed && installed) {
    els.pluginDesc.hidden = true;
    els.pluginError.hidden = false;
    els.pluginError.querySelector(".error-text").textContent = "网络异常,无法检查更新";
    els.pluginActionBtn.hidden = true;
    els.pluginInstalledLabel.hidden = true;
    return;
  }

  els.pluginError.hidden = true;
  els.pluginDesc.hidden = false;

  // 动作区:未安装 → 安装;已装 < 最新 → 更新;已装 >= 最新 → 已安装(绿字)
  const isInstall = !installed;
  const hasUpdate = installed && latest && installed !== latest;
  if (isInstall || hasUpdate) {
    els.pluginActionBtn.hidden = false;
    els.pluginActionBtn.disabled = false;
    els.pluginActionBtn.textContent = isInstall ? "安装" : "更新";
    els.pluginInstalledLabel.hidden = true;
  } else {
    els.pluginActionBtn.hidden = true;
    els.pluginInstalledLabel.hidden = false;
  }
}

/** 查一次插件(本地 + registry)并渲染;每次进入面板都查 */
async function loadPluginInfo() {
  els.pluginHint.hidden = false;
  els.pluginHint.textContent = "正在检查…";
  try {
    renderPlugin(await window.dsh.getPluginInfo());
    els.pluginHint.hidden = true;
  } catch (error) {
    els.pluginHint.hidden = true;
    renderPlugin({ error: String(error), installed: null });
  }
}

/** 安装/更新(主进程负责停服 → dsh plugin add → 恢复服务) */
async function doPluginInstall(version, btn, isInstall) {
  if (pluginInstalling) return;
  const verb = isInstall ? "安装" : "更新";
  const question = isInstall
    ? `确定安装 dsh-better-sidebar ${version} 吗?\n\n需要联网下载,完成后 dsh 服务会自动重启以加载插件。`
    : `确定将 dsh-better-sidebar 更新到 ${version} 吗?\n\n完成后 dsh 服务会自动重启以加载新版本。`;
  if (!confirm(question)) return;
  pluginInstalling = true;
  btn.disabled = true;
  btn.textContent = `${verb}中…`;
  els.pluginHint.hidden = false;
  els.pluginHint.textContent = `正在${verb} dsh-better-sidebar ${version},请稍候…`;
  try {
    const res = await window.dsh.installPlugin(version);
    if (res.ok) {
      els.pluginHint.textContent = res.unchanged
        ? `当前已是 ${res.installed}`
        : `已${verb}到 ${res.installed}${res.restarted ? ",服务已重启" : ",启动服务后生效"}`;
      await loadPluginInfo();
    } else {
      els.pluginHint.textContent = `${verb}失败: ${res.error}`;
    }
  } catch (error) {
    els.pluginHint.textContent = `${verb}失败: ${error}`;
  } finally {
    pluginInstalling = false;
  }
}

// ---------- 应用内升级(DSH 本体,链路不变) ----------

async function doUpgrade(version, btn) {
  if (upgrading) return;
  const ok = confirm(
    `确定将 dsh 升级到 ${version} 吗?\n\n升级过程会短暂停止当前服务,完成后自动恢复。`
  );
  if (!ok) return;
  upgrading = true;
  btn.disabled = true;
  btn.textContent = "升级中…";
  els.upgradeHint.hidden = false;
  els.upgradeHint.textContent = `正在下载并安装 dsh ${version},请稍候…`;
  try {
    const res = await window.dsh.upgrade(version);
    if (res.ok) {
      els.upgradeHint.textContent = res.unchanged
        ? `当前已是 ${res.installed},无需升级`
        : `已升级到 ${res.installed}(原 ${res.previous} 已备份)`;
      await Promise.all([refreshInfo(), loadVersions()]);
    } else {
      els.upgradeHint.textContent = `升级失败: ${res.error}`;
    }
  } catch (error) {
    els.upgradeHint.textContent = `升级失败: ${error}`;
  } finally {
    upgrading = false;
  }
}

// ---------- 事件 ----------

els.startBtn.addEventListener("click", async () => {
  if (upgrading) return;
  els.startBtn.disabled = true;
  els.startBtn.textContent = "正在启动…";
  els.serviceHint.hidden = true;
  try {
    await window.dsh.retry();
  } catch (error) {
    els.serviceHint.hidden = false;
    els.serviceHint.textContent = `启动失败: ${error}`;
  }
  refreshInfo();
});

els.dshUpdateBtn.addEventListener("click", () => {
  doUpgrade(els.dshVersionLink.textContent, els.dshUpdateBtn);
});

els.dshRetryBtn.addEventListener("click", () => {
  loadVersions();
});

els.pluginRetryBtn.addEventListener("click", () => {
  loadPluginInfo();
});

els.pluginActionBtn.addEventListener("click", () => {
  doPluginInstall(lastPluginInfo?.latest ?? null, els.pluginActionBtn, !lastPluginInfo?.installed);
});

// ---------- 初始化 ----------

// 主进程推送服务状态 → 实时刷新徽标与按钮(升级/启停过程中跟着变)
window.dsh.onStatus((status) => {
  if (currentInfo) {
    renderStatus({ ...currentInfo, state: status.state, message: status.message });
  } else {
    refreshInfo();
  }
});

// 进入页面:拉一次服务信息 + 查一次 npm 版本 + 查一次插件
refreshInfo();
loadVersions();
loadPluginInfo();