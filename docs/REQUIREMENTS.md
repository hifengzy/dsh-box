# DSH Box 0.1.0 需求确认清单

> 状态:已与用户确认(2026-xx)。本文档是后续实施 PR 的需求依据,与 docs/APP-UPDATER-PLAN.md
> 互为补充(后者管应用自更新一条线,本文档管 0.1.0 全部需求)。

## 需求 1 — 桌面端打包:Apple M 系 dmg + Windows exe

- **现状**:mac 侧已就绪 —— `build.mac.target = [dmg, zip]`;e2e 已走真实目录构建 + 自签证书验证。
  本机 arm64,默认产物即 M 系;跨机/CI 需显式 `--arm64`(或 universal)。
- **缺口**:Windows 完全未配置(无 `build.win` 段、无 exe/nsis 目标);nsis 打包基本只能在
  Windows 环境(或 wine)跑,属发布工程问题。
- **决定**:正式发布阶段补 `build.win`(nsis)+ Windows 打包说明;与需求 6 的 PR-3 同批。

## 需求 2 — 内置 dsh webUI,装完打开就有服务

- **状态**:✅ 已实现。App 启动即拉起 dsh 子进程(Electron 内置 Node 运行,
  `ELECTRON_RUN_AS_NODE=1`,`web --port 3260 --no-open`),WebUI 内嵌内容视图;
  状态机 starting/ready/error/stopped + 崩溃自愈 + 启动自检回滚。
- **注**:「内置」= 内置 dsh 代码 + 用 Electron 的 Node 跑,非内置独立 Node 发行版
  (独立 Node 的事见需求 3)。

## 需求 3 — 内置 node/npm vs 用户本地(已拍板:方案 B)

- **事实**:dsh 服务本身永不需要用户 Node(走 Electron 运行时)。需要外部工具链的只有:
  1. dsh 升级(`dsh-upgrade.js` spawn 系统 `npm`);
  2. 插件/插件市场安装(dsh CLI 转发 `pnpm`)。
- **决定(用户已选 B)**:**优先用户本地、内置兜底** —— 用户机器有满足 `engines.node >=20`
  的 node/npm 就用他的(兼容镜像/代理/缓存);没有或不满足则回退内置 Node 二进制(+ 自带
  npm / corepack pnpm)。内置 Node 只服务「升级/装插件」,dsh 服务运行时仍用 Electron Node,
  不重复内置两份。
- **已实现(PR-B,解析逻辑 + 内置物管线;真实二进制由脚本按需拉取,不入 git)**:
  - `src/main/toolchain.js`(纯 Node):npm 选用 = DSH_NPM_CMD(env 覆盖)→ 用户本地
    (node ≥ 20 + npm 可用,基于 shellPath 探测:进程 PATH → macOS `launchctl getenv PATH`
    → /usr/bin:/bin 兜底,应对 GUI 不继承终端 PATH)→ 内置运行时 → 明确报错引导;
    pnpm 只注入 PATH(dsh CLI 内部 spawnSync("pnpm") 纯 PATH 解析):用户 pnpm 命中则原样,
    缺失则内置 bin 前置;
  - `dsh-upgrade.js` 依赖闭包安装、`plugin-manager.js` 插件安装均接入(main.js 按打包态
    计算内置目录:dev=assets/runtime/<平台>-<架构>/node,打包=Resources/runtime,
    可 DSH_BUNDLED_RUNTIME 覆盖);
  - `scripts/fetch-bundled-runtime.mjs`:拉取官方 Node 发行(自带 npm)+ pnpm 到
    assets/runtime(不入库 .gitignore;打包时 `extraResources` 拷进 Resources/runtime);
  - 回归 `scripts/regression-toolchain.js`:优先级/版本门槛(node<20 拒绝)/内置完整性/
    pnpm PATH 注入全覆盖。
  - **已知边界**:GUI 应用探测用户 PATH 是尽力而为(launchctl getenv PATH),Homebrew 等
    自定义 PATH 用户若未注入登录会话,会回退内置运行时 —— 符合「内置兜底」设计。

## 需求 4 — 首次打开自动展开「服务状态」侧边栏

- **现状**:侧边栏(服务状态 + 版本 + 插件市场 + 侧边栏插件)已存在;缺「首次启动检测」。
- **已实现(PR-A)**:settings.yaml 的 `dsh-box.launchedBefore` 标记;首启且窗口
  首屏画完后自动展开(注入模式走桥开共享面板,否则回退独立 statusView);
  二次启动不再弹出。覆盖回归:scripts/regression-first-launch.js(auto + seeded 双模式)。

## 需求 5 — 打开状态页自动查最新版 + 更新后自动重启

- **状态**:✅ 基本已交付。dsh 最新版(进入状态页再查 + 启动静默查 + 顶栏红点
  `npm-check.js`)、插件与插件市场(`lastPluginCheck / lastMarketCheck`)、更新后自动重启
  (dsh 升级 staging 原子替换 + 插件/市场安装后 ready 复位防短路)均已有回归覆盖。
- **已实现(PR-A)**:补「打开状态页三处同时刷新」回归断言 ——
  scripts/regression-status-refresh.js:页面每次加载必须同时发起 dsh/插件/市场
  三处查询,重载(重新打开)后三处均重新查询。

## 需求 6 — 应用自动更新(查、下载、安装、重启)

- **状态**:✅ 已实现(PR-1/PR-2 已合入 main):electron-updater 状态机 + 顶栏「新版本」按钮
  + 手动「安装」,e2e 自签证书走通 Squirrel 完整替换。
- **缺口**:PR-3 —— Developer ID 签名 + 公证(notarize)+ `--publish always` 发布脚本 +
  正式 Release「查→下→装→重启」验收(可选 GitHub Actions)。详见 docs/APP-UPDATER-PLAN.md。

## 需求 7 — 与用户本地已有 dsh 的冲突处理(已拍板:主动探测 + 自动换端口)

- **已有防线**(全部已实现并验证):
  1. 多开 DSH Box → 全局锁文件,第二实例退出;
  2. 崩溃残留孤儿 dsh → 启动前清「PPID=1 + 命令行签名匹配」,父进程存活的活服务不碰;
  3. 端口被非 dsh 服务占用 → 健康检查识破假服务,进错误态不误载(ISSUE-003 回归);
  4. 数据隔离 → DSH Box 用 `userData/dsh-home`,与用户 CLI `~/.dsh` 完全隔离,
     不共享会话/插件/设置。
- **已发现的边角风险**:`_reapStaleServers` 的 pgrep 签名 `dsh/lib/bin.js web --port N`
  是子串匹配,用户独立 dsh 若以 `web --port 3260` 后台运行且父进程已死,会被误判孤儿
  误杀。**已修复(PR-A)**:签名收紧为含 `--no-open`(DSH Box 启动必带,用户 CLI 默认不带)。
- **决定(用户已选)**:**主动探测 + 自动换端口并存** —— 启动前 probe 3260,被占则提示
  「检测到已有服务占用」并自动改用 3261+ 起 DSH Box 自己的服务,加载页/状态页如实显示
  当前端口;永不接管、不共享用户的服务与 profile。
- **已实现(PR-A)**:`DshServer.probePort()` 预检 + `start({ port })` 支持换端口 +
  main.js 逐候选重试(最多跳过 10 个端口,含 EADDRINUSE 竞态兜底)+
  `getServerInfo().port/portMovedFrom` 如实上报迁移前后端口 + 状态页展示迁移提示。
  覆盖回归:scripts/regression-port-conflict.js(ISSUE-003 保持:假服务绝不当 WebUI 加载;
  新增:自动改用下一端口并就绪、portMovedFrom 如实上报)。

## 实施拆分(建议顺序)

| 批次 | 内容 | 关联需求 | 状态 |
|---|---|---|---|
| PR-A | 端口冲突并存(预检 + 自动换端口 + 孤儿签名收紧)+ 首启自动展开侧边栏 + 打开状态页三处刷新回归 | 4/5/7 | ✅ 已实现(PR#6 已合) |
| PR-B | 工具链解析(优先用户 npm/pnpm ≥20、内置兜底)+ 内置 Node 打包接入 | 3 | ✅ 已实现(解析逻辑 + 内置物管线;真实二进制脚本按需拉取) |
| PR-C | Developer ID 签名 + 公证 + `--publish always` + 正式 Release 验收 + Windows(win/nsis)打包 | 1/6 | Apple Developer 账号;可边做边等证书 |

---

## 需求 8 — 0.1.7 交互细节批(工具提示 / Tray 服务管理 / 检查更新弹窗 / DMG 引导)

> 2026 年新增需求(一次一批,单 PR 收口)。

### 8.1 顶栏功能入口 tooltips

- **要求**:标题栏 4 个功能入口悬停气泡提示,文案固定:
  GitHub = 「点个Star 🤩」;服务状态 = 「服务管理」;底部面板 = 「面板」;侧边栏 = 「侧栏」。
- **实现**:原生 `title` 气泡(顶栏视图固定 40px 高,`overflow:hidden`,自定义 CSS 气泡会被
  裁剪;原生气泡由系统绘制不受视图边界限制)。文案见 topbar.html 四个按钮的 `title` 属性。
- **覆盖回归**:scripts/regression-topbar.js `[1b]` 断言四个 `title` 精确文案 + 按钮顺序。

### 8.2 菜单栏(Tray)右键「服务管理」+ 应用菜单去重

- **要求**:
  1. 菜单栏 icon 右键菜单在「打开 DSH Box」下面新增「服务管理」——点击后聚焦应用并展开
     「服务状态」面板;
  2. 去掉应用菜单「关于 DSH Box」下面的「dsh 服务与版本…」选项(入口去重)。
- **实现**:tray.js 菜单插「服务管理」(onOpenStatus 回调);main.js 回调 =
   `focusOrCreateWindow()` + 面板未展开时 `toggleStatusSidebar()`(自动走注入桥,异常期
   回退独立面板);menu.js 移除 dshStatus 项与 onOpenStatus 参数。
- **覆盖回归**:regression-tray.js `[2][4b]`(三项 + 位置 + 回调)、regression-menu.js `[2]`
  (应用菜单不再含「dsh 服务与版本…」)。

### 8.3 手动「检查更新…」无新版弹窗

- **要求**:菜单手动点「检查更新…」,若无新版本弹出提示「当前没有可用的更新」。
- **实现**:app-updater.js `checkForUpdates({ notify })` —— 手动检查带回调,检查终态
  (update-not-available → `notify("up-to-date")`、error → `notify({error})`)时通知调用方;
  发现新版本不回调(顶栏「新版本」按钮即反馈);启动静默检查不传 notify 保持静默。
  main.js `buildMenu.onCheckUpdate` 弹 `dialog.showMessageBox`(类型 info/error)。
- **覆盖回归**:regression-app-updater.js `[2e1]`~`[2e5]`(已是最新 / 失败 / 有新版不回调 /
  无终态不悬空)。

### 8.4 DMG 引导(Applications 快捷方式)

- **要求**:打开 dmg 在窗口内展示 Applications 文件夹快捷方式,方便直接拖入。
- **实现**:
  - `build.dmg.contents` 显式两块:DSH Box.app(默认第一项)+ `/Applications` link
    (electron-builder 本就默认创建 Applications 快照,现显式声明 + 槽位对齐);
  - dmg 制作用 electron-builder 同源 dmgbuild CLI(输入已签名 APP;settings.json
    含两图标槽位与窗口尺寸)—— 修复 0.1.7 手工 hdiutil 丢 Applications 的缺陷。
- **变更(0.1.9)**:按用户要求**移除背景图**(assets/dmg-background.png 及生成器
  make-dmg-background.swift 已删除,`build.dmg.background` 不再配置)—— 卷内仅
  DSH Box.app + Applications 快捷方式两个图标,窗口用系统默认背景;图标槽位
  与引导箭头不再需要对齐。
- **验收**:本地构建后挂载 dmg,窗口 540×380 内两个图标(DSH Box.app +
  Applications 链接),无背景图。

### 8.5 仓库转公开前自查(2026 新增)

> 触发:用户计划把 dsh-box 从私有仓库改为公开。全量排查结论 + 需要的改动。

**⚠ 最高危:已发布包内嵌 GitHub PAT**
- 0.1.4 起每个发布包(zip/dmg)的 `Contents/Resources/app-update.yml` 都烤入了
  `gh auth token`(私有仓库 feed 认证必需,electron-updater 有 token → PrivateGitHubProvider
  走 api.github.com)。仓库转公开的瞬间,这些 release 资产对外可见 → **PAT 立即泄露**。
- 修复已合入 release-mac.sh:按仓库可见性自动切换 —— public 模式**不写 token**(无 token →
  electron-updater 匿名 GitHubProvider:`github.com` 的 atom feed + `releases/download`,
  公开仓库无需认证),private 模式保持现状并在写 yml 时打印轮换警告。
- **操作清单(转公开日)**:
  1. 用新脚本发布一版**无 token** 的版本(0.1.7+),并让用户更新到该版本;
  2. **吊销旧 PAT**(`gh auth status` 确认 → GitHub Settings → Developer settings →
     Personal access tokens → 删除;或换 fine-grained token 并最小化权限);
  3. 再点「Make public」。

**其余排查结论(均无阻塞)**
- 源码/文档/git 历史:无 token、无私钥、无凭据文件(e.g. `grep ghp_` 零命中);
- git 跟踪文件:无 `.env/.p12/.pem/keychain/私钥`;`id/`(公证私钥 AuthKey_*.p8 +
  密码文件)已被 .gitignore 覆盖且未跟踪 —— 本机敏感资产,勿提交;
- README/LICENSE(MIT)/docs:内容可公开,无敏感路径与凭证;
- electron-updater 链路:yml 去 token 后走向匿名公开路径,无需改 app-updater.js;
- 发布脚本:keychain 解锁密码支持 `DSH_KEYCHAIN_PW` env 覆盖(默认 verify,
  本地资产;脚本公开后密码不再是秘密,凭据隔离靠「keychain 文件不进仓库」)。

**持续注意**
- 若以后启用 GitHub Actions:公开仓库的 secrets 不暴露给 fork PR,警惕
  `pull_request_target` 类触发;
- 转公开后第一次应用内更新(0.1.7 无 token)即验证匿名 feed 全链路。