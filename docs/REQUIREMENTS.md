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
- **待办**:`resolveToolchain()` 解析函数 + 内置物打入 Resources(build.files 扩展,
  mac arm64 / win x64 二进制)+ `dsh-upgrade.js` / `plugin-manager.js` 改造接入 +
  干净机器回退路径回归。

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
| PR-A | 端口冲突并存(预检 + 自动换端口 + 孤儿签名收紧)+ 首启自动展开侧边栏 + 打开状态页三处刷新回归 | 4/5/7 | ✅ 已实现(本批次) |
| PR-B | 工具链解析(优先用户 npm/pnpm ≥20、内置兜底)+ 内置 Node 打包接入 | 3 | 打包物引入,可拆两步:先解析逻辑,后内置物 |
| PR-C | Developer ID 签名 + 公证 + `--publish always` + 正式 Release 验收 + Windows(win/nsis)打包 | 1/6 | Apple Developer 账号;可边做边等证书 |