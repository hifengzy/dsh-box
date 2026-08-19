"use strict";

/**
 * dsh-status.js — 「dsh 服务与版本」右侧面板逻辑。
 *
 * 面板由顶栏状态按钮(或菜单)开关,自身不提供关闭按钮。
 * 数据全部经 preload 桥(window.dsh.*):
 *   - 服务状态:getInfo() 拉一次 + onStatus 订阅主进程实时推送
 *     (状态机:starting | ready | error | stopped);
 *   - 版本列表:每次打开面板(视图新建)时 checkUpdates() 查一次 npm
 *     (registry JSON API),按发布时间倒序;每行带「最新 / 当前」徽标;
 *     比当前运行版本新的行显示「更新」按钮;
 *   - 升级:upgrade(version) → 主进程 停服 → 下载/校验/原子替换 → 恢复。
 */

const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $("statusDot"),
  statusLabel: $("statusLabel"),
  versionChip: $("versionChip"),
  metaLine: $("metaLine"),
  homeLine: $("homeLine"),
  logLine: $("logLine"),
  errorBox: $("errorBox"),
  errorDetail: $("errorDetail"),
  startBtn: $("startBtn"),
  stopBtn: $("stopBtn"),
  restartBtn: $("restartBtn"),
  serviceHint: $("serviceHint"),
  lastCheck: $("lastCheck"),
  updateBanner: $("updateBanner"),
  bannerVersion: $("bannerVersion"),
  offlineNote: $("offlineNote"),
  versionList: $("versionList"),
  upgradeHint: $("upgradeHint"),
  refreshBtn: $("refreshBtn"),
};

let currentInfo = null;
let upgrading = false;

const STATE_META = {
  ready: { label: "运行中", dot: "ok" },
  starting: { label: "正在启动", dot: "busy" },
  error: { label: "启动失败", dot: "err" },
  stopped: { label: "未运行", dot: "idle" },
};
const DEFAULT_META = { label: "状态未知", dot: "idle" };

/** 渲染当前服务卡 */
function renderStatus(info) {
  if (!info) return;
  currentInfo = info;
  const meta = STATE_META[info.state] || DEFAULT_META;
  els.statusDot.className = `dot ${meta.dot}`;
  els.statusLabel.textContent = meta.label;
  els.versionChip.textContent = info.version ? `dsh ${info.version}` : "dsh(版本未知)";

  const parts = [`端口 ${info.port}`];
  if (info.pid) parts.push(`PID ${info.pid}`);
  els.metaLine.textContent = parts.join(" · ");
  els.homeLine.textContent = info.dshHome ? `DSH_HOME  ${info.dshHome}` : "";
  els.logLine.textContent = info.logFile ? `日志  ${info.logFile}` : "";

  const isError = info.state === "error";
  els.errorBox.hidden = !isError;
  els.errorDetail.textContent = info.message || "";

  // 动作按钮:未运行/失败 → 启动;运行中 → 停止/重启;启动中 → 占位
  const needsStart = info.state === "stopped" || info.state === "error";
  els.startBtn.hidden = !needsStart;
  els.startBtn.disabled = info.state === "starting";
  els.startBtn.textContent = info.state === "starting" ? "启动中…" : "启动服务";
  els.stopBtn.hidden = info.state !== "ready";
  els.restartBtn.hidden = info.state !== "ready";
}

async function refreshInfo() {
  try {
    renderStatus(await window.dsh.getInfo());
  } catch (error) {
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

/** 渲染版本列表 */
function renderVersionList(res) {
  if (res.checkedAt) {
    const when = new Date(res.checkedAt).toLocaleString();
    els.lastCheck.textContent = `检查于 ${when}${res.fromCache ? "(缓存)" : ""}`;
  } else {
    els.lastCheck.textContent = "";
  }

  els.offlineNote.hidden = !res.error;
  if (res.error) {
    els.offlineNote.textContent = `无法连接 npm registry:${res.error}${
      res.rows && res.rows.length ? "。以下为上次缓存结果。" : ""
    }`;
  }

  els.updateBanner.hidden = !res.hasUpdate;
  els.bannerVersion.textContent = res.latest ? `v${res.latest}` : "";

  els.versionList.textContent = "";
  if (!res.rows || !res.rows.length) {
    els.versionList.textContent = "暂无版本信息";
    return;
  }
  for (const row of res.rows) {
    const el = document.createElement("div");
    el.className = "vrow";

    // 第一段:版本号 + 徽标 + 更新按钮(按钮靠右)
    const top = document.createElement("div");
    top.className = "vrow-top";

    const ver = document.createElement("span");
    ver.className = "v-version";
    ver.textContent = row.version;

    const badges = document.createElement("span");
    badges.className = "v-badges";
    if (row.isLatest) {
      const b = document.createElement("span");
      b.className = "badge badge-latest";
      b.textContent = "最新";
      badges.appendChild(b);
    }
    if (row.isCurrent) {
      const b = document.createElement("span");
      b.className = "badge badge-current";
      b.textContent = "当前";
      badges.appendChild(b);
    }

    top.append(ver, badges);

    // 只有比当前运行版本新的版本才显示「更新」按钮
    if (row.hasUpdate) {
      const btn = document.createElement("button");
      btn.className = "btn btn-primary v-update";
      btn.textContent = "更新";
      btn.addEventListener("click", () => doUpgrade(row.version, btn));
      top.appendChild(btn);
    }

    // 第二段:发布日期
    const date = document.createElement("div");
    date.className = "v-date";
    date.textContent = fmtDate(row.publishedAt);

    el.append(top, date);
    els.versionList.appendChild(el);
  }
}

/** 查一次 npm 并渲染(每次进入页面都查) */
async function loadVersions() {
  els.upgradeHint.textContent = "正在检查 npm…";
  try {
    const res = await window.dsh.checkUpdates();
    renderVersionList(res);
    els.upgradeHint.textContent = "";
  } catch (error) {
    els.upgradeHint.textContent = `检查失败: ${error}`;
  }
}

/** 应用内升级 */
async function doUpgrade(version, btn) {
  if (upgrading) return;
  const ok = confirm(
    `确定将 dsh 升级到 ${version} 吗?\n\n升级过程会短暂停止当前服务,完成后自动恢复。`
  );
  if (!ok) return;
  upgrading = true;
  btn.disabled = true;
  btn.textContent = "升级中…";
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
  try {
    await window.dsh.retry();
  } catch (error) {
    els.serviceHint.textContent = `启动失败: ${error}`;
  }
  refreshInfo();
});

els.stopBtn.addEventListener("click", async () => {
  els.stopBtn.disabled = true;
  try {
    await window.dsh.stopServer();
  } catch (error) {
    els.serviceHint.textContent = `停止失败: ${error}`;
  }
  refreshInfo();
});

els.restartBtn.addEventListener("click", async () => {
  els.restartBtn.disabled = true;
  els.restartBtn.textContent = "重启中…";
  try {
    await window.dsh.retry();
  } catch (error) {
    els.serviceHint.textContent = `重启失败: ${error}`;
  }
  refreshInfo();
});

els.refreshBtn.addEventListener("click", () => {
  loadVersions();
});

// ---------- 初始化 ----------
// 主进程推送服务状态 → 实时更新卡片(升级/启停过程中卡片跟着变)
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