# DSH Box v0.1.8 对抗式审查 QA 报告

> 审查对象：DSH Box v0.1.8（Electron + WebContentsView 架构，自建 dsh 服务子进程）
> 审查方式：4 个子 Agent 并行只读对抗式审查，逐条对照 [QA.md](./QA.md) 各组用例预期。**全程未修改任何项目文件。**
> 审查分组：
> ① 服务生命周期与端口冲突（QA A/B/C 组）——`main.js`、`dsh-server.js`
> ② 自定义顶栏与服务状态面板（QA D/E 组）——`topbar.*`、`tooltip.*`、`status-panel-router.js`、`status-ui-inject.js`、`plugin-ui-inject.js`、`sidebar-layout.js`、`sidebar-anim.js`
> ③ 应用自更新 / dsh 升级 / 菜单 / Tray / 发布产物（QA F/G/H/K 组）——`app-updater.js`、`dsh-upgrade.js`、`menu.js`、`tray.js`、`about.js`、`release-mac.sh`、`package.json`
> ④ 插件链路 / 安全边界 / 通知 / 主题（QA E/I/J/L 组）——`plugin-manager.js`、`toolchain.js`、`npm-check.js`、`url-guard.js`、`notify-watch.js`、`theme-sync.js`、`box-settings.js`、`preload.js`

---

## 总览

| 严重度 | 数量 | 结论 |
|---|---|---|
| P0 | **0** | 未发现命令注入、不可逆数据损坏或高概率必然触发的致命缺陷 |
| P1 | **5** | 状态机竞态 ×2、升级自愈死角、配置覆写丢失、Tray 语义反转 |
| P2 | **21** | 规格漂移、双模式行为不一致、竞态边界、安全纵深不足 |
| P3 | **17** | 资源累积、文案瑕疵、低概率泄漏 |

**总结论：无发布阻断级缺陷；建议优先修复 5 个 P1（其中 settings.yaml 覆写与 SIGKILL 迟到误报收益最高），并对齐 QA 文档中两处规格漂移后再走发布验收。**

---

## 一、P1 缺陷（5 项）

### P1-1 stop() 宽限期 SIGKILL 后迟到的 exit 事件被误报为「服务意外退出」

- **位置**：[dsh-server.js:324-351](../src/main/dsh-server.js)（stop）、[dsh-server.js:284-292](../src/main/dsh-server.js)（exit handler）、关联 [main.js:470-485](../src/main/main.js)
- **证据**：

```js
// dsh-server.js stop() —— timer 回调里 kill(SIGKILL) 后立即 resolve()
const timer = setTimeout(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    resolve();                       // ← resolve 与 SIGKILL 同一 tick
}, STOP_GRACE_MS);
```

```js
// exit 监听器 —— stopping 在 stop() 末尾已被复位为 false
child.on("exit", (code, signal) => {
    logStream.end();
    this.childExitCode = code;
    if (this.stopping) return;       // 迟到的 exit 到达时此处不再拦截
    ...
    this.emit("exited", { code, signal });
});
```

stop() 的 promise resolve 后同步执行 `this.child = null; this.stopping = false;`，子进程真正死亡产生的 `'exit'` 事件在下一轮事件循环才投递，此时落入“意外退出”分支。

- **影响**：
  1. dsh 卡住不响应 SIGTERM 时，用户手动「停止」最终显示为错误态（“服务意外退出 code=null signal=SIGKILL”）而非「未运行」；
  2. 升级编排（performUpgrade）或插件安装后 restartServer 停服若踩中 5s 宽限超时，迟到事件会在新服务已 ready 之后到达——把正显示 WebUI 的内容区强制切回加载页错误态，出现“服务实际在跑、UI 显示崩溃”的自相矛盾；
  3. App 退出时 will-quit → server.stop() 同理产生伪崩溃日志。
- **建议**：为 stop 引入跨 resolve 仍有效的“停止会话代际/generation”标记（或在 stop 内注册一次性 exit 处理器而非依赖共享 stopping 标志）；`stopping` 复位推迟到确认 exit 事件处理完毕之后。

### P1-2 「启动进行中」点击停止后追加 START_TIMEOUT 错误广播，污染终态与 lastError

- **位置**：[dsh-server.js:303-312](../src/main/dsh-server.js)、[main.js:1368-1374](../src/main/main.js)
- **证据**：`_waitReady()` 在轮询间隔发现用户触发的停止即抛出 `"服务已停止"`；start() 的 catch **无条件**将其包装为 `DSH_START_TIMEOUT` 并 `emit("error")`；随后 IPC 层 `dsh:stop` 再广播 `{state:"stopped"}`。两个广播到达顺序不受保证。

```js
try { await this._waitReady(); }
catch (error) {
    await this.stop();
    error.code = "DSH_START_TIMEOUT";   // 因主动停止中断也被标成启动超时
    error.message = `dsh 服务在 ...s 内未就绪...原因: ${error.message}`;
    this.emit("error", error);
}
```

- **影响**：B-02 高频路径（60s 就绪窗口内随时可点停止）。error 若后到，状态页定格为“…原因： 服务已停止”的失败文案，与实际“主动停止成功”矛盾；同时污染 lastError，后续 getServerInfo 持续展示旧错误。
- **建议**：区分“因停止而中断”与“真正的启动失败”——stopping 抛出时不走 START_TIMEOUT 包装与 error 广播；IPC 层对 start/stop/retry 建立单一入口互斥。

### P1-3 升级双 rename 中间态（kill -9 毫秒级窗口）绕过启动自愈，且可能静默改跑用户全局 dsh

- **位置**：[dsh-upgrade.js:356-376](../src/main/dsh-upgrade.js)（原子替换）、[main.js:563-566](../src/main/main.js)（自愈入口）、[dsh-server.js:112-146](../src/main/dsh-server.js)（resolveDsh）
- **证据**：

```js
// dsh-upgrade.js 原子替换：两步 rename 之间被 kill -9 则 pkgDir 缺失
fs.renameSync(pkgDir, backup);        // 第一步成功后 pkgDir 不复存在
fs.renameSync(extractedPkg, pkgDir);  // ← 此窗口内被杀留下缺口
```

```js
// main.js 自愈入口：packageDir=null 时直接放弃，备份明明在旁边却无人恢复
const info = getRuntimeDshInfo();
if (!info || !info.packageDir) return;
```

而 `getRuntimeDshInfo()` 依赖 `resolveDsh()`：bundled 目录不存在时 realpathSync 抛错跳过，随后**落入 PATH 兜底**——若用户全局 npm -g 装过 dsh，App 将整个静默改跑用户 CLI 版本（版本错位、数据经 App 注入参数流向它）。

- **影响**：H-02「升级中断自愈」对唯一毫秒级窗口不设防。后果二选一：用户不可修复的服务不可用白屏/错误页，或静默换包运行。
- **建议**：bundled 候选目录缺失时 `resolveDsh()` 应短路返回 null（禁止落 PATH）；healInterruptedUpgrade 增加「pkgDir 缺失但存在 `-bak-` 备份」分支直接 rename 回来。改动极小，建议配合回归脚本模拟该场景。

### P1-4 settings.yaml 读失败时全量空覆写 + 双进程并发读改写无锁非原子（用户配置一次性抹掉）

- **位置**：[box-settings.js:60-113](../src/main/box-settings.js)、[plugin-manager.js:218-271](../src/main/plugin-manager.js)，关联 [theme-sync.js:35-44](../src/main/theme-sync.js)
- **证据**：

```js
} catch {
    lines = [];   // 读失败（ENOENT/EMFILE/EIO）→ 当作空文件继续走写入
}
...
fs.writeFileSync(file, out.join("\n") + "\n");   // 非原子直写覆盖
```

settings.yaml 与 dsh 服务同文件共用（文件头注释自述），构成双写者。

- **影响**：
  1. Box 在 dsh 原子 rename 替换文件的瞬间读到短暂 ENOENT，下一次写入就会产出只剩 `dsh-box.*` 两键的空壳文件并覆盖原文件——用户全部设置（主题偏好、通知开关、市场开关等）静默丢失且无备份；
  2. 两进程并发 read-modify-write 同一文本文件，无锁无 tmp+rename，存在 lost-update 窗口（丢主题偏好直接打击 J-02）；进程中途崩溃/断电会留下截断 YAML，此后所有读取退默认值。
- **建议**：读失败必须中止写入返回 false（宁可本轮不持久化）；统一经单一写入口做 tmp+rename 原子替换；写前保留 `.bak`。

### P1-5 Tray「服务管理」判据数据源错配：注入模式下把已展开的面板收起（违背 F-06）

- **位置**：[main.js:1707-1712](../src/main/main.js)、关联 [main.js:682-690](../src/main/main.js)（sidebarState）、[main.js:1499](../src/main/main.js)；回归盲区 [regression-tray.js:54-61](../scripts/regression-tray.js)
- **证据**：

```js
onOpenStatus: () => {
    focusOrCreateWindow();
    // 面板未展开才展开(已展开则只聚焦)
    if (!sidebarState().open) toggleStatusSidebar();
},
```

而 `sidebarState().open` 返回的是主进程**兜底视图**的 `sidebarOpen`（注入模式恒 false）；注入模式的真实开合记录在 `statusPanelOpen`。于是面板已展开时条件恒真 → toggle → 执行 requestClose 把面板关掉。

- **影响**：F-06 在常态（注入模式）下行为相反：右键「服务管理」不只聚焦，还顺手收起了面板。[regression-tray.js] [4b] 仅断言回调被调，不校验语义，无法拦截此缺陷。
- **建议**：判据改为「注入模式看 statusPanelOpen、兜底模式看 sidebarOpen」，或将托盘语义改为显式 ensure-open 分支；regression-tray 补“已展开再点只聚焦”的真实断言。

---

## 二、P2 缺陷（按模块 21 项）

### 2.A 服务生命周期（6 项）

#### P2-A1 QA B-03 规格漂移：「kill 后自动重启」实现并不存在
- **位置**：[main.js:470-485](../src/main/main.js)、对照 [regression-crash-feedback.js:66-74](../scripts/regression-crash-feedback.js)
- QA.md B-03 预期列写明“自动重启服务”；实现仅广播错误信息并等待人工点击重试。回归脚本断言口径与实现一致、但均与 QA 文档不符。发布验收以 QA 文档为准绳时 B-03 永远无法按字面达标。
- **建议**：对齐口径——要么落地带次数上限+指数退避的自动重启（需同步设计防风暴），要么修订 B-03 为“呈现错误反馈并提供可用重试入口”。

#### P2-A2 startServer/restartServer/dsh:retry/dsh:stop 无互斥标志，并发交叉产生失真文案
- **位置**：[main.js:600-657](../src/main/main.js)、[main.js:1334-1339](../src/main/main.js)、[main.js:1368-1374](../src/main/main.js)
- 入口守卫只挡“已在跑”，不挡“并发启动中”。快速连点重试或 start/stop 交替时，第二调用抛内部哨兵错误进入候选循环空转，触发 “端口 3260 ~ 3269 均被其他服务占用” 的错误广播（实际只有一个正常 starting 的实例）。UI 短暂显示与事实相反的错误后被 ready 覆盖。
- **建议**：加 in-flight 守卫；“已在运行”哨兵错误直通短路。

#### P2-A3 did-fail-load 无兜底：ready 后首次 loadURL 失败停留灰色错误页
- **位置**：[main.js:301-305](../src/main/main.js)、[main.js:458-460](../src/main/main.js)；全文无 did-fail-load 监听
- loadURL 发起后服务即刻死亡 → ERR_CONNECTION_REFUSED 错误页永久停留；应用菜单无 reload 角色。这是加载页“卡死”的真实形态（不是转圈不停，而是死灰屏无从恢复，只能关窗重开）。
- **建议**：注册 did-fail-load 统一回落加载页错误态，或菜单补 reload。

#### P2-A4 关窗重开未复位 statusPanelOpen/statusInjectBroken → 新窗口第一击无效
- **位置**：[main.js:329-336](../src/main/main.js)（closed 只复位 sidebarOpen 等 6 项）
- 上一窗口开着注入面板关窗，Dock 重开后 statusPanelOpen 保持 true；第一次点顶栏按钮 `desiredOpen = !true = false` 向未打开的面板发 requestClose，界面毫无反应，第二次点击才生效。`statusInjectBroken` 不随窗口重建复位同理。
- **建议**：closed 时将 statusPanelOpen/statusInjectBroken/lastPluginPanels/lastError/portMovedFrom 一并复位为新窗口语义初值。

#### P2-A5 全局单实例锁 TOCTOU + EPERM 误判 + PID 重用拒启
- **位置**：[main.js:91-129](../src/main/main.js)
- mkdir 成功与写 pid 文件之间有竞态窗口，B 实例读 pid 抛错进 catch 判定陈旧锁接管 → 双实例并存；`process.kill(pid,0)` 的 EPERM（进程存在但无权限）也落入 catch 当陈旧锁；PID 重用则使第二实例被判已有实例静默退出（console-only，无可见提示）。
- **建议**：pid 文件 O_EXCL 原子创建；EPERM 显式视为存活；拒绝第二实例时给 dialog 可见理由（纵深上可补 `requestSingleInstanceLock` 第二道防线）。

#### P2-A6 reapStaleServers pgrep 正则无锚点且 `.` 泛匹配，存在误杀用户的模仿进程的低概率破坏性风险
- **位置**：[dsh-server.js:405-440](../src/main/dsh-server.js)
- pattern `dsh/lib/bin.js web --port ${port} --no-open` 中 `.` 是任意字符通配、无 `^` 锚；判定仅需“命令行含子串 + PPID=1”。launchd 收养的、复刻 DSH 参数的用户独立 dsh 进程都在射程内。
- **建议**：pattern 加锚点并转义 `.`；叠加 `ps -o command=` 全串精确匹配或核实 ELECTRON_RUN_AS_NODE 来源后再杀。

### 2.B 顶栏与服务状态面板（6 项）

#### P2-B1 插件安装结果回填与重启导航竞态：QA §5.5 明令警惕的旧观感存在复发窗口
- **位置**：[main.js:1084-1099](../src/main/main.js)（performPluginInstall）、[main.js:1131-1146](../src/main/main.js)（market 同构）、[status-ui-inject.js:915-920](../src/main/status-ui-inject.js)（面板侧回填）
- `restartServer()` 完成 ≠ WebUI reload 完成：ready 事件的 loadURL 是 fire-and-forget，随后才 resolve 的 installPlugin 结果（“已更新到 x”提示与刷新后的插件版本行）可能写在已被调度替换的旧 document 上，被新页面整页冲掉——正是 QA 注意事项 5 提到要避免的“更新中…短暂显示后页面刷新”。另外重载后面板开合状态复位、顶栏按钮熄灭（结果提示无处安放）。
- **建议**：结果展示与重启解耦（先本地渲染结果，延迟/确认后再触发重启），或在新页面注入完成后恢复 statusPanelOpen 并让提示存活于新文档。

#### P2-B2 互斥编排依赖缓存态 lastPluginPanels 推断，上报间隙点击可双开面板
- **位置**：[main.js:829-834](../src/main/main.js)、[main.js:1421-1430](../src/main/main.js)、[status-panel-router.js:31-51](../src/main/status-panel-router.js)
- `statusOpen:false` 硬编码、`pluginSideOpen` 取自桥上报缓存（初始化 null，按收起处理）。插件侧栏实际展开而上报未抵达的间隙内点击，「open-status」跳过 closePluginSide，两个面板同帧打开，违背互斥规则。
- **建议**：requestOpen 前经桥实时拉取权威开合态（以查询代替缓存推断）。

#### P2-B3 closePluginSideWithAnimation 忽略桥执行结果；Promise.all 单边失败即整体放弃打开
- **位置**：[main.js:908-915](../src/main/main.js)、[main.js:829-834](../src/main/main.js) catch 分支
- 桥缺失时表达式求值为 false，executeJavaScript 正常 resolve 不报错照常等待；反之视图销毁真异常时 runMutualOpen 整体 reject，catch 直接 markInjectBroken 吞掉本次 openStatus——“点了没反应”且被永久降级到兜底模式（需下次加载才能自动痊愈）。
- **建议**：校验 toggle 返回 `res && res.ok`；区分“动画失败可重试”与“桥真正不可用”。

#### P2-B4 面板拖拽缺 pointercancel 兜底，系统手势打断后过渡效果永久禁用不自愈
- **位置**：[status-ui-inject.js:1229-1255](../src/main/status-ui-inject.js)
- 仅监听 pointerup，无 pointercancel/lostpointercapture。触控板三指/Mission Control 手势打断指针序列后 `data-dragging` 不清除，CSS `transition:none` 从此恒生效，后续所有滑入滑出变瞬跳直到页面重载。
- **建议**：补 pointercancel 监听复用 onUp 清理逻辑。

#### P2-B5 注入面板缺失端口迁移提示，C-01「如实显示迁移前后端口」仅兜底模式成立
- **位置**：[dsh-status.js:129-141](../src/renderer/dsh-status.js)（兜底版显示 portMovedFrom）vs [status-ui-inject.js:765-784](../src/main/status-ui-inject.js)（注入版 metaLine 只有 `端口 · PID`）
- 常规就绪路径（注入模式）下迁移信息不可见，两种底层形态行为不一致。数据已具备（portMovedFrom 在 getInfo 返回中），纯展示遗漏。
- **建议**：移植端口迁移提示进注入面板 renderStatus。

#### P2-B6 注入模式 canOpen 恒为 true：D-08 过窄禁用仅对兜底模式成立
- **位置**：[main.js:682-690](../src/main/main.js)、[topbar.js:44-47](../src/renderer/topbar.js)
- overlay 面板不参与 computeSidebar 宽度判定；960px 最小窗宽下 240~640px 面板不会自动收起，极窄窗 + 极限面板宽度时内容区被压至极限，同一图标在不同模式下禁用语义不同。
- **建议**：注入模式引入宽度感知降级策略（低于某内宽 clamp 到更小面板宽）。

### 2.C 应用自更新与升级（5 项）

#### P2-C1 error 态更新按钮文案固定「下载失败」，检查失败同样误报，且 G-01 与 G-04 要求打架
- **位置**：[topbar.js:134-154](../src/renderer/topbar.js)、[app-updater.js:99-105](../src/main/app-updater.js)
- error 既来自下载也来自检查（feed 404/断网），按钮一律显示且 title 固定 “下载失败,点击重试”——还没下载过却说下载失败；启动即断网的用户每次都会看到一个无法解释的重试按钮，与 G-01「查询失败按钮保持隐藏」字面冲突（G-04 又要求 error 重试可达，两个用例互相矛盾）。回归 [7] 只测了带 version 的下载失败，没有检验失败时按钮可见性断言。
- **建议**：区分两类 error 文案（version 有值/无值）；把 G-01 边界钉死并补断言。

#### P2-C2 retry 凭 version 残留分流：feed 版本被撤回后陷入「重下失败」死循环（幽灵可用版本唯一路径）
- **位置**：[app-updater.js:59-74](../src/main/app-updater.js)、[app-updater.js:201-212](../src/main/app-updater.js)
- `version` 一旦赋值从不主动清零（update-not-available 分支也不清）。available→下载失败→官方撤版后，每次重试都 resetError 复活 available 态（幽灵按钮亮「新版本」）→ 拿缓存 updateInfo 再撞一次 404 → 回 error，永远走不到重新 check 分支，没有任何路径能洗掉陈旧 available 态。
- **建议**：downloadUpdate 连续 N 次失败降级为重新检查；404 类事件主动清除 version 缓存。

#### P2-C3 `.dsh-broken-*` 目录永久累积；启动自愈只试最新一份备份、失败不迭代更早备份
- **位置**：[dsh-upgrade.js:233-241](../src/main/dsh-upgrade.js)、[dsh-upgrade.js:63-75](../src/main/dsh-upgrade.js)（pruneBackups 正则故意不匹配 broken）、[main.js:575-584](../src/main/main.js)
- 每次失败的升级/自愈都在 node_modules 旁堆一份几十 MB 的完整 dsh 包；备份恰好损坏时 App 用一个坏目录换另一个坏目录，此后永久停在坏态（restore 后二次冒烟失败仅 console.error 收场）。
- **建议**：broken/bak 清理节流（保留最近一份其余删除）；自愈迭代最近 K 份备份逐一尝试。

#### P2-C4 quitAndInstall 退出闭环：will-quit 停服 fire-and-forget，Squirrel 替换不等 dsh 死透
- **位置**：[main.js:1764-1768](../src/main/main.js)、[app-updater.js:174-186](../src/main/app-updater.js)
- `server.stop()` 发出 SIGTERM 不 await 即退出，Squirrel.Mac 替换 .app 时残存旧 dsh 变 PPID=1 孤儿继续占端口；新版首启靠 reapStaleServers + 端口迁移兜底，最坏情形首次启动挤到 3261 并如实提示迁移，给用户制造一次假故障感。（设置保存无忧：settings.yaml 全部 IPC 即时落盘。）
- **建议**：will-quit 中 preventDefault + 显式 await server.stop()（带上限），或 quitAndInstall 前置停服步骤。

#### P2-C5 黑洞型网络故障下「下载中 0%」停留分钟级，无超时/取消出口
- **位置**：[app-updater.js:159-171](../src/main/app-updater.js)
- 快速故障（DNS/TCP 拒绝）秒级转 error 可重试；连接建立后吞吐归零的黑洞只能等 httpExecutor 默认 60s 一档 idle timeout 或 OS 放弃。期间只有扫光动画，按钮不可再点、无可取消操作。
- **建议**：downloading 态增加“0% 超阈值自动转 error”或允许取消回到 available；配置显式请求超时上界。

### 2.D 安全边界（5 项）

#### P2-D1 权限处理器信任任意 file:// URL，并用顶层 getURL() 而非请求发起 origin 判定
- **位置**：[main.js:1625-1641](../src/main/main.js)、[url-guard.js:33-35](../src/main/url-guard.js)
- `isAppFilePage` 仅判断前缀 `file://`——磁盘上任何 HTML 的权限请求都被信任；iframe 发起的请求沿用顶层页面判定（回调的 details.requestingUrl/requestingOrigin 未使用）；setPermissionCheckHandler 对 requestingOrigin 为空串无条件放行。
- **建议**：file:// 收紧到 app 自带资源目录前缀；改用 details.requestingOrigin；空串放行限定 permission 白名单并留日志。

#### P2-D2 server 未就绪时的 trustedOrigin 兜底信任「占着计划端口的陌生本地服务」
- **位置**：[main.js:1625-1626](../src/main/main.js)
- fallback 用配置端口 `http://127.0.0.1:${port}`，而 QA §5.3 明确该端口被占时服务迁移——此刻占用 3260 的另一进程页面请求权限会被判可信。应 fail-closed（server.url 未知直接拒绝）。

#### P2-D3 HTTP 重定向可将内容视图导出同源，did-navigate 层无二次校验
- **位置**：[main.js:310-327](../src/main/main.js)
- 仅有 setWindowOpenHandler（全 deny）与 will-navigate 精确 origin 比对；服务器 30x/Location 替换不触发 will-navigate，主进程也无 did-navigate 兜底。L-02「非同源导航被阻止」在“dsh WebUI 返回恶意跳转”路径上失守（loopback 劫持/恶意升级包场景）。
- **建议**：补 did-navigate 校验，异源强制回 loadURL(server.url)。

#### P2-D4 IPC 版本号校验正则尾部 `(?:[-+].*)?` 过宽
- **位置**：[main.js:1378](../src/main/main.js)（upgrade）、[main.js:1401](../src/main/main.js)（plugin-install）、[main.js:1460](../src/main/main.js)（market-install）
- `.` 匹配 `/`、`@`、空格等。当前上游链路（registry 白名单）实际兜住不可达危害，但这道防线只靠“registry 不发怪版本号”支撑。
- **建议**：收窄为 semver 合法字符集或 semver.valid()。

#### P2-D5 nvm/fnm/volta 用户的插件安装失败路径缺少文档化引导，README 口径误导
- **位置**：[toolchain.js:36-41,49-57,262-263](../src/main/toolchain.js)、对照 [README.md] L57/L151
- 探测 PATH 链路（GUI 空 PATH → launchctl → Homebrew 双前缀 → /usr/bin:/bin）对 nvm/fnm/volta（node/pnpm 在 ~ 下）全部落空，交给 dsh CLI 报错仅落盘 plugin-cli.log。README 反复强调“不需要装 Node”，常见问题区无 pnpm/nvm 一句，与实际能力不符，误导用户提 issue。
- **建议**：README 补充插件/市场安装的工具链依赖说明与 DSH_NPM_CMD 引导。

### 2.E 性能与工具链（2 项）

#### P2-E1 toolchain 探测全程 spawnSync 同步阻塞 Electron 主进程
- **位置**：[toolchain.js:87-100,114-128,69-84](../src/main/toolchain.js)
- probeOut 单次 8s 超时，probeUserNpm 连探 node+npm 最坏 16s，外加 launchctl 2s；升级/装插件发起时于 UI 主进程同步执行，外置磁盘慢或防病毒 hook 时窗口冻结可感知。
- **建议**：换 async execFile 或加短 TTL 缓存。

#### P2-E2 release-mac.sh 密钥资产面：/tmp 目录权限未校验、keychain 弱默认密码、gh token 全权内嵌
- **位置**：[release-mac.sh:38-45,98,109](../../scripts/release-mac.sh)
- `$ASSETS/.p8/keychain/entitlements` 只查存在从不检查 mode；/tmp 共享 sticky 目录多用户机器其他用户可能读取 Developer ID 私钥与 notary key；`KEYCHAIN_PW="${DSH_KEYCHAIN_PW:-verify}"` 弱默认；private 分支 `gh auth token` 是 gh 当前登录的全权 token（scope 远大于 release 读写），烤进 yml 面过大（public 分支已规避，K-02 成立）。
- **建议**：构建前 `stat -f %A` 校验 700；keychain 密码强制 env 提供；private 模式换最小 scope/fine-grained token 或 CI secret 注入。

### 2.F 发布脚本健壮性（1 项）

#### P2-F1 bash 3.2 + set -u 下空数组展开崩溃
- **位置**：[release-mac.sh:35,116-118](../../scripts/release-mac.sh)
- `PUBLISH_ARGS=()` 在 public 模式保持空数组，`"${PUBLISH_ARGS[@]}"` 在 macOS 自带 bash<4.4 与 `set -euo pipefail` 组合报 unbound variable（作者机器装了新 bash 所以未暴露）。纯净环境/CI 跑发布会立刻 fail-fast（不会产坏包，属健壮性问题）。
- **建议**：`${PUBLISH_ARGS[@]+"${PUBLISH_ARGS[@]}"}` 写法。

---

## 三、P3 缺陷（17 项）

### 服务生命周期
| # | 问题 | 位置 |
|---|---|---|
| P3-01 | 日志文件无限累积；extractCrashReason 整文件 readFileSync 可阻塞主进程 | [dsh-server.js:222-225,50-56](../src/main/dsh-server.js) |
| P3-02 | will-quit 不 await server.stop()，App 先于 dsh 消失，SQLite/JSON 写入中途截断无防护 | [main.js:1764-1768](../src/main/main.js) |
| P3-03 | mainWindow 为 null 时菜单「检查更新…」结果弹窗 TypeError 被 `.catch(()=>{})` 静默吞掉 | [main.js:1657-1672](../src/main/main.js) |
| P3-04 | app.whenReady 主链同步 IO 抛错成 unhandled rejection，生命周期半途中止 | [main.js:1679-1758](../src/main/main.js) |
| P3-05 | probePort 把超时/非 HTTP 保守视为占用；loopback 被防火墙 drop 时 10 个候选全“假占用”，allBusy 文案指引方向错误 | [dsh-server.js:454-462](../src/main/dsh-server.js) |
| P3-06 | 子进程提前退出的精确错误也被标 DSH_START_TIMEOUT，日志分流失真；isPortConflict 定义 1 参调用传 2 参（风格瑕疵） | [dsh-server.js:307](../src/main/dsh-server.js)、[main.js:641 vs 595](../src/main/main.js) |
| P3-07 | `__DSH_BOOT__` 标记可被本地任意 HTTP 服务伪造，健康检查信任模型偏弱（本地威胁模型低危） | [dsh-server.js:374-379](../src/main/dsh-server.js) |
| P3-08 | 端口迁移中间消息“自动改用端口 X+1”在后继候选也被占时会再次改口，措辞像最终结论 | [main.js:624-628](../src/main/main.js) |

### 顶栏与面板
| # | 问题 | 位置 |
|---|---|---|
| P3-09 | tooltip 宽度按字数估算（length*13+20），字体回退/长文案时气泡溢出视图被裁剪；边缘钳制后箭头不对准按钮 | [main.js:1601-1607](../src/main/main.js) |
| P3-10 | tooltipView 与 statusView addChildView 栈序冲突：后创建者盖住前者，悬停中的 tooltip 可能悬浮不消失 | [main.js:1582,789](../src/main/main.js) |
| P3-11 | 悬停中的 tooltip 不随窗口 resize/移动校正，停留旧坐标 | [main.js:1597-1613](../src/main/main.js) |
| P3-12 | `color: orange` 硬编码不受亮暗主题调节；三条永久轮询定时器常驻页面（2s report + TreeWalker 全树遍历、800ms market 轮询） | [status-ui-inject.js:539,104](../src/main/status-ui-inject.js)、[plugin-ui-inject.js:333-338](../src/main/plugin-ui-inject.js) |
| P3-13 | sidebar-layout CONTENT_MIN=900 声明未参与计算，纯误导性残留 | [sidebar-layout.js:19](../src/main/sidebar-layout.js) |

### 更新与升级
| # | 问题 | 位置 |
|---|---|---|
| P3-14 | 手动检查 notify 单槽位被第二次调用覆盖，首个结果永不弹窗；Squirrel autoInstallOnAppQuit 默认 true——下载完 Cmd+Q 重启也会变新版，“手动安装”语义被平台机制削弱 | [app-updater.js:59-65,143-157](../src/main/app-updater.js) |
| P3-15 | registry 数据缺 integrity 时 sha512 校验静默放行无任何日志，供应链校验形同虚设 | [dsh-upgrade.js:48-54,310-312](../src/main/dsh-upgrade.js) |
| P3-16 | staging→pkgDir 跨设备 rename 无 EXDEV 降级（定制 Home 卷场景两次 rename 必败，现有 catch 会如实报错不产生坏态）；DMGBUILD_DIR 缓存版本硬编码 dmg-builder@1.2.5；e2e 钩子 app.exit(1) 绕过 will-quit 清理（仅测试环境可达）；token/keychain 密码短暂出现在 ps.argv | [dsh-upgrade.js:300,360-361](../src/main/dsh-upgrade.js)、[release-mac.sh:197,131-137](../../scripts/release-mac.sh)、[main.js:1323-1326](../src/main/main.js) |

### 插件与安全
| # | 问题 | 位置 |
|---|---|---|
| P3-17 | ensureOpenByDefault 失败静默且 warning 分支为死代码（偏好写入失败无提示无日志）；readThemePreference 依赖 block-style YAML 格式契约，dsh 未来改 flow style 会致“跟随系统”静默失效（§5.4 回归盲区）；npm-check 缓存非原子写；notify-watch stop 跳过 CONNECTING 态 socket；提示音无节流可叠响；box-settings 正则构造未转义 key（当前全为字面量故安全）；statusView/topBarView 缺 will-navigate 守卫（纵深缺口） | [plugin-manager.js:268-270](../src/main/plugin-manager.js)、[main.js:1078-1083](../src/main/main.js)、[theme-sync.js:38-39](../src/main/theme-sync.js)、[npm-check.js:98-107](../src/main/npm-check.js)、[notify-watch.js:195-208](../src/main/notify-watch.js)、[main.js:1202-1211,1243](../src/main/main.js)、[box-settings.js:30,33,94](../src/main/box-settings.js)、[main.js:318-321](../src/main/main.js) |

---

## 四、对抗验证通过项（重点列出）

1. **命令注入不可行**：插件包名受 MANAGED_PLUGINS 白名单硬约束；spec 经 execFile 数组参数传递全程无 shell；registry 名 encodeURIComponent；version 三层白名单化（UI 取 registry latest → IPC 格式校验 → upgrade 白名单命中 registry list）。
2. **并发互斥在主进程层扎实实现**：IPC 层三锁（pluginInstalling/marketInstalling/upgrading）+ 编排层共享 pluginOpPending（插件与市场跨互斥）；JS 单线程 check-and-set 无竞态；绕过 UI 直接 invoke 同样被拒——I-03 达标。
3. **url-guard 核心击穿尝试均失败**：origin 经 new URL 规范化精确比较，userinfo 欺骗天然剥离，大小写/尾斜杠/端口混淆（32600）拒绝，data:/javascript:（origin="null"≠server）拒绝；window.open 全量 deny 且 http(s) 外送系统浏览器——L-01 达标。
4. **应用更新幽灵按钮防线是全仓库最扎实的部分**：html 初始 hidden 首帧不闪现；renderAppUpdate hidden 属性 + dataset 分态；up-to-date/disabled 隐藏；回归同时断言 hidden 属性与 computed display:none 防 CSS 覆盖式假隐藏；autoDownload=false 有回归锁定；installUpdate 有 downloaded 硬守卫；percent 统一 Number()+clamp+NaN 安全。
5. **注入保持机制成立（QA §5.5 核心）**：did-finish-load 每次全量重注四套桥 + 幂等防重入；insertCSS 随文档生命周期自然失效不堆积；SPA 软导航由 MutationObserver + 2s 轮询兜底；markInjectBroken 自动痊愈（上报 shell:status-panel 即复位）不存在永久降级。
6. **C 组主路径达标**：健康检查要求首页含 `__DSH_BOOT__`，任意 HTTP 占用者不会被误认为 dsh 就绪；reapStaleServers 对常规独立 `dsh web --port N`（不带 --no-open）签名不匹配、PPID≠1 一律不碰、ps 不可用保守放弃；迁移前后端口如实上报（注意 B5 例外见 P2-B5）。
7. **单实例锁动机正确**：固定 tmpdir 锁解决 dev 与打包版 userData 不同导致的抢端口问题（实现竞态另见 P2-A5）。
8. **theme-sync「跟随系统」镜像锁死历史 bug 已彻底修复**：applyThemePreference 只同步偏好本身、system 显式解锁媒体查询、幂等守卫防快速切换抖动、watcher 单例幂等不随窗口重建累积——J-01/J-02 主路径达标（格式契约盲区另见 P3-17）。
9. **dsh 升级主链路完整**：staging 先闭包安装后原子替换（数分钟安装期任意中断都发生在 staging 线上不动）；tarball sha512 + 解压版本一致性 + 闭包后版本三重校验；install-post 自检用与真实启动相同的 Electron Node 运行时；失败回滚完备、wasReady 自动恢复、二次回滚到原版本再启。
10. **菜单/Tray/关于符合规格**：F-01/F-02/F-03 结构达标；tray 未 setContextMenu 使 click/right-click 可区分；about 版本来源可信（app.getVersion + 实际运行包 package.json），渲染端全 textContent 注入、sandbox/contextIsolation 全开。
11. **release public 模式达标（K-01/K-02/K-03 成立）**：公开判定显式 -R + 大小写归一化 + 3 次重试 + 失败宁中止绝不静默烤 token；手写 app-update.yml 在签名之前落盘遵守 codesign seal 顺序；sha512 hex→raw→base64 与 electron-builder 格式一致；url 纯文件名；dmgbuild 带 Applications link/背景/settings.json；spctl 终验收口。
12. **preload 暴露面最小化**：contextIsolation+sandbox+nodeIntegration:false；全 channel 白名单 + 入参类型校验/钳制；executeJavaScript 注入值全部 JSON.stringify 或白名单枚举，无 fs/shell 能力外泄。
13. **notify-watch 无泄漏**：单例 watcher 幂等启停、代际比对防重复重连、seenRpc LRU 上限 512、titles/subagents 由 session-removed 清理。
14. **宽度持久化四道钳制一致**：生成期/拖拽期/IPC/启动读取统一 240~640 取整；损坏 JSON→null→回退默认 320，E-08 边界 OK。

---

## 五、结论与发布建议

1. **无 P0，可以发布的技术前提下仍有明确优先级**：
   - 第一梯队（收益最高）：P1-4 settings.yaml 覆写丢失（用户配置不可逆损失）、P1-1 SIGKILL 迟到误报（波及升级/插件/退出全链路状态机）；
   - 第二梯队（改动极小）：P1-3 升级 kill -9 自愈死角、P1-5 Tray 语义反转；
   - 第三梯队：P1-2 及各 P2 按模块排期。
2. **发布验收前必须对齐 QA 文档两处规格漂移**：
   - B-03「自动重启」不存在，实际是错误反馈 + 手动重试（P2-A1）；
   - G-01「查询失败按钮保持隐藏」与 G-04「error 态重试」对同一 error 态的要求互相矛盾（P2-C1）。
3. **发布快速单补充项**（在 §6 Release Checklist 基础上建议追加）：
   - [ ] 断网冷启动观察顶栏是否出现无法解释的「重试」按钮（P2-C1 验证）；
   - [ ] GUI 场景以 nvm 环境验证插件安装失败文案的可理解性（P2-D5）；
   - [ ] CI 或纯净 bash 3.2 环境预演 release-mac.sh（P2-F1）。
4. **回归脚本补强建议**：regression-tray 补 F-06「已展开则只聚焦」语义断言；regression-topbar 补检查失败（version:null）时按钮可见性断言；新增“pkgDir 移除 + bak 残留”的自愈模拟用例（对应 P1-3）。

> 本报告由对抗式只读审查产出，所列建议均为描述性方向，未对代码做任何修改。
