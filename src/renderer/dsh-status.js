"use strict";

/**
 * dsh-status.js — 「服务状态 + DSH 版本」右侧面板逻辑。
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
 * DSH 版本(原「版本列表」):
 *   - 按发布时间倒序(发布时间最新 = 「最新」);
 *   - 默认显示最近 10 条,「更多」按钮每次再加载 10 条旧版本,
 *     直到全部查完隐藏「更多」;
 *   - 网络查询失败 → 「网络服务异常」+「重试」;有缓存时回退展示并提示;
 *   - 比当前运行版本新的行显示「更新」按钮(升级链路不变)。
 *
 * 侧边栏插件(dsh-better-sidebar):
 *   - 未安装 → 「安装」;已装无更新 → 无按钮;已装有更新 → 「更新」;
 *   - 网络查询失败 → 「网络服务异常」+「重试」;
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
  // 侧边栏插件
  pluginCard: $("pluginCard"),
  pluginHint: $("pluginHint"),
  // DSH 版本
  versionList: $("versionList"),
  versionError: $("versionError"),
  retryBtn: $("retryBtn"),
  cacheNote: $("cacheNote"),
  moreBtn: $("moreBtn"),
  upgradeHint: $("upgradeHint"),
};

let currentInfo = null;
let upgrading = false;
let pluginInstalling = false;

/** 版本分页:每页条数 / 当前展示条数 / 全部行缓存 */
const PAGE_SIZE = 10;
let visibleCount = 0;
let allRows = [];

// ---------- 服务状态 ----------

/** 渲染服务状态(两态:运行中 / 停止) */
function renderStatus(info) {
  if (!info) return;
  currentInfo = info;

  // 1) 版本号(超长截断,完整值放进 title)
  const versionText = info.version ? `DSH ${info.version}` : "DSH(版本未知)";
  els.versionLine.textContent = versionText;
  els.versionLine.title = versionText;

  // 2) 端口 · PID
  const running = info.state === "ready";
  els.metaLine.textContent = running
    ? `端口 ${info.port} · PID ${info.pid ?? "-"}`
    : "端口 - · PID -";

  // 3) 状态徽标:运行中(绿) / 停止(灰)
  els.statePill.classList.toggle("state-running", running);
  els.stateLabel.textContent = running ? "运行中" : "停止";

  // 4) 仅停止时显示「启动服务」;启动中禁用以防重复点击
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

// ---------- DSH 版本(列表) ----------

/** 渲染当前可见的版本行(visibleCount 条) */
function renderVersionRows() {
  els.versionList.textContent = "";
  const rows = allRows.slice(0, visibleCount);
  rows.forEach((row, index) => {
    const card = document.createElement("div");
    card.className = "vcard";

    // 上排:版本号 + 徽标 + 更新按钮
    const top = document.createElement("div");
    top.className = "vcard-top";

    const ver = document.createElement("span");
    ver.className = "v-version";
    ver.textContent = row.version;
    ver.title = row.version;

    const badges = document.createElement("span");
    badges.className = "v-badges";
    // 发布时间倒序首行 = 发布时间最新 = 「最新」(取消 dist-tag 置顶语义)
    if (index === 0) {
      const b = document.createElement("span");
      b.className = "v-badge";
      b.textContent = "最新";
      badges.appendChild(b);
    }
    if (row.isCurrent) {
      const b = document.createElement("span");
      b.className = "v-badge";
      b.textContent = "当前";
      badges.appendChild(b);
    }

    top.append(ver, badges);

    // 比当前运行版本新的行 → 更新按钮(升级链路不变)
    if (row.hasUpdate && !row.isCurrent) {
      const btn = document.createElement("button");
      btn.className = "btn btn-primary v-update";
      btn.textContent = "更新";
      btn.addEventListener("click", () => doUpgrade(row.version, btn));
      top.appendChild(btn);
    }

    // 下排:发布日期
    const date = document.createElement("div");
    date.className = "v-date";
    date.textContent = fmtDate(row.publishedAt);

    card.append(top, date);
    els.versionList.appendChild(card);
  });
}

/** 渲染版本区整体(错误 / 缓存 / 列表 + 更多按钮) */
function renderVersion(res) {
  allRows = res.rows || [];
  const failed = !!res.error || !allRows.length;

  // 查询失败:无内容可用 → 错误态 + 重试
  if (failed) {
    els.versionError.hidden = false;
    els.cacheNote.hidden = true;
    els.versionList.textContent = "";
    els.moreBtn.hidden = true;
    visibleCount = 0;
    return;
  }

  // 有缓存回退(网络失败但有上次结果)
  els.versionError.hidden = true;
  els.cacheNote.hidden = !res.fromCache;

  visibleCount = Math.min(PAGE_SIZE, allRows.length);
  renderVersionRows();

  // 还有更旧的版本 → 显示「更多」
  els.moreBtn.hidden = visibleCount >= allRows.length;
}

/** 查一次 npm 并渲染(每次进入页面都查) */
async function loadVersions() {
  els.upgradeHint.hidden = false;
  els.upgradeHint.textContent = "正在检查…";
  try {
    const res = await window.dsh.checkUpdates();
    renderVersion(res);
    els.upgradeHint.hidden = true;
  } catch (error) {
    // invoke 抛错(极端)也走错误态
    els.upgradeHint.hidden = true;
    renderVersion({ error: String(error), rows: [] });
  }
}

/** 「更多」:加载下一批 10 条旧版本 */
function loadMore() {
  visibleCount += PAGE_SIZE;
  renderVersionRows();
  els.moreBtn.hidden = visibleCount >= allRows.length;
}

// ---------- 应用内升级(链路不变) ----------

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

// ---------- 侧边栏插件(dsh-better-sidebar) ----------
// 状态机:未安装 →「安装」;已装无更新 → 无按钮;已装有更新 →「更新」;
// 网络查询失败 →「网络服务异常」+「重试」(已装时保留版本信息)。

/** 渲染插件卡片(info = getPluginInfo 结果) */
function renderPluginCard(info) {
  const card = els.pluginCard;
  card.textContent = "";
  const isInstalled = !!info.installed;
  const failed = !!info.error;

  // 名称行
  const name = document.createElement("div");
  name.className = "plugin-name";
  name.textContent = "dsh-better-sidebar";
  card.appendChild(name);

  // 未安装 + 网络失败 → 错误态(复用版本区样式)
  if (failed && !isInstalled) {
    const err = document.createElement("div");
    err.className = "version-error";
    const p = document.createElement("p");
    p.className = "error-text";
    p.textContent = "网络服务异常";
    const retry = document.createElement("button");
    retry.className = "btn btn-outline";
    retry.textContent = "重试";
    retry.addEventListener("click", () => loadPluginInfo());
    err.append(p, retry);
    card.appendChild(err);
    return;
  }

  // 版本行:未安装 / 已装(±最新)
  const meta = document.createElement("div");
  meta.className = "plugin-meta";
  const latestSuffix =
    info.latest && !info.hasUpdate && isInstalled ? " · 已是最新" : "";
  if (!isInstalled) {
    meta.textContent = info.latest ? `未安装 · 最新 ${info.latest}` : "未安装";
  } else {
    meta.textContent = info.hasUpdate
      ? `已装 ${info.installed} · 最新 ${info.latest}`
      : `已装 ${info.installed}${latestSuffix}`;
  }
  card.appendChild(meta);

  // 已装但网络失败 → 额外警示行 + 重试(不提供更新按钮,无法判断)
  if (failed && isInstalled) {
    const warn = document.createElement("div");
    warn.className = "plugin-meta plugin-meta-warn";
    warn.textContent = "网络异常,无法检查更新";
    card.appendChild(warn);
    const retry = document.createElement("button");
    retry.className = "btn btn-outline plugin-action";
    retry.textContent = "重试";
    retry.addEventListener("click", () => loadPluginInfo());
    card.appendChild(retry);
    return;
  }

  // 操作按钮:未安装 → 安装;已装有更新 → 更新;已装无更新 → 无按钮
  if (!isInstalled || info.hasUpdate) {
    const btn = document.createElement("button");
    btn.className = "btn btn-primary plugin-action";
    const isInstall = !isInstalled;
    btn.textContent = isInstall ? "安装" : "更新";
    btn.addEventListener("click", () => doPluginInstall(info.latest, btn, isInstall));
    card.appendChild(btn);
  }
}

/** 查一次插件(本地 + registry)并渲染;每次进入面板都查 */
async function loadPluginInfo() {
  els.pluginHint.hidden = false;
  els.pluginHint.textContent = "正在检查…";
  try {
    const info = await window.dsh.getPluginInfo();
    renderPluginCard(info);
    els.pluginHint.hidden = true;
  } catch (error) {
    els.pluginHint.hidden = true;
    renderPluginCard({ error: String(error), installed: null });
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

els.retryBtn.addEventListener("click", () => {
  loadVersions();
});

els.moreBtn.addEventListener("click", () => {
  loadMore();
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