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
│    └─ WebContentsView 内容 (加载页 → WebUI)        │  自定义标题栏 / 内缩+圆角
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
- **顶栏视图** (`src/renderer/topbar.*`) 是独立的自定义标题栏:整条可拖动、双击最大化,左侧留红绿灯空间且**不显示应用名**;右侧 `.actions` 是功能入口区,当前放 **GitHub 仓库按钮**(32×32 无背景,悬停显示背景,图标 20×20 随 light/dark 变色,点击在系统浏览器打开 `https://github.com/hifengzy/dsh-box`,纯 HTML 想加就加)。
- **内容视图** 显示加载页,就绪后加载 dsh WebUI;窗口层内缩 8px + 圆角 10px(VS Code 风格),**不碰页面布局**,不会产生滚动条。

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
    menu.js          应用菜单(全中文:关于 DSH Box / 退出 DSH Box / 编辑 / 视图 / 窗口)
    about.js         「关于 DSH Box」品牌弹窗(logo / 版本 / 依赖版本)
    dsh-server.js    dsh 子进程管理:启动、健康检查、优雅停止
  preload/
    preload.js       contextBridge 最小桥(getInfo / onStatus / retry)
  renderer/
    index.html       启动页(等待 dsh 就绪)
    renderer.js      启动页逻辑(状态渲染、重试)
    style.css
    about.html       关于弹窗页面(about.css / about.js 配套)
scripts/
  doctor.js          环境诊断:npm run doctor
  smoke.js           核心链路冒烟测试(纯 Node):npm run smoke
  dev-launch.mjs     品牌化开发启动:npm start(菜单栏显示 DSH Box)
  make-app-icon.mjs 把任意源图加安全边距后生成 assets/icon.png:npm run make-icon
assets/
  icon.png           应用图标源图(1024×1024,内容居中安全区;打包时由 electron-builder 自动转成 icns)
docs/
  PERMISSIONS.md     macOS 权限原理与配置(重点读这篇)
```

## 自检 / 测试

```bash
npm run doctor    # 环境体检:Node / dsh / Electron / 端口
npm run smoke     # 核心链路冒烟测试(纯 Node,不弹窗口)
npm run smoke:e2e # 完整 E2E:启动真实 App → 拉起 dsh → 加载 WebUI → 退出
npm run test:regression # 回归套件:重开窗口 / 加载页可见性 / 端口冲突 / 崩溃反馈 / 菜单栏 Tray / 应用菜单与关于弹窗
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
- [ ] 打包签名 + notarization(hardened runtime)
- [ ] 自动更新
- [ ] 会话/Profile 管理界面(切换 DSH_HOME)

## 许可

MIT。DeepSeek Harness 本身是 MIT(见其[仓库](https://github.com/deepseek-ai/deepseek-harness))。
