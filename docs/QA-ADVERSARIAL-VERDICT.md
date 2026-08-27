# 对抗式 QA 报告核查裁定 v0.1.8

> 对象:[docs/QA-ADVERSARIAL-REPORT-v0.1.8.md](./QA-ADVERSARIAL-REPORT-v0.1.8.md)
> 方法:对报告每条声明读取当前 `main` 分支实际代码验证(P1 全部由主核查亲验;P2/P3 由 4 个并行只读子代理逐条核实,均有行号级证据)。
> 结论口径:CONFIRMED = 缺陷真实存在 / PARTIAL = 机制成立但部分描述有出入 / NOT_CONFIRMED = 与代码矛盾(误报)。

## 一、总览

| 级别 | 报告数量 | 核查结果 |
|---|---|---|
| P1 | 5 | **CONFIRMED 4 / 误报 1**(P1-5) |
| P2 | 报告称 21(清单实际 25 项) | CONFIRMED 17 / PARTIAL 4 / 无误报,1 项为「有意设计」 |
| P3 | 17 | CONFIRMED 15 / PARTIAL 1(P3-17)/ 误报 1(P3-03) |

- **报告内计数瑕疵**:总览表写 P2=21,但正文清单实际列出 25 项(A1-6/B1-6/C1-5/D1-5/E1-2/F1);总览数量与清单不符,以清单为准。
- **报告整体质量:高**。43 项声明中 36 项完全属实、5 项部分属实、2 项误报,且"对抗验证通过项"(命令注入不可行/三锁互斥/url-guard/幽灵按钮防线/注入保持/主题镜像锁死已修复)均与代码一致。误报集中在「对实现细节的过度推断」(P1-5、P3-03),不改变 P0=0 的总体结论。

## 二、P1 裁决(4/5 成立)

### P1-1 ✅ CONFIRMED — stop() 宽限 SIGKILL 后迟到 exit 被误报「意外退出」
- **验证**:`dsh-server.js:349` `this.stopping = false` 在 stop() 的 promise resolve 后**同步复位**,而 SIGKILL 后子进程的 `'exit'` 事件在下轮事件循环才投递,此时 `stopping=false` → `dsh-server.js:287` 走进 `emit("exited")` → `main.js:471-485` 广播错误 + 把内容区切回加载页错误态。
- **后果成立**:dsh 不响应 SIGTERM 时,手动停止→显示"服务意外退出";升级/插件重启踩中宽限 → 新服务已 ready 后旧 exit 迟到 → **服务在跑、UI 显示崩溃**,自相矛盾。
- **方案**:停止复位交给事件消化 —— `stopping` 的复位移到 exit/error 处理器(`if (this.stopping) { this.stopping = false; return; }`),并在 exit 处理器加代际判断 `if (this.child !== child) return;`(旧 child 迟到一律按停止流程处理)。

### P1-2 ✅ CONFIRMED — 启动中点击停止 → 被误标 DSH_START_TIMEOUT 并广播错误
- **验证**:`_waitReady()`(dsh-server.js:357)`if (this.stopping) throw new Error("服务已停止")`;start() 的 catch(dsh-server.js:303-312)**无条件** `error.code = "DSH_START_TIMEOUT"` + `emit("error")`;与 IPC `dsh:stop` 的 stopped 广播竞态,error 可能后到污染终态与 lastError。
- **方案**:catch 内先判 `if (this.stopping) { await this.stop(); return; }` —— 主动停止中断走平稳退出,不包装不广播。

### P1-3 ✅ CONFIRMED — 升级双 rename 毫秒级窗口 + resolveDsh 落 PATH
- **验证**:`dsh-upgrade.js:360-361` 两步 rename 之间被 kill -9 → pkgDir 缺失;`resolveDsh()`(dsh-server.js:112-146)bundled 缺失 → `which dsh` PATH 兜底 → 用户全局 npm -g dsh 被 App 静默改跑(数据经 App 注入参数流向用户全局包);`healInterruptedUpgrade`(main.js:563)`!info.packageDir` 直接 return。
- **注**:PATH 兜底本身是**有意的产品行为**(dsh-server.js 注释:与用户 CLI 共用同一 profile);问题在于 kill -9 窗口下**内置包缺失时没有恢复路径**。
- **方案**:heal 增加「pkgDir 缺失但存在 `.dsh-*-bak-*` 备份 → 直接恢复」分支;启动自愈对"内置包缺失"与"冒烟失败"分别处理,不依赖 resolveDsh 的 PATH 结果。

### P1-4 ✅ CONFIRMED — settings.yaml 读失败空覆写 + 非原子并发写
- **验证**:`box-settings.js:64-68` 读失败(ENOENT/EIO/EMFILE)`lines = []` → 继续 `writeFileSync` 覆盖,把 dsh 侧全部配置抹成只剩 `dsh-box:` 域;`writeFileSync` 直写非原子 + 与 dsh 双写者无锁 → lost-update/截断。
- **方案**:① 读失败区分:ENOENT = 首启允许空建;**其它错误 = 中止写入并返回 false**(宁可本轮不持久化);② 写入改 `settings.yaml.tmp` → `renameSync` 原子替换;③ (可选)写前保留 `.bak`。

### P1-5 ❌ NOT_CONFIRMED — Tray「服务管理」判据错配(误报)
- **验证**:`main.js:682-685` `sidebarState()` 注入模式分支 `return { open: statusPanelOpen, canOpen: true }` —— **注入模式返回的就是 statusPanelOpen**,并非报告所称"恒 false 的 sidebarOpen"。Tray onOpenStatus(main.js:1707-1711)`if (!sidebarState().open) toggleStatusSidebar()` 在注入模式下判定正确:面板已展开(statusPanelOpen=true)→ 只聚焦,不会收起。
- **结论**:报告对 sidebarState 实现的引用有误(或基于旧版本),缺陷不存在。
- **可采纳的部分**:regression-tray 目前只断言回调被调、不验语义 —— 补一条「注入模式下已展开再点服务管理 → 面板保持展开」的真实断言作为防回归(**测试补强,非缺陷修复**)。

## 三、P2 裁决(17 真 + 4 部分 + 1 设计使然)

### 完全成立(CONFIRMED,17 项)
| ID | 缺陷 | 方案要点 |
|---|---|---|
| A1 | exited 无自动重启,B-03 规格漂移 | **修订 QA 文档**:B-03 改「错误反馈 + 人工重试入口」(自动重启非现状;若未来要自动重启需另设计防风暴) |
| A2 | start/restart/retry/stop 无 in-flight 守卫,连点双重 spawn + 全占错误广播 | startServer 加 in-flight 标志;「已在运行」哨兵短路 |
| A4 | closed 不复位 statusPanelOpen/statusInjectBroken/lastPluginPanels,重开首击无效 | closed 一并复位为新窗口语义初值 |
| A5 | 单实例锁 mkdir+写 pid 非原子 / EPERM 当陈旧锁 / PID 重用静默拒启 | pid 文件 O_EXCL 原子创建;EPERM 显式视为存活;拒启给可见 dialog |
| A6 | reapStaleServers pgrep "." 未转义无锚点 | pattern 转义 `.` 并加锚;或 `ps -o command=` 全串精确匹配 |
| B1 | 插件安装结果提示与重启导航竞态(写旧 document 被冲掉) | 结果展示与重启解耦:先展示结果、再触发重启;或新页 did-finish-load 后恢复面板态并注入提示 |
| B4 | 面板拖拽无 pointercancel 兜底,手势打断后 transition 永久失效 | 补 pointercancel/lostpointercapture 复用 onUp 清理 |
| B5 | 注入面板缺端口迁移提示(仅兜底有) | 把 portMovedFrom 渲染移植进 status-ui-inject 的 renderStatus |
| B6 | 注入模式 canOpen 恒 true,过窄禁用仅兜底成立 | **设计使然**(overlay 不挤占内容区,main.js:683 注释自述);记录为已知行为,不改 |
| C2 | version 永不主动清零,撤版后重试死循环(幽灵可用版本唯一路径) | 下载连续 N 次失败降级为重新检查;404 类错误主动清 version |
| C3 | .dsh-broken-* 目录永久累积;自愈只试最新一份备份 | broken 节流清理(保留最近一份);自愈迭代最近 K 份备份 |
| C4 | will-quit 停服 fire-and-forget,Squirrel 替换时旧 dsh 变孤儿 | will-quit preventDefault + 上限内显式 await server.stop();app-updater autoInstallOnAppQuit 场景同路径 |
| C5 | 黑洞网络下「下载中 0%」无超时/取消出口 | downloading 超阈值(如 60s 无进度)自动转 error;或允许取消回 available |
| D1 | 权限处理器信任任意 file:// 前缀 + 用顶层 getURL 判定 + 空 requestingOrigin 放行 | file:// 收紧到 app 资源目录前缀;改用 details.requestingOrigin;空串限定权限白名单 |
| D2 | server 未就绪时兜底信任「占着计划端口的陌生服务」 | fail-closed:server.url 未知直接拒绝 |
| D3 | 仅 will-navigate 无 did-navigate,HTTP 30x 重定向绕过同源校验 | 补 did-navigate 校验,异源强制回 loadURL(server.url) |
| D4 | 版本号正则 `(?:[-+].*)?` 过宽(匹配 /、@、空格) | 收窄为 semver 合法字符集 `[-+][0-9A-Za-z.-]*` 或 semver.valid() |
| D5 | nvm/fnm/volta 用户工具链探测落空 + README 误导 | README 补插件/市场安装的工具链依赖说明与 DSH_NPM_CMD 引导 |
| E1 | toolchain spawnSync 同步阻塞主进程(最坏 ~34s) | 换 async execFile / 加短 TTL 缓存 |
| E2 | 发布脚本资产不校验权限、KEYCHAIN_PW 弱默认、gh 全权 token 内嵌 | 构建前 `stat -f %A` 查 700;KEYCHAIN_PW 强制 env;private 分支最小权限 token |
| F1 | bash 3.2 + set -u 下空数组展开崩溃 | `"${PUBLISH_ARGS[@]+"${PUBLISH_ARGS[@]}"}"` |

### 部分成立(PARTIAL,4 项)
| ID | 成立部分 | 不成立部分 |
|---|---|---|
| A3 | ✅ 无 did-fail-load 监听,ready 后 loadURL 失败停留错误页 | ❌ "应用菜单无 reload"——menu.js:104 有 `role:"reload"` |
| B2 | ✅ pluginSideOpen 取缓存 lastPluginPanels,上报间隙可双开 | ❌ statusOpen:false 硬编码无实际影响(该分支不读它) |
| B3 | ✅ closePluginSideWithAnimation 忽略桥返回值 | ❌ "永久降级"不成立——页面重载即自动自愈(main.js:1498) |
| C1 | ✅ error title 固定"下载失败,点击重试"不区分检查/下载失败 | ❌ 按钮文案是「重试」非「下载失败」;G-01/G-04 矛盾是 **QA 文档表述问题**(代码里 error 恒显示按钮) |

## 四、P3 裁决(15 真 + 1 部分 + 1 误报)

**误报**:P3-03 —— `dialog.showMessageBox(mainWindow, …)` 首参为 null 时按无父窗口弹窗,**不抛 TypeError**。

**部分**:P3-17 —— 8 子项中 6 项属实(broken 静默/theme block-style 契约/npm-check 非原子写/notify CONNECTING 泄漏/提示音无节流/topBar·statusView 缺 will-navigate),box-settings 正则未转义 key 存在但当前调用方均为固定安全字面量(无实际影响),1 项行号引用错误。

**其余 15 项全部属实**(P3-01 日志累积+整文件同步读、P3-02 will-quit 不等待、P3-04 whenReady 主链无拒绝处理、P3-05 防火墙假占用、P3-06 提前退出误标超时+isPortConflict 死参、P3-07 __DSH_BOOT__ 可伪造、P3-08 迁移措辞、P3-09 tooltip 宽度估算、P3-10 tooltip/status 栈序、P3-11 resize 不校正 tooltip、P3-12 orange 硬编码+永久轮询、P3-13 CONTENT_MIN 死常量、P3-14 notify 单槽位+autoInstallOnAppQuit、P3-15 integrity 缺失静默放行、P3-16 EXDEV 无降级+DMGBUILD 硬编码+e2e exit(1))。

## 五、采纳建议(按实施批次)

**批 1 · 立即修(低风险高价值,改动小)**
- P1-1 / P1-2 / P1-4(stop 复位时机、启动停止中断、box-settings 读失败中止+原子写)
- P2-F1(空数组展开)、P2-A6(pgrep 转义)、P2-D4(版本正则)、P2-B4(pointercancel)、P2-D3(did-navigate 一行)
- QA 文档修订:B-03 与 G-01 两处规格漂移对齐实现 + P1-5/P3-03 误报标注

**批 2 · 设计后修(需权衡)**
- P1-3(heal 备份恢复分支)、P2-B1(结果展示与重启解耦)、P2-C2(version 清空策略)、P2-C4(will-quit await)、P2-C5(下载超时/取消)、P2-A2(in-flight 守卫)、P2-A4(closed 复位)、P2-C3(broken 节流+备份迭代)

**批 3 · 纵深(排期)**
- P2-D1(file:// 收紧)、P2-D5(README 工具链说明)、P2-E1(async 化)、P2-E2(发布脚本权限/token 面)、P3 各项按模块消化

**不采纳**
- P1-5、P3-03(误报,无需修复);P2-B6(设计使然,记录为已知行为)
- P2-B3 的"永久降级"论断、P2-A3 的"菜单无 reload"论断(PARTIAL 中失实部分)

## 六、报告本身的两处口径建议

1. 总览 P2 计数(21)与正文清单(25)不一致,建议改 25。
2. P1-5 的举证代码(main.js:682-690)与该版本实际代码不符,建议复核引用版本(当前 main 为 `{ open: statusPanelOpen, canOpen: true }`,注入模式判据正确)。