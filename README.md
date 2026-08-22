# DSH Box for macOS (dsh-box)

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 封装成**原生 macOS 桌面 App**(基于 Electron)。

> 目标:相比在浏览器里用 Harness 的 WebUI,桌面 App 能让 Harness 以**原生应用的身份**运行,从而获得更完整的**本地文件系统权限与操作能力**——这是浏览器做不到的。原理见 [docs/PERMISSIONS.md](docs/PERMISSIONS.md)。

## 快速开始

环境要求:macOS 14+(Apple Silicon,本项目按 M4 Pro 开发)、Node.js ≥ 20、npm。

```bash
# 1. 安装本项目依赖(会把 dsh 一起装进来)
npm install

# 2. 环境体检(可选但推荐)
npm run doctor

# 3. 启动 App
npm start
```

> 开发模式下不再需要全局安装 dsh:项目把 `@deepseek-ai/dsh` 作为**正式依赖**,
> 运行时用 App 自带的 Electron(经 `ELECTRON_RUN_AS_NODE`)直接跑打进来的 dsh,
> 连系统 Node 都不依赖。

> `npm start` 会用**品牌化副本**启动(见 `scripts/dev-launch.mjs`):克隆一份
> `Electron.app` 到 `.runtime/dev/DSH Box.app` 并改名为「DSH Box」,让 dev 模式
> 菜单栏左上角也显示「DSH Box」而不是 Electron(首次拷贝约 1-2 秒,按 Electron
> 版本缓存,之后无感;失败自动回退原生 Electron)。需要原始 Electron 环境调试时用
> `npm run start:electron`。

启动后,窗口先显示加载页,等 dsh 服务就绪后自动切换到 Harness WebUI(默认端口 `3260`,可用环境变量 `DSH_APP_PORT` 覆盖)。

## 架构

```
┌────────────────────────────────────────────────────┐
│  DSH Box.app (Electron)                          │
│                                                    │
│  主进程 src/main/main.js                           │
│    ├─ spawn ──→ dsh web 子进程 (Node)              │  ← 同一原生进程树
│    │               └─ spawn ─→ bash / shell        │     → 继承 App 的
│    ├─ WebContentsView 顶栏 (topbar.html)           │        macOS 权限(TCC)
│    ├─ WebContentsView 内容 (加载页 → WebUI)        │  自定义标题栏 / 内缩+圆角
│    └─ WebContentsView 右侧面板 (dsh-status.html)   │  可选展开:≈1/5 宽服务面板
│            ▲ contextBridge                         │
│            │                                       │
│        preload.js (最小 IPC 桥,不暴露 Node)         │
└────────────────────────────────────────────────────┘
```

- **主进程** (`src/main/`) 负责启动/停止 dsh 服务、管理窗口与权限。
- **dsh-server.js** 把 `dsh web` 作为子进程拉起。dsh 的查找优先级:
  1. 环境变量 `DSH_BIN`(测试/调试用);
  2. **打进 App 的 dsh**(打包后是 `app.asar.unpacked/node_modules/@deepseek-ai/dsh`,开发时是项目 `node_modules`)——默认走这个;
  3. PATH 里的 `dsh`(兜底)。
  用 `ELECTRON_RUN_AS_NODE=1` + 当前可执行文件运行,所以**用户机器上不需要装 Node,也不需要装 dsh**。`DSH_HOME` 默认用 App 自己的数据目录(`~/Library/Application Support/DSH Box/dsh-home`),与浏览器 WebUI 的 `~/.dsh` 隔离,避免两个 dsh 服务并发读写同一会话导致弹层闪烁(见「常见问题」)。
- **顶栏视图** (`src/renderer/topbar.*`) 是独立的自定义标题栏:整条可拖动、双击最大化,左侧留红绿灯空间且**不显示应用名**;右侧 `.actions` 是功能入口区,当前放 **dsh 状态入口**、**侧栏插件两个面板开关**和 **GitHub 仓库按钮**(28×28 无背景,悬停显示背景,图标 20×20 随 light/dark 变色,点击在系统浏览器打开 `https://github.com/hifengzy/dsh-box`)。
  - **侧栏插件两个面板开关**(右侧栏 / 底部面板,在状态入口与 GitHub 之间):控制 dsh-better-sidebar 插件的侧栏/底栏开合。链路:顶栏按钮 → preload IPC → 主进程 → `executeJavaScript` 注入桥(`src/main/plugin-ui-inject.js` 的 `PLUGIN_BRIDGE_JS`)→ 桥模拟点击插件自己的 toggle 按钮(React store 全同步);开合状态经插件公开的布局钩子(`body[data-dsh-sidebar-collapsed]` 与 `--dsh-sidebar-height`)实时回显到顶栏按钮(展开 = 品牌蓝高亮);**插件未安装或当前没有活跃会话时按钮禁用**。插件自带的右上角两个入口被注入的 `PLUGIN_HIDE_CSS` 隐藏(visibility 保留空位,零布局扰动)。
- **右侧「dsh 服务与版本」面板**(`src/renderer/dsh-status.*` + `src/main/sidebar-layout.js`):不是独立窗口,而是窗口内右侧面板,**由顶栏状态按钮(或菜单)开关,面板自身无关闭按钮**。展示核心依赖 dsh 的运行状态 + 版本列表,并支持**应用内一键升级**:
  - **布局策略(尽量大 + 自动收起)**:面板与内容区间隙 4px(与窗口左右内缩一致);面板展开时 dsh 内容区保底 **960px**(实测 dsh 至 720px 均无横向滚动);面板 = 内宽 − 960 − 4,**上限 480px**——1280 默认窗口下面板 **308px**/内容 960,1440 下面板 468px,≥1452 触顶 480px;窗口窄到面板放不下(<240px,即窗口 <≈1212px)时**自动收起面板**,dsh 内容区拿回全宽;重新展开需窗口拉宽到 ≈1262px(50px 缓冲防抖动)。纯函数 `computeSidebar()` 单测覆盖(含滞回边界)。
  - **展开/收起动画**:与 dsh 左侧边栏同款规格(实测其主框架 `transition: grid-template-columns 0.3s cubic-bezier(.4,0,.2,1)`):面板宽度以 **300ms + cubic-bezier(.4,0,.2,1)** 逐帧动画(主进程按帧 setBounds 两个视图),dsh 内容区同步平滑重排;窗口缩放/全屏切换时为快照布局(取消动画);动画期间快速切换可反向(开→关→开)不卡死。
  - 上卡 = 服务状态:只展示 DSH 版本号、端口、PID;**状态只有「运行中(绿)/ 停止(灰)」两态**,仅停止时显示「启动服务」按钮;版本号过长自动截断为 …,完整值悬停可见;
  - 中卡 = 侧边栏(dsh-better-sidebar):插件名(链接,悬停下划线)+ 最新版本徽标 + 说明文案;**状态机:未安装 →「安装」;已装且版本 == 最新 →「已安装」绿色文案;已装但低于最新 →「更新」;查询失败 →「网络服务异常」+「重试」(已装时徽标回退本地版本并警示)**。安装/更新由主进程执行 `dsh plugin --profile web add dsh-better-sidebar@<版本>`(`src/main/plugin-manager.js`),成功后**自动重启 dsh 服务**让新 bundle 生效,并写入 `openByDefault: true`(与浏览器 WebUI 对齐,可在插件设置页改回)。安装/更新失败不阻塞,可重试。
  - 下卡 = DSH:只展示**最新一条版本**(版本号链接 `deepseek-harness` 仓库,悬停下划线)+「最新」徽标 + 发布日期;**当前运行版本 < 最新 →「更新」按钮;一致 →「当前」绿色文案**;查询失败显示「网络服务异常」+「重试」(有缓存回退展示并提示)。每次打开面板(视图重建)自动查一次 npm registry(`https://registry.npmjs.org/@deepseek-ai/dsh` JSON API,非网页);
  - 每次启动应用也会静默查一次 npm 和插件 registry,有新版 → 顶栏入口红点(本体或插件任一有更新即亮);面板展开时顶栏按钮呈激活态(品牌蓝),再点一次收起、dsh 内容区恢复整宽;
  - 升级链路(`src/main/dsh-upgrade.js`):下载 tarball → **sha512 校验**(registry 的 `dist.integrity`)→ 系统 tar 解压 → 停服 → **原子替换**(旧包留 `.bak` 备份)→ 启服;任何一步失败自动回滚,不留下半截状态。升级会短暂停止服务,完成后自动恢复。
  - 离线/查询失败回退到上次缓存结果(userData/cache)并提示;中国网络可用 `DSH_NPM_REGISTRY` 切换镜像(如 `https://registry.npmmirror.com`)。
  - **实机验收指引(侧栏插件)**:1) 首次进入「服务状态」面板 → 侧边栏插件卡 → 点「安装」(联网,约 30-60s)→ 自动重启 dsh;2) 在 dsh 里打开/新建一个**活跃会话**(插件侧栏 per-session,无会话时顶栏按钮禁用):3) 点顶栏两个面板开关(在状态入口与 GitHub 之间)→ dsh 页面内右侧栏/底部面板展开收起,按钮随面板开合高亮;4) 插件自带的页面右上角两个小按钮已被隐藏;5) 插件有新版时「服务状态」面板显示「更新」按钮,顶栏红点也会亮起(本体或插件任一有更新)。
- **内容视图** 显示加载页,就绪后加载 dsh WebUI;窗口层内缩 4px + 圆角 10px,**不碰页面布局**,不会产生滚动条。

### 窗口外观

隐藏系统标题栏(`titleBarStyle: hiddenInset`),用**自定义顶栏视图**替代:macOS 红绿灯浮在顶栏左侧(不随侧边栏收起而横跨区域);顶栏整条可拖动,双击最大化。内容区相对窗口边缘**内缩 4px、四角圆角 10px**(纤细边框)。

**玻璃拟态(参考新版微信 macOS)**:内容区以外的区域(顶栏 + 边框)用 macOS 原生毛玻璃材质(`vibrancy: under-window`,`visualEffectState: active` 失焦也保持模糊),背景透出桌面/其它窗口;顶栏文字用 `light-dark()` 跟随外观。想换材质改 `src/main/main.js` 顶部的 `VIBRANCY_MATERIAL`(`under-window` / `sidebar` / `hud` / `header`)。

**主题联动**:dsh UI 设置 → 通用设置 → 外观 里切换浅色/深色/跟随系统时,外壳(毛玻璃材质、红绿灯、顶栏文字)会一起跟随(通过监听 dsh 前端 `data-ds-dark-theme` 属性同步到 `nativeTheme.themeSource`)。**启动加载页也主题自适应**:深色 = 黑底 + `logo-dark.svg`,浅色 = 白底 + `logo-light.svg`,文案/动画/按钮颜色同步;主进程启动时读取 `settings.yaml` 里已持久化的 `settings.theme.preference`,让启动页从第一帧就跟随用户设置(不是先闪系统主题)。已知边界:显式选深/浅色后切回「跟随系统」且与系统相反时,需要重启一次才完全跟随系统。

### 自定义 UI(不用写插件)

编辑项目根目录的 `custom.css`(打包后为 `Resources/app/custom.css`),保存后重启 App(或 ⌘R)生效。支持改颜色(DSH 的 `--dsw-*` 设计变量)、三栏比例、隐藏侧边栏等,文件里有注释示例。结构级改动(新增组件/面板)需要写 DSH client 插件,见下文「常见问题」。

## 目录结构

```
src/
  main/
    main.js          Electron 入口:窗口、菜单、权限、生命周期
    menu.js          应用菜单(全中文:关于 DSH Box / dsh 服务与版本… / 退出 DSH Box / 编辑 / 视图 / 窗口)
    about.js         「关于 DSH Box」品牌弹窗(logo / 版本 / 依赖版本)
    dsh-server.js    dsh 子进程管理:启动、健康检查、优雅停止
    dsh-version.js   运行时 dsh 版本单一事实来源(从实际入口反查 package.json)
    npm-check.js     npm registry 版本查询:缓存 / 离线降级 / semver 比较
    dsh-upgrade.js   应用内升级:下载 → sha512 → 解压 → 原子替换 → 回滚
    sidebar-layout.js 右侧面板宽度策略纯函数(内容优先 + 面板拿剩余)
    plugin-manager.js 侧边栏插件(dsh-better-sidebar)生命周期:本地版本 / registry 查询 / dsh plugin add / openByDefault 写入
    plugin-ui-inject.js 注入桥(PLUGIN_BRIDGE_JS,模拟点击插件 toggle + 状态上报)与隐藏 CSS(PLUGIN_HIDE_CSS)
  preload/
    preload.js       contextBridge 最小桥(getInfo / onStatus / retry / checkUpdates / upgrade / toggleSidebar / getPluginInfo / installPlugin / togglePluginPanel / …)
  renderer/
    index.html       启动页(等待 dsh 就绪)
    renderer.js      启动页逻辑(状态渲染、重试)
    style.css
    about.html       关于弹窗页面(about.css / about.js 配套)
    dsh-status.html  「dsh 服务与版本」右侧面板(状态卡 + DSH 最新版本 + 侧边栏插件,窄版竖排)
    dsh-status.js
    dsh-status.css
    topbar.html      自定义顶栏(GitHub / dsh 状态入口 + 红点 / 侧栏插件两个面板开关)
scripts/
  doctor.js          环境诊断:npm run doctor
  smoke.js           核心链路冒烟测试(纯 Node):npm run smoke
  dev-launch.mjs     品牌化开发启动:npm start(菜单栏显示 DSH Box)
  make-app-icon.mjs 把任意源图加安全边距后生成 assets/icon.png:npm run make-icon
  check-dsh-narrow.js dsh 窄宽度可用性扫描(校准 CONTENT_MIN):npm run test:narrow
assets/
  icon.png           应用图标源图(1024×1024,内容居中安全区;打包时由 electron-builder 自动转成 icns)
  github.svg         GitHub 按钮图标(mask 镂空,随 light/dark 变色)
  dsh-status.svg     dsh 状态入口图标(同上)
docs/
  PERMISSIONS.md     macOS 权限原理与配置(重点读这篇)
```

## 自检 / 测试

```bash
npm run doctor    # 环境体检:Node / dsh / Electron / 端口
npm run smoke     # 核心链路冒烟测试(纯 Node,不弹窗口)
npm run smoke:e2e # 完整 E2E:启动真实 App → 拉起 dsh → 加载 WebUI → 退出
npm run test:regression # 回归套件:面板宽度策略 / URL 信任边界 / 重开窗口 / 加载页可见性 / 端口冲突 / 崩溃反馈 / 菜单栏 Tray / 应用菜单与关于弹窗 / 顶栏 / 服务与版本面板 / 升级链路 / 侧边栏插件真实环境 e2e
```

> `smoke:e2e` 会短暂弹出应用窗口,并把临时数据放到 `.runtime/`(已 gitignore)。`--no-sandbox` 只用于测试环境(沙箱受限的 CI/容器)。

## 打包成 .app / .dmg

```bash
npm run dist        # 打包当前架构的 .app + .dmg (输出到 dist/)
npm run dist:dir    # 只生成解包后的 .app,最快
npm run dist:dmg    # 只生成 .dmg
```

打包产物在 `dist/`。**dsh 已经打进 App 里了**(`Contents/Resources/app/node_modules/@deepseek-ai/dsh`),用户拿到 `.dmg` 后:
拖进「应用程序」→ 打开,就能直接用——**不需要装 Node,也不需要装 dsh**。

> **签名说明**:如果本机钥匙串里有 electron-builder 能自动发现、但无法用于签名的证书(比如只装了证书没装私钥),打包会报 `this identity cannot be used for signing code`。这时用
> `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist` 跳过自动签名(用 ad-hoc 签名,本机可运行)。正式分发需要真正的 Developer ID 证书 + notarization,见路线图。

注意:
- 打包后首次打开,需要在系统设置里给 App 授予文件权限(系统设置 → 隐私与安全性),具体见 [docs/PERMISSIONS.md](docs/PERMISSIONS.md)。
- 目前 `hardenedRuntime` 为 `false`(未开启公证/签名)。发布到其他机器需要 Apple Developer 证书 + notarization,见文末路线图。
- 原生模块(node-pty / koffi)走 N-API 预编译,`npmRebuild: false` 不重新编译;换架构打包(如 arm64 → x64)前先确认对应平台的 prebuild 存在。
- **为什么 `asar: false`**:App 用 `ELECTRON_RUN_AS_NODE` 把 dsh 当纯 Node 脚本跑,而该模式读不了 asar 归档;且 dsh 的解包目录需要能解析到整个依赖树。所以代码以真实文件形式放在 `Contents/Resources/app/`(对 MIT 开源项目无影响)。

## 常用配置(环境变量)

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_APP_PORT` | `3260` | dsh WebUI 监听端口(避开开发常用的 3080) |
| `DSH_BIN` | 自动查找 | 显式指定 dsh 可执行文件路径 |
| `DSH_HOME` | App 数据目录 | Harness 数据目录(profile/会话);默认与浏览器 WebUI 隔离 |
| `DSH_NPM_REGISTRY` | `https://registry.npmjs.org` | 版本检查/升级用的 npm registry 镜像(如 npmmirror) |

## 常见问题

**`找不到 dsh 命令`**
运行 `npm run doctor` 看提示。打包后的 App 自带 dsh;开发模式下先确认 `npm install` 装过 `@deepseek-ai/dsh`。也可用 `DSH_BIN` 强制指定。

**启动后一直停在加载页**
看日志:主进程终端会打印 `[dsh:err] ...`,完整日志在 `~/Library/Application Support/DSH Box/logs/`。最常见原因:端口被占用(换 `DSH_APP_PORT`)或 DSH_HOME 里的 profile 配置损坏。

**启动页总是闪一下红色「服务启动失败」但服务其实正常**
最常见原因:**同时跑了两个实例**(比如 `npm start` 的 dev 版和已安装的打包版同时打开)。两个实例的 userData 不同,Electron 自带单实例锁管不住,会争抢同一个端口,后启动者的 dsh 绑定失败(EADDRINUSE)却从先启动者的服务加载 UI → 误报。App 现已用**全局单实例锁**(所有实例共享,与 userData 无关),后启动的实例会直接退出。若仍出现,检查是否有残留进程:`pkill -f "bin.js web"` 后重开。

**命令面板/触发菜单打开即消失(闪烁)**
通常是**两个 dsh 服务共享同一会话**导致的:浏览器 WebUI 和桌面 App 各跑一个 dsh 服务,同时打开同一个会话时,一方写入会让另一方的会话状态刷新,把会话级弹层顶掉。App 默认已用独立 DSH_HOME 隔离;如果手动设了 `DSH_HOME=~/.dsh` 共享,请**不要同时在两个客户端打开同一个会话**。

**WebUI 里执行 shell 命令没有权限(比如访问桌面/文档/下载)**
这是 macOS 的 TCC 限制,与 Harness 无关。按 [docs/PERMISSIONS.md](docs/PERMISSIONS.md) 给 App 授予「完全磁盘访问权限」即可——这是本方案相对浏览器的核心优势。

**关掉窗口后 App 还在后台?**
macOS 惯例:关窗不退出,点 Dock 图标重新开窗,dsh 服务保持运行(再次打开秒开)。要彻底退出:菜单栏「DSH Box」→「退出 DSH Box」,或 ⌘Q。

## 路线图

- [x] Electron 壳:dsh 子进程托管 + WebUI 加载
- [x] 权限继承方案(进程树继承 TCC)
- [x] dsh 打进 App,用户免安装(内置 Node 运行)
- [x] 正式图标、关于页(品牌化菜单栏 + 「关于 DSH Box」弹窗)
- [x] 「dsh 服务与版本」页:运行状态 / 端口 / 版本列表 / 应用内一键升级(dsh)
- [ ] 打包签名 + notarization(hardened runtime)
- [ ] 自动更新(应用本体)
- [ ] 会话/Profile 管理界面(切换 DSH_HOME)

## 许可

MIT。DeepSeek Harness 本身是 MIT(见其[仓库](https://github.com/deepseek-ai/deepseek-harness))。
