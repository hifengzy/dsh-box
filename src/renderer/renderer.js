"use strict";

/**
 * renderer.js — 启动页逻辑。
 *
 * 主进程会推状态过来:
 *   { state: "starting" | "ready" | "error", message }
 * 就绪后主进程会直接把窗口切到 dsh Web UI,这里只负责
 * 显示「启动中 / 失败」两种状态和重试按钮。
 */

const statusEl = document.getElementById("status");
const spinnerEl = document.getElementById("spinner");
const errorPanel = document.getElementById("errorPanel");
const errorMessageEl = document.getElementById("errorMessage");
const retryBtn = document.getElementById("retryBtn");

// 双击隐形标题栏 = 最大化/还原(macOS 惯例)
document.getElementById("dragStrip").addEventListener("dblclick", () => {
  window.dsh.toggleMaximize();
});

function setStatus(state, message) {
  statusEl.textContent = message || "…";
  const loading = state === "starting" || state === "ready";
  spinnerEl.hidden = !loading;
  errorPanel.hidden = state !== "error";
  if (state === "error") {
    errorMessageEl.textContent = message || "未知错误";
  }
}

retryBtn.addEventListener("click", async () => {
  retryBtn.disabled = true;
  retryBtn.textContent = "正在重试…";
  setStatus("starting", "正在重新启动 dsh 服务…");
  try {
    await window.dsh.retry();
  } catch (error) {
    setStatus("error", String(error));
  } finally {
    retryBtn.disabled = false;
    retryBtn.textContent = "重试";
  }
});

// 订阅主进程推送的状态
window.dsh.onStatus(setStatus);

// 启动时先拉一次当前状态(比如主进程已经就绪、窗口刚重建)
window.dsh
  .getInfo()
  .then((info) => {
    if (info.ready) {
      setStatus("ready", `服务已就绪: ${info.url}`);
    }
  })
  .catch(() => {});
