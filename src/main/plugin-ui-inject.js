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
  // 状态变化才上报(避免 IPC 洪峰);初始与每次变化各报一次。
  let lastReported = null;
  const report = () => {
    let state;
    try { state = api.state(); } catch { return; }
    const key = JSON.stringify(state);
    if (key === lastReported) return;
    lastReported = key;
    try {
      if (window.dsh && window.dsh.reportPluginPanels) {
        window.dsh.reportPluginPanels(state);
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
  // 常驻低频兜底轮询:覆盖 observer 覆盖不到的 DOM 变化(如会话激活时
  // cluster 按钮从 disabled 解除——按钮属性变化不触发 body/style 观察),
  // 保证顶栏开关状态始终跟随插件真实状态(此前只补报 4 秒,之后永远灰)。
  setInterval(report, 2000);
})();
`;

const PLUGIN_HIDE_CSS = `
/* 隐藏插件自带的右上角两个 toggle 入口(侧栏/底栏切换按钮)。
 * display:none 彻底移除(不保留占位);按钮仍在 DOM 中,桥的 toggle 用
 * .click() 触发不受影响(事件派发不依赖可见性)。
 * 同时回收「折叠态页头」的占位:插件为 cluster 预留的 78px 右 padding
 * 与 cluster 显隐无关,折叠态下把页头恢复为默认 28px 右间距。
 * (面板打开时 tab strip 的 72px 由插件哈希类控制,无法回收——保持原样。)
 */
[data-dsh-toggle-cluster] {
  display: none !important;
}
body[data-dsh-sidebar-collapsed] [data-slot="conversation.session.header"] > header {
  padding-right: 28px !important;
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
      // 换图标:保留 svg 类,尺寸跟随「设置」图标的当前尺寸(不同 dsh 版本
      // 规格可能不同,如 16×16 / 18×18),替换内部图形为 chajian 方块网格
      const svg = btn.querySelector('svg');
      if (svg) {
        const sSvg = settingsBtn.querySelector('svg');
        if (sSvg) {
          svg.setAttribute('width', sSvg.getAttribute('width') || '16');
          svg.setAttribute('height', sSvg.getAttribute('height') || '16');
          const scs = getComputedStyle(sSvg);
          if (parseInt(scs.width, 10) > 0) {
            svg.style.width = scs.width;
            svg.style.height = scs.height;
          }
        }
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.innerHTML = '<g fill="currentColor"><rect x="1.96" y="3.36" width="3.3" height="3.3" rx="0.53"></rect><rect x="5.71" y="3.36" width="3.3" height="3.3" rx="0.53"></rect><rect x="1.96" y="7.11" width="3.3" height="3.3" rx="0.53"></rect><rect x="5.71" y="7.11" width="3.3" height="3.3" rx="0.53"></rect><rect x="9.46" y="7.11" width="3.3" height="3.3" rx="0.53"></rect><rect x="1.96" y="10.86" width="3.3" height="3.3" rx="0.53"></rect><rect x="5.71" y="10.86" width="3.3" height="3.3" rx="0.53"></rect><rect x="9.46" y="10.86" width="3.3" height="3.3" rx="0.53"></rect></g><rect x="10.74" y="2.09" width="3.3" height="3.3" rx="0.53" fill="currentColor" transform="rotate(9 12.39 3.74)"></rect>';
      } else {
        const holder = document.createElement('span');
        holder.style.cssText = 'display:inline-flex;';
        holder.innerHTML = '${CHAJIAN_SVG.replace(/\u0027/g, "&#39;")}';
        btn.insertBefore(holder, btn.firstChild);
      }
      // 换文本:确保 label 叶子存在且为「插件」。
      // 注意:若在侧栏折叠态下克隆,「设置」按钮的 label 文本已被 dsh
      // 清空(label 元素空文本)→ 上面「文本==='设置'」匹配不到 → 按钮会
      // 缺「插件」文字。这里兜底:优先复用空 label 元素,否则补建一个。
      let pluginLabel = null;
      for (const el of btn.querySelectorAll('*')) {
        if (el.children.length > 0) continue;
        const text = (el.textContent || '').trim();
        if (text === '设置') { pluginLabel = el; break; }
        if (el.tagName === 'SPAN' && text === '') { pluginLabel = el; }
      }
      if (!pluginLabel) {
        pluginLabel = document.createElement('span');
        btn.appendChild(pluginLabel);
      }
      pluginLabel.textContent = '插件';
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

    const syncEntry = () => {
      if (!marketEntry) { removeEntry(); return; }
      if (!document.querySelector('[data-slot="sidebar.market"]')) {
        entryBtn = makeEntry();
        // 新按钮立即按当前折叠状态应用内联样式(railOn 可能已为 true,
        // 普通 applyRailState 会因防重入跳过,必须强制同步一次)。
        applyRailState(railSignal(), true);
      }
    };

    // ---------- 侧边栏折叠(rail)适配 ----------
    // dsh 的 rail 收缩规则绑定「设置」槽位(选择器含 data-slot),克隆的
    // 「插件」按钮同 class 也不命中(折叠尺寸/圆角/label 隐藏都跟着丢)。
    // 这里以「设置」按钮的计算宽度为折叠信号(展开 264px / 折叠 36px),
    // 用 ResizeObserver 实时跟随宽度动画(每帧回调,与 dsh 同步),折叠时
    // 给「插件」按钮补内联样式:36×36、border-radius:50%(与「设置」的
    // 纯圆 hover 一致)、图标居中、label 隐藏;foot 区最小高度抬高容纳
    // 两枚按钮并保持纵向排列;展开时全部还原。不依赖任何哈希类名。
    let railOn = false;
    const findPluginLabel = (btn) => {
      for (const el of btn.querySelectorAll('*')) {
        if (el.children.length === 0 && (el.textContent || '').trim() === '插件') return el;
      }
      return null;
    };
    // 克隆发生在任意折叠状态,按钮可能带着「当时」的 rail 专用类
    // (如 VOzbGW_rail),展开后残留会让它保持 36px。这里让按钮的类
    // 始终跟随「设置」按钮的当前类(折叠=带 rail 类,展开=基础类)。
    const syncBtnClass = () => {
      const sb = document.querySelector('[data-slot="sidebar.settings"] button');
      const wrap = document.querySelector('[data-slot="sidebar.market"]');
      const btn = wrap ? wrap.querySelector('button') : null;
      if (sb && btn && btn.className !== sb.className) btn.className = sb.className;
    };
    // 图标尺寸跟随「设置」图标:属性 + 内联双保险(应对 dsh 版本把设置
    // 图标做成 18×18 等规格或 CSS 控制尺寸的情况)。
    const syncBtnIcon = () => {
      const sb = document.querySelector('[data-slot="sidebar.settings"] button');
      const wrap = document.querySelector('[data-slot="sidebar.market"]');
      const btn = wrap ? wrap.querySelector('button') : null;
      const mSvg = btn ? btn.querySelector('svg') : null;
      const sSvg = sb ? sb.querySelector('svg') : null;
      if (!mSvg || !sSvg) return;
      const css = getComputedStyle(sSvg);
      const w = parseInt(css.width, 10);
      const h = parseInt(css.height, 10);
      if (w > 0 && h > 0) {
        if (mSvg.getAttribute('width') !== String(w)) mSvg.setAttribute('width', String(w));
        if (mSvg.getAttribute('height') !== String(h)) mSvg.setAttribute('height', String(h));
        mSvg.style.width = w + 'px';
        mSvg.style.height = h + 'px';
      }
    };
    const applyRailState = (next, force = false) => {
      if (next === railOn && !force) return;
      railOn = next;
      syncBtnClass();
      syncBtnIcon();
      const wrap = document.querySelector('[data-slot="sidebar.market"]');
      const btn = wrap ? wrap.querySelector('button') : null;
      const settingsAnchor = document.querySelector('[data-slot="sidebar.settings"]');
      const footArea = settingsAnchor ? settingsAnchor.parentElement.parentElement : null;
      if (railOn) {
        if (btn) {
          btn.style.cssText = 'width:36px;height:36px;padding:0;justify-content:center;border-radius:50%;';
          const label = findPluginLabel(btn);
          if (label) label.style.display = 'none';
        }
        if (wrap) wrap.style.display = 'block';
        if (footArea) {
          footArea.style.minHeight = '96px';
          footArea.style.flexDirection = 'column';
        }
      } else {
        if (btn) {
          btn.style.cssText = '';
          const label = findPluginLabel(btn);
          if (label) label.style.display = '';
        }
        if (wrap) wrap.style.display = 'contents';
        if (footArea) {
          footArea.style.minHeight = '';
          footArea.style.flexDirection = '';
        }
      }
    };
    const railSignal = () => {
      const sb = document.querySelector('[data-slot="sidebar.settings"] button');
      return sb ? parseInt(getComputedStyle(sb).width, 10) <= 40 : false;
    };
    // 实时跟随:ResizeObserver 在设置按钮尺寸动画的每一帧触发,与 dsh
    // 的折叠/展开同步(文字显隐、圆角、尺寸都不再滞后半拍)。
    let railObserver = null;
    const ensureRailObserver = () => {
      const sb = document.querySelector('[data-slot="sidebar.settings"] button');
      if (!sb || railObserver) return;
      railObserver = new ResizeObserver(() => { syncBtnClass(); syncBtnIcon(); applyRailState(railSignal()); });
      railObserver.observe(sb);
    };
    ensureRailObserver();
    // 兜底:慢速轮询(ResizeObserver 偶发未触发时恢复状态),不影响实时性
    setInterval(() => {
      ensureRailObserver();
      syncBtnClass();
      syncBtnIcon();
      applyRailState(railSignal());
    }, 800);

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