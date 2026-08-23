"use strict";

/**
 * status-ui-inject.js — 「服务状态」共享面板(路径 A)注入体。
 *
 * 背景:原「服务状态」是独立的 WebContentsView(statusView,固定宽度由主进程
 * 布局计算,不随用户意愿调整)。本文件把同一套内容改造成「dsh 内容区内的
 * overlay 面板」:
 *   - 顶栏状态按钮(或菜单)常态点击 → 主进程 executeJavaScript 调这里 toggle;
 *   - 面板浮在 dsh 页面内容区右侧(position:fixed),不挤压 dsh 布局;
 *   - 宽度可拖拽左缘调整(240~640px),拖拽结束经 window.dsh.setStatusPanelWidth
 *     持久化到 settings.yaml(dsh-box.statusPanelWidth),下次打开记得;
 *   - 数据/操作全部复用内容视图既有的 window.dsh.* preload 桥(getInfo /
 *     checkUpdates / getPluginInfo / getMarketInfo / installPlugin / installMarket /
 *     upgrade / retry / setMarketSwitch / onStatus / openExternal),主进程 IPC 零新增
 *     (仅面板开合上报 + 宽度持久化两个小通道);
 *   - dsh 服务异常(未启动/崩溃/重启中)时内容视图不在 dsh origin,主进程自然
 *     回退到 statusView 兜底页,面板不参与 — 两者以「内容视图是否为 dsh origin」
 *     自动切换,互不干扰。
 *
 * 定位锚点全部是 dsh 公开 UI(侧边栏槽位 / 数据属性 / 主题属性 body
 * [data-ds-dark-theme]),不硬编码哈希类名;面板 DOM 与样式全部加 dshbox-st- 前缀
 * 隔离,不触碰 dsh / 插件源码。
 */

/** 面板宽度:默认 / 最小 / 最大(拖拽 clamp 范围,与主进程共用) */
const STATUS_WIDTH_MIN = 240;
const STATUS_WIDTH_MAX = 640;
const STATUS_WIDTH_DEFAULT = 320;

/** 面板样式(dsh-status.css 同款设计体系,整体 scoped 到 #dshbox-status-panel) */
const STATUS_PANEL_CSS = `
#dshbox-status-panel {
  --st-bg: #f9fafb;
  --st-surface: #ffffff;
  --st-surface-2: #ebedf0;
  --st-border: rgba(0, 0, 0, 0.1);
  --st-border-weak: rgba(0, 0, 0, 0.06);
  --st-text: #0f1115;
  --st-text-secondary: #61666b;
  --st-text-muted: #81858c;
  --st-primary-fill: #0f1115;
  --st-primary-fg: #ffffff;
  --st-primary-hover: #43454a;
  --st-brand: #4176e6;
  --st-ok: #22c55e;
  --st-ok-weak: rgba(34, 197, 94, 0.1);
  --st-idle: #81858c;
  --st-idle-weak: rgba(129, 133, 140, 0.1);
  --st-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  --st-radius: 5px;
}
#dshbox-status-panel.dshbox-st-dark {
  --st-bg: #151517;
  --st-surface: #1b1b1c;
  --st-surface-2: #353638;
  --st-border: rgba(255, 255, 255, 0.12);
  --st-border-weak: rgba(255, 255, 255, 0.08);
  --st-text: #f9fafb;
  --st-text-secondary: #cfd3d6;
  --st-text-muted: #adb2b8;
  --st-primary-fill: #f9fafb;
  --st-primary-fg: #0f1115;
  --st-primary-hover: #ebedf0;
  --st-brand: #679efe;
  --st-ok: #4ed17e;
  --st-ok-weak: rgba(78, 209, 126, 0.16);
  --st-idle: #adb2b8;
  --st-idle-weak: rgba(173, 178, 184, 0.16);
}
#dshbox-status-panel {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  z-index: 46;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  background: var(--st-bg);
  color: var(--st-text);
  font-family: var(--st-font);
  font-size: 12px;
  line-height: 18px;
  border-left: 1px solid var(--st-border);
  user-select: none;
  -webkit-font-smoothing: antialiased;
  /* 插件侧栏同款滑入/滑出:translate(102%) ↔ 0;时长/缓动读 dsh 主题变量
     (--ds-transition-duration-slow / --ds-ease-in-out),缺失时回退 300ms + 同款缓动 */
  transform: translateX(102%);
  visibility: hidden;
  pointer-events: none;
  transition:
    transform var(--ds-transition-duration-slow, 300ms) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
    width var(--ds-transition-duration-slow, 300ms) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
    visibility 0s linear var(--ds-transition-duration-slow, 300ms);
}
#dshbox-status-panel.dshbox-st-open {
  transform: translateX(0);
  visibility: visible;
  pointer-events: auto;
  /* 展开时 visibility 立即生效(无延迟),transform/width 保持动画 */
  transition:
    transform var(--ds-transition-duration-slow, 300ms) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
    width var(--ds-transition-duration-slow, 300ms) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}
/* 拖拽调宽时禁用面板过渡,配合 body 属性让内容区挤压跟手 */
#dshbox-status-panel[data-dragging] {
  transition: none;
}
body[data-dshbox-status-dragging] #root {
  transition: none !important;
}
/* 布局挤压:展开时内容区让出面板宽度(与插件侧栏同机制,组合变量互不干扰;
   互斥保证两侧变量同时只有一个非零)。!important 压过插件自己的 #root 规则。 */
#root {
  margin-right: calc(var(--dsh-sidebar-width, 0px) + var(--dshbox-status-panel-width, 0px)) !important;
  width: calc(100% - var(--dsh-sidebar-width, 0px) - var(--dshbox-status-panel-width, 0px)) !important;
  transition:
    margin-right var(--ds-transition-duration-slow, 300ms) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
    width var(--ds-transition-duration-slow, 300ms) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}
/* 拖拽把手(左缘 6px):展开 = 面板变宽;收起 = 变窄 */
#dshbox-status-panel .dshbox-st-resizer {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  z-index: 2;
}
#dshbox-status-panel .dshbox-st-resizer:hover {
  background: rgba(103, 158, 254, 0.25);
}
/* 右上角关闭按钮(浮动,不占布局) */
#dshbox-status-panel .dshbox-st-close {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  appearance: none;
  border: none;
  background: transparent;
  color: var(--st-text-muted);
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
}
#dshbox-status-panel .dshbox-st-close:hover {
  background: var(--st-surface-2);
  color: var(--st-text-secondary);
}
/* 内容滚动区 */
#dshbox-status-panel .dshbox-st-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
#dshbox-status-panel .dshbox-st-scroll::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
#dshbox-status-panel .dshbox-st-scroll::-webkit-scrollbar-track {
  background: transparent;
}
#dshbox-status-panel .dshbox-st-scroll::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: var(--st-border);
}
#dshbox-status-panel .dshbox-st-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--st-text-muted);
}
#dshbox-status-panel .dshbox-st-content {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
/* 区块 */
#dshbox-status-panel .dshbox-st-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
#dshbox-status-panel .dshbox-st-section + .dshbox-st-section {
  border-top: 1px solid var(--st-border-weak);
  padding-top: 20px;
}
#dshbox-status-panel .dshbox-st-section-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  color: var(--st-text);
}
#dshbox-status-panel .dshbox-st-status-info {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
#dshbox-status-panel .dshbox-st-status-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
#dshbox-status-panel .dshbox-st-version-line,
#dshbox-status-panel .dshbox-st-meta-line {
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#dshbox-status-panel .dshbox-st-version-line {
  color: var(--st-text-secondary);
}
#dshbox-status-panel .dshbox-st-meta-line {
  color: var(--st-text-muted);
}
#dshbox-status-panel .dshbox-st-status-side {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
#dshbox-status-panel .dshbox-st-state-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--st-radius);
  background: var(--st-idle-weak);
  color: var(--st-idle);
  white-space: nowrap;
}
#dshbox-status-panel .dshbox-st-state-pill.dshbox-st-running {
  background: var(--st-ok-weak);
  color: var(--st-ok);
}
#dshbox-status-panel .dshbox-st-state-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
#dshbox-status-panel .dshbox-st-state-label {
  font-size: 11px;
  line-height: 16px;
}
#dshbox-status-panel .dshbox-st-hint {
  font-size: 11px;
  line-height: 16px;
  color: var(--st-text-muted);
  word-break: break-all;
}
/* 按钮 */
#dshbox-status-panel .dshbox-st-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--st-font);
  font-size: 12px;
  line-height: 18px;
  height: 28px;
  padding: 0 14px;
  border-radius: 100px;
  border: none;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}
#dshbox-status-panel .dshbox-st-btn-primary {
  background: var(--st-primary-fill);
  color: var(--st-primary-fg);
}
#dshbox-status-panel .dshbox-st-btn-primary:hover:not(:disabled) {
  background: var(--st-primary-hover);
}
#dshbox-status-panel .dshbox-st-btn-outline {
  background: transparent;
  border: 1px solid var(--st-border);
  color: var(--st-text-muted);
}
#dshbox-status-panel .dshbox-st-btn-outline:hover:not(:disabled) {
  background: var(--st-surface-2);
  color: var(--st-text-secondary);
}
#dshbox-status-panel .dshbox-st-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
#dshbox-status-panel .dshbox-st-btn:focus-visible {
  outline: 2px solid var(--st-brand);
  outline-offset: 2px;
}
#dshbox-status-panel [hidden] {
  display: none !important;
}
/* 行布局 */
#dshbox-status-panel .dshbox-st-row-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
#dshbox-status-panel .dshbox-st-row-link {
  color: var(--st-text);
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
#dshbox-status-panel .dshbox-st-row-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
#dshbox-status-panel .dshbox-st-row-link:focus-visible {
  outline: 2px solid var(--st-brand);
  outline-offset: 2px;
  border-radius: 2px;
}
#dshbox-status-panel .dshbox-st-v-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border: 1px solid var(--st-border);
  border-radius: var(--st-radius);
  font-size: 11px;
  line-height: 16px;
  color: var(--st-text-muted);
  white-space: nowrap;
  flex: none;
}
#dshbox-status-panel .dshbox-st-v-update,
#dshbox-status-panel .dshbox-st-plugin-action {
  margin-left: auto;
  flex: none;
  height: 28px;
  padding: 0 12px;
}
#dshbox-status-panel .dshbox-st-state-current {
  margin-left: auto;
  flex: none;
  font-size: 11px;
  line-height: 16px;
  color: var(--st-ok);
  white-space: nowrap;
}
#dshbox-status-panel .dshbox-st-v-date {
  font-size: 12px;
  line-height: 18px;
  color: var(--st-text-muted);
}
#dshbox-status-panel .dshbox-st-plugin-desc {
  font-size: 11px;
  line-height: 17px;
  color: var(--st-text-muted);
  word-break: break-word;
}
#dshbox-status-panel .dshbox-st-row-name {
  color: var(--st-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 开关 */
#dshbox-status-panel .dshbox-st-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
  cursor: pointer;
}
#dshbox-status-panel .dshbox-st-switch-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--st-text-secondary);
}
#dshbox-status-panel .dshbox-st-switch {
  position: relative;
  flex: none;
  width: 33px;
  height: 18px;
  border-radius: 10px;
  border: 1px solid var(--st-border);
  background: transparent;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
#dshbox-status-panel .dshbox-st-switch .dshbox-st-switch-knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--st-text-muted);
  transition: left 0.15s ease, background-color 0.15s ease;
}
#dshbox-status-panel .dshbox-st-switch.dshbox-st-on {
  background: var(--st-primary-fill);
  border-color: var(--st-primary-fill);
}
#dshbox-status-panel .dshbox-st-switch.dshbox-st-on .dshbox-st-switch-knob {
  left: 16px;
  background: var(--st-primary-fg);
}
#dshbox-status-panel .dshbox-st-switch:focus-visible {
  outline: 2px solid var(--st-brand);
  outline-offset: 2px;
}
/* 查询失败 */
#dshbox-status-panel .dshbox-st-version-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
}
#dshbox-status-panel .dshbox-st-error-text {
  font-size: 12px;
  line-height: 18px;
  color: var(--st-text-muted);
}
#dshbox-status-panel .dshbox-st-cache-note {
  font-size: 11px;
  line-height: 16px;
  color: orange;
  text-align: center;
}
`;

/**
 * STATUS_BRIDGE_JS_FN — 面板桥注入体(页面 http 域,无文件访问,全部内联)。
 *
 * 桥挂 window.__dshBoxStatusBridge(幂等防重入):
 *   - toggle():开/合面板,返回 { ok, open }(顶栏按钮经主进程调这里);
 *   - state(): 返回 { open };
 *   - setWidth(w): 运行时改宽(持久化交给拖拽结束回调,一般不用);
 * 面板每次打开都重新查 npm / 插件(与旧 statusView「进入即查」语义一致)。
 * 开合变化 → window.dsh.reportStatusPanel({ open })(主进程据此同步顶栏按钮
 * 高亮 + 关闭异常态 statusView 兜底,避免双开)。
 * 拖拽结束 → window.dsh.setStatusPanelWidth(width)(持久化 settings.yaml)。
 * 主题 → 跟随 body[data-ds-dark-theme] 切换 .dshbox-st-dark 类。
 *
 * @param {number} width 持久化的初始宽度(主进程注入时写入)
 */
function STATUS_BRIDGE_JS_FN(width) {
  const initialWidth = Math.max(
    STATUS_WIDTH_MIN,
    Math.min(STATUS_WIDTH_MAX, Math.round(Number(width) || STATUS_WIDTH_DEFAULT))
  );

  // 面板骨架(与 src/renderer/dsh-status.html 同构;id 只在面板作用域内使用)
  const SKELETON = `
    <div class="dshbox-st-resizer" title="拖动调整宽度"></div>
    <button class="dshbox-st-close" type="button" aria-label="关闭服务状态">✕</button>
    <div class="dshbox-st-scroll">
      <main class="dshbox-st-content">
        <section class="dshbox-st-section">
          <h1 class="dshbox-st-section-title">服务状态</h1>
          <div class="dshbox-st-status-info">
            <div class="dshbox-st-status-text">
              <div class="dshbox-st-version-line" id="stVersionLine" title="">DSH 1.0.0</div>
              <div class="dshbox-st-meta-line" id="stMetaLine">端口 - · PID -</div>
            </div>
            <div class="dshbox-st-status-side">
              <span class="dshbox-st-state-pill" id="stStatePill">
                <span class="dshbox-st-state-dot"></span>
                <span class="dshbox-st-state-label" id="stStateLabel">运行中</span>
              </span>
              <button class="dshbox-st-btn dshbox-st-btn-primary" id="stStartBtn" type="button" hidden>启动服务</button>
            </div>
          </div>
          <div class="dshbox-st-hint" id="stServiceHint" hidden></div>
        </section>

        <section class="dshbox-st-section">
          <h1 class="dshbox-st-section-title">DSH</h1>
          <div class="dshbox-st-row-line" id="stDshRow" hidden>
            <a class="dshbox-st-row-link" id="stDshVersionLink" href="https://github.com/deepseek-ai/deepseek-harness/" target="_blank" rel="noreferrer" title="">-</a>
            <span class="dshbox-st-v-badge">最新</span>
            <button class="dshbox-st-btn dshbox-st-btn-primary dshbox-st-v-update" id="stDshUpdateBtn" type="button" hidden>更新</button>
            <span class="dshbox-st-state-current" id="stDshCurrentLabel" hidden>当前</span>
          </div>
          <div class="dshbox-st-v-date" id="stDshDate" hidden></div>
          <div class="dshbox-st-version-error" id="stDshError" hidden>
            <p class="dshbox-st-error-text">网络服务异常</p>
            <button class="dshbox-st-btn dshbox-st-btn-outline" id="stDshRetryBtn" type="button">重试</button>
          </div>
          <div class="dshbox-st-cache-note" id="stDshCacheNote" hidden>网络异常,以下为上次缓存结果</div>
          <div class="dshbox-st-hint" id="stUpgradeHint" hidden></div>
        </section>

        <section class="dshbox-st-section">
          <h1 class="dshbox-st-section-title">侧边栏</h1>
          <div class="dshbox-st-row-line" id="stPluginRow" hidden>
            <a class="dshbox-st-row-link" id="stPluginNameLink" href="https://github.com/omdsh-dev/DSH-better-sidebar" target="_blank" rel="noreferrer" title="dsh-better-sidebar">dsh-better-sidebar</a>
            <span class="dshbox-st-v-badge" id="stPluginVersionBadge">-</span>
            <button class="dshbox-st-btn dshbox-st-btn-primary dshbox-st-plugin-action" id="stPluginActionBtn" type="button" hidden>安装</button>
            <span class="dshbox-st-state-current" id="stPluginInstalledLabel" hidden>已安装</span>
          </div>
          <p class="dshbox-st-plugin-desc" id="stPluginDesc" hidden>
            支持文件渲染编辑、终端、Git、子代理、子会话,以及第三方插件注册为新 Tab。
          </p>
          <div class="dshbox-st-version-error" id="stPluginError" hidden>
            <p class="dshbox-st-error-text">网络服务异常</p>
            <button class="dshbox-st-btn dshbox-st-btn-outline" id="stPluginRetryBtn" type="button">重试</button>
          </div>
          <div class="dshbox-st-hint" id="stPluginHint" hidden></div>
        </section>

        <section class="dshbox-st-section">
          <h1 class="dshbox-st-section-title">插件市场</h1>
          <div class="dshbox-st-row-line" id="stMarketRow" hidden>
            <span class="dshbox-st-row-name" id="stMarketName">dsh-market</span>
            <span class="dshbox-st-v-badge" id="stMarketVersionBadge">-</span>
            <button class="dshbox-st-btn dshbox-st-btn-primary dshbox-st-plugin-action" id="stMarketActionBtn" type="button" hidden>安装</button>
            <span class="dshbox-st-state-current" id="stMarketInstalledLabel" hidden>已安装</span>
          </div>
          <p class="dshbox-st-plugin-desc" id="stMarketDesc" hidden>
            浏览、搜索、安装、更新、卸载社区插件。
          </p>
          <label class="dshbox-st-switch-row" id="stMarketSwitchRow" hidden>
            <span class="dshbox-st-switch-label">在 DSH 侧边栏显示插件市场入口</span>
            <span class="dshbox-st-switch" id="stMarketSwitch" role="switch" aria-checked="false" tabindex="0">
              <span class="dshbox-st-switch-knob"></span>
            </span>
          </label>
          <div class="dshbox-st-version-error" id="stMarketError" hidden>
            <p class="dshbox-st-error-text">网络服务异常</p>
            <button class="dshbox-st-btn dshbox-st-btn-outline" id="stMarketRetryBtn" type="button">重试</button>
          </div>
          <div class="dshbox-st-hint" id="stMarketHint" hidden></div>
        </section>
      </main>
    </div>`;

  return `(() => {
    if (window.__dshBoxStatusBridge) return;
    let panel = null;
    let open = false;
    let busy = false; // 展开/收起动画进行中(互斥编排与 UI 都靠它防重入)
    let width = ${initialWidth};

    // ---------- 工具 ----------
    const $ = (id) => panel.querySelector('#' + id);
    const theme = () =>
      document.body && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
    const applyTheme = () => {
      if (panel) panel.classList.toggle('dshbox-st-dark', theme() === 'dark');
    };
    const report = () => {
      try {
        if (window.dsh && window.dsh.reportStatusPanel) {
          window.dsh.reportStatusPanel({ open: !!open });
        }
      } catch { /* 上报失败不影响面板 */ }
    };
    /** 挤压宽度变量(0px = 不挤压;面板展开时 = 目标宽) */
    const setPanelWidthVar = (w) => {
      document.documentElement.style.setProperty('--dshbox-status-panel-width', w ? w + 'px' : '0px');
    };
    /** dsh 主题的慢速过渡时长(互斥等待插件动画完成用;缺失回退 300ms) */
    const slowMs = () => {
      try {
        const v = getComputedStyle(document.documentElement)
          .getPropertyValue('--ds-transition-duration-slow').trim();
        const m = /^([\d.]+)(ms|s)$/.exec(v);
        if (m) return parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1);
      } catch { /* 回退 */ }
      return 300;
    };
    /** 等待元素 transition(transform/width)结束;带超时兜底(reduced-motion 等) */
    const onceTransitionEnd = (el, done) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        el.removeEventListener('transitionend', onT);
        clearTimeout(timer);
        done();
      };
      const onT = (e) => {
        if (e.propertyName === 'transform' || e.propertyName === 'width') finish();
      };
      const timer = setTimeout(finish, slowMs() + 150);
      el.addEventListener('transitionend', onT);
    };

    // ---------- 渲染状态(移植 src/renderer/dsh-status.js,作用于面板内) ----------
    let currentInfo = null;
    let upgrading = false;
    let pluginInstalling = false;
    let marketInstalling = false;
    let lastPluginInfo = null;
    let lastMarketInfo = null;
    let marketSwitchOn = false;

    // ---------- 服务状态 ----------
    const renderStatus = (info) => {
      if (!info) return;
      currentInfo = info;
      const versionText = info.version ? 'DSH ' + info.version : 'DSH(版本未知)';
      const vLine = $('stVersionLine');
      vLine.textContent = versionText;
      vLine.title = versionText;
      const running = info.state === 'ready';
      $('stMetaLine').textContent = running
        ? '端口 ' + info.port + ' · PID ' + (info.pid ?? '-')
        : '端口 - · PID -';
      $('stStatePill').classList.toggle('dshbox-st-running', running);
      $('stStateLabel').textContent = running ? '运行中' : '停止';
      const startBtn = $('stStartBtn');
      startBtn.hidden = running;
      startBtn.disabled = info.state === 'starting';
      startBtn.textContent = info.state === 'starting' ? '启动中…' : '启动服务';
    };
    const refreshInfo = async () => {
      try {
        renderStatus(await window.dsh.getInfo());
      } catch (error) {
        $('stServiceHint').hidden = false;
        $('stServiceHint').textContent = '获取服务信息失败: ' + error;
      }
    };

    const fmtDate = (iso) => {
      if (!iso) return '';
      try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      } catch { return ''; }
    };

    // ---------- DSH(最新一条) ----------
    const renderDsh = (res) => {
      if (res.error || !res.latest || !res.rows || !res.rows.length) {
        $('stDshError').hidden = false;
        $('stDshCacheNote').hidden = true;
        $('stDshRow').hidden = true;
        $('stDshDate').hidden = true;
        return;
      }
      const latestRow =
        res.rows.find((r) => r.version === res.latest) ??
        res.rows.find((r) => r.isLatest) ??
        res.rows[0];
      const latestVersion = latestRow.version;
      $('stDshError').hidden = true;
      $('stDshCacheNote').hidden = !res.fromCache;
      $('stDshRow').hidden = false;
      const link = $('stDshVersionLink');
      link.textContent = latestVersion;
      link.title = latestVersion;
      const hasUpdate = !!res.hasUpdate;
      $('stDshUpdateBtn').hidden = !hasUpdate;
      $('stDshCurrentLabel').hidden = hasUpdate;
      if (hasUpdate) $('stDshUpdateBtn').textContent = '更新';
      $('stDshDate').hidden = false;
      $('stDshDate').textContent = fmtDate(latestRow.publishedAt) || String(latestVersion);
    };
    const loadVersions = async () => {
      const hint = $('stUpgradeHint');
      hint.hidden = false;
      hint.textContent = '正在检查…';
      try {
        renderDsh(await window.dsh.checkUpdates());
        hint.hidden = true;
      } catch (error) {
        hint.hidden = true;
        renderDsh({ error: String(error), rows: [] });
      }
    };

    // ---------- 侧边栏插件 ----------
    const renderPlugin = (info) => {
      lastPluginInfo = info;
      const installed = info.installed;
      const failed = !!info.error;
      const latest = info.latest;
      const row = $('stPluginRow');
      row.hidden = false;
      const badgeText = failed ? (installed || latest) : (latest || installed);
      const badge = $('stPluginVersionBadge');
      if (badgeText) {
        badge.textContent = badgeText;
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
      if (failed && !installed) {
        row.hidden = true;
        $('stPluginDesc').hidden = true;
        $('stPluginError').hidden = false;
        $('stPluginError').querySelector('.dshbox-st-error-text').textContent = '网络服务异常';
        return;
      }
      if (failed && installed) {
        $('stPluginDesc').hidden = true;
        $('stPluginError').hidden = false;
        $('stPluginError').querySelector('.dshbox-st-error-text').textContent = '网络异常,无法检查更新';
        $('stPluginActionBtn').hidden = true;
        $('stPluginInstalledLabel').hidden = true;
        return;
      }
      $('stPluginError').hidden = true;
      $('stPluginDesc').hidden = false;
      const isInstall = !installed;
      const hasUpdate = installed && latest && installed !== latest;
      if (isInstall || hasUpdate) {
        const btn = $('stPluginActionBtn');
        btn.hidden = false;
        btn.disabled = false;
        btn.textContent = isInstall ? '安装' : '更新';
        $('stPluginInstalledLabel').hidden = true;
      } else {
        $('stPluginActionBtn').hidden = true;
        $('stPluginInstalledLabel').hidden = false;
      }
    };
    const loadPluginInfo = async () => {
      const hint = $('stPluginHint');
      hint.hidden = false;
      hint.textContent = '正在检查…';
      try {
        renderPlugin(await window.dsh.getPluginInfo());
        hint.hidden = true;
      } catch (error) {
        hint.hidden = true;
        renderPlugin({ error: String(error), installed: null });
      }
    };
    const resetActionBtn = (btn, isInstall) => {
      btn.disabled = false;
      btn.textContent = isInstall ? '安装' : '更新';
    };
    const doPluginInstall = async (version, btn, isInstall) => {
      if (pluginInstalling) return;
      const verb = isInstall ? '安装' : '更新';
      const question = isInstall
        ? '确定安装 dsh-better-sidebar ' + version + ' 吗?\\n\\n需要联网下载,完成后 dsh 服务会自动重启以加载插件。'
        : '确定将 dsh-better-sidebar 更新到 ' + version + ' 吗?\\n\\n完成后 dsh 服务会自动重启以加载新版本。';
      if (!confirm(question)) return;
      pluginInstalling = true;
      btn.disabled = true;
      btn.textContent = verb + '中…';
      const hint = $('stPluginHint');
      hint.hidden = false;
      hint.textContent = '正在' + verb + ' dsh-better-sidebar ' + version + ',请稍候…';
      try {
        const res = await window.dsh.installPlugin(version);
        if (res.ok) {
          hint.textContent = res.unchanged
            ? '当前已是 ' + res.installed
            : '已' + verb + '到 ' + res.installed + (res.restarted ? ',服务已重启' : ',启动服务后生效') + (res.warning ? '; ' + res.warning : '');
          await loadPluginInfo();
        } else {
          hint.textContent = verb + '失败: ' + res.error;
          resetActionBtn(btn, isInstall);
        }
      } catch (error) {
        hint.textContent = verb + '失败: ' + error;
        resetActionBtn(btn, isInstall);
      } finally {
        pluginInstalling = false;
      }
    };

    // ---------- 插件市场 ----------
    const renderMarketSwitch = (on) => {
      marketSwitchOn = on;
      const sw = $('stMarketSwitch');
      sw.classList.toggle('dshbox-st-on', on);
      sw.setAttribute('aria-checked', String(on));
    };
    const renderMarket = (info) => {
      lastMarketInfo = info;
      const installed = info.installed;
      const failed = !!info.error;
      const latest = info.latest;
      const row = $('stMarketRow');
      row.hidden = false;
      const badgeText = failed ? (installed || latest) : (latest || installed);
      const badge = $('stMarketVersionBadge');
      if (badgeText) {
        badge.textContent = badgeText;
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
      if (failed && !installed) {
        row.hidden = true;
        $('stMarketDesc').hidden = true;
        $('stMarketSwitchRow').hidden = true;
        $('stMarketError').hidden = false;
        $('stMarketError').querySelector('.dshbox-st-error-text').textContent = '网络服务异常';
        return;
      }
      if (failed && installed) {
        $('stMarketDesc').hidden = true;
        $('stMarketSwitchRow').hidden = true;
        $('stMarketError').hidden = false;
        $('stMarketError').querySelector('.dshbox-st-error-text').textContent = '网络异常,无法检查更新';
        $('stMarketActionBtn').hidden = true;
        $('stMarketInstalledLabel').hidden = true;
        return;
      }
      $('stMarketError').hidden = true;
      const isInstall = !installed;
      const hasUpdate = installed && latest && installed !== latest;
      if (isInstall || hasUpdate) {
        const btn = $('stMarketActionBtn');
        btn.hidden = false;
        btn.disabled = false;
        btn.textContent = isInstall ? '安装' : '更新';
        $('stMarketInstalledLabel').hidden = true;
      } else {
        $('stMarketActionBtn').hidden = true;
        $('stMarketInstalledLabel').hidden = false;
      }
      $('stMarketDesc').hidden = !isInstall;
      $('stMarketSwitchRow').hidden = isInstall;
    };
    const loadMarketInfo = async () => {
      const hint = $('stMarketHint');
      hint.hidden = false;
      hint.textContent = '正在检查…';
      try {
        renderMarket(await window.dsh.getMarketInfo());
        hint.hidden = true;
      } catch (error) {
        hint.hidden = true;
        renderMarket({ error: String(error), installed: null });
      }
      if (lastMarketInfo && lastMarketInfo.installed) {
        try {
          const res = await window.dsh.getMarketSwitch();
          renderMarketSwitch(!!(res && res.ok && res.enabled));
        } catch { /* 读开关失败保持现状 */ }
      } else {
        renderMarketSwitch(false);
      }
    };
    const doMarketInstall = async (version, btn, isInstall) => {
      if (marketInstalling) return;
      const verb = isInstall ? '安装' : '更新';
      const question = isInstall
        ? '确定安装插件市场 ' + version + ' 吗?\\n\\n需要联网下载,完成后 dsh 服务会自动重启以加载插件。'
        : '确定将插件市场更新到 ' + version + ' 吗?\\n\\n完成后 dsh 服务会自动重启以加载新版本。';
      if (!confirm(question)) return;
      marketInstalling = true;
      btn.disabled = true;
      btn.textContent = verb + '中…';
      const hint = $('stMarketHint');
      hint.hidden = false;
      hint.textContent = '正在' + verb + '插件市场 ' + version + ',请稍候…';
      try {
        const res = await window.dsh.installMarket(version);
        if (res.ok) {
          hint.textContent = res.unchanged
            ? '当前已是 ' + res.installed
            : '已' + verb + '到 ' + res.installed + (res.restarted ? ',服务已重启' : ',启动服务后生效') + (res.warning ? '; ' + res.warning : '');
          await loadMarketInfo();
        } else {
          hint.textContent = verb + '失败: ' + res.error;
          resetActionBtn(btn, isInstall);
        }
      } catch (error) {
        hint.textContent = verb + '失败: ' + error;
        resetActionBtn(btn, isInstall);
      } finally {
        marketInstalling = false;
      }
    };

    // ---------- 应用内升级 ----------
    const doUpgrade = async (version, btn) => {
      if (upgrading) return;
      const ok = confirm(
        '确定将 dsh 升级到 ' + version + ' 吗?\\n\\n升级过程会短暂停止当前服务,完成后自动恢复。'
      );
      if (!ok) return;
      upgrading = true;
      btn.disabled = true;
      btn.textContent = '升级中…';
      const hint = $('stUpgradeHint');
      hint.hidden = false;
      hint.textContent = '正在下载并安装 dsh ' + version + ',请稍候…';
      try {
        const res = await window.dsh.upgrade(version);
        if (res.ok) {
          hint.textContent = res.unchanged
            ? '当前已是 ' + res.installed + ',无需升级'
            : '已升级到 ' + res.installed + (res.previous ? '(原 ' + res.previous + ' 已备份)' : '');
          await Promise.all([refreshInfo(), loadVersions()]);
        } else {
          hint.textContent = '升级失败: ' + res.error;
          resetUpgradeBtn();
        }
      } catch (error) {
        hint.textContent = '升级失败: ' + error;
        resetUpgradeBtn();
      } finally {
        upgrading = false;
      }
    };
    const resetUpgradeBtn = () => {
      $('stDshUpdateBtn').disabled = false;
      $('stDshUpdateBtn').textContent = '更新';
    };

    // ---------- 面板创建 / 销毁 ----------
    // 服务状态实时推送(主进程 broadcastStatus → preload onStatus):升级/启停
    // 过程中面板状态行/徽标/按钮实时跟随。订阅桥级一次,面板关闭时忽略。
    let statusUnsub = null;
    const ensureStatusSub = () => {
      if (statusUnsub || !window.dsh || !window.dsh.onStatus) return;
      statusUnsub = window.dsh.onStatus((status) => {
        if (!panel) return;
        if (currentInfo) {
          renderStatus({ ...currentInfo, state: status.state, message: status.message });
        } else {
          refreshInfo();
        }
      });
    };
    const bindExternalLink = (el) => {
      el.addEventListener('click', (event) => {
        event.preventDefault();
        const href = el.getAttribute('href');
        if (href && window.dsh && window.dsh.openExternal) {
          window.dsh.openExternal(href).catch(() => {});
        }
      });
    };

    const createPanel = () => {
      if (panel) return panel;
      const div = document.createElement('div');
      div.id = 'dshbox-status-panel';
      div.style.width = width + 'px';
      div.innerHTML = ${JSON.stringify(SKELETON)};
      document.body.appendChild(div);
      panel = div;
      applyTheme();
      ensureStatusSub();

      bindExternalLink($('stDshVersionLink'));
      bindExternalLink($('stPluginNameLink'));

      $('stStartBtn').addEventListener('click', async () => {
        if (upgrading) return;
        const btn = $('stStartBtn');
        btn.disabled = true;
        btn.textContent = '正在启动…';
        $('stServiceHint').hidden = true;
        try {
          await window.dsh.retry();
        } catch (error) {
          btn.disabled = false;
          btn.textContent = '启动服务';
          $('stServiceHint').hidden = false;
          $('stServiceHint').textContent = '服务启动失败: ' + error;
        }
        refreshInfo();
      });
      $('stDshUpdateBtn').addEventListener('click', () => {
        doUpgrade($('stDshVersionLink').textContent, $('stDshUpdateBtn'));
      });
      $('stDshRetryBtn').addEventListener('click', () => loadVersions());
      $('stPluginRetryBtn').addEventListener('click', () => loadPluginInfo());
      $('stMarketRetryBtn').addEventListener('click', () => loadMarketInfo());
      $('stPluginActionBtn').addEventListener('click', () => {
        doPluginInstall(lastPluginInfo && lastPluginInfo.latest != null ? lastPluginInfo.latest : null, $('stPluginActionBtn'), !(lastPluginInfo && lastPluginInfo.installed));
      });
      $('stMarketActionBtn').addEventListener('click', () => {
        doMarketInstall(lastMarketInfo && lastMarketInfo.latest != null ? lastMarketInfo.latest : null, $('stMarketActionBtn'), !(lastMarketInfo && lastMarketInfo.installed));
      });
      $('stMarketSwitch').addEventListener('click', async () => {
        const next = !marketSwitchOn;
        renderMarketSwitch(next);
        try {
          const res = await window.dsh.setMarketSwitch(next);
          if (res && res.ok) renderMarketSwitch(!!res.enabled);
          else renderMarketSwitch(!next);
        } catch {
          renderMarketSwitch(!next);
        }
      });
      $('stMarketSwitch').addEventListener('keydown', (event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          $('stMarketSwitch').click();
        }
      });
      div.querySelector('.dshbox-st-close').addEventListener('click', () => {
        toggle();
      });

      // 拖拽调宽(左缘,240~640 钳制;结束持久化;拖拽中内容区挤压跟手)
      const resizer = div.querySelector('.dshbox-st-resizer');
      resizer.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        resizer.setPointerCapture(event.pointerId);
        div.setAttribute('data-dragging', '');
        document.body.setAttribute('data-dshbox-status-dragging', '');
        const startX = event.clientX;
        const startW = width;
        const onMove = (ev) => {
          const next = Math.round(Math.min(${STATUS_WIDTH_MAX}, Math.max(${STATUS_WIDTH_MIN}, startW - (ev.clientX - startX))));
          div.style.width = next + 'px';
          width = next;
          setPanelWidthVar(next);
        };
        const onUp = () => {
          resizer.removeEventListener('pointermove', onMove);
          resizer.removeEventListener('pointerup', onUp);
          div.removeAttribute('data-dragging');
          document.body.removeAttribute('data-dshbox-status-dragging');
          try {
            if (window.dsh && window.dsh.setStatusPanelWidth) {
              window.dsh.setStatusPanelWidth(width).catch(() => {});
            }
          } catch { /* 持久化失败不影响拖拽 */ }
        };
        resizer.addEventListener('pointermove', onMove);
        resizer.addEventListener('pointerup', onUp);
      });
      return div;
    };

    // 打开时数据全部重新查(与旧 statusView「进入即查」语义一致)
    const refreshAll = () => {
      refreshInfo();
      loadVersions();
      loadPluginInfo();
      loadMarketInfo();
    };

    // ---------- 展开 / 收起(带滑入/滑出动画,防重入) ----------
    const doOpen = (onDone) => {
      if (busy || open) { onDone && onDone(open); return; }
      busy = true;
      const div = createPanel();
      setPanelWidthVar(width); // 挤压动画:内容区让出面板宽度
      requestAnimationFrame(() => {
        if (!div) { busy = false; onDone && onDone(false); return; }
        div.classList.add('dshbox-st-open');
        open = true;
        busy = false;
        report();
        refreshAll();
        onDone && onDone(true);
      });
    };

    const doClose = (onDone) => {
      if (!panel || !open) { onDone && onDone(!open); return; }
      busy = true;
      const div = panel;
      open = false;
      setPanelWidthVar(0); // 挤压回收
      div.classList.remove('dshbox-st-open');
      report(); // 立即上报关闭(顶栏按钮熄灭与动画同步)
      onceTransitionEnd(div, () => {
        if (panel === div) { div.remove(); panel = null; }
        busy = false;
        onDone && onDone(true);
      });
    };

    // 互斥编排用:返回 Promise,动画完成后 resolve
    const requestOpen = () =>
      new Promise((resolve) => doOpen((ok) => resolve({ ok: !!ok, open: !!open })));
    const requestClose = () =>
      new Promise((resolve) => doClose((ok) => resolve({ ok: !!ok, open: false })));

    // ---------- 桥 ----------
    // toggle 同步返回「目标态」(不动画等待);UI 与旧路径兼容用。
    const toggle = () => {
      const target = !open;
      if (target) doOpen();
      else doClose();
      return { ok: true, open: target };
    };
    const setWidth = (w) => {
      const next = Math.round(Math.min(${STATUS_WIDTH_MAX}, Math.max(${STATUS_WIDTH_MIN}, Number(w) || ${STATUS_WIDTH_DEFAULT})));
      width = next;
      if (panel) panel.style.width = next + 'px';
      if (open) setPanelWidthVar(next); // 展开中调宽 → 挤压跟随
      try {
        if (window.dsh && window.dsh.setStatusPanelWidth) {
          window.dsh.setStatusPanelWidth(next).catch(() => {});
        }
      } catch { /* 忽略 */ }
      return { ok: true, width: next };
    };

    window.__dshBoxStatusBridge = {
      toggle,
      setWidth,
      requestOpen,
      requestClose,
      state() { return { open, busy }; },
      // 诊断(回归/排查用):暴露面板内异步任务锁状态
      _debug() { return { upgrading, pluginInstalling, marketInstalling }; },
    };

    // ---------- 主题跟随 + 首次上报 + 宽度变量初始化 ----------
    const start = () => {
      if (!document.body) { setTimeout(start, 100); return; }
      setPanelWidthVar(0); // 页面重载后确保不残留挤压
      new MutationObserver(applyTheme).observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme'],
      });
      report(); // 初始 open=false → 主进程据此把顶栏按钮复位(页面重载后)
    };
    start();
  })()`;
}

module.exports = {
  STATUS_PANEL_CSS,
  STATUS_BRIDGE_JS_FN,
  STATUS_WIDTH_MIN,
  STATUS_WIDTH_MAX,
  STATUS_WIDTH_DEFAULT,
};