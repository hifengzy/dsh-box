# DeepSeek Harness 桌面版 WebUI「设置」界面 UI 设计规范（逆向分析报告）

> 分析对象：`node_modules/@deepseek-ai/` 下 7 个包的编译产物 `lib/client.js` / `lib/index.js`
> 方法：只读逆向编译后的 React JS（jsx("div", {className}) 形式 + 内联 CSS-module 字符串），类名为哈希（如 `_root_xxx_1` / `VOzbGW_panel`）。
> 结论先行：设置是一个**居中 Modal 弹窗**（非独立页面/侧边面板），外层全屏蒙层 + 800×800 弹层，内部左侧 188px 分类导航 + 右侧内容区；通用设置页为最典型的"设置行（row）列表"。整套风格由 `--dsw-*` CSS 变量驱动，组件代码只引用语义化 alias token，深浅色完全由 token 层切换。

---

## 1. 弹窗/页面容器结构

### 1.1 定位：居中模态弹窗（Modal），不是页面/抽屉

- 出处：`dsh-client-ui-settings-general/lib/client.js` 的 `SettingsPanel` + `SettingsRoot`（注释标注 figma 501:29947, 1080×700 设计稿）。
- 触发：侧边栏底部（sidebar foot）的「设置」按钮（`sidebar.settings` 槽位）；宽侧栏为整行按钮，窄侧栏（rail, ≤1024px 视口自动收起）退化为 36×36 圆形图标钮。
- 打开方式：`aria-haspopup="dialog"` / `aria-expanded`；关闭路径：关闭按钮、点击蒙层、Esc（document keydown，仅在打开时挂载监听）。打开时自动 focus 关闭按钮（`closeButton.current?.focus()`）。
- 弹窗语义：`role="dialog" aria-modal="true" aria-labelledby=<navTitle id>`。

### 1.2 层级结构（三层）

```
overlay（fixed inset:0, z-index:1000, flex 居中）
└─ mask（absolute inset:0，遮罩）            onClick 关闭
└─ panel（z-index:1, 800×min(800px, 100vh-48px), overflow:hidden, flex 行）
   ├─ nav（左栏 188px 分类导航）            └─ content（右栏，flex:1 列）
   │   ├─ navTitle（标题, aria-labelledby）     ├─ header（54px：actions 槽 + 关闭钮）
   │   └─ navList（分类按钮列表）               └─ options（滚动内容区, padding 0 24px 24px）
```

### 1.3 关键 CSS（SettingsRoot.module.css，哈希前缀 `VOzbGW_`）

```css
.VOzbGW_overlay { z-index:1000; display:flex; justify-content:center; align-items:center; position:fixed; inset:0 }
.VOzbGW_mask   { background:var(--dsw-alias-bg-mask-1); backdrop-filter:var(--dsw-mask-blur); position:absolute; inset:0 }
.VOzbGW_panel  { z-index:1; background:var(--dsw-alias-bg-layer-2);
                 width:800px; max-width:calc(100vw - 48px);
                 height:min(800px, 100vh - 48px);
                 box-shadow:var(--dsw-shadow-lv3);
                 --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
                 --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);
                 border-radius:24px; display:flex; position:relative; overflow:hidden }
.VOzbGW_nav    { box-sizing:border-box; flex-direction:column; flex:none; gap:18px;
                 width:188px; padding:22px 12px 0; display:flex }
.VOzbGW_navTitle { color:var(--dsw-alias-label-primary); padding:0 12px;
                 font-size:16px; font-weight:500; line-height:24px }
.VOzbGW_header { box-sizing:border-box; flex:none; justify-content:space-between;
                 align-items:flex-start; gap:8px; height:54px;
                 padding:20px 14px 8px 10px; display:flex }
.VOzbGW_options{ flex:1; min-height:0; padding:0 24px 24px; overflow-y:auto }
.VOzbGW_close  { width:28px; height:28px; border-radius:28px; color:var(--dsw-alias-label-primary);
                 background:0 0; border:none; display:inline-flex; justify-content:center; align-items:center }
.VOzbGW_close:hover { background:var(--dsw-alias-interactive-bg-hover) }
```

- **尺寸体系**：面板 800×800（视口受限时 `min(800px, 100vh-48px)`，左右各留 24px）；圆角 **24px**；阴影 `--dsw-shadow-lv3`（`0 0 1px rgba(0,0,0,.2), 0 0 4px rgba(0,0,0,.02), 0 12px 32px rgba(0,0,0,.08)`，深浅色共用）；蒙层 = `--dsw-alias-bg-mask-1`（浅色 rgba(0,0,0,.24) / 深色 rgba(0,0,0,.5)）＋ `--dsw-mask-blur: blur(2px)` 背景模糊。
- 右侧内容列宽 = 800 − 188(nav) ≈ 612px；内容区水平 padding 24px → 实际文案区约 564px。各 section 内容再用 `max-width:720px`（模型页）/ `760px`（插件页）收窄。

### 1.4 容器内嵌滚动

内容区 `options` 自身 `overflow-y:auto`，面板整体 `overflow:hidden`；部分页面（fetch 弹层等）用 `max-height:calc(100vh - 48px)` 限制。滚动条样式通过 `--dsh-scrollbar-thumb{,-hover}` 变量重绑定（弹层面板绑定 l2 色对），全局 8px 宽 WebKit 滚动条主题在 `dsh-client-ui-theme/lib/styles/scrollbar.css`。

### 1.5 页面触发按钮（Sidebar foot）

```css
.VOzbGW_trigger { width:calc(100% + 8px); height:34px; border-radius:12px;
  color:var(--dsw-alias-label-primary); background:0 0; border:none;
  align-items:center; gap:8px; margin:4px -4px; padding:6px 2px 6px 10px;
  font-size:14px; line-height:22px; display:flex }
.VOzbGW_trigger:hover { background:var(--dsw-alias-interactive-bg-hover) }
.VOzbGW_trigger.VOzbGW_rail { border-radius:50%; justify-content:center; gap:0;
  width:36px; height:36px; margin:8px 0 10px; padding:0 }
```

宽侧栏：图标 16px（`IconSettingsOutline16` size 16）+ 标签「设置/Settings」；窄栏：`IconSettingsOutline14` 渲染为 18px 圆形钮。

### 1.6 外层布局（dsh-client-ui-layout）

应用主框架是 3 列 CSS Grid（sidebar | center | details）：
- `grid-template-columns: <sidebar>px minmax(0,1fr) <details>px`，侧栏 264–420px（默认 280，收起到 56px rail），详情 300–520px（默认 360，0=关闭但保持挂载）。
- 列间可拖拽分隔条（8px 热区 + rAF 节流，hover 显示 12×32 椭圆手柄），中列最小 640px，视口 <1024px 自动收侧栏。
- 主题呈现 `ThemePresenter`：设置 `documentElement.style.colorScheme` + body 上打 `data-ds-dark-theme` 属性 + 把当前主题 token 作为内联 CSS 变量写到 body。

---

## 2. 分类导航（左侧 rail）

- 分类项由 `settings.section` 槽位注册，按 `order` 升序排列；`aria-current="true"` 标记当前页。
- 实际分类与顺序：**通用设置(0) → 模型(10) → 插件(15) → Agent 预设(20)**（另见 §8 各注册点）。
- 每个分类 = `<button>` 40px 高、圆角 12px、`gap:8px`、图标 16px + 文字标签；hover 用侧栏专用交互色，选中态为浅色底块（无左侧强调条，纯背景块）。

```css
.VOzbGW_navCell { height:40px; color:var(--dsw-alias-label-primary); text-align:left;
  background:0 0; border:none; border-radius:12px; align-items:center; gap:8px;
  padding:9px 16px 9px 12px; font-size:14px; font-weight:400; line-height:22px; display:flex }
.VOzbGW_navCell:hover  { background:var(--dsw-specific-sidebar-nav-item-hover) }
.VOzbGW_navCell.VOzbGW_active { background:var(--dsw-specific-sidebar-nav-item-active) }
.VOzbGW_navLabel { white-space:nowrap; text-overflow:ellipsis; flex:1; min-width:0; overflow:hidden }
```

- 图标映射（`navIcon(id)`）：models → `IconDataOutline16`；agent-presets → `IconAgentPresetOutline16`；plugins → `IconPersonalizationOutline16`；其它（含 general）→ `IconSettingsOutline16`。全部 16px outline。

---

## 3. 设置项行（Setting Row）布局 —— 全系统最核心的模式

### 3.1 通用页（General）的规范行（figma 501:30011）

五个通用页行（语言、会话回车行为、权限默认、Agent 预设默认、外观）中的四个使用**同一套行结构**（跨包 CSS 哈希不同但声明逐字一致，如 `hVGvvW_`/`oY77xG_`/`T1PP_q_`/`_5QVD0a_`）：

```css
/* ---- 行容器 ---- */
.row { border-bottom:1px solid var(--dsw-alias-border-l2);
       align-items:center; gap:8px; padding:16px 0; display:flex }
.rowText { flex-direction:column; flex:1; gap:4px; min-width:0;
           padding-right:48px; display:flex }        /* 48px 固定沟槽，避免文字压到控件 */
.title  { color:var(--dsw-alias-label-primary); font-size:14px; font-weight:400; line-height:22px }
.desc   { color:var(--dsw-alias-label-tertiary);  font-size:12px; font-weight:400; line-height:18px }

/* ---- 右侧控件（pill 选择器 / selector）---- */
.selector { background:var(--dsw-alias-bg-module-platform); height:36px; font:inherit;
            color:var(--dsw-alias-label-primary); cursor:pointer; border:none;
            border-radius:18px; align-items:center; gap:12px; padding:0 14px;
            font-size:14px; line-height:22px; display:inline-flex }
.selector:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover) }
```

- 结构：`<div.row> <div.rowText>{title, desc}</div> <Menu anchor=selector/> </div>`；`rowText` `flex:1` 把控件推到最右，`align-items:center` 垂直居中。
- 行之间无间距（padding 16px 0 叠 border-bottom），分隔线为 1px `--dsw-alias-border-l2`；**末行分隔线被壳层规则去掉**：
  ```css
  ._WvWnq_section>[data-slot="settings.general.item"]>:last-child { border-bottom:none }
  ```
- 行本身无 hover / 背景变化——只有内部控件响应交互（轻量、克制的行设计）。
- 必填/可选标记：当前设置页**没有显式 required 标记**；字段层用 badge（`已覆盖`/`已配置`）表达状态而非必填。
- 通用页行渲染顺序（order）：Agent 预设默认(−25) → 权限默认(−20) → 语言(0) → 外观(10) → 回车行为(20)。

### 3.2 外观行（AppearanceRow, dsh-client-ui-theme）—— 例外形态

- 结构：`group`（列、gap 8、padding 16 0、border-bottom l2）> `title`(14/400/22) + `cubeRow`（flex-wrap, gap 8）> 三个**主题方块按钮**（浅色/深色/跟随系统，`aria-pressed`）。
- 方块：`flex:180px` 基础宽、`padding:20px 32px`、圆角 16px、gap 4、16px 图标 + 14px label；选中态 `background:var(--dsw-alias-bg-module-platform); border-color:var(--dsw-static-neutral-bluish-400)`；未选中 hover `background:var(--dsw-alias-interactive-bg-hover)`。

```css
._8HJdBW_themeCube { border:1px solid var(--dsw-alias-border-l2); border-radius:16px;
  flex:180px; flex-direction:column; justify-content:center; align-items:center; gap:4px;
  padding:20px 32px; font-size:14px; line-height:22px; display:flex }
._8HJdBW_selected { background:var(--dsw-alias-bg-module-platform);
  border-color:var(--dsw-static-neutral-bluish-400) }
```

### 3.3 模型页行卡片（Models）

- 列表 `ul.rows`（gap 8）> `li.rowCard`：`border:1px solid l2; radius:12px; flex-column; gap:12px; padding:12px 14px`（卡片式，非分隔线式）。
- 行头：`rowHead`（gap 10）> `rowIdentity`（gap 6：名称 14/500/22 + 可选「自定义」Tag + 8px 圆形凭证状态点）＋ `rowActions`（`margin-left:auto`，28px 紧凑图标按钮：编辑/删除）。
- 凭证点：`credentialDot` 8px 圆点；已配置=success 绿，缺失=error 红。
- 行卡片无 hover 态（交互都在按钮上）。

### 3.4 插件页卡片（Plugins）

- 配置卡片：`border:1px solid l2; bg-layer-3; radius:12px`；标题按钮头（名称 15/600 + 描述 13 三级色 + 「未保存」pill + 旋转 chevron 14px）；展开后 body `bg-layer-2`、`border-top` 分隔、字段列表每项 12px padding + `border-top` 分隔，底部右对齐 Save/Discard。
- 插件清单卡片：2 列网格（`repeat(2,minmax(0,1fr))`，<680px 单列），卡片 `radius:10px`、标题 14/600 truncate、右侧「已启用/已停用」tag（radius 5px、启用态 10% success 混色）+ 7px 状态圆点（active=绿/failed=红/loading=业务蓝）+ 12px chevron。

---

## 4. 表单控件

> 重要发现：**设置页没有任何 Switch/Toggle**——所有"开关式"状态用 pill 选择器、卡片展开、Tag/圆点表达。控件体系如下。

### 4.1 按钮（Button，primitive，宿主 shell CSS 提供样式）

- 基础：inline-flex、gap 4、`border-radius:18px`、font 14/22、padding 0 14px；`:disabled{opacity:.4; cursor:not-allowed}`。
- 尺寸：`md` = 36px 高（settings 内默认）；`sm` = 28px 高 / 12/18 / padding 0 10px / radius 14px。
- 变体：
  - **primary**：`bg var(--dsw-alias-button-primary-fill)`（实心，浅色=近黑 bluish-1000，深色=近白 bluish-50，即"反白"强调）+ `color var(--dsw-alias-label-primary-foreground)`；hover → `--dsw-alias-button-primary-hover`。
  - **ghost**：透明底，hover `--dsw-alias-interactive-bg-hover`，active `--dsw-alias-interactive-bg-active`。
  - **outline**：1px `--dsw-alias-border-l2` 描边 + hover 交互底色。
  - **toolbar**：`--dsw-alias-button-tool-bar-fill`。
  - **icon**：16×16 图标钮。
- 设置页内嵌实现（models 页 zGbnIq_ 前缀）：36px pill（radius 18）为基准；行内紧凑 variant = height 28 / radius 14 / font 12 / padding 0 10；另有 44px 虚线「添加」大按钮（`border:1px dashed var(--dsw-alias-border-l3); radius:12px`）、危险按钮（error 红字 + hover 危险底色）、link 按钮（12px 文字钮）、28px 图标按钮（radius 6）。
- 键盘焦点：统一 2px 环。模型/插件页按钮/卡片头：`outline:2px solid var(--dsw-alias-brand-primary)`，offset −2px（卡片头/内容）/ +1px（按钮）；或 `box-shadow:0 0 0 2px var(--dsw-alias-border-l3); outline:none`（模型页按钮组、图标钮）；输入类用 border-color 变色 + `outline:none`。
- 保存按钮门控：`disabled = !dirty || invalid || saving`；saving 时文案变「保存中…/Saving…」。

### 4.2 文本输入 / 数字输入

- 模型页 `input`：`height:32px; border:1px solid l2; radius:8px; bg-layer-1; padding:0 10px; font 14/22`；focus `border-color:var(--dsw-alias-brand-primary)`；placeholder `--dsw-alias-label-dimmed`；disabled `opacity:.6`。
- 插件页字段输入 `At1oFq_input`：`height:34px; radius:8px; bg-layer-3; padding:0 12px; font 13/1.5`；focus-visible 仅 border 变色；无效态 `aria-invalid` + `border-color` 错误色（+ 12px 错误说明文字）。
- 数字输入仅设 `inputMode:"numeric"`（不静默改写用户输入，校验交给 schema）。
- 密文字段 `SecretField`：不回声明文，仅通过 badge（`已配置密钥`/`未配置密钥`）暗化表达。

### 4.3 下拉选择（Select 与 Menu）

- 原生 `<select>`（模型页）：复用 input 样式，`max-width:240px`，`appearance:none` + 内联 SVG chevron data-URI（12×12，#81858C 描边）右 12px 居中、padding-right 32px。
- 自绘选择器（通用页 pill）：36px pill + `Menu`（primitive，portal + `align:"end"`，`aria-haspopup="menu"`/`aria-expanded`）；menu 面板：`border:1px solid border-inverted; radius:12px; bg var(--dsw-specific-menu); shadow-lv3; padding 4px`。
- 标签行左对齐，控件右对齐（§3.1）。

### 4.4 开关切换

设置页**不存在**。全代码扫描 0 处（模型/插件/通用各注册文件均无 Switch 渲染）。

### 4.5 分段控制（Segmented / 单选）

- 唯一接近的是**主题外观三方块**（§3.2，`aria-pressed` 互斥）+ 「模型来源」picker 弹层的原生 checkbox 列表（fetch 候选列表 `candidateList` 中 6px 圆角项 + label）。无标准 segmented 组件。

### 4.6 徽标 / 标签 / 状态点（Badge / Pill / Dot）

- **pill 徽标**（通用）：`border-radius:999px; background:var(--dsw-alias-bg-module-platform); color:var(--dsw-alias-label-secondary); padding:1px 8px; font-size:11px; font-weight:500; line-height:17px`；muted 变体去底、三级文字色（`--dsw-alias-label-tertiary`）。
  - 用途：插件字段「已覆盖/Overridden」、「已配置密钥/A key is configured」、卡片头「未保存/Unsaved」。
- **方形小标签**：模型行「自定义」tag `radius:4px; border:1px solid l3; padding:1px 6px; 11px/16px`；插件清单「已启用/已停用」tag `radius:5px; bg-layer-1; 11px/16px`（启用态 = `color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)` 底 + success 色文字）。
- **状态圆点**：凭证 8px 圆（绿/红）；插件运行相位 7px 圆（active 绿 / failed 红 / loading 业务蓝 / 缺省 `--dsw-alias-label-tertiary`），`role="img"` + aria-label 相位词。

### 4.7 列表项 / 表格行

- 模型目录：`modelEntry`（radius 8、padding 6）内 `modelRow` 为 grid `minmax(0,1.4fr) minmax(0,1fr) auto auto`（模型名 | 路由 | 编辑 | 删除），gap 6；高级参数区 `repeat(auto-fit,minmax(160px,1fr))`。
- 插件清单详情：`dl` 网格 `76px minmax(0,1fr)` 键值对（label caption 色 / value 三级色，overflow-wrap:anywhere）。
- 通用页的「行」即 §3.1 的 .row（label+desc+右侧控件），非表格。

### 4.8 弹窗（Modal，primitive `Modal`）

- 宿主 shell 样式：`_dialog{position:relative; z-index:1; flex-column; gap:20px; width:min(380px,100%); padding:0 0 24px; overflow:hidden; border:1px solid var(--dsw-alias-border-inverted); border-radius:24px; background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-shadow-lv3)}`；backdrop `fixed inset:0; z-index:1000; display:grid; place-items:center; padding:40px`。
- 设置页内弹窗尺寸：删除确认 `width:min(480px,100%)`；fetch 候选 `max-width:520px`；onboarding `width:min(600px,100%)` + 内容 `padding:28px`（窄屏 24px）+ 标题 20/500/28。
- 系统级开关（onboarding/deepseek 欢迎）走 `settings.onboarding` 槽位，屏蔽应用（"keep the application root inert"）。

### 4.9 其它 primitive 组件（宿主样式表提供）

`dsh-client-ui-primitives`（5855 行）包含：Button、Input、Modal、Pill、Menu、Toast、Tooltip、HoverCard、DisclosureRow、StateDot、SearchBlock、JsonTree、Markdown 渲染族（shiki 高亮 + katex）、TerminalBlock、DiffBlock、OnboardingSurface、RiskConfirmation、ConnectionBanner 等。其 CSS module 在发布包中是 stub（`\0dsh-css-stub:`），真实样式随 Web shell 宿主层（`dsh-web-frontend/dist/assets/index-*.css`）注入——即 primitive 组件外观由应用层统一供给。要点：

- **Input（带图标包装）**：包装器 `_wrap{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}`，`:focus-within{border-color:var(--dsw-alias-brand-primary)}`；裸 input 仅 `flex:1;font:14/22;color:label-primary;placeholder:label-dimmed`；前置图标 16px 三级色。
- **Pill（可交互小胶囊）**：`height:24px;padding:0 8px;border-radius:12px;font:12/18;color:label-secondary;background:bg-layer-2`；hover `--dsw-alias-interactive-bg-hover`；active 选中态 = `color:label-primary;background:var(--dsw-alias-button-ghost-active-fill);box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)`（**内描边环**）。
- **Menu（下拉）**：列表 `min-width:218px;max-width:360px;border-radius:12px;border:1px solid border-inverted;background:var(--dsw-specific-menu);box-shadow:shadow-lv3;padding:4px`；portal 容器 z-index 1100；含 submenu、分隔线、label、footer、dense/compact 两档（compact 7px 圆角）。条目：`min-height:40px;padding:8px 10px;border-radius:10px;font:14/22`，hover=`interactive-bg-hover`，**选中态不加底色、只在行尾渲染 16px 对勾图标**；danger 条目=error 红字 + hover-danger 底；分隔线 1px border-l1、label 12/16 三级色。
- **Toast / Tooltip**：Toast 顶部居中（进场 .16s、3s 后淡出、4s 生命周期）；Tooltip 深色气泡 13/20、`data-side` 定位 + 自动翻转、.15s 淡入。
- **StateDot / Spinner**：StateDot 8–10px 同心圆结构（`data-state=done/warning/error` 换色）；Spinner 20×20、2px 边框、`border-top-color:brand-primary`、rotate .8s linear infinite。
- **缺失组件（本库明确没有）**：Switch、TextArea、Select/Combobox、SegmentedControl、Spinner 独立封装、EmptyState、Kbd、Avatar、Divider、ScrollArea、Field/Label 抽象——设置页风格即按此"无开关/无表单抽象"的原则手写行结构。

---

## 5. 交互状态

- **hover**：一律走 token：列表项/图标钮 `--dsw-alias-interactive-bg-hover`（浅色 rgba(38,49,72,.06)、深色 rgba(255,255,255,.08)）；强 hover `--dsw-alias-interactive-bg-hover-solid`；危险 hover `--dsw-alias-interactive-bg-hover-danger`；卡片 hover 只换 border 色（`--dsw-alias-label-dimmed`）不换底色（插件配置卡）或换底（清单卡）。
- **active**：按钮/ghost `--dsw-alias-interactive-bg-active`；大部分组件无显式 :active。
- **disabled**：按钮 `opacity:.4; cursor:default/not-allowed`；输入 `opacity:.6` 或 `color:label-tertiary`；自定义元素用 `:hover:not(:disabled)` 抑制 hover。
- **focus / focus-visible**：键盘焦点 = 2px 环（brand 或 border-l3 或 state-business 主色，offset ±2px），输入类用 border 变色；部分组件 `outline:none` + shadow ring。
- **loading**：无 skeleton、无 spinner。加载态=文字：`t("loading")`（"正在读取插件…"）+ `aria-busy`；保存中=按钮文案「保存中…」+ disabled；模型应用中=「正在应用…」「正在向提供商确认…」+ disabled。（primitive 提供 `IconLoadingOutline16` 但设置页未用。）
- **错误态**：内联 12px 红字（`--dsw-alias-state-error-primary`/`--dsw-alias-label-error`），`role="alert"`；保存失败错误留在字段下方提示"已保留供你修改"。
- **成功反馈：无 toast**（primitive 有 Toast 组件但设置页零使用）。成功=页内绿色提示行 `savedNotice`（12px success 绿，`role="status"` + `aria-live="polite"`）或「未保存」pill 消失/坏占位。
- **动效**：chevron 翻转 180°（transform .12–.16s）；卡片 border/背景过渡 .16s；统一 `--ds-ease-in-out: cubic-bezier(0.4,0,0.2,1)`，时长 `--ds-transition-duration{,-fast,-slow}` = .2s/.1s/.3s；一律有 `@media (prefers-reduced-motion:reduce)` 关闭动画。

---

## 6. 文案排版（字号/字重层级）

设置页用**硬编码字号 + line-height**（14/22、12/18 …），同时全局提供等价 font token（由 Figma 插件导出，见 gradient-shadow-text.css）；标题小节奏引用 token。层级如下：

| 层级 | 字号/行高 | 字重 | 用途 |
|---|---|---|---|
| 弹窗标题 h1 | 16/24 | 500 | 弹窗标题（navTitle）、模型页标题 |
| 插件页大标题 h2 | 18px | 600 | 插件页 heading |
| 卡片名 | 15px | 600 | 插件配置卡名称；列表卡 14/600 |
| 正文/行标题 | 14/22 | 400（控件 500） | 行 title、按钮、pill 选择器文字 |
| 强正文 | 14/22 | 500 | 强调标签（`--dsw-font-s-strong-14`） |
| 小字/说明 | 13/20 | 400/500 | 导航标签、输入框、intro… |
| 二级正文/描述 | 12/18 | 400 | 行 desc、字段 label(500)、hint、错误、meta |
| 徽标 | 11/16–17 | 400–500 | pill/tag |
| 超大 | 20/28 | 500 | 弹窗标题（modal title） |

- 全局 font token 完整阶梯（gradient-shadow-text.css）：`--dsw-font-xl-24:600 24/32`、`l-20:500 20/28`、`m-18:500 16/28`、`base-16:400 16/24`、`s-14:400 14/22`、`xs-13:400 13/20`、`xxs-12:400 12/18`、`xxxs-11:400 11/16`（各带 `-strong-` 500 变体）；markdown 标题族 h1–h4 = 24/34、22/32、20/30、16/28（700/700/700/600）。
- 字体族：`--dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif`；等宽 `--ds-font-family-code: 'SF Mono','JetBrains Mono','Fira Code',Consolas,…`（显式去掉裸 monospace 尾部，规避 Windows CJK 回退 SimSun）。
- 说明文字用「三级色」`--dsw-alias-label-tertiary`，帮助文字 12px，数字/计数用 `font-variant-numeric:tabular-nums`。

---

## 7. 图标体系

### 7.1 命名规范

组件名 = `Icon<名称><风格><尺寸>`：`IconNewChatOutline16`、`IconSettingsOutline14`、`IconDarkOutline16`…风格为 `Outline`/`Fill`，尺寸后缀 = 网格像素（12/14/16/18/20/24）。JSDoc 保留 Figma 原名：`/** ic_ds_search_outline_16 */`。

设置界面实际用到的图标（全部 outline 线性图标）：

| 位置 | 图标 | 尺寸 |
|---|---|---|
| 触发按钮（宽） | `IconSettingsOutline16` | 16 |
| 触发按钮（rail） | `IconSettingsOutline14` | 渲染为 18 |
| 导航：模型 / Agent 预设 / 插件 / 通用 | `IconDataOutline16` / `IconAgentPresetOutline16` / `IconPersonalizationOutline16` / `IconSettingsOutline16` | 16 |
| 关闭按钮 | `IconCloseOutline16` | 14 |
| 行/pill 选择器展开 | `IconChevronDownOutline14` | 14（清单卡内 12） |
| 删除 / 新增 | `IconTrashOutline16` / `IconPlusOutline16` | 渲染 14 |
| 主题方块 | `IconLightOutline16` / `IconDarkOutline16` / `IconFollowsystemOutline16` | 16 |
| 搜索 | `IconSearchOutline16` | 16 |
| 高级设置折叠箭头 | 内联 SVG 箭头 / 原生 `<details>` 伪元素箭头（5×5 旋转 45°） | — |

### 7.2 实现方式

手写内联 SVG：`<svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns>` + 若干 `<path fill="currentColor" d="…">`。**颜色完全由 `currentColor` 继承**，因此图标跟随所在元素的 `color`/token 变色，浅深色零成本适配。图标组件通过 props `size`（默认 16）和 `className` 透传尺寸与 CSS 类。

---

## 8. 主题适配（明暗双主题）

### 8.1 机制（三层 token，自上而下）

```
静态色板（--dsw-static-*）  —— "raw" 调色板，按色相+步进命名
   ↳ 语义别名（--dsw-alias-*） —— 组件唯一引用层
   ↳ 特定用途（--dsw-specific-*）—— 单一消费者组件（侧栏/气泡/菜单…）
```

- **声明位置**：`dsh-client-ui-theme/lib/styles/design-platform.css` 中所有 token 挂载在 `body {}`（亮色）与 `body[data-ds-dark-theme] {}`（深色覆盖）；`gradient-shadow-text.css` 追加阴影/渐变/字体 scale（浅深色各有 `body[data-ds-dark-theme]` 覆盖段）。`scrollbar.css` 挂滚动条皮肤。
- **切换方式**：`dsh-client-ui-layout` 的 `ThemePresenter` 在主题变更时：① 设 `documentElement.style.colorScheme = light|dark`；② 在 `document.body` 上**增删 `data-ds-dark-theme` 属性**；③ 把当前激活主题的 token 覆写作为内联 CSS 变量写回 body。
- **主题偏好**：`ui-theme` 命名空间持久化 `preference ∈ {light, dark, system}`（默认 system），`system` 跟随 `prefers-color-scheme` 媒体查询；动态主题通过 `overrideTokens(source, {light, dark})` 叠层注入（逐 token 以 `{light, dark}` 成对值要求）。

### 8.2 静态色板（--dsw-static-*，节选）

色相：`neutral` / `neutral-bluish`（带蓝底的灰，UI 主力）/ `blue` / `deepseek`（品牌蓝）/ `green` / `red` / `amber`；步进 50/75/100/150/200/250/300/400/450/500/600/700/750/800/850/875/900/950/1000。

- 品牌蓝（deepseek）：`deepseek-500: rgb(65,118,230)`（亮）／`deepseek-400: rgb(103,158,254)`（暗）。
- 中性带蓝：`neutral-bluish-00:#fff`、`-50:rgb(249,250,251)`、`-100:rgb(235,238,242)`、`-200:rgb(225,229,238)`、`-400:rgb(173,178,184)`、`-700:rgb(97,102,107)`、`-850:rgb(44,44,46)`、`-875:rgb(35,35,36)`、`-900:rgb(27,27,28)`、`-950:rgb(21,21,23)`、`-1000:rgb(15,17,21)`。

### 8.3 语义别名（--dsw-alias-*）亮/暗对照（设置 UI 用到的）

| Token | 亮色 | 暗色 |
|---|---|---|
| `--dsw-alias-bg-base` | neutral-bluish-00 (#fff) | neutral-bluish-950 (21,21,23) |
| `--dsw-alias-bg-layer-1` | #fff | bluish-875 (35,35,36) |
| `--dsw-alias-bg-layer-2`（设置面板/弹层） | #fff | bluish-850 (44,44,46) |
| `--dsw-alias-bg-layer-3`（卡片面） | #fff | bluish-800 (53,54,56) |
| `--dsw-alias-bg-overlay`（浮层） | bluish-150 | bluish-700 |
| `--dsw-alias-bg-mask-1`（设置蒙层） | rgba(0,0,0,.24) | rgba(0,0,0,.5) |
| `--dsw-alias-bg-module-platform`（pill/选中块底） | bluish-60 | bluish-800 |
| `--dsw-alias-border-l1` | rgba(0,0,0,.04) | rgba(255,255,255,.06) |
| `--dsw-alias-border-l2`（行分隔/卡片描边） | rgba(0,0,0,.10) | rgba(255,255,255,.12) |
| `--dsw-alias-border-l3` / `-l4` | rgba(0,0,0,.12/.16) | rgba(255,255,255,.16/.20) |
| `--dsw-alias-label-primary` | bluish-1000 (15,17,21) | bluish-50 (249,250,251) |
| `--dsw-alias-label-secondary` | bluish-700 | bluish-300 |
| `--dsw-alias-label-tertiary`（说明文字/图标） | bluish-600 | bluish-400 |
| `--dsw-alias-label-dimmed` / 占位 | bluish-200 | bluish-100 |
| `--dsw-alias-brand-primary` | bluish-1000（近黑，反白主按钮底） | bluish-50（近白） |
| `--dsw-alias-button-primary-fill` | = brand-primary | = brand-primary |
| `--dsw-alias-button-primary-hover` | bluish-750 | bluish-100 |
| `--dsw-alias-interactive-bg-hover` | rgba(38,49,72,.06) | rgba(255,255,255,.08) |
| `--dsw-alias-interactive-bg-active` | rgba(38,49,72,.10) | rgba(255,255,255,.14) |
| `--dsw-alias-interactive-bg-hover-solid` | bluish-75 | bluish-100 |
| `--dsw-alias-interactive-bg-hover-danger` | rgba(236,19,19,.05) | rgba(242,90,90,.15) |
| `--dsw-alias-state-success-primary` | green-500 (34,197,94) | green-500 |
| `--dsw-alias-state-error-primary` | red-600 (236,19,19) | red-400 (242,90,90) |
| `--dsw-alias-state-warn-primary/-label` | amber-500/-600 | amber-500/-600 |
| `--dsw-alias-state-business-primary`（品牌/主操作蓝） | deepseek-500 | deepseek-400 |
| `--dsw-alias-toast-bg` | bluish-800 | bluish-750 |
| `--dsw-alias-tooltip-bg` | bluish-850 | bluish-750 |
| `--dsw-alias-scrollbar-bg-l1/l2` | neutral-200 | neutral-700/600 |

### 8.4 特定用途（--dsw-specific-*）亮/暗

`sidebar-fill`（bluish-50 / bluish-900）、`sidebar-nav-item-hover`（bluish-75 / bluish-850）、`sidebar-nav-item-active`（bluish-100 / bluish-750）、`menu`（= bg-layer-3）、`selector`（bluish-60 / bluish-800）、`bubble / bubble-highlight`、`input-major`、`tip`、`login-input`。

### 8.5 阴影 / 模糊 / 渐变 token

```css
--dsw-shadow-lv1: 0 2px 4px 0 rgba(0,0,0,.05);
--dsw-shadow-lv2: 0 4px 12px 0 rgba(0,0,0,.02), 0 2px 8px 0 rgba(0,0,0,.04);
--dsw-shadow-lv3: 0 0 1px 0 rgba(0,0,0,.2), 0 0 4px 0 rgba(0,0,0,.02), 0 12px 32px 0 rgba(0,0,0,.08); /* 设置面板/弹窗/menu 用 */
--dsw-mask-blur: blur(2px);   /* 设置蒙层背景模糊 */
--dsw-linear-gradient-think / --dsw-linear-think-select: 顶到底 20.19% 白→透明（深浅各一套）
```

深浅共用同一组阴影（暗色不加重），仅蒙层透明度与背景模糊不变。

### 8.6 深浅切换要点（对实现者）

- 组件代码**只允许引用 `--dsw-alias-*` / 已声明 token**，禁止硬编码颜色——插件页报告确认：0 处 `data-theme`/`prefers-color-scheme`/`.dark` 选择器，深浅适配 100% 由 token 层完成。
- 少量跨层直用静态色：主题选中方块边框 `--dsw-static-neutral-bluish-400`、品牌 shimmer 渐变用 `--dsw-static-deepseek-*`。
- 外部壳页（DSH Box）无 `--dsw-*` 时，用 `light-dark()` 把上面§8.3 表翻译成本地变量（见 `dsh-box-ui` 技能 §2 的翻译表）。

---

## 9. 上手速查（做一张与设置页一致的新页面的最小配方）

1. **容器**：覆盖层 `position:fixed; inset:0; z-index:1000; display:grid; place-items:center; padding:40px`；面板 `width:min(380px,100%) / 800px；border-radius:24px; background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-shadow-lv3); border:1px solid var(--dsw-alias-border-inverted)`。
2. **文案层级**：标题 16/500/24→面板小标题 12/600→正文 14/22→说明 12/18→徽标 11/16；全用 `--dsw-alias-label-*` 三档色。
3. **设置行**：`.row{border-bottom:1px solid var(--dsw-alias-border-l2); display:flex; align-items:center; gap:8px; padding:16px 0}` + `.rowText{flex:1; flex-direction:column; gap:4px; padding-right:48px}`；末行去掉分隔线；控件 = 36px 高 pill：`background:var(--dsw-alias-bg-module-platform); border-radius:18px; padding:0 14px; gap:12px`。
4. **按钮**：主 = `background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground); height:36px; border-radius:18px; padding:0 14px; gap:4px; font:14/22`；次 = `border:1px solid var(--dsw-alias-border-l2)`；禁用 `opacity:.4`；focus-visible 2px 环。
5. **输入**：`height:32px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-1); padding:0 10px; font:14/22`；focus 换 `border-color:var(--dsw-alias-brand-primary)`。
6. **状态表达**：loading=文字+aria-busy/disabled；错误=12px 红字 role=alert；成功=12px 绿字 role=status（无 toast）。
7. **图标**：`Icon<Name>Outline<16|14>`，`fill:none` 线性 SVG + `fill:currentColor` 路径，尺寸 16 默认（行 pill 内 chevron 14）。
8. **深浅色**：全走 token；壳页面用 `light-dark()` 翻译（§8.3 表）。

---

## 附：证据清单（关键文件）

| 文件 | 内容 |
|---|---|
| `dsh-client-ui-settings-general/lib/client.js` | 设置弹窗壳（SettingsRoot/SettingsPanel）、nav、header、close、通用区容器、打开配置文件动作（Button outline sm）、中英文案 |
| `dsh-client-ui-settings/lib/client.js` + `index.js` | 设置命名空间传输层（非视觉；`SettingsScopeBinder/Controller`），说明"设置"是宿主持久化的配置值服务 |
| `dsh-client-ui-settings-models/lib/client.js` | 模型页：模型行卡片、凭证状态点、编辑区、目录表格、删除/拉取弹窗、onboarding |
| `dsh-client-ui-settings-plugins/lib/client.js` | 插件页：tab 壳 + 可配置插件卡片（Shell/Agent loop/Web search）+ 字段/徽标/保存条 |
| `dsh-client-ui-settings-plugin-inventory/lib/client.js` | 只读插件清单 tab（搜索、2 列卡片、相位状态点、配置详情 dl） |
| `dsh-client-ui-theme/lib/client.js` | 外观行（主题三方块）、主题运行时/注册表、内置 token 目录说明 |
| `dsh-client-ui-theme/lib/styles/design-platform.css` | 全套 `--dsw-static-*`/`--dsw-alias-*`/`--dsw-specific-*` 亮暗定义 |
| `dsh-client-ui-theme/lib/styles/gradient-shadow-text.css` | 阴影、遮罩 blur、字体 scale（markdown + 通文字阶） |
| `dsh-client-ui-theme/lib/styles/base.css` | 字体族、动效时长/easing 基础变量 |
| `dsh-client-ui-theme/lib/styles/scrollbar.css` | 8px 滚动条皮肤（`--dsh-scrollbar-thumb{,-hover}` 重绑定机制） |
| `dsh-client-ui-layout/lib/client.js` | 3 列应用框架、拖拽分隔条、`data-ds-dark-theme` 主题呈现器 |
| `dsh-client-ui-primitives/lib/index.js` | 通用组件库（Button/Input/Modal/Menu/Pill/Toast/Tooltip/…，CSS stub）、图标库 |
| `dsh-web-frontend/dist/assets/index-*.css` | 宿主 shell 层组件真实样式（Button md/sm + primary/ghost/outline/toolbar、Modal dialog/backdrop、Menu） |