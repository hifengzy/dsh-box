# DSH Box QA 文档

> 适用版本:v0.1.8(公开仓库、无 token 发布链路)
> 平台:macOS 14+ / Apple Silicon(本项目按 M4 Pro 开发)
> 配套自动化:`npm run test:regression`(24 项回归,详见 §4 对照表)

## 1. QA 概述

### 1.1 测试范围
DSH Box 是 DeepSeek Harness 的 macOS 桌面壳(Electron + WebContentsView 架构):
自建 dsh 服务子进程、自定义顶栏、服务状态面板、插件/插件市场管理、应用自更新、DMG 发布产物。
本文档覆盖全部用户可见功能 + 发布链路 + 安全边界,按模块给出可执行用例。

### 1.2 架构速览(理解用例背景)
- **进程模型**:Electron 主进程(main.js)spawn dsh 子进程(ELECTRON_RUN_AS_NODE 起
  `web --port 3260 --no-open`);窗口 = 顶栏 WebContentsView(40px)+ 内容 WebContentsView
  (加载页 → dsh WebUI)+ 右侧状态面板(注入式共享面板 / 兜底独立视图)+ tooltip 气泡层。
- **数据隔离**:用户数据在 `~/Library/Application Support/DSH Box/dsh-home`,与用户 CLI
  `~/.dsh` 完全隔离。
- **发布链路**:release-mac.sh(打包→签名→公证→stapler→zip/dmg→feed),仓库公开后
  自动无 token 模式,dmg 走 dmgbuild(Applications 快捷方式,无背景图)。

### 1.3 质量基线
- 每次改动 `src/main/*.js` 或 `plugin-manager.js` 后必须跑 `node scripts/check-main-integrity.js`。
- 功能改动必须跑全量 `npm run test:regression`,全部 PASS(0 项失败)才可进入发布。
- 发布产物(0.1.8+):包内 `app-update.yml` **不得含 token**;dmg 必须含
  `Applications -> /Applications` 链接(无背景图)。

## 2. 测试环境准备

| 项 | 说明 |
|---|---|
| 安装方式 | 全新:dmg 拖入 Applications(可同时验收 DMG 引导);升级:应用内「新版本」或手动下载 zip |
| 干净环境 | 需验证首启行为时,删除 `~/Library/Application Support/DSH Box` 后重装 |
| dev 模式 | `npm start`;注意 dev 模式下**应用自更新禁用**(状态 disabled,顶栏无「新版本」) |
| 服务端口 | 默认 3260;被占自动跳 3261+ |
| 测试账号 | 无登录要求;插件/市场走 npm registry,需网络 |
| 日志 | 主进程日志在终端(dev)/系统日志;插件 CLI 失败详情在 `dsh-home/logs/plugin-cli.log` |

## 3. 功能测试矩阵

> 优先级:P1 = 发布必过;P2 = 常规回归;P3 = 边界/体验细节。
> 「自动回归」列 = 对应的 scripts/regression-*.js(§4 有完整对照)。

### A. 安装与首次启动

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| A-01 | 首启自动展开服务状态 | 干净环境首次启动 | 首屏画完后右侧自动展开「服务状态」面板;二次启动不再弹 | regression-first-launch(两种模式) | P1 |
| A-02 | 关窗重开 | Cmd+W 关窗 → Dock 点击重开 | 窗口重建,加载 WebUI,注入生效(侧栏/面板可用) | regression-reopen | P1 |
| A-03 | 双击顶栏最大化/还原 | 双击顶栏空白区 ×2 | 窗口放大/还原;双击功能按钮**不**触发(事件已隔离) | —(手工) | P2 |
| A-04 | 第二实例 | 已运行状态下再启动一次 App | 第二实例立即退出,不破坏第一个实例 | 单实例锁(手工) | P1 |
| A-05 | 加载页过渡 | 停止服务后重启应用 | 先显示加载页,服务 ready 后无缝切 WebUI | regression-loading-visibility | P1 |

### B. 服务生命周期

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| B-01 | 启动/就绪 | 启动应用,观察状态页 | 状态机 starting→ready;状态页显示当前端口/版本 | regression-restart | P1 |
| B-02 | 手动停止/启动 | 状态页「停止」→「启动」 | 停止后显示「未运行」,加载页/状态页同步;再次启动恢复 | regression-restart | P1 |
| B-03 | 崩溃自愈 | kill dsh 子进程 | **错误反馈 + 提供「重试」入口**(无自动重启):内容区切回加载页错误态,点击重试恢复;不白屏 | regression-crash-reason/feedback | P1 |
| B-04 | 崩溃反馈 | 制造崩溃(可注入) | 出现错误态 + 「重试」入口,重试可恢复 | regression-crash-feedback | P1 |
| B-05 | 启动失败根因 | 端口被假服务占用等 | 错误态显示可读的失败原因(非裸报错) | regression-crash-reason | P1 |

### C. 端口冲突并存

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| C-01 | 端口被占自动换 | 先起一个 3260 服务,再启动 DSH Box | 不误加载假服务;自动改 3261+;状态页如实显示迁移前后端口 | regression-port-conflict | P1 |
| C-02 | 占用原服务不被破坏 | 同上,检查被占端口服务 | 原服务照常运行,DSH Box 不接管、不共享数据 | 同 C-01 | P1 |

### D. 自定义顶栏

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| D-01 | 顶栏拖拽窗口 | 按住顶栏空白拖动 | 窗口跟随移动;功能按钮区域不触发拖动 | —(手工) | P2 |
| D-02 | 4 入口顺序/图标 | 悬停 github/服务状态/底部面板/侧边栏 | 顺序由左至右:更新按钮(出现时)→github→服务状态→底部面板→侧边栏;图标线框,激活态转实心 | regression-topbar | P1 |
| D-03 | 入口 tooltip(0.1.8) | 悬停任一入口 icon,停留 >250ms | **按钮正下方弹出深色气泡**(点个Star 🤩 / 服务管理 / 面板 / 侧栏);移出即消失 | regression-topbar[8] | P1 |
| D-04 | GitHub 入口 | 点击 github icon | 系统浏览器打开 https://github.com/hifengzy/dsh-box | regression-topbar | P1 |
| D-05 | 服务状态入口 | 点击「服务状态」icon | 右侧面板展开(激活态点亮);再点收起 | regression-topbar/status | P1 |
| D-06 | 插件面板开关 | 侧栏/底栏按钮 | 经桥切换 dsh 页内插件面板开合;未装插件时按钮置灰禁用 | regression-status[9]/status-inline | P2 |
| D-07 | 更新红点 | 某依赖有新版(可造) | 服务状态 icon 右上角亮红点;无新版隐藏 | regression-status[8] | P2 |
| D-08 | 窗口过窄 | 窗口缩到很窄 | 状态入口禁用(提示面板放不下),扩宽恢复 | check-dsh-narrow | P2 |

### E. 服务状态面板(右侧)

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| E-01 | 面板内容 | 打开面板 | 板块顺序:服务状态 → DSH → 通知 → 插件市场 → 侧边栏;每板块标题齐全 | regression-status[14a] | P1 |
| E-02 | 三处刷新 | 关闭再打开面板 | 每次打开都重新查询 dsh 最新版/插件/插件市场 | regression-status-refresh | P1 |
| E-03 | DSH 升级 | 状态页 DSH 板块「升级」 | staging 原子替换 → 自动重启;版本号更新;失败可回滚 | regression-upgrade | P1 |
| E-04 | 插件板块四态 | 未装/已装==最新/已装<最新/失败 | 分别显示「安装」「已安装」「更新」「错误+重试」 | regression-status[10] | P1 |
| E-05 | 插件安装/更新(0.1.8) | 插件板块点「安装」或「更新」 | 服务全程在线 → 安装 → **自动重启一次**;期间面板被注入保持、不刷掉;失败不动服务并给错误 | regression-plugin-live + 手工(见 §5 注意) | P1 |
| E-06 | 插件市场同样四态/安装 | 市场板块操作 | 与插件一致;「侧边栏入口」开关持久化 | regression-market-live / status[12] | P1 |
| E-07 | 通知设置 | 通知板块开/关横幅与声音 | 设置持久化(settings.yaml);开横幅后 dsh 触发推送时右上角横幅 + 声音 | regression-notify-watch | P2 |
| E-08 | 面板宽度拖拽 | 拖动面板左缘调整宽度 | 宽度实时变化并持久化;重启后保持 | regression-sidebar-layout | P2 |
| E-09 | 互斥展开 | 插件侧栏展开时开服务状态 | 先收插件侧栏,再展开服务状态;反向亦然 | regression-status-inline | P2 |
| E-10 | 兜底面板 | 服务异常(未 ready)时开面板 | 自动用独立 statusView 兜底,内容一致 | —(手工/异常注入) | P2 |

### F. 应用菜单与 Tray

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| F-01 | 应用菜单结构 | 查看菜单栏 | 首菜单「DSH Box」:关于 → 检查更新… → 服务 → 隐藏/退出(不再有「dsh 服务与版本…」) | regression-menu | P1 |
| F-02 | 关于弹窗 | 菜单「关于 DSH Box」 | 品牌弹窗:logo + 版本 + DeepSeek Harness(在 Electron 上方)+ Electron/Node 版本 | regression-menu[6] | P1 |
| F-03 | 手动检查更新 | 菜单「检查更新…」 | 有新版→顶栏出现「新版本」;无新版→弹「当前没有可用的更新」;失败→错误弹窗 | regression-menu[3.5]/app-update-live | P1 |
| F-04 | Tray 单击聚焦 | 菜单栏图标单击 | 聚焦/打开主窗口 | regression-tray | P1 |
| F-05 | Tray 右键菜单 | 右键图标 | 菜单:「打开 DSH Box」/「服务管理」/「退出」 | regression-tray | P1 |
| F-06 | Tray 服务管理(0.1.8) | 右键 →「服务管理」 | 应用聚焦 + 状态面板展开(已展开则只聚焦) | regression-tray[4b] | P1 |

### G. 应用自更新(公开仓库匿名 feed)

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| G-01 | 启动静默检查 | 启动 App(有新版时) | 静默查出最新版 → 顶栏出现「新版本」按钮;**查无新版本 → 按钮隐藏**(无幽灵按钮);**检查失败 → error 态显示「重试」入口**(与 G-04 一致,可重查) | regression-topbar[7]/app-updater | P1 |
| G-02 | 点击下载即时反馈(0.1.6) | 点「新版本」 | **立即**显示「下载中 0%」+ 扫光动画;真实进度到达后变「下载中 n%」 | regression-topbar[7] | P1 |
| G-03 | 下载完成/安装 | 等下载完成 → 点「安装」 | 「安装」反白涂满 → 退出+替换+自动重启到新版 | regression-app-update-live | P1 |
| G-04 | 失败重试 | 断网/feed 异常时检查或下载 | error 态「重试」:检查失败→重新检查;下载失败→重新下载 | regression-app-updater[3d-3f] | P1 |
| G-05 | 公开仓库 feed(0.1.7+) | 0.1.8 上再检查更新 | 走匿名公开链路(无 token 也能查/下载);包内 app-update.yml 无 token 字段 | 发布验证(§K) | P1 |
| G-06 | dev 模式禁用 | `npm start` 查看 | 自更新 disabled,顶栏无更新按钮 | regression-app-updater[1] | P3 |

### H. dsh 升级链路

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| H-01 | 升级成功闭环 | 状态页升级 dsh 到指定版本 | staging 目录原子替换 → 服务自动重启 → 新版本生效 | regression-upgrade | P1 |
| H-02 | 升级中断自愈 | 模拟升级中断 | 启动时检测残留 staging,自动回滚/自检(verifyDshBoot) | regression-upgrade(heal) | P1 |
| H-03 | 升级失败不破坏 | 强制失败场景 | 原版本保留可继续使用;错误如实上报 | regression-upgrade | P1 |

### I. 插件 / 插件市场安装链路

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| I-01 | GUI 场景 pnpm 可用(0.1.8) | **从 GUI(非终端)启动 App**,插件板块「更新」 | 成功安装 → 自动重启 → 显示新版本;不再报「pnpm not found on PATH」 | regression-plugin-live + regression-toolchain | P1 |
| I-02 | 工具链优先级 | 用户 node≥20 优先;缺失回退内置或报错引导 | 探测顺序:DSH_NPM_CMD → 用户本地 → 内置 → 明确报错 | regression-toolchain | P2 |
| I-03 | 并发互斥 | 连续快速点两次插件「更新」 | 第二次被拒绝("已有安装任务进行中") | 状态页交互(手工) | P2 |
| I-04 | 安装失败落盘 | 制造失败(如 registry 不可达) | 面板显示错误 + 详情落盘 `dsh-home/logs/plugin-cli.log` | —(手工,远程诊断通道) | P2 |

### J. 主题与外观

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| J-01 | 主题跟随系统 | 系统切深/浅色 | App 顶栏/面板/关于页跟随,无锁死(选「跟随系统」应持续跟随) | regression-theme-sync | P1 |
| J-02 | 偏好持久化 | 状态页/设置改主题偏好 | settings.yaml 实时生效,重启保持 | regression-theme-sync | P2 |

### K. DMG 发布产物(验收发布质量)

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| K-01 | DMG 布局(0.1.9,无背景) | 挂载新版 dmg | 窗口 540×380(系统默认背景):仅 **DSH Box.app + Applications 快捷方式**两个图标(80px,左 130/右 410);无背景图/无引导箭头;**Applications 快捷方式可见可拖** | 发布验证脚本(手工,见 §6) | P1 |
| K-02 | 包内无 token(0.1.7+) | 解压 zip 读 `Contents/Resources/app-update.yml` | 仅 owner/repo/provider/updaterCacheDirName,**无 token 行** | 发布验证 | P1 |
| K-03 | feed 完整性 | 比对 latest-mac.yml sha512 与 zip 实际值 | 一致;url 为纯文件名 | 发布验证 | P1 |
| K-04 | 签名公证 | 全新下载安装首启 | Gatekeeper 无拦截(spctl accepted,Notarized Developer ID) | 发布验证 | P1 |
| K-05 | 应用内更新闭环 | 0.1.7 → 0.1.8 应用内更新 | 检查→下载→安装→自动重启到新版 | G 组 + 发布验证 | P1 |

### L. 安全与信任边界

| 编号 | 用例 | 步骤 | 预期 | 自动回归 | 优先级 |
|---|---|---|---|---|---|
| L-01 | 外链只进系统浏览器 | 页面/面板点 GitHub/插件仓库链接 | 一律走系统默认浏览器,不在 App 内开新窗口 | regression-url-guard | P1 |
| L-02 | URL 精确匹配 | 尝试前缀/端口混淆 URL | 非 dsh 同源导航被阻止 | regression-url-guard | P1 |
| L-03 | 权限最小化 | 页面请求权限(如通知) | 只信任 dsh 自身 origin + 本地 file 页面,其余拒绝 | —(代码审查 + 手工) | P2 |

## 4. 自动化回归对照表

| 回归脚本 | 覆盖用例 | 运行方式 |
|---|---|---|
| check-main-integrity | 关键函数完整性守卫(防误删) | node |
| regression-app-updater | G-01/02/03/04/06(状态机 + notify 弹窗) | node |
| regression-app-update-live | G-03 真实更新闭环(本地 fake feed) | electron |
| regression-menu | F-01/02/03 | electron |
| regression-tray | F-04/05/06 | electron |
| regression-topbar | D-02/03/04/05/07 + 更新按钮全套 | electron |
| regression-status | D-05/06、E-01/04/06、F-06 联动 | electron |
| regression-status-inline | E-09 注入式共享面板互斥 | electron |
| regression-status-refresh | E-02 | electron |
| regression-first-launch | A-01(auto + seeded) | electron |
| regression-reopen | A-02 | electron |
| regression-loading-visibility | A-05 | electron |
| regression-restart | B-01/02 | electron |
| regression-crash-reason / crash-feedback | B-03/04/05 | electron |
| regression-port-conflict | C-01/02 | electron |
| regression-sidebar-layout | E-08 宽度策略 | node |
| regression-upgrade | H-01/02/03 | electron |
| regression-plugin-live / market-live | E-05/06、I-01 真实 e2e | electron |
| regression-toolchain | I-01/02(GUI Homebrew PATH 回归) | node |
| regression-notify-watch | E-07 | node |
| regression-theme-sync | J-01/02 | node |
| regression-url-guard | L-01/02 | node |
| check-dsh-narrow | D-08 | electron |

> 全量一键:`npm run test:regression`(要求 0 失败)。

## 5. 已知边界与注意事项(QA 时的雷区)

1. **GUI 场景 PATH**:插件/市场安装依赖用户 pnpm/npm。0.1.8 起 toolchain 前置 Homebrew
   前缀(`/opt/homebrew/bin`、`/usr/local/bin`)解决 GUI 找不到 pnpm 的问题;若用户的
   工具链装在非标准位置,安装仍可能失败(报错引导)。
2. **应用内更新验证**:dev 模式自更新禁用,必须用打包产物验证 G 组用例;0.1.6 及更早
   版本的应用内更新已随旧 PAT 吊销而失效,**更新验收一律从 0.1.7/0.1.8 开始闭环**。
3. **端口迁移**:被占时端口跳到 3261+,状态页如实显示;**不要**把 3260 的可用性当作
   服务健康判据。
4. **主题「跟随系统」**:若在设置里选过浅/深再切回「跟随系统」,应持续跟随系统变化
   (曾有解析镜像锁死历史,已修复,勿回归)。
5. **插件更新编排**:成功时服务自动重启一次、面板注入保持;失败**不动服务**直接报错
   (0.1.5 修复)。「更新中…」短暂显示后页面刷新 = 旧缺陷,回归时留意。
6. **DMG 内容**:发布版 dmg 必须含 Applications 快捷方式;**无背景图**(用户指定,0.1.9 起);
   若手工测试 `hdiutil` create -srcfolder 之类自制 dmg,不含 Applications 快捷方式
   (仅用于临时验证,勿误当发布产物)。
7. **检查更新弹窗**:公开仓库下无新版 → 「当前没有可用的更新」;若在私有仓库未公开前
   的旧包上点检查会报「检查更新失败」(过渡态,非缺陷)。

## 6. 发布前 QA 快速单(Release Checklist)

- [ ] `node scripts/check-main-integrity.js` PASS
- [ ] `npm run test:regression` 全部 PASS(0 失败)
- [ ] 已用打包产物(非 dev)走通 G-03 应用内更新闭环(0.1.7→新版)
- [ ] 全新 dmg 安装首启:Gatekeeper 无拦截;首次自动展开状态面板
- [ ] 挂载 dmg:Applications 快捷方式存在、无背景图(仅两个图标)
- [ ] 解压 zip 校验:app-update.yml **无 token**;latest-mac.yml sha512 与 zip 一致
- [ ] releases/latest 指向新版本;资产 zip/dmg/yml 齐全、大小与本地一致
- [ ] 公开仓库匿名验证:无 token 拉 get feed 200

## 7. 缺陷上报规范

每份缺陷报告含:
1. **版本与来源**:App 版本 + 安装方式(dmg/更新/dev)+ 系统版本;
2. **复现步骤**:最小可复现路径(含前置状态,如「插件市场已装 1.31.1」);
3. **实际 vs 预期**;
4. **日志/证据**:主进程控制台输出、状态页截图、`dsh-home/logs/plugin-cli.log`(插件类)、
   `~/Library/Application Support/DSH Box/dsh-home` 相关文件;
5. **第一性原理倾向**:先确认是「交互预期」还是「机制缺陷」(参照各用例的预期列)。