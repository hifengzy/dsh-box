---
name: dsh-box-ui
version: 1.0.0
description: |
  为 DSH Box（DeepSeek Harness 桌面壳）生成与 dsh 原生 WebUI 视觉完全一致的页面
  （右侧面板 / 弹窗 / 加载页 / 顶栏 / 关于页 / 设置页等）。内含从
  @deepseek-ai/dsh-web-frontend 实测提取的完整设计系统：色彩 token 表（亮/暗两套）、
  字阶、圆角体系、组件规格（按钮/输入框/菜单/弹窗/pill/导航/列表行/滚动条）、
  设置弹窗解剖、图标规范与主题适配方法。用户说"按 dsh 风格做新页面"、
  "和 dsh UI 保持一致"、"用 dsh 的设计变量"、或新增 dsh-box 的 renderer 页面时使用。
whenToUse: |
  在 DSH Box 项目里新建或修改 src/renderer/ 下的任何页面（.html/.css/.js），
  需要视觉上与 dsh WebUI 统一的场景；也适用于给 dsh WebUI 写 custom.css 调整。
  不适用于 dsh 内部功能的改版（那需要写 dsh client 插件，另走插件体系）。
user-invocable: true
---

# DSH Box UI 统一风格（dsh-box-ui）

给 DSH Box 新增页面时，按本技能产出与 DeepSeek Harness WebUI 视觉一致的界面。
**完整 token 表和逐组件规格见 `docs/DSH-UI-DESIGN.md`（本技能的事实依据）。**

## 工作流程（必须按序执行）

### 1. 确认接入位置（决定 token 用法）

先判断新页面属于哪种：

| 场景 | 页面位置 | 主题方案 |
| --- | --- | --- |
| A. 独立外壳页面 | `src/renderer/*.html`（新文件）| 自带 CSS + `light-dark()` 翻译 token（§8 清单）|
| B. 注入 dsh WebUI 的样式微调 | 项目根 `custom.css` | 直接引用 `--dsw-*` 变量（dsh 页面已定义）|
| C. 需要 dsh 页面内新组件 | 需写 client 插件 | 引用 `--dsw-alias-*` 变量，组件规范见 §4 |

> 默认新增页面走 **A**（独立 WebContentsView 或弹窗），与现状 topbar/dsh-status/about 一致。

### 2. 主题接入（A 场景必做）

```css
:root { color-scheme: light dark; }
/* 把 docs/DSH-UI-DESIGN.md §1 的别名表用 light-dark() 翻译成本地变量 */
:root {
  --bg: light-dark(rgb(249,250,251), rgb(21,21,23));      /* bg-base */
  --surface: light-dark(#ffffff, rgb(27,27,28));          /* bg-layer-2 */
  --surface-2: light-dark(rgb(235,238,242), rgb(53,54,56)); /* 选中/hover 底 */
  --border: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.08));   /* border-l2* */
  --border-strong: light-dark(rgba(0,0,0,.12), rgba(255,255,255,.16)); /* border-l3 */
  --text: light-dark(rgb(15,17,21), rgb(249,250,251));    /* label-primary */
  --text-secondary: light-dark(rgb(97,102,107), rgb(207,211,214)); /* label-secondary */
  --text-muted: light-dark(rgb(151,157,166), rgb(129,133,140));    /* label-tertiary */
  --brand: light-dark(rgb(65,118,230), rgb(103,158,254)); /* state-business-primary */
  --brand-hover: light-dark(rgb(57,100,205), rgb(124,172,255));
  --brand-weak: light-dark(rgba(65,118,230,.1), rgba(103,158,254,.16));
  --ok: light-dark(rgb(34,197,94), rgb(78,209,126));
  --err: light-dark(rgb(236,19,19), rgb(242,90,90));
  --warn: light-dark(rgb(221,134,41), rgb(245,158,11));
}
```

参考实现：`src/renderer/dsh-status.css`（现成范例，含完整版）。

### 3. 按下面是硬性规范写页面

- **字体**：`-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif`；代码 `ui-monospace, "SF Mono", Menlo, monospace`；`-webkit-font-smoothing: antialiased`。
- **字号只允许字阶**：正文 14px/22px；小字 12px/18px；极小 11px/16px；面板标题 12px/600；大标题 16px/600。禁止 13px 乱入（13 保留给 tooltip）。
- **圆角只允许一套**：面板/卡片 10~16px、按钮 7~8px（或胶囊 999px，小按钮 14px）、chip/badge 999px、弹窗 24px、图标按钮圆形。
- **边框**：一律透明层（亮 `rgba(0,0,0,.04~.16)`，暗 `rgba(255,255,255,.06~.20)`），分隔线 1px，禁止实色边框。
- **按钮**：主按钮 = 品牌蓝底白字（hover 加深）；次按钮 = 透明 + 边框(strong) + hover 变 surface-2；按钮内图标 gap 4px。禁用 = `opacity:.55`。
  > 注：外壳页面（A 场景）主按钮用品牌蓝与现有 dsh-status 一致；**dsh 内部页面（C 场景）
  > 主按钮是"反白"**（浅色=近黑底 `--dsw-alias-button-primary-fill` / 深色=近白底），
  > 品牌蓝只用于链接/进行中/聚焦环——写 client 插件时遵循后者。
- **状态色语义**：成功 green（`rgb(34,197,94)`/`rgb(78,209,126)`）、错误 red（`rgb(236,19,19)`/`rgb(242,90,90)`）、警告 amber（`rgb(221,134,41)`/`rgb(245,158,11)`）、进行中/主色 = 品牌蓝。红点更新徽标用 red。
- **交互反馈**：hover 底色变化 ≤ `0.15s ease`；active 加深；focus-visible 用 `2px outline + 2px offset`（色 `state-business-primary` 或 `border-l4`）。尊重 `prefers-reduced-motion`。
- **滚动条**：8px 宽，thumb 4px 圆角（§4.10）。
- **间距**：flex/grid + gap（4/6/8/10/12），块间 16，弹窗内容 24；列表行高 40/34/26 三档。
- **图标**：16px 网格线性 SVG，`fill:none` + 路径，颜色 currentColor；外壳透明底上用 mask 方案（参考 topbar.css）。

### 4. 需要组件规格（按钮/输入/菜单/弹窗/设置页/nav/pill/tooltip/toast）时

打开 `docs/DSH-UI-DESIGN.md` §4~§5，照抄对应组件的 CSS 骨架（都是实测值），
只换成本地变量名（`--bg/--surface/--border/--text/--brand`）。

> 已知要点（实测）：
> - dsh 的组件库（dsh-client-ui-primitives）是"agent 证据卡片"产品库——**没有
>   Select/Switch/Tabs/Badge 等通用控件**；需要时按 `docs/DSH-UI-DESIGN.md` §4 的
>   同类规格手写（下拉用 Menu、状态用 StateDot、徽章用 Pill）。组件全景见 §6.2。
> - 全库仅 6 个动画且克制（tooltip .15s 淡入、toast .16s+3s、StateDot 矩阵扫描 1s、
>   spinner .8s、抽屉宽度 .3s、hover ≤.15s）；Modal/菜单**无进入动画**。明细见 §6.1。
> - 图标源码命名 `ic_ds_<name>_<variant>_<size>`（14/16 为主），全部 `currentColor`。

### 5. 校验清单（交付前逐条过）

- [ ] `color-scheme: light dark` 已声明；所有颜色走变量，深浅色各验证一遍
- [ ] 无超出字阶/圆角体系的硬编码
- [ ] 无 `#xxx` 实色（品牌蓝/状态色按 §3 色值表）
- [ ] hover/active/disabled/focus-visible 四态齐全
- [ ] 可访问性：图标按钮带 aria-label；红点等纯装饰带 `aria-hidden`/`pointer-events:none`
- [ ] 滚动区域有 8px 滚动条
- [ ] `prefers-reduced-motion` 时不动画
- [ ] 与相邻 dsh 页面并排时无突兀色差（对照 `--dsw-alias-*` 亮暗值）

## 规则与禁忌

- **不要**引入新 UI 框架（Tailwind/Ant/MUI 等）与 dsh 视觉冲突。
- **不要**为外壳页面定义 `--dsw-*` 变量并期待生效——外壳是独立 file:// 页面，
  必须自包含 token（用 `light-dark()` 翻译）。
- **不要**在透明玻璃面（顶栏）上用不透明纯色 hover 底，用半透明白/黑层（参考 topbar.css `--bar-hover`）。
- 中文界面文案：保持一致语气（`应用中` 而非 `App`、`服务已停止` 等），参考现有 renderer 页面用语。
- 新页面记得在主进程 `main.js` / preload 桥里注册 IPC（如需与主进程通信），
  并在 `installWebUIInjection` 无冲突的前提下新增视图/弹窗。

## 参考文件

- `docs/DSH-UI-DESIGN.md` —— 完整设计系统（本文档的展开版）
- `docs/DSH-SETTINGS-UI.md` —— **设置弹窗专项**（容器/导航/设置行/表单控件/交互反馈逐项解剖）
- `src/renderer/dsh-status.css` —— 外壳页面首选范本（面板/卡片/按钮/列表/badge 全都有）
- `src/renderer/topbar.css` —— 毛玻璃/透明底/图标 mask 范本
- `src/renderer/style.css` —— 启动加载页范本（深浅两套 + 主题切换）
- 上游素材（只读参考，勿改）：
  - `node_modules/@deepseek-ai/dsh-client-ui-theme/lib/styles/design-platform.css`（完整 token）
  - `node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.css`（编译后组件样式）