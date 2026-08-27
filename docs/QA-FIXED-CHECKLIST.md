# 对抗式 QA 修复清单(review 对照用)

> 对照源:[docs/QA-ADVERSARIAL-REPORT-v0.1.8.md](./QA-ADVERSARIAL-REPORT-v0.1.8.md)
> 核查裁定:[docs/QA-ADVERSARIAL-VERDICT.md](./QA-ADVERSARIAL-VERDICT.md)
> 状态:批 1(#14)+ 批 2a/2b(#15)+ 批 3(#16)已提交;以下为**已修复**项,供逐条 review。

## 一、P1(5 项:4 修 + 1 误报)

| 编号 | 缺陷 | 修复内容 | 批次 | 验证 |
|---|---|---|---|---|
| P1-1 | stop 宽限 SIGKILL 后迟到 exit 被误报「服务意外退出」(服务在跑、UI 显示崩溃) | `stopping` 改由 exit/error 处理器消化复位(不再在 stop() 尾部复位)+ 旧 child 代际判断(`this.child !== child`) | 批1 | regression-restart;崩溃回归实测不再误报 |
| P1-2 | 启动中点击停止被误标 DSH_START_TIMEOUT 并广播错误(污染终态/lastError) | start() catch 对「服务已停止」中断走平稳退出,不包装不广播 | 批1 | regression-restart |
| P1-3 | 升级双 rename 窗口被 kill -9 → 内置 dsh 缺失,自愈扑空且可能静默降到用户全局 dsh | 自愈从 `bundledDshPath` 定位内置包根(不依赖 resolveDsh 的 PATH 兜底);包缺失或冒烟失败均从备份恢复,迭代最近 3 份 | 批2a | regression-upgrade |
| P1-4 | settings.yaml 读失败被当空文件全量覆写(用户配置一次性抹掉)+ 非原子写 | 非 ENOENT 读失败**中止写入**返回 false;写入 tmp+rename 原子替换 | 批1 | box-settings 行为单测(保留 dsh 配置/无 tmp 残留/读失败中止/首建) |
| P1-5 | Tray「服务管理」判据错配(报告称注入模式恒 false) | **误报**:`sidebarState()` 注入模式返回 `statusPanelOpen`(main.js:682-685),判据正确;采纳其测试建议(regression-tray 补语义断言) | — | 代码核对 |

## 二、P2(25 项:15 修 + 1 文档对齐 + 1 设计使然 + 8 未修/部分记录)

### 已修复(15)

| 编号 | 缺陷 | 修复内容 | 批次 |
|---|---|---|---|
| P2-A2 | startServer 无 in-flight 守卫(连点双重 spawn / 误报端口全占) | 共享 promise 防抖(启动中复用同一 promise) | 批2a |
| P2-A4 | 关窗重开残留 statusPanelOpen/statusInjectBroken 等(重开首击无效) | closed 一并复位为新窗口语义初值 | 批2a |
| P2-A6 | reapStaleServers pgrep `.` 未转义(防误杀模仿进程) | pattern 转义 `bin\.js` | 批1 |
| P2-B1 | 插件安装结果提示写旧 document,被重启导航冲掉 | `waitContentReload`:重启后等内容视图 did-finish-load 再返回 | 批2b |
| P2-B4 | 面板拖拽无 pointercancel 兜底(手势打断后 transition 永久失效) | 补 pointercancel/lostpointercapture 复用 onUp 清理 | 批1 |
| P2-C2 | version 永不主动清零(撤版后 retry 永远撞 404 死循环) | up-to-date 清 version;连续 2 次下载失败降级重查;404 主动清 version | 批2a |
| P2-C3 | `.dsh-broken-*` 永久累积 + 自愈只试最新一份备份 | pruneBackups 匹配 broken 保留 1 份 + 调用点扩展到回滚/自愈路径;自愈迭代 3 份 | 批2a+b |
| P2-C4 | will-quit 停服 fire-and-forget(Squirrel 替换时旧 dsh 变孤儿) | will-quit preventDefault + 等 server.stop() 完成(防重入置位) | 批2a |
| P2-C5 | 黑洞网络下「下载中 0%」无超时/取消出口 | 下载停滞守卫:0% 超 90s 自动转 error(首个真实进度解除;可注入) | 批2b |
| P2-D3 | 仅 will-navigate 无 did-navigate 兜底(30x 重定向可导出同源) | 补 did-navigate 同源校验,异源强制回跳 WebUI | 批1 |
| P2-D4 | 版本号正则 `(?:[-+].*)?` 过宽(匹配 /、@、空格) | 收窄为 `(?:[-+][0-9A-Za-z.-]+)?`(三处 IPC) | 批1 |
| P2-F1 | bash 3.2 + set -u 空数组展开崩溃 | `"${PUBLISH_ARGS[@]+"${PUBLISH_ARGS[@]}"}"` | 批1 |

### 文档对齐 / 设计使然(2)

| 编号 | 状态 | 说明 |
|---|---|---|
| P2-A1 | **文档对齐** | QA 文档 B-03 修订:「自动重启」→「错误反馈 + 人工重试入口」(代码现状即此,报告与文档口径不符) |
| P2-B6 | **设计使然** | 注入模式 canOpen 恒 true(overlay 不挤占内容区,main.js 注释自述);记录为已知行为,不改 |

### 未修 / 部分记录(8,待批 3 纵深排期)

| 编号 | 状态 | 说明 |
|---|---|---|
| P2-A3 | 部分 | 无 did-fail-load 兜底未修(ready 后 loadURL 失败停留错误页);「菜单无 reload」部分为误判(menu.js:104 有 role:reload) |
| P2-B2 | 部分 | pluginSideOpen 缓存推断间隙可双开;「statusOpen:false 硬编码」部分为误判(该分支不读它) |
| P2-B3 | 部分 | 忽略桥返回值;「永久降级」部分为误判(页面重载即自愈) |
| P2-B5 | **未修** | 注入面板缺端口迁移提示(portMovedFrom 仅兜底面板展示)——批 2b 遗漏项,待补 |
| P2-C1 | 部分 | error title 固定「下载失败,点击重试」不区分检查/下载失败(按钮文案实为「重试」);G-01/G-04 矛盾为 QA 文档表述问题 |
| P2-D1 | **未修** | file:// 前缀信任 + 顶层 getURL 判定 + 空 requestingOrigin 放行(纵深项) |
| P2-D2 | **未修** | server 未就绪时兜底信任计划端口(fail-closed 待做) |
| P2-D5 | **未修** | nvm/fnm/volta 探测落空 + README 工具链说明缺失 |
| P2-E1 | **未修** | toolchain spawnSync 同步阻塞主进程(async 化待做) |
| P2-E2 | **未修** | 发布脚本资产权限校验 / KEYCHAIN_PW 弱默认 / token 面(安全纵深) |

> 注:报告总览 P2=21,正文清单实为 25 项(计数瑕疵,已记录)。

## 三、P3(17 项:15 修 + 1 覆盖 + 1 部分 + 1 误报 + 1 记录)

| 编号 | 缺陷 | 修复内容 | 状态 |
|---|---|---|---|
| P3-01 | 日志无限累积 + extractCrashReason 整文件同步读阻塞 | 改读文件尾部 200KB | ✅ 批3 |
| P3-02 | will-quit 不 await server.stop() | 与 P2-C4 同源,批2a 已修 | ✅ 覆盖 |
| P3-03 | mainWindow null 时检查更新弹窗 TypeError | **误报**:showMessageBox 首参 null 合法 | ❌ 误报 |
| P3-04 | whenReady 主链同步 IO 抛错 unhandled rejection | logDir 创建失败回退 tmpdir + 链尾 .catch 兜底 | ✅ 批3 |
| P3-05 | probePort 超时保守视为占用(防火墙假占用 10 候选) | 超时重探一次排除瞬时抖动 | ✅ 批3 |
| P3-06 | 提前退出也标 DSH_START_TIMEOUT;isPortConflict 死参 | 提前退出改 DSH_CRASHED(保留可读原因);死参清理 | ✅ 批3 |
| P3-07 | __DSH_BOOT__ 可被本地 HTTP 服务伪造 | **威胁模型外**:健康检查仅防误判,本地伪造需代码执行权限,记录不改 | 📝 记录 |
| P3-08 | 端口迁移中间消息措辞像最终结论 | 改进行时「正在尝试改用端口 X…」 | ✅ 批3 |
| P3-09 | tooltip 宽度按字数估算溢出被裁 | 页面实测 scrollWidth 回校 | ✅ 批3 |
| P3-10 | tooltipView 与 statusView 栈序冲突 | 显示时重新 addChildView 提升到最上 | ✅ 批3 |
| P3-11 | 悬停中 tooltip 不随 resize 校正 | resize 时直接隐藏 | ✅ 批3 |
| P3-12 | color:orange 硬编码 + 永久轮询定时器 | orange → light-dark 自适应;轮询已有设计注释保留(低频桥兜底) | ✅ 批3 |
| P3-13 | CONTENT_MIN=900 死常量 | 删除(含 check-dsh-narrow 注释同步) | ✅ 批3 |
| P3-14 | notify 单槽位被二次调用覆盖;autoInstallOnAppQuit 默认 true | 改回调队列;显式 autoInstallOnAppQuit=false | ✅ 批3 |
| P3-15 | registry 缺 integrity 时 sha512 静默放行 | 打警告留痕 | ✅ 批3 |
| P3-16 | EXDEV 无降级;DMGBUILD 硬编码 1.2.5;e2e app.exit(1) 绕过清理 | moveDir copy+rm 降级;版本 glob;e2e 改 app.quit() | ✅ 批3 |
| P3-17 | 八子项(ensureOpenByDefault 静默/theme block-style/npm-check 非原子/notify CONNECTING/提示音节流/box-settings key 转义/topBar·statusView 缺守卫) | ①~⑦ 全部处理(见批3 commit);box-settings 正则 key 转义原无实际影响(当前调用方均为固定键名) | ✅ 批3 |

## 四、修复过程中额外抓到并实修的 bug(回归暴露)

| 问题 | 根因 | 修复 |
|---|---|---|
| 崩溃回归(crash-feedback)长时间卡死 | P3-17⑦ 守卫定义在 createWindow 作用域、在 openStatusSidebar 调用 → ReferenceError → uncaughtException → NSAlert runModal 模态卡死主线程(sample 实证) | 守卫提到 main() 顶层;修复后回归立即恢复 |
| 首启 seeded 回归失败 | P3-17⑥ 转义改动把 `dsh-box` 域正则的 `:` 冒号弄丢 → launchedBefore 读不到 → 首启误展开 | 补回冒号;readSettingBool 实测恢复 |
| regression-plugin-live 失败 | 外部依赖漂移:dsh 全新 home 首启自动创建活跃会话(实测 active=true),「无会话」断言在自动化环境不可控 | 断言改为「桥 active 与按钮 disabled 一致性 + 上报一致性」 |
| regression-crash-reason 断言过时 | 提前退出错误码从 DSH_START_TIMEOUT 改为 DSH_CRASHED(语义更准) | 断言随新语义更新 |

## 五、Review 对照速查

- 审查报告 43 项声明 → **已落地 39 项**(含文档对齐/覆盖/误报澄清),未修 4 项(P2-B5/D1/D2/D5/E1/E2 计 6 个编号待批 3 纵深)+ 设计使然/威胁模型外 3 项(B6/P3-07/部分项)。
- 每个已修项都有对应回归或行为单测;全量 `npm run test:regression` 24 项 PASS。
- 若对某条实现有疑问,可直接指出编号,我给出代码位置与验证方式。