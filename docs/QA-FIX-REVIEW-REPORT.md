# 对抗式 QA 修复 Review 报告

> Review 对象：[QA-FIXED-CHECKLIST.md](./QA-FIXED-CHECKLIST.md) 声明的全部修复（批 1 `b09f9c8` + 批 2a/2b `33861c4` + 批 3 `5e45740`）
> Review 方式：4 个子 Agent 并行只读核验，以当前 HEAD = `5520515`（工作树干净）代码为准，结合 `git show` 对照修复前后版本；每条裁定均附代码证据。
> 对照源：[QA-ADVERSARIAL-REPORT-v0.1.8.md](./QA-ADVERSARIAL-REPORT-v0.1.8.md)、[QA-ADVERSARIAL-VERDICT.md](./QA-ADVERSARIAL-VERDICT.md)

---

## 总览

| 裁定 | 数量 | 说明 |
|---|---|---|
| ✅ 通过 | **30** | 修复真实落地且实现正确 |
| ⚠️ 部分/有缺口 | **4** | 主体成立但有覆盖缺口或交互缺口 |
| ❌ 未生效 | **2** | **声称已修、实际不可达或半截修复（P1-3、P1-4）** |
| 📝 口径不符 | **3** | 清单描述与仓库实际不符（单测不存在、断言未补、文件引用勘误） |
| ✅ 误报裁定核实 | 1 | P1-5 误报裁定经 git 历史比对**确认成立** |

**总体结论：修复质量整体较高（30 项实质落地，含两个曾引发回归的坑 P3-17⑥/⑦ 已正确闭合），但存在 2 个「声称已修、实际未生效」的重大偏差——P1-3 自愈是死代码且首段必抛 TypeError，P1-4 只改了 box-settings 未改 plugin-manager——这两项正是原始报告里后果最重的两项，建议发布前必修。**

---

## 一、重大发现（发布前必修）

### 1.1 P1-3 修复未生效：healInterruptedUpgrade 是死代码，且首段必抛 TypeError 【❌ 高】

**两个独立缺陷，任一都足以让自愈完全失效：**

**缺陷 A —— 自愈函数从未被调用。**
`healInterruptedUpgrade` 在 src/ 中只有定义（[main.js:608](../src/main/main.js)），全文件无任何调用点；whenReady 主链（main.js:1876-1928）未接入。`git log -S healInterruptedUpgrade` 显示该函数自初次引入起**历代都只有定义行，从未有调用行**——修复批重写了函数体，但没接线。
讽刺的是 [check-main-integrity.js:55](../scripts/check-main-integrity.js) 的「升级启动自愈接入」静态检查用 `/healInterruptedUpgrade/` 匹配 main.js，**定义本身即命中**，检查形同虚设，这正是它漏网的原因。

**缺陷 B —— 即使补上调用，函数体第一段必抛 TypeError。**
[bundledDshPath()](../src/main/dsh-server.js#L103-L112) 返回**数组**，而 [main.js:617](../src/main/main.js) 写的是：

```js
const bundled = bundledDshPath();   // 数组!
let dir = path.dirname(bundled);    // path.dirname 不接受数组 → ERR_INVALID_ARG_TYPE
```

实测该异常被 main.js:677 的 catch 吞掉，只打一条「启动自愈检查跳过」日志就返回。

**实际后果**：kill -9 双 rename 窗口场景在 HEAD 的行为 = **修复前原样**——内置目录缺失时 [resolveDsh](../src/main/dsh-server.js#L143-L156) 照样落到 `which dsh` 静默跑用户全局 dsh，原始缺陷完全敞开。

**回归为何没拦住**：[regression-upgrade.js:228-249](../scripts/regression-upgrade.js) 用例 9 只测「自愈部件」（verifyDshBoot / findNewestBackup / restoreDshBackup 单件直调），从未以坏态拉起 App 验证 heal 编排。

**修复方向**：① 在 whenReady 主链（startServer 之前）接入 `healInterruptedUpgrade()`；② `bundled` 改为遍历数组候选（如 `bundledDshPath().find(p => fs.existsSync(path.dirname(p)))`）；③ check-main-integrity 的正则改为匹配「调用点」而非「标识符出现」。

### 1.2 P1-4 半截修复：plugin-manager.js 未改造，settings.yaml 数据丢失风险未闭合 【⚠️ 高】

- **[box-settings.js](../src/main/box-settings.js) 已正确改造 ✅**：读失败 `code !== "ENOENT"` 中止写入返回 false（:71-79）；tmp+rename 原子写 + 失败清理（:122-132）。
- **[plugin-manager.js](../src/main/plugin-manager.js) 完全未动 ❌**（原始报告 P1-4 明确点名的第二处，批 1 diff 未触碰该文件）：
  - [:222-224](../src/main/plugin-manager.js) 仍是 `catch { lines = []; }`——任何读失败（含 EIO/权限）都被当空文件全量覆写；
  - [:265](../src/main/plugin-manager.js) 仍是 `writeFileSync` 直写非原子。
- **后果**：settings.yaml 三个写者中两个已原子化（box-settings、dsh 外部 rename），plugin-manager 成为**唯一非原子写者**，可与 rename 原子写竞争造成丢写/覆盖，数据丢失模式与 P1-4 原文一致。

**📝 清单口径不符**：清单验证栏与批 1 commit message 均声称「box-settings 行为单测」，但全仓库（排除 node_modules）检索不到该测试——**单测未随仓库提交**。

**附带缺口**：`writeSettingBool/Value` 共 4 处设置类 IPC 调用（main.js:1623/1655/1676/1685）忽略 false 返回，写失败时 IPC 恒回 `ok:true`——内存态已翻转、磁盘未持久化，UI 与磁盘分叉无用户可见反馈（低危，未闭环）。

### 1.3 清单口径与仓库不符的另外两处 【📝】

| 项 | 清单声明 | 仓库实际 |
|---|---|---|
| P1-5 测试补强 | 「采纳测试建议，regression-tray 补语义断言」 | `git log b09f9c8^..HEAD -- scripts/regression-tray.js` 为空，[4b] 仍只断言 `statusCalled !== 1`，「已展开则只聚焦」断言未补 |
| P3-12 文件引用 | （沿用原报告）`status-ui-inject.js:104` 的 2s 轮询 | 该轮询自始就在 [plugin-ui-inject.js:104](../src/main/plugin-ui-inject.js)，status-ui-inject.js 修复前后均无 setInterval——原报告引用勘误（不影响修复本身，light-dark 已正确落地） |

---

## 二、逐项核验裁定

### 2.1 P1 组（4 修 + 1 误报）

| 编号 | 裁定 | 核验要点 |
|---|---|---|
| P1-1 | ✅ | [dsh-server.js:296-314](../src/main/dsh-server.js)：exit 处理器消化复位 stopping（`if (this.stopping) { this.stopping = false; return; }`）+ 代际防线 `this.child !== child`（:309）；stop() 尾部不再复位（批 1 diff 确认删除）。推演 SIGKILL 迟到场景不再 emit exited；stop→start 边界由代际防线拦截，无串扰 |
| P1-2 | ✅ | [dsh-server.js:328-335](../src/main/dsh-server.js)：catch 内先 `await stop()` 清理，随后「服务已停止」分支在 START_TIMEOUT 包装与 emit(error) **之前** return——不包装、不广播，与 stopped 终态不再竞态 |
| P1-3 | **❌** | **见 §1.1**：死代码 + 必抛 TypeError，kill -9 场景行为与修复前一致 |
| P1-4 | **⚠️** | **见 §1.2**：box-settings ✅ / plugin-manager ❌ / 声称的单测 📝 不存在 / 调用方返回值半闭环 |
| P1-5 | ✅ 误报裁定成立 | **证据链完整**：`git show b09f9c8^:src/main/main.js`（审查时点代码）第 682-690 行 sidebarState() 注入分支确实返回 `{ open: statusPanelOpen, canOpen: true }`——与原报告「恒 false」矛盾，原报告举证引用失实；`git log -S sidebarState` 显示该函数最后一次改动是 QA 报告之前的 feature 提交，三个修复批零触碰——**不是修复顺带改的，误报裁定成立**。但清单声称的 regression-tray 语义断言未兑现（见 §1.3） |

### 2.2 P2 组

| 编号 | 裁定 | 核验要点 |
|---|---|---|
| P2-A2 | ✅ | [main.js:695-766](../src/main/main.js)：`serverStartPromise` 共享防抖 + `.finally` 清理（成功/失败/异常三路都清，无永久卡死） |
| P2-A3 | ✅ 部分如实 | did-fail-load 兜底确实未修；「菜单无 reload」误判核实属实：[menu.js:104](../src/main/menu.js) `role: "reload"` 存在（:105 还有 forceReload） |
| P2-A4 | ✅ | [main.js:362-376](../src/main/main.js)：statusPanelOpen/statusInjectBroken/lastPluginPanels/lastError/portMovedFrom 五项全复位，无缺漏 |
| P2-A6 | ✅ | [dsh-server.js:450](../src/main/dsh-server.js)：模板字符串 `\\.` 产生字面 `\.`，spawnSync 不经 shell 逐字传达，pgrep ERE 收到 `bin\.js` |
| P2-B1 | ✅ | [main.js:779-790](../src/main/main.js) waitContentReload：10s 超时 + once(did-finish-load) + clearTimeout。竞态推演：ready 事件先于 start() resolve，故 `await restartServer()` 恢复时新导航必已发起（isLoading=true 进入等待），did-finish-load 是渲染事件不可能抢先——**不会错过也不会提前返回**。两处调用点（:1221/:1269）覆盖插件与市场 |
| P2-B4 | ✅ | [status-ui-inject.js:1230-1262](../src/main/status-ui-inject.js)：setPointerCapture 使 pointercancel/lostpointercapture 可达，onUp 复用清 4 类监听 + 属性，无二次触发 |
| P2-C2 | ✅（残留权衡见 §3-2） | up-to-date 清 version（:99）、DOWNLOAD_FAIL_LIMIT=2 降级重查（:250-256）、404 清 version（:123-125）；回归 [2f0]-[2f8] 三路径全覆盖 |
| P2-C3 | ⚠️ | pruneBackups 正则匹配 bak+broken 保留 1 份 ✅（[dsh-upgrade.js:67-80](../src/main/dsh-upgrade.js)）；调用点缺口：① 自愈路径两处调用随 P1-3 死代码不可达；② performUpgrade 兜底回滚（main.js:1108-1122）成功后**未**调 pruneBackups——清单「调用点扩展到回滚路径」在此路径遗漏。另有排序瑕疵：文件名字典序按版本前缀主导，跨版本时「最近 N 份」语义漂移 |
| P2-C4 | ✅ | [main.js:1934-1950](../src/main/main.js)：preventDefault → await stop → finally 置位 + app.quit()，二次 will-quit 放行，应用可正常退出；quitCleanupDone 为进程内闭包变量无残留 |
| P2-C5 | ✅（交互缺口见 §3-1） | DOWNLOAD_STALL_MS=90s 可注入（:42/:70）；定时器创建/解除路径完整（首个真实进度、下载抛错、promise 结束三路解除）；0% 进度事件不清除符合声明口径 |
| P2-D3 | ✅（低危备注） | [main.js:352-360](../src/main/main.js)：did-navigate 同源校验，异源 console.warn + 强制回跳；同源判断走 url-guard 解析式比对；回跳后同源不再加载，**不会自循环**。备注：若服务自身 30x 异源会形成回跳往复，无计数/阻尼（本地威胁模型内低危）。statusView/topBarView 已有 guardLocalViewNavigation 覆盖，未加 did-navigate 合理 |
| P2-D4 | ✅ | 三处 IPC（main.js:1521/1544/1603）均已收窄为 `(?:[-+][0-9A-Za-z.-]+)?`，旧式宽匹配无残留 |
| P2-B6 | ✅ 设计使然记录属实 | sidebarState 注入分支 canOpen:true 为注释自述的既定设计 |

### 2.3 P3 组

| 编号 | 裁定 | 核验要点 |
|---|---|---|
| P3-01 | ✅ | 尾部 200KB 读取（min(size,200K)）；<200KB 全读；截断处残行因 `^Error:` 行首锚定宁漏不误；fd 条件关闭无 ReferenceError |
| P3-02 | ✅ 覆盖 | 由 P2-C4 同一修复覆盖，与清单口径一致 |
| P3-03 | ✅ 误报属实 | showMessageBox 首参 null 合法（清单裁定与代码一致） |
| P3-04 | ✅ | logDir 失败回退 os.tmpdir()（main.js:711-719）+ whenReady 链尾 .catch（:1924-1928） |
| P3-05 | ✅ | 超时/无 code 重探一次（:497-519），重探被拒→空闲、仍异常→保守占用，语义闭环 |
| P3-06 | ✅ | 「立即退出」改 DSH_CRASHED 分流在 START_TIMEOUT 之前，保留可读原因；isPortConflict 单参无死参 |
| P3-07 | ✅ 记录合理 | 本地伪造需代码执行权限，威胁模型外，记录不改合理 |
| P3-08 | ✅ | 中间消息改「正在尝试改用端口 X…」进行时措辞（main.js:732-735）；console.log 仍结论式但属主进程日志可接受 |
| P3-09 | ✅ | 粗估摆位 → scrollWidth+20 实测回校 → 钳制 40~260；回校只 setBounds 自身、无二次回读，**无循环风险** |
| P3-10 | ✅ | 每次 tooltip-show 先 addChildView 重新入栈（try/catch 兜底），statusView 遮盖场景由下次 show 自愈 |
| P3-11 | ✅ | resize 时 setBounds 置零隐藏（main.js:302-308） |
| P3-12 | ✅ | `color: light-dark(rgb(180,122,18), rgb(247,173,49))`（status-ui-inject.js:539-540）；2s/800ms 轮询的设计注释确实存在（plugin-ui-inject.js:101-104/:332-338） |
| P3-13 | ✅（清理残留） | 常量已删；check-dsh-narrow.js 头尾注释已同步。残留：[regression-sidebar-layout.js:18](../scripts/regression-sidebar-layout.js) 死导入 `CONTENT_MIN`（现 undefined，不报错）；check-dsh-narrow.js:11 与 README.md:122 旧名引用未清 |
| P3-14 | ✅ | pendingNotifies 队列 + takeNotifies 全量消费，连续 3 次检查每个都弹窗；autoInstallOnAppQuit=false（:155）带动机注释。缺口：回归只断言 autoDownload，autoInstallOnAppQuit 无断言 |
| P3-15 | ✅ | 缺 integrity 时 console.warn 留痕（dsh-upgrade.js:49-54） |
| P3-16 | ⚠️ | DMGBUILD glob ✅（多版本缓存时 head -1 取字典序首个，小瑕疵）；e2e app.quit() ✅；**EXDEV 降级有边缘缺口**：cpSync 半截失败且 package.json 已拷入时，调用方回滚条件 `!existsSync(pkgDir/package.json)` 不成立→既不清理半截目录也不恢复备份，却报「已回滚」（叠加自愈死代码，此场景无自动恢复） |
| P3-17 | ✅ 七子项全落地 | ① ensureOpenByDefault 返回值检查+warning（main.js:1207-1218）② theme 契约解析失败警告留痕 ③ npm-check tmp+rename+清理 ④ notify-watch `readyState !== 3` 才跳过（CONNECTING 一律 close）⑤ 提示音 800ms 节流（main.js:1338-1345）⑥ **回归重点已验证**：三处正则同时具备 escapeRegExp 转义与 `:` 冒号（box-settings.js:35/38/106），首启误展开根因消除 ⑦ **回归重点已验证**：guardLocalViewNavigation 定义于 main() 顶层（main.js:235-245）+ 两调用点可达（:271/:918），无 createWindow 内残留定义 |
| 额外实修 4 bug | ✅ | 崩溃回归卡死（守卫作用域）、首启 seeded 失败（冒号）、plugin-live 断言改造、crash-reason 断言更新——均与当前代码状态吻合 |

### 2.4 未修项现状确认

P2-B5 / P2-D1 / P2-D2 / P2-D5 / P2-E1 / P2-E2 六个未修编号逐一到代码核实，**均与清单「未修」声明一致**（portMovedFrom 仅兜底面板展示、url-guard file:// 前缀信任仍在、fail-open 兜底仍在、spawnSync 仍在、KEYCHAIN_PW 默认 "verify" 仍在）。

---

## 三、修复引入/暴露的新问题（按风险排序）

| # | 风险 | 问题 | 位置 |
|---|---|---|---|
| 1 | 高 | **P2-C5 × P2-C2 交互缺口**：停滞超时经 `setState("error")` 直达，不经过 `au.on("error")` → downloadFailures 不递增。黑洞网络下每次 retry 都满足 `version && downloadFailures < 2` 永远走重下（90s 一轮），**2 次降级机制对停滞型失败永不生效** | [app-updater.js:210](../src/main/app-updater.js) |
| 2 | 中 | **EXDEV 半截拷贝回滚条件失真**：package.json 先拷入后半截失败 → 回滚条件不成立，报「已回滚」但现场无法自愈 | [dsh-upgrade.js:267-275,397-408](../src/main/dsh-upgrade.js) |
| 3 | 低 | dsh-server **error 处理器缺代际防线**（exit 有 `this.child !== child`，error 没有）：stop→start 后旧 child error 迟到会清空新 child 引用（触发条件苛刻，建议补对称判断） | [dsh-server.js:315-325](../src/main/dsh-server.js) |
| 4 | 低 | 旧 child 迟到 exit 无条件写 `this.childExitCode`，跨代际可污染新代 `_waitReady` 的快速失败判断（理论窗口极窄） | [dsh-server.js:298](../src/main/dsh-server.js) |
| 5 | 低 | 设置类 IPC 忽略 writeSetting false 返回，恒回 `ok:true`，UI 与磁盘分叉无反馈 | main.js:1623/1655/1676/1685 |
| 6 | 低 | performUpgrade 兜底回滚成功后未调 pruneBackups（清单「回滚路径」声明在此遗漏）；备份排序按字典序、跨版本语义漂移 | main.js:1108-1122、dsh-upgrade.js:67-80 |
| 7 | 低 | P2-C2 残留权衡：update-available 重置计数器并重设 version，feed 仍列版本但资产损坏时可形成用户驱动循环（每轮需点击，非自动死循环——原「永不重查」缺陷已防住） | app-updater.js:92-93 |
| 8 | 低 | did-navigate 回跳无阻尼：服务自身 30x 异源时回跳往复（本地威胁模型内低危） | main.js:352-360 |
| 9 | 低 | 回归覆盖缺口：autoInstallOnAppQuit=false 无断言；regression-upgrade 未测 heal 编排（正是 P1-3 漏网原因）；notify 队列多回调并发未显式覆盖 | scripts/ |
| 10 | 低 | CONTENT_MIN 删除的清理残留：regression-sidebar-layout.js:18 死导入；check-dsh-narrow.js:11、README.md:122 旧名引用 | scripts/、README |

---

## 四、结论与建议

### 4.1 总体评价

- **30 项修复实质落地且质量良好**，尤其两个修复过程中曾引发回归的坑（P3-17⑥ 冒号、P3-17⑦ 守卫作用域）已在最终提交中正确闭合；P2-B1 waitContentReload 的竞态推演、P1-1 的代际防线设计均属正确实现。
- 但 **P1 级两项存在「声称已修、实际未生效」**：P1-3 自愈从未接线且首段必抛异常（check-main-integrity 静态检查被定义本身骗过）、P1-4 只修了三个写者之一。这两个编号恰是原始报告中后果最重的项，**当前 HEAD 的 kill -9 双 rename 场景与 settings.yaml 数据丢失风险面与修复前基本一致**。
- 清单存在 3 处口径与仓库不符（单测不存在、regression-tray 断言未补、P3-12 引用勘误），建议同步修订清单，避免后续 review 基于失实声明。

### 4.2 发布前必修（P0 级行动项）

1. **接线 P1-3**：whenReady 主链（startServer 之前）调用 `healInterruptedUpgrade()`；修复 `bundledDshPath()` 数组误用（遍历候选取 dirname）；check-main-integrity.js 的自愈接入检查改为匹配调用点（如 `/^\s*(?:await\s+)?healInterruptedUpgrade\(\)/m`）。
2. **补齐 P1-4**：plugin-manager.js 的 ensureOpenByDefault 同等改造（非 ENOENT 读失败中止 + tmp+rename）；将声称的 box-settings 行为单测真实提交入库。
3. **补停滞超时与失败计数的联动**：停滞转 error 时递增 downloadFailures（或在停滞回调里走与 au error 相同的分流），否则黑洞网络下降级机制失效。
4. **regression-upgrade 补编排级用例**：以「pkgDir 缺失 + bak 残留」坏态拉起 App 断言自愈生效（这是唯一能拦住 P1-3 类漏网的手段）。

### 4.3 后续排期建议

- EXDEV 半截拷贝的回滚条件修正（拷贝前移除/后置 package.json 判定标记）；
- dsh-server error 处理器补代际防线（与 exit 对称一行）；
- performUpgrade 兜底回滚路径补 pruneBackups；
- 未修的 6 个纵深项（P2-B5/D1/D2/D5/E1/E2）按原排期推进；
- 修订 QA-FIXED-CHECKLIST.md 的 3 处口径偏差。

---

*本报告由 4 个只读核验子 Agent 产出，未修改任何项目文件。所有裁定均可通过文中文件:行号直接复核。*
