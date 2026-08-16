"use strict";

/**
 * renderer.js — 启动加载页逻辑。
 *
 * 主进程推送状态:
 *   { state: "starting" | "ready" | "error", message }
 * 就绪后主进程会把内容视图切到 dsh WebUI,这里只负责:
 *   - 显示加载动画 + 「服务启动中:<url>」(url 端口动态);
 *   - 失败时显示「服务启动失败」+ 错误详情 + 底部「重试」按钮。
 */

const loadingEl = document.getElementById("loading");
const loadingTextEl = document.getElementById("loadingText");
const errorEl = document.getElementById("error");
const errorDetailEl = document.getElementById("errorDetail");
const retryBtn = document.getElementById("retryBtn");

function showLoading() {
  loadingEl.hidden = false;
  errorEl.hidden = true;
  retryBtn.hidden = true;
}

function showError(message) {
  loadingEl.hidden = true;
  errorEl.hidden = false;
  retryBtn.hidden = false;
  errorDetailEl.textContent = message || "";
}

retryBtn.addEventListener("click", async () => {
  retryBtn.disabled = true;
  retryBtn.textContent = "正在重试…";
  showLoading();
  try {
    await window.dsh.retry();
  } catch (error) {
    showError(String(error));
  } finally {
    retryBtn.disabled = false;
    retryBtn.textContent = "重试";
  }
});

// 订阅主进程推送的状态
window.dsh.onStatus((status) => {
  if (status.state === "error") showError(status.message);
  else if (status.state === "starting" || status.state === "ready") showLoading();
});

// 启动时拉取服务信息,显示动态端口文案(如 服务启动中: http://127.0.0.1:3260)
window.dsh
  .getInfo()
  .then((info) => {
    if (info && info.url) {
      loadingTextEl.textContent = `服务启动中: ${info.url}`;
    }
  })
  .catch(() => {});
