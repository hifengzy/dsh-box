"use strict";

/**
 * plugin-ui-inject.js — 注入 dsh 页面(dsh-better-sidebar 所在环境)的桥脚本与隐藏样式。
 *
 * PLUGIN_BRIDGE_JS:DSH Box 顶栏的两个按钮(侧栏/底栏切换)经主进程
 * executeJavaScript 调到这里,模拟点击插件自己的 toggle 按钮 — React store
 * 全同步(宽度/角标/布局变量都由插件自身处理)。同时把面板开合状态上报给
 * 外壳(顶栏按钮高亮),信号用插件公开的布局钩子:
 *   - 侧栏开合:body[data-dsh-sidebar-collapsed] 属性(有=折叠)
 *   - 底栏开合:documentElement 的 --dsh-sidebar-height 变量(非 0px=展开)
 * 插件未安装/未挂载时 installed=false,顶栏按钮保持禁用。
 *
 * PLUGIN_HIDE_CSS:隐藏插件自带的右上角两个 toggle 入口(侧栏/底栏切换按钮)。
 * visibility 保留它预留的 72px 空位 → 布局零扰动、跨版本最稳。
 */

const PLUGIN_BRIDGE_JS = `
(() => {
  if (window.__dshBoxPluginBridge) return;
  const api = {
    installed() {
      return !!document.querySelector('[data-dsh-toggle-cluster]');
    },
    toggle(which) {
      const cluster = document.querySelector('[data-dsh-toggle-cluster]');
      if (!cluster) return { ok: false, error: 'plugin-not-mounted' };
      const buttons = Array.from(cluster.querySelectorAll('button'));
      // 插件 DOM 顺序固定:第一个 = 底栏,最后一个 = 侧栏(narrow 只有侧栏)
      const btn = which === 'side' ? buttons[buttons.length - 1]
        : which === 'bottom' ? buttons[0]
        : null;
      if (!btn) return { ok: false, error: 'toggle-missing' };
      btn.click();
      return { ok: true };
    },
    state() {
      const collapsed = document.body.hasAttribute('data-dsh-sidebar-collapsed');
      const h = document.documentElement.style.getPropertyValue('--dsh-sidebar-height').trim();
      const cluster = document.querySelector('[data-dsh-toggle-cluster]');
      // 无活跃会话时插件自己的 toggle 按钮是 disabled 的(侧栏 per-session):
      // 外壳据此禁用顶栏按钮,避免点了没反应。
      let active = false;
      if (cluster) {
        active = Array.from(cluster.querySelectorAll('button')).some((b) => !b.disabled);
      }
      return {
        installed: this.installed(),
        active,
        side: !collapsed,
        bottom: h !== '' && h !== '0px',
      };
    },
  };
  window.__dshBoxPluginBridge = api;
  const report = () => {
    try {
      if (window.dsh && window.dsh.reportPluginPanels) {
        window.dsh.reportPluginPanels(api.state());
      }
    } catch { /* 上报失败不影响页面 */ }
  };
  const start = () => {
    if (!document.body) { setTimeout(start, 100); return; }
    const observer = new MutationObserver(report);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-dsh-sidebar-collapsed'],
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    });
    report();
  };
  start();
  // 插件 mount 晚于页面加载:延迟补报几次,直到 cluster 出现(或放弃)
  let tries = 0;
  const timer = setInterval(() => {
    if (api.installed() || ++tries >= 8) {
      report();
      clearInterval(timer);
    }
  }, 500);
})();
`;

const PLUGIN_HIDE_CSS = `
[data-dsh-toggle-cluster] {
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
`;

module.exports = { PLUGIN_BRIDGE_JS, PLUGIN_HIDE_CSS };