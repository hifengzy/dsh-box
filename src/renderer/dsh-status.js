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

// 进入页面:拉一次服务信息 + 查一次 npm 版本
refreshInfo();
loadVersions();