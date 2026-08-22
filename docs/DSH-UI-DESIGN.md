# DSH UI 设计规范（DeepSeek Harness WebUI 风格）

> 本文档是 **dsh-box-ui** 技能的事实依据，由对 `@deepseek-ai/dsh-web-frontend` 编译产物
> （`index-*.css` / `dsh-client-ui-*/lib/client.js`）与 `dsh-client-ui-theme/lib/styles/*.css`
> 的实测分析整理而成。给 DSH Box 新增页面时，**优先读技能 SKILL.md**；需要精确数值时查本文档。
> 「设置」弹窗的专项完整解剖见 **`docs/DSH-SETTINGS-UI.md`**。

---

## 0. 设计哲学

- **冷静克制的浅灰 + DeepSeek 品牌蓝**：中性色占绝对主导，蓝色只用于品牌强调、选中态与链接；
  红/绿/琥珀仅作状态语义色。
- **层级靠「表面色 + 边框透明度」表达**，不靠阴影堆叠：同层表面几乎同色，靠 4%~20% 透明度的
  边框线（l1→l4）与极小阴影区分层次。
- **圆角统一在 4px 一族（5/7/8/10/12）、大面板 16/24**，胶囊按钮用 999px 一族（14/18/28）。
- **主题由 `--dsw-*` 变量驱动**，组件永不写死颜色；深色 = `body[data-ds-dark-theme]` 上的变量覆盖。
- 动效统一走 `--ds-ease-in-out: cubic-bezier(0.4,0,0.2,1)`，时长 0.1s（fast）/0.2s（base）/0.3s（slow）。

---

## 1. 色彩系统（完整 token 表）

### 1.1 静态色板 `--dsw-static-*`（同一值，深色模式不覆盖——static 语义）

全部定义在 `design-platform.css`。核心色板：

| 色板 | 典型值（light/dark 共用） |
| --- | --- |
| neutral-bluish-00 | `rgb(255,255,255)`（浅色页面底） |
| neutral-bluish-50 | `rgb(249,250,251)`（侧边栏底） |
| neutral-bluish-60 | `rgb(249,250,251)`（浅色底变体） |
| neutral-bluish-75 | `rgb(241,243,245)`（hover 底） |
| neutral-bluish-100 | `rgb(235,238,242)`（选中底） |
| neutral-bluish-150 | `rgb(233,236,242)` |
| neutral-bluish-200 | `rgb(225,229,238)`（placeholder/弱文本） |
| neutral-bluish-300 | `rgb(207,211,214)` |
| neutral-bluish-400 | `rgb(173,178,184)`（caption 文本） |
| neutral-bluish-500 | `rgb(151,157,166)`（中弱文本/边框强） |
| neutral-bluish-600 | `rgb(129,133,140)`（tertiary 文本） |
| neutral-bluish-700 | `rgb(97,102,107)`（secondary 文本） |
| neutral-bluish-750 | `rgb(67,69,74)`（ename hover） |
| neutral-bluish-800 | `rgb(53,54,56)`（深色弹层） |
| neutral-bluish-850 | `rgb(44,44,46)`（深色 tooltip） |
| neutral-bluish-875/900/950 | `rgb(35,35,36)` / `rgb(27,27,28)` / `rgb(21,21,23)`（深色分层表面） |
| neutral-bluish-1000 | `rgb(15,17,21)`（深色主文本） |
| deepseek-50 | `rgb(237,243,254)`（气泡浅底） |
| deepseek-100/200/300 | `rgb(228,237,253)` / `rgb(211,226,255)` / `rgb(183,200,254)` |
| deepseek-400 | `rgb(103,158,254)`（暗色品牌蓝） |
| deepseek-450 | `rgb(86,134,254)`（进行中状态） |
| deepseek-500 | `rgb(65,118,230)`（亮色品牌蓝 = 主按钮/链接） |
| deepseek-600 | `rgb(72,104,178)` |
| blue-50/100/400/500/600/900 | Tailwind 蓝系（`rgb(239,246,255)` … `rgb(30,64,175)`） |
| green-100/400/500/900 | `rgb(230,250,237)` / `rgb(78,209,126)` / `rgb(34,197,94)` / `rgb(35,60,44)` |
| red-50/100/400/500/600/900 | `rgb(254,242,242)` / `rgb(254,226,226)` / `rgb(242,90,90)` / `rgb(239,68,68)` / `rgb(236,19,19)` / `rgb(87,12,12)` |
| amber-100/400/500/600/900 | `rgb(254,245,231)` / `rgb(247,173,49)` / `rgb(245,158,11)` / `rgb(221,134,41)` / `rgb(39,36,31)` |

### 1.2 语义别名 `--dsw-alias-*`（light / dark 两套，写组件用别名，不直接用 static）

| 别名 | light | dark |
| --- | --- | --- |
| `--dsw-alias-bg-base` | neutral-bluish-00 `#fff` | neutral-bluish-950 `#151517` |
| `--dsw-alias-bg-layer-1` | neutral-bluish-00 | neutral-bluish-875 |
| `--dsw-alias-bg-layer-2` | neutral-bluish-00 | neutral-bluish-850（弹窗/菜单面） |
| `--dsw-alias-bg-layer-3` | neutral-bluish-00 | neutral-bluish-800 |
| `--dsw-alias-bg-mask-1` | `rgba(0,0,0,.24)` | `rgba(0,0,0,.5)`（弹窗遮罩） |
| `--dsw-alias-bg-mask-2` | `rgba(0,0,0,.12)` | `rgba(0,0,0,.2)` |
| `--dsw-alias-bg-mask-3` | `rgba(0,0,0,.48)` | 同左 |
| `--dsw-alias-bg-mask-photo` | `rgba(0,0,0,.88)` | 同左 |
| `--dsw-alias-bg-overlay` | neutral-bluish-150 | neutral-bluish-700 |
| `--dsw-alias-border-l1` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)`（最弱分隔线） |
| `--dsw-alias-border-l2` | `rgba(0,0,0,.10)` | `rgba(255,255,255,.12)`（默认边框） |
| `--dsw-alias-border-l2-darkmode-thin` | `rgba(0,0,0,.10)` | `rgba(255,255,255,.06)` |
| `--dsw-alias-border-l3` | `rgba(0,0,0,.12)` | `rgba(255,255,255,.16)` |
| `--dsw-alias-border-l4` | `rgba(0,0,0,.16)` | `rgba(255,255,255,.20)`（强边框/focus） |
| `--dsw-alias-border-inverted` | `rgba(0,0,0,0)`（明面菜单边框用 shadow 代替） | `rgba(255,255,255,.06)`（暗面菜单描边） |
| `--dsw-alias-label-primary` | neutral-bluish-1000 `#0f1115` | neutral-bluish-50 `#f9fafb` |
| `--dsw-alias-label-secondary` | neutral-bluish-700 | neutral-bluish-300 |
| `--dsw-alias-label-tertiary` | neutral-bluish-600 | neutral-bluish-400 |
| `--dsw-alias-label-caption` | neutral-bluish-400 | neutral-bluish-600 |
| `--dsw-alias-label-dimmed` | neutral-bluish-200（placeholder） | neutral-bluish-750 |
| `--dsw-alias-label-primary-foreground` | 白 `#fff`（主按钮文字） | neutral-bluish-1000 |
| `--dsw-alias-label-primary-inverted` | 白 | neutral-bluish-800（toast 文字） |
| `--dsw-alias-brand-primary` | neutral-bluish-1000（亮色主按钮=黑） | neutral-bluish-50（暗色主按钮=白） |
| `--dsw-alias-brand-text` | neutral-bluish-1000 | neutral-bluish-50（品牌文字） |
| `--dsw-alias-brand-primary-new-colorprimary-new-color` | `rgb(65,118,230)` | deepseek-450 `rgb(86,134,254)`（品牌蓝，用于链接/强调） |

> **注意品牌语义**：`brand-primary` 在亮暗都是中性色（黑白按钮的背景），真正显示"品牌蓝"
> 的是 `state-business-primary`／`brand-primary-new-colorprimary-new-color`。做强调色时对照下表。

| 状态别名 | light | dark | 用途 |
| --- | --- | --- | --- |
| `--dsw-alias-state-business-primary` | deepseek-500 `rgb(65,118,230)` | deepseek-400 `rgb(103,158,254)` | 链接/品牌强调/选中 |
| `--dsw-alias-state-business-tertiary` | deepseek-100 | deepseek-800 | 强调弱底 |
| `--dsw-alias-state-success-primary` | green-500 | green-500 | 成功 |
| `--dsw-alias-state-success-secondary` | green-400 | green-400 | |
| `--dsw-alias-state-success-tertiary` | green-100 | green-900 | 成功弱底 |
| `--dsw-alias-state-error-primary` | red-600 | red-400 | 错误 |
| `--dsw-alias-state-error-secondary` | red-400 | red-400 | |
| `--dsw-alias-state-warn-primary` | amber-500 | amber-500 | 警告 |
| `--dsw-alias-state-warn-secondary` | amber-400 | amber-400 | |
| `--dsw-alias-state-warn-label` | amber-600 | amber-600 | 警告文字 |
| `--dsw-alias-state-warn-tertiary` | amber-100 | amber-900 | 警告弱底 |

### 1.3 交互底色别名（hover/active 统一走透明层，不换色）

| 别名 | light | dark |
| --- | --- | --- |
| `--dsw-alias-interactive-bg-hover` | `rgba(38,49,72,.06)` | `rgba(255,255,255,.08)` |
| `--dsw-alias-interactive-bg-active` | `rgba(38,49,72,.10)` | `rgba(255,255,255,.14)` |
| `--dsw-alias-interactive-bg-hover-accent` | `rgba(38,49,72,.14)` | `rgba(255,255,255,.24)` |
| `--dsw-alias-interactive-bg-hover-danger` | `rgba(236,19,19,.05)` | `rgba(242,90,90,.15)` |
| `--dsw-alias-interactive-bg-hover-solid` | neutral-bluish-75 | neutral-bluish-800 |

### 1.4 按钮、菜单、toast、tooltip 专用别名

| 别名 | light | dark | 用途 |
| --- | --- | --- | --- |
| `--dsw-alias-button-primary-fill` | `var(--dsw-alias-brand-primary)`（黑） | 白 | 主按钮底 |
| `--dsw-alias-button-primary-hover` | neutral-bluish-750 | neutral-bluish-100 | 主按钮 hover |
| `--dsw-alias-button-primary-dimmed` | neutral-bluish-100 | neutral-bluish-750 | 主按钮禁用弱底 |
| `--dsw-alias-button-ghost-active-fill` | neutral-bluish-100 | neutral-bluish-750 | 选中态底 |
| `--dsw-alias-button-ghost-active-border` | neutral-bluish-500 | neutral-bluish-600 | 选中态内描边 |
| `--dsw-alias-button-ghost-active-hover` | neutral-bluish-150 | neutral-bluish-700 | 选中态 hover |
| `--dsw-alias-button-elevated-fill` | 白 | neutral-bluish-750 | 凸起按钮（如「新建会话」） |
| `--dsw-alias-button-floating-fill` | 白 | neutral-bluish-850 | 浮动按钮 |
| `--dsw-alias-button-floating-hover` | neutral-bluish-75 | neutral-bluish-800 | |
| `--dsw-alias-button-contrast-fill` | neutral-bluish-700 | neutral-bluish-50 | toast 底（对比色） |
| `--dsw-alias-button-info-fill` | deepseek-500 | deepseek-400 | info 按钮 |
| `--dsw-alias-button-info-hover` | deepseek-400 | deepseek-500 | |
| `--dsw-alias-button-tool-bar-fill` | `rgba(84,85,87,.5)` | 同左 | 悬浮工具栏底 |
| `--dsw-alias-button-tool-bar-hover` | `rgba(84,85,87,.6)` | 同左 | |
| `--dsw-alias-toast-bg` | neutral-bluish-800 | neutral-bluish-750 | toast 底（旧） |
| `--dsw-alias-tooltip-bg` | neutral-bluish-850 | neutral-bluish-750 | tooltip 底 |
| `--dsw-alias-scrollbar-bg-l1/l2` | neutral-200 `rgb(229,229,229)` | neutral-700/600 | 滚动条底（基础面/浮层） |
| `--dsw-alias-scrollbar-hover-l1/l2` | neutral-300 | neutral-600/550 | 滚动条 hover |

### 1.5 `--dsw-specific-*`（组件专属）

| 别名 | light | dark |
| --- | --- | --- |
| `--dsw-specific-sidebar-fill` | neutral-bluish-50 | neutral-bluish-900（侧边栏底） |
| `--dsw-specific-sidebar-nav-item-active` | neutral-bluish-100 | neutral-bluish-750（导航选中底） |
| `--dsw-specific-sidebar-nav-item-active-accent` | deepseek-100 | neutral-bluish-800 |
| `--dsw-specific-sidebar-nav-item-hover` | neutral-bluish-75 | neutral-bluish-850 |
| `--dsw-specific-menu` | `var(--dsw-alias-bg-layer-3)` | 同左（菜单底） |
| `--dsw-specific-bubble` | deepseek-50 | neutral-bluish-850（气泡） |
| `--dsw-specific-bubble-highlight` | deepseek-200 | neutral-bluish-750 |
| `--dsw-specific-input-major` | 白 | neutral-bluish-850（主输入框） |
| `--dsw-specific-tip` | neutral-bluish-60 | neutral-bluish-800（提示底） |
| `--dsw-specific-selector` | neutral-bluish-60 | neutral-bluish-800 |
| `--dsw-specific-login-input` | neutral-bluish-50 | neutral-bluish-900 |

### 1.6 阴影与遮罩（三层，克制）

```
--dsw-shadow-lv1:      0 2px 4px 0 rgba(0,0,0,.05)                     /* 悬浮卡片 */
--dsw-shadow-lv1-blur: 0 4px 12px 0 rgba(0,0,0,.02)
--dsw-shadow-lv2:      0 4px 12px 0 rgba(0,0,0,.02), 0 2px 8px 0 rgba(0,0,0,.04)
--dsw-shadow-lv3:      0 0 1px 0 rgba(0,0,0,.2), 0 0 4px 0 rgba(0,0,0,.02), 0 12px 32px 0 rgba(0,0,0,.08)
                       /* 弹窗/菜单/下拉 (浅色下边框 l3 用 0 0 1px + 大偏移阴影) */
--dsw-mask-blur:       blur(2px)                                        /* 弹窗遮罩模糊 */
```

---

## 2. 字体与文本排版

### 2.1 字体栈

```css
--dsw-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
  "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
--ds-font-family-code: "SF Mono", "JetBrains Mono", "Fira Code", Consolas,
  "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";
```

`body { -webkit-font-smoothing: antialiased; }`（macOS 必备）。

### 2.2 字阶（Figma token，唯一的字号来源）

| token | 字号/行高/字重 | 用途 |
| --- | --- | --- |
| `--dsw-font-xl-24` | 600 24px/32px | 页面大标题 |
| `--dsw-font-l-20` | 500 20px/28px | 区块标题 |
| `--dsw-font-m-18` | 500 16px/28px | 次标题 |
| `--dsw-font-base-16` | 400 16px/24px | 正文/对话框正文 |
| `--dsw-font-base-strong-16` | 500 16px/24px | 正文强调 |
| `--dsw-font-s-14` | 400 14px/22px | **默认 UI 字号**（按钮/输入/列表项/导航） |
| `--dsw-font-s-strong-14` | 500 14px/22px | UI 强调（「新建会话」按钮） |
| `--dsw-font-xs-13` | 400 13px/20px | 小文本 |
| `--dsw-font-xs-strong-13` | 500 13px/20px | |
| `--dsw-font-xxs-12` | 400 12px/18px | 辅助/徽标/次级说明 |
| `--dsw-font-xxs-strong-12` | 500 12px/18px | 面板标题、小节标题 |
| `--dsw-font-xxxs-11` | 400 11px/14px | 最弱标注 |
| `--dsw-font-xxxs-strong-11` | 500 11px/14px | |

**Markdown 字阶**（渲染对话内容）：h1=700 24/34、h2=700 22/32、h3=700 20/30、
h4=600 16/28、正文=16/28、small=14/24、code=14/22、code-block=13/22、table=15/25。

**行高规律**：字号+8（13→20、14→22、16→24、20→28、24→32）或 *1.4~1.5；
小字用紧行高（11→14、12→18）。

---

## 3. 间距 / 圆角 / 布局节奏

### 3.1 间距（无独立 spacing token，实测规律）

| 场景 | 值 |
| --- | --- |
| 弹窗/面板内边距 | content 水平 `24px`，header 上方 `22px`，options 底部 `24px` |
| 设置行纵向 | `padding: 16px 0`，行间 gap 8px，行间分隔 `border-bottom: 1px solid l2` |
| 导航列表项间距 | gap 4px（navList）/ 2px（紧凑菜单） |
| 按钮图标间隙 | gap 4px（icon + label） |
| 通用小组件间隙 | gap 6/8px（输入框图标、pill、菜单项） |
| 区块间隙 | gap 8/10/12px（同级）|
| 弹窗标题栏与内容 | gap 20px（dialog flex column）|
| 菜单项内边距 | `8px 10px`（高 40px）/ 紧凑 `3px 7px`（高 26px）|

### 3.2 圆角体系（实测频率）

| 值 | 用途 |
| --- | --- |
| `4px` | 滚动条 thumb、极小元素 |
| `5px`；`6px` | 紧凑菜单项、极小控件 |
| `7px`；`8px` | **输入框/小按钮/工具按钮/文本框**默认圆角 |
| `10px` | 菜单项（40px 行内） |
| `12px` | **pill/导航项/「新建会话」/卡片/terminal 块**（最常见中圆角） |
| `14px` | 小号按钮（sm），toast |
| `16px` | 大卡片、主题色块选择器、头像/缩略图容器 |
| `18px` | 中号按钮（md） |
| `24px` | **弹窗 Dialog / 设置面板**（大圆角） |
| `28px`；`999px` | 圆形图标按钮、关闭钮、胶囊 |

规律：**按钮/小控件 8~18（sm 14 / md 18）；导航项、pill、卡片 12；大面板 24；小面板 16。**

### 3.3 布局节奏

- 列表/导航行高：常规 `40px`，紧凑 `34px`，极紧凑 `26px`。
- 输入控件高度：`32px`（带边框）、主输入框 36px；按钮高度 md `36px`、sm `28px`。
- 图标按钮：`28×28`（圆形 `border-radius:50%`），悬停有底。
- 分隔线一律 `1px` + `--dsw-alias-border-l1/l2`。
- 布局用 **flex/grid + gap**，禁止 margin 堆叠（组件间 gap 优先）。

---

## 4. 组件规格

### 4.1 按钮 Button

```
默认: inline-flex; align-items:center; justify-content:center; gap:4px;
      border:none; border-radius:18px; font-size:14px; line-height:22px;
      color: label-primary; background:transparent; padding:0 14px;
      cursor:pointer
md : height:36px
sm : height:28px; font-size:12px; line-height:18px; padding:0 10px; border-radius:14px
disabled: opacity:.4; cursor:not-allowed
```

变体：`primary`（`button-primary-fill` 底 + `label-primary-foreground` 字，hover 换 primary-hover）、
`ghost`（透明底，hover `interactive-bg-hover`，active `interactive-bg-active`）、
`outline`（`1px solid border-l2` + interactive hover）、`toolbar`（`button-tool-bar-fill` + hover）、
`icon`（16×16 内置图标）。危险操作样式：文字/图标用 `state-error-primary`，hover 底 `interactive-bg-hover-danger`。

### 4.2 输入框 Input

```
wrap: inline-flex; align-items:center; gap:6px; height:32px; padding:0 8px;
      border:1px solid var(--dsw-alias-border-l2); border-radius:8px;
      background: var(--dsw-alias-bg-layer-1)
focus-within: border-color: var(--dsw-alias-brand-primary)
input: flex:1; min-width:0; border:none; outline:none; background:transparent;
       font-size:14px; line-height:22px; color:label-primary
::placeholder: var(--dsw-alias-label-dimmed)
leading icon: 16×16, color label-tertiary
```

### 4.3 下拉菜单 Menu / Dropdown

```
面板: padding:4px; flex-column; gap:0; border-radius:12px;
      border:1px solid var(--dsw-alias-border-inverted);
      background: var(--dsw-specific-menu); box-shadow: var(--dsw-shadow-lv3);
      min-width:218px; max-width:360px; z-index:100;
      浮层内滚动条用 scrollbar-bg-l2 组 (浮层更亮)
菜单项: display:flex; align-items:center; gap:8px; width:100%;
      min-height:40px; padding:8px 10px; border-radius:10px; font-size:14px;
      color: label-primary; hover: interactive-bg-hover
紧凑版 (compact): min-width:164px; padding:2px; radius:7px; 项 min-height:26px;
      padding:3px 7px; radius:5px; font-size:12px; 图标 14×14
dense 版: 项 min-height:34px; padding-block:5px
分隔线: height:1px; margin:4px 2px; bg border-l1
分组标签: padding:8px 10px; font-size:12px; color: label-tertiary
选中项: 文字变 primary + 尾部 16px 勾选图标（无底色）；危险项: 文字+图标 error-primary,
      hover 底 interactive-bg-hover-danger
```

交互细节（实测）：portal 模式 `position:fixed; z-index:1100`，与视口边缘夹紧 12px；
触发器↔面板 4px 间隙可穿越（200ms pointer-grace 防手抖误关）；子菜单在右侧
`left:calc(100%+10px)`，带 10px 过渡带（`:before` 桥）防指针掉落；Escape/外点关闭；
footer 钉底行（上边框 border-l2）；面板滚轮视口 `max-height:calc(100vh - 24px)`。

### 4.4 弹窗 Modal / Dialog

```
root    : fixed; inset:0; z-index:1000; display:flex; align-items:center;
          justify-content:center; padding:24px
mask    : absolute; inset:0; background: var(--dsw-alias-bg-mask-1);
          backdrop-filter: var(--dsw-mask-blur)   /* blur(2px) */
dialog  : width:min(380px,100%); flex-column; gap:20px; padding:0 0 24px;
          border:1px solid var(--dsw-alias-border-inverted);
          border-radius:24px; background: var(--dsw-alias-bg-layer-2);
          box-shadow: var(--dsw-shadow-lv3); z-index:1
header  : flex; space-between; align-items:center; gap:8px; padding:22px 14px 12px 24px
title   : 16px/24px/500 label-primary
close   : 28×28; radius:8px(全圆 28px 亦可); color label-secondary;
          hover: interactive-bg-hover; 图标 14px (IconCloseOutline14)
description: margin:0; padding:0 24px; 14px/22px/400 label-primary
body    : flex-column; min-width:0; margin-top:20px; padding:0 24px
footer  : flex; justify-content:flex-end; gap:8px; padding:0 24px
Esc 关闭；点 mask 关闭；footer 主按钮最小宽 72px，确认按钮 136px
/* 无进入动画（实测 Modal 不带动画，只有点到即现 + 遮罩模糊） */
```

### 4.5 Pill（胶囊徽标）

```
pill: inline-flex; align-items:center; gap:4px; height:24px; padding:0 8px;
      border-radius:12px; font-size:12px; line-height:18px;
      color: label-secondary; background: bg-layer-2
interactive: cursor:pointer; hover: interactive-bg-hover
active(选中): color:label-primary; background:button-ghost-active-fill;
      box-shadow: inset 0 0 0 1px button-ghost-active-border
```

### 4.6 Tooltip / Toast / HoverCard

```
tooltip: padding:3px 7px; border-radius:8px; background: var(--dsw-alias-tooltip-bg);
         color: #fff(浅)/白; font-size:13px; line-height:20px;
         animation: fade-in .15s var(--ds-ease-in-out); pointer-events:none
toast  : fixed; top:120px; left:50%; translateX(-50%); z-index:1100;
         inline-flex; gap:10px; max-width:min(560px, 100vw-48px);
         padding:12px 16px; border-radius:14px; font-size:14px;
         background: var(--dsw-alias-button-contrast-fill);
         color: var(--dsw-alias-label-primary-inverted);
         box-shadow: lv3; 动画 in .16s + 3s 后淡出 (respects reduced-motion)
hovercard: width:244px; padding:12px 16px; border-radius:12px; z-index:100;
          background:#2C2C2E(固定暗面); box-shadow: lv3
```

### 4.7 导航项（侧边栏 / 设置导航）

```
高 40px; border-radius:12px; font-size:14px; padding:9px 16px 9px 12px;
flex; gap:8px; 图标 16px(label-tertiary) + 文字 flex:1 ellipsis
hover: --dsw-specific-sidebar-nav-item-hover
active: --dsw-specific-sidebar-nav-item-active（无左侧竖条，就是整块底色）
```

### 4.8 状态点 StateDot（运行/进行中/成功/失败/警告）

```
done    : 10px 圆点 = 10% 大小光环(opacity .1) + 20% 内芯, color: state-success-primary
warning : 同上, state-warn-primary
error   : 同上, state-error-primary
ongoing : 3×3 像素矩阵 (10px 画布内 8 个 2px 方块), 8 格按 125ms 阶梯错位
          顺时针逐个点亮再暗 (animation-delay 负值起步), 循环 1s,
          color: --dsh-state-ongoing (deepseek-450)
用法: 配文字使用时点 aria-hidden, 文字承担语义 (hint: 与文字并排 = 左点右文)
```

### 4.9 列表/表格/设置行（setting row 规格最重要）

**Markdown 表格 / 引文 / 内联代码**（渲染对话内容时）：

```
表格: th/td padding 10px 16px; 列宽上限 min(30vw, 320px);
      th 底 border-l3; 表头 500 15px/25px
引文: 2px 左侧竖线, 色 label-caption; 引用文字 14px/24px
内联代码: font-size .875em; 内联-flex; 6px 圆角; 底 markdown-inline-code
链接: 色 state-business-primary; hover 下划线; focus-visible 2px 品牌蓝环
      (box-shadow 0 0 0 2px, 走 --ds-transition-duration 缓动)
```

**通用设置行**（语言/权限等所有 general 分区行共用同一布局，实测）：

```
row     : display:flex; align-items:center; gap:8px; padding:16px 0;
          border-bottom:1px solid var(--dsw-alias-border-l2)
rowText : flex-column; flex:1; gap:4px; min-width:0; padding-right:48px   ← 右侧留控件位
title   : 14px/400/22px label-primary
desc    : 12px/400/18px label-tertiary
selector(右): inline-flex; align-items:center; gap:12px; height:36px; padding:0 14px;
          border:none; border-radius:18px(胶囊); font-size:14px;
          background: var(--dsw-alias-bg-module-platform);
          hover: interactive-bg-hover; 尾部 chevron 图标
```

**外观主题色块选择器**（AppearanceRow，外观设置行）：

```
group   : border-bottom:1px solid l2; flex-column; gap:8px; padding:16px 0
title   : 14px/400 label-primary
cubeRow : flex-wrap; gap:8px
themeCube: flex:180px(基准); border:1px solid l2; radius:16px; flex-column;
          align-items:center; justify-content:center; gap:4px; padding:20px 32px;
          font-size:14px; hover: interactive-bg-hover
selected: background: bg-module-platform; border-color: neutral-bluish-400
```

**其它列表**：行间分隔 `border-top:1px solid l1`；行高 40/34/26 三档；
checkbox 16×16 `accent-color: label-secondary`（markdown 表格内）/ `button-primary-fill`（确认弹窗内）。

### 4.10 滚动条（全局统一）

```css
::-webkit-scrollbar { width:8px; height:8px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { border-radius:4px; background: var(--dsh-scrollbar-thumb); }
::-webkit-scrollbar-thumb:hover { background: var(--dsh-scrollbar-thumb-hover); }
/* 基础面默认 scrollbar-bg-l1 组；浮层(菜单/弹窗)rebind 到 l2 组 */
```

---

## 5. 设置弹窗（Settings Modal）完整解剖

`dsh-client-ui-settings-general` 的外壳（实测 CSS 类前缀 VOzbGW_）：

```
结构: fixed 遮罩(z-index:1000) → mask(blur(2px)) → 居中面板(800px)
面板: width:800px; max-width:calc(100vw - 48px); height:min(800px, 100vh - 48px);
      display:flex; border-radius:24px; background:bg-layer-2;
      box-shadow:lv3; overflow:hidden; 滚动条 rebind l2 组
├─ nav 左侧导航: width:188px; flex-column; gap:18px; padding:22px 12px 0
│   ├─ navTitle: 16px/500/24px label-primary; padding:0 12px (设置弹窗标题)
│   └─ navList: flex-column; gap:4px
│       └─ navCell: 40px; radius:12px; gap:8px; padding:9px 16px 9px 12px;
│           14px; icon 16px + label; hover sidebar-nav-item-hover;
│           active sidebar-nav-item-active
└─ content 右侧内容: flex:1; flex-column; min-width:0
    ├─ header: height:54px; padding:20px 14px 8px 10px; space-between;
    │   └─ close: 28×28; radius:28px; color label-primary; hover interactive-bg-hover
    └─ options: flex:1; min-height:0; padding:0 24px 24px; overflow-y:auto
        └─ 每个分区 = section(flex-column; gap:按内容)：
            section 内最后一个 item 的 border-bottom:none
```

**顶部触发器**（侧边栏底部「设置」入口）: 高 34px; radius:12px; width:calc(100%+8px);
margin:4px -4px; padding:6px 2px 6px 10px; 14px; hover interactive-bg-hover；
收起态(rail)变 36×36 圆形图标按钮。

**打开方式**：不是独立窗口，是 **sidebar 底部按钮 → 居中模态**；内容按分区（nav）切换，
行由各功能插件注册（`settings.general.item` slot：「外观」「语言」「权限」等），
支持「打开配置文件」、onboarding 引导叠加层。

**设置专项完整解剖见 `docs/DSH-SETTINGS-UI.md`**（401 行专项报告：含模型页/插件页卡片、
凭证状态点、字段表单、保存条门控、loading/错误/成功反馈模式等全部细节）。此处摘要要点：

- 分类导航顺序：通用设置(0) → 模型(10) → 插件(15) → Agent 预设(20)；图标映射
  models=`IconDataOutline16`、agent-presets=`IconAgentPresetOutline16`、
  plugins=`IconPersonalizationOutline16`、general/其它=`IconSettingsOutline16`。
- 内容区实际文案宽 ≈ 564px（800 − 188 nav − 24×2 padding）；各 section 内部用
  `max-width:720px`（模型）/`760px`（插件）收窄。
- **设置页没有 Switch/Toggle**：开关式状态全部用 pill 选择器、卡片展开、tag/状态点表达。
- **没有 skeleton/spinner**：loading 态 = 文字（「正在读取插件…」）+ `aria-busy`；
  保存中 = 按钮文案「保存中…」+ disabled；成功反馈 = 页内 12px 绿字 `role="status"`
  （无 toast）；错误 = 内联 12px 红字 `role="alert"`。
- 主按钮是**反白强调**（浅色=近黑底/深色=近白底，`--dsw-alias-button-primary-fill`），
  **不是品牌蓝**；品牌蓝（`state-business-primary`）用于链接/进行中状态/聚焦环。
- 图标按钮 / 行卡片上无 hover 态，交互都在控件上；hover 只出现在可点元素。

---

## 5.5 主框架三栏布局（整体页面骨架）

```
.pI_x6G_frame: display:grid; grid-template-rows:100%; height:100%;
               transition: grid-template-columns .3s var(--ds-ease-in-out)  ← 侧边栏动画的宿主
├─ .pI_x6G_sidebarCol : background: --dsw-specific-sidebar-fill;
│                       border-right:1px solid --dsw-alias-border-l1
├─ .pI_x6G_centerCol  : flex-column; min-width:0
└─ .pI_x6G_detailsCol : border-left:1px solid --dsw-alias-border-l2;
                        [data-details-collapsed] 时无左边线
拖拽手柄: 8px 宽; hover 时浮现 12×32 圆角小竖条 (radius:10px, border-l2)
```

---

## 6. 图标体系

- **命名**：源码规范为 `ic_ds_<名称>_<变体>_<尺寸>`（编译后为 `Icon<名称><变体><尺寸>` 函数），
  如 `ic_ds_settings_outline_16`（`IconSettingsOutline16`）、`ic_ds_check_outline_14`、
  `ic_ds_close_outline_16`、`ic_ds_search_outline_16`、`ic_ds_light_outline_16`、
  `ic_ds_dark_outline_16`、`ic_ds_followsystem_outline_16`（跟随系统）、
  `ic_ds_panel_left_outline_16`（收起侧边栏）。
- **尺寸**：14/16 为主（16 是标准），12/20 用于特例；Fill 变体用于强调状态
  （如 `LikeFill16`）。图标 props 仅 `{ size?, className? }`。
- **批次**：Batch A 镜像 deepsuite 图标库（同一 Figma 源）；Batch B 为 harness 专属提取
  （globe/api/personalization/project_add/goal/question/archive 等，JSDoc 标 "figma extract"）。
- **规格**：`<svg width=size height=size viewBox="0 0 16 16" fill="none">`，线性描边风格
  （Figma 导出路径），颜色**永远是 `currentColor`**（用 CSS 控制 `color` 即变色）；
  容器类 `.icon { width:16px; height:16px; display:inline-flex;
  align-items:center; justify-content:center; color: label-tertiary }`。
- DSH Box 外壳的图标用 **mask 方案**：SVG 自身镂空 + `background-color: currentColor`
  + `-webkit-mask`（见 topbar.css，可随 light/dark 自动变色）。

## 6.1 动效清单（全库仅 6 个动画，克制）

| 动画 | 规格 | 用途 |
| --- | --- | --- |
| tooltip 淡入 | `.15s var(--ds-ease-in-out)` 透明度 | Tooltip |
| toast 滑入+淡出 | in `.16s ease-out`（自 -6px 下落）+ `1s ease 3s forwards`（4s 生命周期）| Toast |
| StateDot 扫描 | `1s infinite`，8 格顺时针阶梯错位（125ms 步进）| 进行中状态点 |
| spinner | `.8s linear` 旋转 | 加载圈 |
| onboarding 遮罩 | `.16s` 淡入 | 首次引导 |
| DisclosureRow chevron | `.1s` 交叉淡化 | 可折叠项箭头 |
| 面板/抽屉宽度 | `.3s var(--ds-ease-in-out)`（`--ds-transition-duration-slow`）| 侧边栏展开、主框架 grid 列宽 |
| hover 底色 | ≤`0.15s` ease 透明度变化 | 全部可点击元素 |

`prefers-reduced-motion: reduce` 时上述动画全部关闭（各组件用 media query 处理）。

## 6.2 组件库全景（dsh-client-ui-primitives 实测 export 清单）

证据卡片产品库（非通用 UI 库，通用控件见 §4 手写规格）：

- **交互骨架**：Button / Pill / Input / Menu / Modal / Tooltip / Toast / HoverCard / StateDot / DisclosureRow
- **agent 证据卡片**：TerminalBlock / ReadBlock / DiffBlock / SearchBlock / WebBlock / WebFetchBlock / WebSearchBlock / CodeBlock / JsonBlock / JsonTree / MarkdownText / MessageText / SourceItem / ExtractMarkdownPlainText
- **品牌与引导**：BrandWordmark / FishLogo / ConnectionBanner / OnboardingSurface / RiskConfirmation
- **注意**：无 Select/Switch/Tabs/Badge/Skeleton 等通用控件——需要时按 §4 的同类规格手写（如分组下拉用 Menu、状态用 StateDot、徽章用 Pill）。

---

## 7. 主题适配（dark/light）

- 组件**只引用别名/static 变量**，深色自动适配（`body[data-ds-dark-theme]` 覆盖变量）。
- 独立页面（DSH Box 外壳：顶栏/状态面板/加载页/关于页）不依赖 dsh 页面时用
  **`light-dark()` + `color-scheme: light dark`** 提前翻译 token（参考
  `src/renderer/dsh-status.css` 的做法——把上面别名表译成一套 CSS 变量）。
- 图标按钮在玻璃/透明底上：hover `--bar-hover` 式半透明层（macOS 毛玻璃上不能用
  纯色透明层）——参考 topbar.css。
- `prefers-reduced-motion: reduce` 时关掉全部位移动画（dsh 组件用 media query 处理）。

---

## 8. DSH Box 外壳接入清单（给 dsh-box 新页面用）

写新页面（顶栏/面板/弹窗/加载页/关于页）时的硬性清单：

1. `:root { color-scheme: light dark; }` + 把 §1.2/§1.3 的别名表用 `light-dark()` 翻译成
   本地变量（命名沿用 `--bg/--surface/--border/--text/--brand/--ok/--err` 或 `--dsw-*` 均可）。
2. 字体：`-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif`
   + `-webkit-font-smoothing: antialiased`。
3. 字号只允许 §2.2 字阶；默认正文 14px，面板标题 12px(strong)，大标题 16px。
4. 圆角只允许 §3.2 一组：面板 10~16（外壳用 10 与 dsh 内容一致）、按钮 7、胶囊 999、chip 999。
5. 边框一律透明层 `rgba(0,0,0,.06~.16)` / 暗色 `rgba(255,255,255,.06~.20)`。
6. 按钮：主按钮品牌蓝(亮 `rgb(65,118,230)`/暗 `rgb(103,158,254)`) 白字；
   次按钮透明 + 边框；hover 用透明度层。
7. 状态语义色只允许 green-500/400、red-600/400、amber-500、品牌蓝。
8. 滚动条 8px + 4px radius thumb（§4.10）。
9. 需要图标：优先从素材抽 SVG 路径（16 网格），或 mask 方案。
10. 交互反馈：hover 底色变化 ≤0.15s ease；禁用 `opacity:.4~.55`；focus-visible 用
    `2px outline + offset 2px`（色用 state-business-primary 或 border-l4）。