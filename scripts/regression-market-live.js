#!/usr/bin/env node
"use strict";

/**
 * regression-market-live.js — 插件市场(dshmarket)真实环境端到端回归:
 *
 *   1. 复用隔离 DSH_HOME(缺插件时联网安装 dshmarket);
 *   2. 真实启动 dsh web,加载真实 WebUI,注入 MARKET_BRIDGE_JS_FN(true) + MARKET_INJECT_CSS
 *      (与 main.js installWebUIInjection 相同的注入);
 *   3. 断言:侧边栏「插件」入口出现在「设置」按钮上方(chajian 图标+文本);
 *      点击入口 → 设置弹窗打开并激活「插件市场」页;
 *      设置弹窗导航里「插件市场」按钮的默认图标被替换为 chajian 方块网格;
 *      开关 setEnabled(false) → 入口移除;setEnabled(true) → 恢复。
 *
 * 用法: electron scripts/regression-market-live.js --no-sandbox
 * 说明:默认联网安装插件(仅首次);可用 DSH_E2E_HOME 指定已就绪的隔离 home。
 */

const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const { resolveDsh } = require(path.join(ROOT, "src", "main", "dsh-server"));
const { MARKET_BRIDGE_JS_FN } = require(path.join(ROOT, "src", "main", "plugin-ui-inject"));

const E2E_HOME = process.env.DSH_E2E_HOME || "/tmp/dsh-box-plugin-e2e";
const PORT = Number(process.env.DSH_E2E_PORT) || 3974;
const WAIT_MS = 400;
const MOUNT_TIMEOUT_MS = 30_000;

const PRELOAD = {
  preload: path.join(ROOT, "src", "preload", "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitServerReady(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* 未就绪 */ }
    await wait(500);
  }
  return false;
}

function spawnWeb() {
  const resolved = resolveDsh();
  if (!resolved) throw new Error("找不到 dsh");
  const env = { ...process.env, DSH_HOME: E2E_HOME, DSH_TELEMETRY_DISABLED: "1" };
  let command;
  let args;
  if (resolved.type === "script") {
    command = process.execPath;
    args = ["--expose-internals", resolved.path, "web", "--port", String(PORT)];
    env.ELECTRON_RUN_AS_NODE = "1";
  } else {
    command = resolved.path;
    args = ["web", "--port", String(PORT)];
  }
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (c) => process.stderr.write(`[dsh:err] ${c}`));
  return child;
}

let dshProcess = null;

app.whenReady().then(async () => {
  let win = null;
  try {
    // ---------- 1. 准备隔离 home + 启动 web ----------
    fs.mkdirSync(E2E_HOME, { recursive: true });
    const fs2 = require("node:fs");
    const marketVersion = (() => {
      try {
        return JSON.parse(fs2.readFileSync(
          path.join(E2E_HOME, "profiles", "web", "node_modules", "dshmarket", "package.json"), "utf8"
        )).version ?? null;
      } catch { return null; }
    })();
    if (!marketVersion) {
      const { runDshCli } = require(path.join(ROOT, "src", "main", "plugin-manager"));
      const res = await runDshCli(E2E_HOME, ["plugin", "--profile", "web", "add", "dshmarket"]);
      if (!res.ok) throw new Error(`插件市场安装失败: ${res.error}`);
    }
    console.log(`[e2e] dshmarket ${marketVersion} 就绪`);

    dshProcess = spawnWeb();
    const url = `http://127.0.0.1:${PORT}`;
    if (!(await waitServerReady(url))) throw new Error("dsh web 未就绪");

    // ---------- 2. 加载真实 WebUI + 注入市场桥与入口样式 ----------
    win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: PRELOAD });
    win.webContents.on("did-finish-load", () => {
      win.webContents.executeJavaScript(MARKET_BRIDGE_JS_FN(true), true).catch(() => {});
    });
    await win.loadURL(url);
    await wait(WAIT_MS);

    // ---------- 3a. 侧边栏「插件」入口:克隆设置按钮,出现在其上方 ----------
    const entry = await (async () => {
      const start = Date.now();
      while (Date.now() - start < MOUNT_TIMEOUT_MS) {
        const r = await win.webContents.executeJavaScript(`(() => {
          const settingsAnchor = document.querySelector('[data-slot="sidebar.settings"]');
          const marketWrap = document.querySelector('[data-slot="sidebar.market"]');
          if (!settingsAnchor || !marketWrap) return null;
          const settingsBtn = settingsAnchor.querySelector('button');
          const btn = marketWrap.querySelector('button');
          if (!settingsBtn || !btn) return null;
          const beforeSettings = settingsAnchor.compareDocumentPosition(marketWrap) & Node.DOCUMENT_POSITION_PRECEDING;
          const cs = (el) => { const st = getComputedStyle(el); return { w: st.width, h: st.height, br: st.borderRadius, pad: st.padding }; };
          const label = [...btn.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '插件');
          return {
            before: !!beforeSettings,
            text: btn.textContent.trim(),
            sameClass: btn.className === settingsBtn.className,
            styleSame: JSON.stringify(cs(btn)) === JSON.stringify(cs(settingsBtn)),
            iconCount: btn.querySelectorAll('svg rect').length,
            labelTag: label ? label.tagName : null,
          };
        })()`);
        if (r && r.text === "插件") return r;
        await wait(500);
      }
      return null;
    })();
    if (!entry) throw new Error("侧边栏「插件」入口未出现");
    if (!entry.before) throw new Error("「插件」入口应在「设置」按钮上方");
    if (entry.text !== "插件" || !entry.labelTag) throw new Error(`入口文案错误: ${JSON.stringify(entry)}`);
    if (!entry.sameClass) throw new Error("「插件」应克隆「设置」的渲染 class");
    if (!entry.styleSame) throw new Error("「插件」与「设置」的计算样式应一致");
    if (entry.iconCount < 8) throw new Error(`入口图标应为 chajian 方块网格,实际 rect=${entry.iconCount}`);
    console.log("[1] 侧边栏「插件」入口:克隆设置按钮(同 class/同样式)+ 在设置上方 ✓");

    // ---------- 1a2. 图标尺寸跟随「设置」(dsh 版本把设置 icon 做成 18×18 等规格) ----------
    await win.webContents.executeJavaScript(`(() => {
      const sBtn = document.querySelector('[data-slot="sidebar.settings"] button');
      const svg = sBtn.querySelector('svg');
      svg.setAttribute('width', '18');
      svg.setAttribute('height', '18');
      svg.style.width = '18px';
      svg.style.height = '18px';
    })()`);
    await wait(1500); // 等一次兜底轮询同步
    const iconSync = await win.webContents.executeJavaScript(`(() => {
      const info = (btn) => {
        const svg = btn.querySelector('svg');
        const r = svg.getBoundingClientRect();
        return { w: svg.getAttribute('width'), h: svg.getAttribute('height'), rw: Math.round(r.width), rh: Math.round(r.height) };
      };
      return {
        s: info(document.querySelector('[data-slot="sidebar.settings"] button')),
        m: info(document.querySelector('[data-slot="sidebar.market"] button')),
      };
    })()`);
    if (iconSync.m.rw !== 18 || iconSync.m.rh !== 18)
      throw new Error(`「插件」icon 应与「设置」一致(18×18),实际 ${JSON.stringify(iconSync)}`);
    if (iconSync.m.w !== iconSync.s.w || iconSync.m.h !== iconSync.s.h)
      throw new Error(`「插件」icon 属性应同步设置,实际 ${JSON.stringify(iconSync)}`);
    console.log("[1a2] 图标尺寸跟随「设置」(18×18 规格下同步) ✓");

    // ---------- 3a2. 折叠(rail)后:两按钮都 icon-only、上下排列不重叠 ----------
    const collapsed = await win.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('button,[role="button"]')].find((x) => (((x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '')).includes('收起侧边栏')));
      if (b) { b.click(); return true; }
      return false;
    })()`);
    if (!collapsed) throw new Error("找不到「收起侧边栏」按钮");
    const railState = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const r = await win.webContents.executeJavaScript(`(() => {
          const settingsAnchor = document.querySelector('[data-slot="sidebar.settings"]');
          const marketWrap = document.querySelector('[data-slot="sidebar.market"]');
          if (!settingsAnchor || !marketWrap) return null;
          const settingsBtn = settingsAnchor.querySelector('button');
          const btn = marketWrap.querySelector('button');
          const cs = (el) => { const st = getComputedStyle(el); return { w: st.width, h: st.height, br: st.borderRadius }; };
          const sRect = settingsBtn.getBoundingClientRect();
          const mRect = btn.getBoundingClientRect();
          const textLeafVisible = (el, text) => {
            for (const x of el.querySelectorAll('*')) {
              if (x.children.length === 0 && (x.textContent || '').trim() === text) {
                return x.getClientRects().length > 0;
              }
            }
            return false;
          };
          let collapsedCls = false;
          { let el = btn.parentElement; for (let i = 0; i < 8 && el; i++) { if (((el.className || '') + '').includes('collapsed')) { collapsedCls = true; break; } el = el.parentElement; } }
          return {
            collapsedCls,
            settingsCS: cs(settingsBtn),
            marketCS: cs(btn),
            settingsLabelVisible: textLeafVisible(settingsBtn, '设置'),
            marketLabelVisible: textLeafVisible(btn, '插件'),
            marketAbove: mRect.top < sRect.top,
            noOverlap: mRect.top + mRect.height <= sRect.top + 0.5,
          };
        })()`);
        if (r && r.marketCS.w === "36px") return r;
        await wait(500);
      }
      return null;
    })();
    if (!railState) {
      const dbg = await win.webContents.executeJavaScript(`(() => {
        const btn = document.querySelector('[data-slot="sidebar.settings"] button');
        const cs = btn ? getComputedStyle(btn) : null;
        let collapsedCls = false;
        { let el = btn; for (let i = 0; i < 8 && el; i++) { if (((el.className || '') + '').includes('collapsed')) { collapsedCls = true; break; } el = el.parentElement; } }
        const labels = [...document.querySelectorAll('button,[role="button"]')].filter((b) => ((b.getAttribute('aria-label') || '') + (b.textContent || '')).includes('侧边栏')).map((b) => b.getAttribute('aria-label'));
        return { w: cs ? cs.width : null, collapsedCls, labels: [...new Set(labels)] };
      })()`);
      console.error("[dbg] rail debug:", JSON.stringify(dbg));
      throw new Error("折叠侧边栏后未进入 rail 态(按钮未变 36px)");
    }
    if (railState.settingsCS.h !== "36px") throw new Error("折叠后「设置」应为 36×36 icon-only");
    if (railState.marketCS.w !== "36px" || railState.marketCS.h !== "36px")
      throw new Error(`折叠后「插件」应 36×36,实际 ${JSON.stringify(railState.marketCS)}`);
    if (railState.settingsCS.br !== "50%" || railState.marketCS.br !== "50%")
      throw new Error(`折叠后两按钮圆角应 50%(与「设置」纯圆 hover 一致),实际 ${railState.settingsCS.br} vs ${railState.marketCS.br}`);
    if (railState.settingsLabelVisible || railState.marketLabelVisible)
      throw new Error("折叠后两个按钮都应只显示 icon(label 隐藏)");
    if (!railState.marketAbove) throw new Error("折叠后「插件」仍应在「设置」上方");
    if (!railState.noOverlap) throw new Error("折叠后两按钮不应重叠(应上下排列)");
    console.log("[1b] 折叠(rail):两按钮 36×36 icon-only,上下排列不重叠 ✓");

    // ---------- 3a3. 折叠态才开启入口 → 展开后必须完整恢复(rail 类残留 bug) ----------
    // 回归:克隆发生在折叠态时按钮带着 VOzbGW_rail 等折叠专用类,展开后
    // 残留会导致按钮保持 36px 且文字缺失——按钮类须跟随「设置」当前类。
    // 当前仍在折叠态(1b 未展开):先关再开开关,模拟「折叠状态开启入口」。
    await win.webContents.executeJavaScript(`window.__dshBoxMarketBridge.setEnabled(false); undefined;`);
    await wait(200);
    await win.webContents.executeJavaScript(`window.__dshBoxMarketBridge.setEnabled(true); undefined;`);
    await wait(600);
    const mRail2 = await win.webContents.executeJavaScript(`(() => {
      const mBtn = document.querySelector('[data-slot="sidebar.market"] button');
      let label = null;
      for (const x of mBtn.querySelectorAll('*')) {
        if (x.children.length === 0 && (x.textContent || '').trim() === '插件') { label = getComputedStyle(x).display; break; }
      }
      return { w: getComputedStyle(mBtn).width, label, clsHasRail: (mBtn.className || '').includes('rail') };
    })()`);
    if (mRail2.w !== "36px" || mRail2.label !== "none" || !mRail2.clsHasRail)
      throw new Error(`折叠态开启入口后按钮应为 36px+label 隐藏+rail 类,实际 ${JSON.stringify(mRail2)}`);
    // 展开 → 按钮恢复 264px 完整行 + 文字 + 移除 rail 类
    await win.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('button,[role="button"]')].find((x) => (((x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '')).includes('展开侧边栏')) || (((x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '')).includes('打开侧边栏')));
      if (b) b.click();
    })()`);
    await wait(1500);
    const mExpanded2 = await win.webContents.executeJavaScript(`(() => {
      const mBtn = document.querySelector('[data-slot="sidebar.market"] button');
      let labelVisible = false;
      for (const x of mBtn.querySelectorAll('*')) {
        if (x.children.length === 0 && (x.textContent || '').trim() === '插件') { labelVisible = x.getClientRects().length > 0; break; }
      }
      return { w: getComputedStyle(mBtn).width, labelVisible, clsHasRail: (mBtn.className || '').includes('rail') };
    })()`);
    if (mExpanded2.w !== "264px" || !mExpanded2.labelVisible || mExpanded2.clsHasRail)
      throw new Error(`展开后「插件」应恢复完整行+文字+无 rail 类,实际 ${JSON.stringify(mExpanded2)}`);
    console.log("[1c] 折叠态开启入口 → 展开后完整恢复(类跟随,无 rail 残留) ✓");

    // ---------- 3b. 点击「插件」→ 设置弹窗打开并激活插件市场页 ----------
    await win.webContents.executeJavaScript(`document.querySelector('[data-slot="sidebar.market"] button').click(); undefined;`);
    const marketActivated = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        const r = await win.webContents.executeJavaScript(`(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return null;
          const marketBtn = [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '插件市场');
          if (!marketBtn) return null;
          const isCurrent = marketBtn.getAttribute('aria-current') === 'true';
          const active = dialog.querySelector('[data-section-id="market"], [class*="sectionOn"], [aria-selected="true"]');
          return { dialog: true, isCurrent, activeNow: !!active };
        })()`);
        if (r && r.dialog && (r.isCurrent || r.activeNow)) return r;
        // 弹窗已开但尚未激活 → 继续等(可能点击时序差一拍)
        await wait(500);
      }
      return null;
    })();
    if (!marketActivated?.dialog) throw new Error("点击「插件」应打开设置弹窗");
    if (!marketActivated.isCurrent && !marketActivated.activeNow)
      throw new Error("设置弹窗应激活「插件市场」页");
    console.log("[2] 点「插件」 → 设置弹窗打开并激活插件市场页 ✓");

    // ---------- 3c. 设置弹窗导航图标替换为 chajian ----------
    const icon = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const r = await win.webContents.executeJavaScript(`(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return null;
          const marketBtn = [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '插件市场');
          if (!marketBtn) return null;
          const holder = marketBtn.querySelector('.dshbox-market-icon');
          const defaultSvg = marketBtn.querySelector('svg:not(.dshbox-market-icon)') || marketBtn.querySelector('svg');
          return {
            holder: !!holder,
            holderRects: holder ? holder.querySelectorAll('svg rect').length : 0,
            defaultSvgGone: holder ? (defaultSvg === null || defaultSvg === undefined || defaultSvg.closest('.dshbox-market-icon')) : false,
          };
        })()`);
        if (r && r.holder) return r;
        await wait(500);
      }
      return null;
    })();
    if (!icon) throw new Error("设置弹窗里「插件市场」按钮图标未替换");
    if (!icon.holder || icon.holderRects < 8) throw new Error("替换图标应为 chajian 方块网格");
    if (!icon.defaultSvgGone) throw new Error("默认齿轮图标应被移除");
    console.log("[3] 设置弹窗「插件市场」导航图标:默认齿轮 → chajian ✓");

    // ---------- 3d. 开关门控:setEnabled(false) 移除入口,true 恢复 ----------
    await win.webContents.executeJavaScript(`window.__dshBoxMarketBridge.setEnabled(false); undefined;`);
    await wait(300);
    const gone = await win.webContents.executeJavaScript(`!document.querySelector('[data-slot="sidebar.market"]')`);
    if (!gone) throw new Error("setEnabled(false) 后入口应移除");
    await win.webContents.executeJavaScript(`window.__dshBoxMarketBridge.setEnabled(true); undefined;`);
    await wait(300);
    const back = await win.webContents.executeJavaScript(`!!document.querySelector('[data-slot="sidebar.market"]')`);
    if (!back) throw new Error("setEnabled(true) 后入口应恢复");
    console.log("[4] 开关门控:关 → 入口移除;开 → 恢复 ✓");

    console.log("\nPASS ✓ 插件市场真实环境端到端回归通过");
    win.destroy();
    app.quit();
  } catch (err) {
    console.error("\nFAIL ✗ 插件市场真实环境端到端回归:", err.message);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  } finally {
    if (dshProcess) {
      try { dshProcess.kill("SIGTERM"); } catch { /* 已退出 */ }
    }
  }
});

app.on("window-all-closed", () => {
  app.quit();
});