"use strict";

/**
 * app-updater.js — DSH Box 应用自更新的状态机封装(PR-1,UI 驱动用)。
 *
 * 底层 = electron-updater(macOS 上基于 Squirrel.Mac:下载 zip → 退出前 spawn
 * helper → 替换 .app → 重启)。本模块把它的离散事件汇流成一份稳定的
 * 状态对象,供顶栏「新版本」按钮渲染:
 *
 *   idle → checking → available | up-to-date | error
 *        → downloading(percent) → downloaded → installing → error(可重试)
 *
 * 设计约束:
 *   - autoUpdater 实例可注入(回归用 fake,见 regression-app-updater.js),
 *     provider 满足 electron-updater AppUpdater 接口即可(事件 + checkForUpdates
 *     / downloadUpdate / quitAndInstall);
 *   - dev 守卫:app.isPackaged === false(dev-launch 克隆 Electron.app 跑仓库)
 *     时自动置 disabled,所有动作为 no-op —— 自更新只对打包产物生效;
 *   - 不做「忽略此版本」(用户拍板砍掉);下载与安装均为手动触发(点「新版本」
  *     → 下载,点「安装」→ 安装);electron-updater 默认 autoDownload=true
  *     (发现新版本即自动下载),必须在 init 时显式关闭;
 *   - 网络错误进入 error 态,「重试」= 重新下载(回到 downloading)。
 *   - 手动检查(菜单「检查更新…」)带 notify 回调:检查结束把结果告诉调用方
 *     ——「已是最新」或「检查失败」需要弹窗告知用户;启动静默检查不传,
 *     保持静默。发现新版本不回调(顶栏「新版本」按钮即为反馈)。
 */

/** 更新状态机可能状态 */
const UPDATE_STATES = [
  "idle",      // 未检查
  "disabled",  // dev/非打包环境:不参与自更新
  "checking",  // 正在检查更新
  "available", // 发现新版本(未下载)——顶栏「新版本」按钮
  "up-to-date",// 已是最新
  "downloading", // 下载中(percent 0~100)
  "downloaded",  // 下载完成——顶栏「安装」按钮
  "installing",  // 安装中(quitAndInstall 已触发)
  "error",       // 检查/下载失败——「重试」
];

/** 下载停滞阈值(0% 停留超过该时长自动转 error,对抗审查 P2-C5) */
const DOWNLOAD_STALL_MS = 90_000;

/**
 * 创建更新状态机。
 * @param {object} opts
 * @param {object} opts.autoUpdater electron-updater 的 autoUpdater(或 fake)
 * @param {boolean} [opts.isPackaged=false] 是否打包环境(dev 守卫)
 * @param {(state: object) => void} [opts.onChange] 状态变化回调(广播)
 * @param {(msg: string) => void} [opts.log=console.log] 日志
 * @returns {object} 状态机实例(init/checkForUpdates/startDownload/installUpdate/getState/resetError)
 */
function createAppUpdater({ autoUpdater, isPackaged = false, onChange, log = console.log, stallMs: stallMsOpt }) {
  // log 入参兼容函数(默认 console.log)与对象(main.js 传 log: console)
  const logFn = typeof log === "function" ? log : (...args) => { if (log && typeof log.log === "function") log.log(...args); };
  let state = "idle";
  let percent = 0;
  let version = null;
  let error = null;
  let initialized = false;
  /** 手动检查的结束回调(仅一次;取走即清空,自动检查/发现新版本时无值) */
  let pendingNotify = null;
  /** 下载连续失败次数:≥ DOWNLOAD_FAIL_LIMIT 后「重试」降级为重新检查,
   *  防止 feed 版本被撤回后 forever 撞 404(对抗审查 P2-C2) */
  let downloadFailures = 0;
  /** 下载停滞定时器(0% 超阈值自动转 error);null = 未在计 */
  let stallTimer = null;
  /** 下载停滞阈值(0% 停留时长);可注入(回归用小值) */
  const stallMs = stallMsOpt ?? DOWNLOAD_STALL_MS;

  const takeNotify = () => {
    const n = pendingNotify;
    pendingNotify = null;
    return n;
  };

  const setState = (next, extra = {}) => {
    state = next;
    if (extra.percent !== undefined) percent = extra.percent;
    if (extra.version !== undefined) version = extra.version;
    if (extra.error !== undefined) error = extra.error;
    onChange?.({ state, percent, version, error });
  };

  // ---------- electron-updater 事件 → 状态 ----------
  const wire = () => {
    const au = autoUpdater;
    au.on("checking-for-update", () => setState("checking"));
    au.on("update-available", (info) => {
      takeNotify(); // 有新版:顶栏按钮即反馈,无弹窗
      downloadFailures = 0; // 新一轮检查重新开始计数
      setState("available", { version: info && info.version });
      logFn(`[app-update] 发现新版本: ${(info && info.version) || "?"}`);
    });
    au.on("update-not-available", () => {
      // 已是最新:清掉可能残留的 version —— 否则 feed 撤版后旧 version 会
      // 让 retry 永远走「重新下载」撞 404(P2-C2 幽灵可用版本路径)
      setState("up-to-date", { version: null, error: null });
      downloadFailures = 0;
      logFn("[app-update] 已是最新");
      const n = takeNotify();
      if (n) n("up-to-date"); // 手动检查 → 「当前没有可用的更新」弹窗
    });
    au.on("download-progress", (p) => {
      // percent 可能为字符串/小数,统一为 0~100 数字;按钮涂色直接消费
      const pct = Math.max(0, Math.min(100, Math.round(Number(p && p.percent) || 0)));
      // 首个真实进度(>0)到达 → 解除停滞守卫(黑洞场景不会再误转)
      if (pct > 0) clearStallTimer();
      setState("downloading", { percent: pct });
    });
    au.on("update-downloaded", (info) => {
      downloadFailures = 0;
      setState("downloaded", { percent: 100, version: info && info.version });
      logFn("[app-update] 下载完成,等待安装");
    });
    au.on("error", (err) => {
      const message = (err && err.message) || String(err);
      // 下载失败计数(version 有值 = 失败发生在下载阶段);404/404 类(版本被
      // 撤回/资产消失)主动清 version,让重试走向「重新检查」而非死磕下载
      if (version !== null) downloadFailures += 1;
      else downloadFailures = 0;
      if (/404|not found/i.test(message)) {
        downloadFailures = 0;
        setState("error", { version: null, error: message });
      } else {
        setState("error", { error: message });
      }
      logFn(`[app-update] 更新错误: ${message}`);
      const n = takeNotify();
      if (n) n({ error: message }); // 手动检查失败 → 错误弹窗
    });
  };

  /**
   * 初始化:挂事件 + dev 守卫 + 启动节流检查一次。
   * @param {boolean} [checkOnStart=true] 启动后自动检查一次
   */
  const init = async ({ checkOnStart = true } = {}) => {
    if (initialized) return;
    initialized = true;
    if (!isPackaged) {
      setState("disabled", { version: null });
      logFn("[app-update] dev 模式:自更新禁用");
      return;
    }
    try {
      // electron-updater 默认 autoDownload=true(发现新版本即自动下载);
      // 本产品拍板「手动下载」—— 必须显式关闭,否则顶栏「新版本」出现前
      // 下载就已开始(用户看到的「没点就下载」bug)。fake 无此属性也无妨
      // (普通赋值)。
      autoUpdater.autoDownload = false;
      wire();
    } catch (err) {
      setState("disabled", { error: String(err && err.message || err) });
      logFn("[app-update] autoUpdater 不可用:", err);
      return;
    }
    if (checkOnStart) {
      checkForUpdates().catch(() => {});
    }
  };

  /** 手动检查更新(菜单「检查更新…」)
   * @param {object} [opts] { notify?: (outcome) => void }
   *   notify: 检查结束回调,outcome = "up-to-date"(已是最新,弹窗)
   *   或 { error: string }(检查失败,弹窗)。发现新版本不回调(顶栏按钮即反馈);
   *   启动静默检查不传 → 保持静默。
   */
  const checkForUpdates = async ({ notify = null } = {}) => {
    if (!initialized || !isPackaged) return;
    if (notify) pendingNotify = notify;
    setState("checking");
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // electron-updater 多数错误经 error 事件到达;同步抛错兜底(事件路径
      // 已 takeNotify 则这里不再重复回调)
      const n = takeNotify();
      const message = (err && err.message) || String(err);
      setState("error", { error: message });
      if (n) n({ error: message });
    }
  };

  /** 下载停滞守卫(对抗审查 P2-C5):0% 停留超过阈值自动转 error —— 黑洞型
   * 网络(连接建立后吞吐归零)下不再无限扫光。收到首个真实进度即解除。 */
  const clearStallTimer = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  /** 开始下载(顶栏「新版本」→ 下载中,后台进行) */
  const startDownload = async () => {
    if (!initialized || !isPackaged) return;
    // 点击即反馈:不等 electron-updater 首个 download-progress 事件(可能延迟
    // 数秒,尤其私有仓库 token 重定向链),先置「下载中 0%」,顶栏立即响应;
    // 0% 静默期间 fill 扫光 loading 动画,首个真实进度到达后接管(见 topbar.css)。
    setState("downloading", { percent: 0 });
    clearStallTimer();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (state !== "downloading") return;
      logFn("[app-update] 下载长时间无进展,自动转到错误态");
      setState("error", { error: "下载长时间无进展(可能网络受限),请重试" });
    }, stallMs);
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      clearStallTimer();
      setState("error", { error: (err && err.message) || String(err) });
    }
    clearStallTimer();
  };

  /** 手动安装(顶栏「安装」→ Squirrel 退出+替换+重启;不自动触发) */
  const installUpdate = () => {
    if (!initialized || !isPackaged) return;
    if (state !== "downloaded") {
      logFn("[app-update] 未下载完成,忽略安装请求");
      return;
    }
    setState("installing");
    try {
      autoUpdater.quitAndInstall();
    } catch (err) {
      setState("error", { error: (err && err.message) || String(err) });
    }
  };

  /** 错误后重试 = 重新下载(按钮「重试」) */
  const restartDownload = () => {
    if (!initialized || !isPackaged) return;
    resetError();
    startDownload().catch(() => {});
  };

  /** 错误态「重试」分流(顶栏「重试」按钮):
   *   - 下载失败且未超过连续失败上限(version 有值)→ 重新下载;
   *   - 检查失败(version 为 null,如 feed 404/网络不可达)→ 重新检查 ——
   *     不能走 startDownload(无 updateInfo 会立即再次失败,重试死循环);
   *   - 下载连续失败 ≥ DOWNLOAD_FAIL_LIMIT(如 feed 撤版)→ 降级为重新检查,
   *     不再死磕下载(P2-C2 幽灵可用版本唯一路径)。
   */
  const DOWNLOAD_FAIL_LIMIT = 2;
  const retry = () => {
    if (!initialized || !isPackaged) return;
    if (state !== "error") return;
    if (version && downloadFailures < DOWNLOAD_FAIL_LIMIT) restartDownload();
    else checkForUpdates().catch(() => {});
  };

  const resetError = () => {
    if (state !== "error") return;
    if (version) setState("available", { version, error: null });
    else setState("idle", { error: null });
  };

  return {
    init,
    checkForUpdates,
    startDownload,
    installUpdate,
    restartDownload,
    retry,
    resetError,
    getState: () => ({ state, percent, version, error }),
  };
}

module.exports = { createAppUpdater, UPDATE_STATES };