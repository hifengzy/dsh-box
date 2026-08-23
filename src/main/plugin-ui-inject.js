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

/**
 * MARKET_BRIDGE_JS_FN — 插件市场(dshmarket)外壳定制注入体:
 *
 *   1) 设置弹窗导航里「插件市场」标签页按钮:隐藏 dsh 默认齿轮图标,
 *      替换为 chajian.svg(方块网格,currentColor 16px);
 *   2) DSH 左侧边栏底部「设置」按钮上方注入「插件」入口按钮:完全
 *      克隆「设置」按钮(同 class + 同内部结构,只换图标与文本)→ dsh
 *      对侧栏按钮的样式(宽/窄 rail 两态、hover、label 隐藏)自动继承,
 *      与「设置」零差异;点击 = 打开设置并激活插件市场页;显隐受
 *      `marketEntry` 开关控制(由主进程注入时写入)。
 *
 * 定位锚点全部是 dsh 公开 UI(文本 / data-slot / 克隆现有按钮的类名),
 * 不硬编码哈希类名(VOzbGW_* 等会随 dsh 构建变化,克隆即时跟随),
 * 也不触碰 dsh / dshmarket 源码。
 *
 * @param {boolean} marketEntry 开关:是否在侧边栏显示「插件」入口
 */
function MARKET_BRIDGE_JS_FN(marketEntry) {
  const enabled = !!marketEntry;
  // chajian.svg 内联(页面是 http 域,不能引用 file:// 资源;currentColor 随主题)
  const CHAJIAN_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g fill="currentColor"><rect x="1.96" y="3.36" width="3.3" height="3.3" rx="0.53"></rect><rect x="5.71" y="3.36" width="3.3" height="3.3" rx="0.53"></rect><rect x="1.96" y="7.11" width="3.3" height="3.3" rx="0.53"></rect><rect x="5.71" y="7.11" width="3.3" height="3.3" rx="0.53"></rect><rect x="9.46" y="7.11" width="3.3" height="3.3" rx="0.53"></rect><rect x="1.96" y="10.86" width="3.3" height="3.3" rx="0.53"></rect><rect x="5.71" y="10.86" width="3.3" height="3.3" rx="0.53"></rect><rect x="9.46" y="10.86" width="3.3" height="3.3" rx="0.53"></rect></g><rect x="10.74" y="2.09" width="3.3" height="3.3" rx="0.53" fill="currentColor" transform="rotate(9 12.39 3.74)"></rect></svg>';

  return `(() => {
    if (window.__dshBoxMarketBridge) return;
    let marketEntry = ${JSON.stringify(enabled)};
    let entryBtn = null;

    const makeEntry = () => {
      // 在 sidebar.settings 槽位前插入「插件」按钮:完全克隆「设置」按钮
      // (class + 内部结构原样继承)→ dsh 的样式规则(宽/窄 rail 两态、
      // hover、label 隐藏、圆角/间距)全部作用于它,与「设置」完全一致。
      const anchor = document.querySelector('[data-slot="sidebar.settings"]');
      if (!anchor) return null;
      if (document.querySelector('[data-slot="sidebar.market"]')) return null;
      const settingsBtn = anchor.querySelector('button');
      if (!settingsBtn) return null;
      const btn = settingsBtn.cloneNode(true);
      btn.removeAttribute('aria-haspopup');
      btn.removeAttribute('aria-expanded');
      btn.title = '插件市场';
      // 换图标:保留 svg 属性(尺寸/类),只替换内部图形为 chajian 方块网格
      const svg = btn.querySelector('svg');
      if (svg) {
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.innerHTML = '<g fill="currentColor"><rect x="1.96" y="3.36" width="3.3" height="3.3" rx="0.53"></rect><rect x="5.71" y="3.36" width="3.3" height="3.3" rx="0.53"></rect><rect x="1.96" y="7.11" width="3.3" height="3.3" rx="0.53"></rect><rect x="5.71" y="7.11" width="3.3" height="3.3" rx="0.53"></rect><rect x="9.46" y="7.11" width="3.3" height="3.3" rx="0.53"></rect><rect x="1.96" y="10.86" width="3.3" height="3.3" rx="0.53"></rect><rect x="5.71" y="10.86" width="3.3" height="3.3" rx="0.53"></rect><rect x="9.46" y="10.86" width="3.3" height="3.3" rx="0.53"></rect></g><rect x="10.74" y="2.09" width="3.3" height="3.3" rx="0.53" fill="currentColor" transform="rotate(9 12.39 3.74)"></rect>';
      } else {
        const holder = document.createElement('span');
        holder.style.cssText = 'display:inline-flex;';
        holder.innerHTML = '${CHAJIAN_SVG.replace(/\u0027/g, "&#39;")}';
        btn.insertBefore(holder, btn.firstChild);
      }
      // 换文本:label「设置」→「插件」
      for (const el of btn.querySelectorAll('*')) {
        if (el.children.length === 0 && (el.textContent || '').trim() === '设置') {
          el.textContent = '插件';
          break;
        }
      }
      btn.addEventListener('click', () => {
        // 打开设置 → 激活插件市场页(复用 dsh 自有交互,不调内部 API)
        const settingsBtn = document.querySelector('[data-slot="sidebar.settings"] button');
        if (settingsBtn) settingsBtn.click();
        setTimeout(() => {
          const navBtns = [...document.querySelectorAll('nav button, [role="dialog"] button')];
          const market = navBtns.find((b) => (b.textContent || '').trim() === '插件市场');
          if (market) market.click();
        }, 350);
      });
      // 槽位包装:插到 foot 区(sidebar.settings 的父)里、settingsArea 之前,
      // 与 settingsArea 平级 —— 宽/窄两态都沿 foot 的 column 上下排列,
      // 不会把按钮塞进 settingsArea 内部导致折叠时重叠。
      const wrap = document.createElement('div');
      wrap.setAttribute('data-slot', 'sidebar.market');
      wrap.style.display = 'contents';
      wrap.appendChild(btn);
      const foot = anchor.parentElement ? anchor.parentElement.parentElement : null;
      const settingsArea = anchor.parentElement;
      if (foot && settingsArea) foot.insertBefore(wrap, settingsArea);
      else if (anchor.parentElement) anchor.parentElement.insertBefore(wrap, anchor);
      return btn;
    };

    const removeEntry = () => {
      const old = document.querySelector('[data-slot="sidebar.market"]');
      if (old) old.remove();
      entryBtn = null;
    };

    // ---------- 侧边栏折叠(rail)适配 ----------
    // dsh 的 rail 收缩规则绑定了「设置」槽位(选择器含 data-slot),克隆的
    // 「插件」按钮同 class 也不命中 → 折叠后它保持宽款式。这里以「设置」
    // 按钮的计算宽度为折叠信号(展开 264px / 折叠 36px),实时给「插件」
    // 按钮补内联样式(36×36、图标居中、label 隐藏),展开时还原。
    // 不依赖任何哈希类名,仅依赖「设置按钮宽度」这个行为信号。
    let railOn = false;
    const findPluginLabel = (btn) => {
      for (const el of btn.querySelectorAll('*')) {
        if (el.children.length === 0 && (el.textContent || '').trim() === '插件') return el;
      }
      return null;
    };
    const applyRail = () => {
      const settingsAnchor = document.querySelector('[data-slot="sidebar.settings"]');
      const sb = settingsAnchor ? settingsAnchor.querySelector('button') : null;
      const next = sb ? parseInt(getComputedStyle(sb).width, 10) <= 40 : false;
      if (next === railOn) return;
      railOn = next;
      const wrap = document.querySelector('[data-slot="sidebar.market"]');
      const btn = wrap ? wrap.querySelector('button') : null;
      // 折叠时 dsh 把 foot 区高度固定为单个 36px 按钮(54px),两个按钮会
      // 重叠——把 foot 区最小高度拉高到容纳两个按钮(上下排列)。
      const footArea = settingsAnchor ? settingsAnchor.parentElement.parentElement : null;
      if (footArea) {
        footArea.style.minHeight = railOn ? '96px' : '';
        // 折叠后强制纵向排列(rail 的 foot 可能被 dsh 排成横向,两个 36px
        // 图标会被挤到同一行互相重叠)——「插件」「设置」上下各一行。
        footArea.style.flexDirection = railOn ? 'column' : '';
      }
      if (!btn) return;
      if (railOn) {
        btn.style.cssText = 'width:36px;height:36px;padding:0;justify-content:center;';
        const label = findPluginLabel(btn);
        if (label) label.style.display = 'none';
        // 折叠时 foot 区高度按单个 36px 按钮收窄,display:contents 不占位
        // 会让两个按钮重叠——改为块级占一行,foot 高度自动撑开上下排列
        wrap.style.display = 'block';
      } else {
        btn.style.cssText = '';
        const label = findPluginLabel(btn);
        if (label) label.style.display = '';
        wrap.style.display = 'contents';
      }
    };
    setInterval(applyRail, 500);

    const syncEntry = () => {
      if (!marketEntry) { removeEntry(); return; }
      if (!document.querySelector('[data-slot="sidebar.market"]')) {
        entryBtn = makeEntry();
      }
    };

    // 1) 设置弹窗导航图标替换(观察 body 子级变化,幂等)
    const patchNavIcon = () => {
      const navBtns = [...document.querySelectorAll('nav button, [role="dialog"] button')];
      const market = navBtns.find((b) => (b.textContent || '').trim() === '插件市场');
      if (!market) return false;
      if (market.querySelector('.dshbox-market-icon')) return true;
      const icon = market.querySelector('svg');
      if (icon) icon.remove();
      const holder = document.createElement('span');
      holder.className = 'dshbox-market-icon';
      holder.style.cssText = 'display:inline-flex;';
      holder.innerHTML = '${CHAJIAN_SVG.replace(/\\u0027/g, "&#39;")}';
      market.insertBefore(holder, market.firstChild);
      return true;
    };

    // 观察器:设置弹窗 / 侧边栏结构动态出现
    const observer = new MutationObserver(() => {
      patchNavIcon();
      syncEntry();
    });
    const start = () => {
      if (!document.body) { setTimeout(start, 100); return; }
      observer.observe(document.body, { childList: true, subtree: true });
      patchNavIcon();
      syncEntry();
    };
    start();
    // 插件 market 挂载晚于页面加载:延迟补查几次
    let tries = 0;
    const timer = setInterval(() => {
      patchNavIcon();
      syncEntry();
      if (++tries >= 10) clearInterval(timer);
    }, 800);

    window.__dshBoxMarketBridge = {
      setEnabled(v) {
        marketEntry = !!v;
        syncEntry();
      },
      refresh() { patchNavIcon(); syncEntry(); },
    };
  })()`;
}

module.exports = {
  PLUGIN_BRIDGE_JS,
  PLUGIN_HIDE_CSS,
  MARKET_BRIDGE_JS_FN,
};