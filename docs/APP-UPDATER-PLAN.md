# DSH Box 应用自更新 — 开发 Plan

> 目标：DSH Box（Electron 壳）自身升级，端到端体验按用户设想：
> 启动后台查 GitHub Releases → 标题栏「新版本」标签按钮 → 点击下载
> （按钮即进度条：背景从左到右涂色 + 文案「下载中 n%」）→ 100% 涂满
> → 文案「安装」→ 点击安装（自动关闭 → 覆盖替换 → 自动重启）。
>
> 底层采用 `electron-updater`（macOS 上基于 Squirrel.Mac 的成熟替换/重启机制），
> UI 层自定义（不开默认对话框）。更新换代载体 = **zip**（mac 自动更新不支持 dmg）。

---

## 0. 现状与前提

- 当前无任何自更新机制：无 electron-updater、无 publish 配置、无签名/公证
  （`hardenedRuntime: false`，构建物未签名）。
- 构建：`electron-builder --mac`，target `dmg + zip`（zip 已具备 ✓）。
- 本 plan 是 **App 壳自更新**，与已有的「dsh npm 包升级」（A3: staging+原子替换+自愈）互不冲突，
  两套独立：前者在打包产物顶部跑，后者在开发仓库/app 内跑。
- **dev 模式守卫**：`app.isPackaged === false`（dev-launch 克隆 Electron.app 跑仓库）时
  禁用自动更新检查，避免对非标准 bundle 路径误操作。

## 1. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 构建侧 | publish 配置 + 出包产物含更新元数据 | `dist/latest-mac.yml` 存在且可被本地静态服务提供 |
| M1 UI 状态机 | 顶栏「新版本」按钮全状态（mock 事件驱动） | 状态流转 + 涂色 0→100% 回归断言 |
| M2 下载闭环 | 真下载（本地 fake repo）+ 进度涂色 + 手动安装接管 | 下载完成→「安装」→（测试模式）安装回调触发 |
| M3 正式发布 | 签名 + 公证 + `--publish always` 自动传 Release | 从正式 Release 走通「查→下→装→重启」 |

## 2. 阶段任务

### Phase 0 — 构建侧（M0）

1. `package.json`：
   - 依赖新增 `electron-updater`（^6.x，与 electron 43 兼容）。
   - `build` 增加：
     ```json
     "publish": { "provider": "github", "owner": "hifengzy", "repo": "dsh-box" }
     ```
   - 保持 `mac.target: ["dmg", "zip"]`（dmg 供手动安装，zip 供自动更新）。
2. 版本号：沿用 package.json `version`（当前 0.1.0）；semver 语义，releases 只发正式版
   （electron-updater 的 `latest-mac.yml` 天然只聚合已发布资产，draft/prerelease 不会进入）。
3. 构建验证：`npx electron-builder --mac zip --publish never` → 检查
   `dist/mac-arm64/latest-mac.yml`（含 sha512/版本/文件清单）。
4. 本阶段不做签名/公证（见 Phase 4）。

### Phase 1 — 更新服务（main 进程）（M1 依赖）

新模块 **`src/main/app-updater.js`**（纯状态机，provider 可注入，便于单测）：

- 状态机：`idle → checking → available | up-to-date | error → downloading(percent, bytes) → downloaded → installing → error(可重试/忽略)`。
- 封装 electron-updater 事件汇流为统一状态 + 变更广播：
  - `checking-for-update` / `update-available(info)` / `update-not-available` / `error`
  - `download-progress({percent, transferred, total})` → 按钮涂色输入
  - `update-downloaded(info)` → 文案「安装」
- API（供 main.js 调用）：
  - `initAppUpdater({ checkOnStart })`：`app.isPackaged` 守卫；启动后节流检查一次
  - `checkForUpdates()` / `startDownload()` / `installUpdate()` → 内部调 autoUpdater
  - `getState()` / `onChange(cb)`（广播用）
  - `clearError()`、`ignoreVersion(v)`（可选「忽略此版本」，存 settings.yaml）
- 主要注入点：autoUpdater 实例可替换（fake 供回归），feedURL 可覆盖（测试用本地服务）。

`src/main/main.js` 接线：

- whenReady 后 `initAppUpdater`；`will-quit` 无特殊处理（electron-updater 离开前自行收尾下载）。
- IPC：
  - `dsh:app-update-state`（getter / 变更推送 `onAppUpdate`）
  - `dsh:app-update-check`（手动「检查更新」，菜单项）
  - `dsh:app-update-download`（点「新版本」→ 开始下载）
  - `dsh:app-update-install`（点「安装」）
  - `dsh:app-update-ignore`（忽略版本）
- 菜单：应用菜单「服务」组下加「检查更新…」（与 onOpenStatus 并列）。
- preload：`getAppUpdateState/onAppUpdate/checkAppUpdate/downloadAppUpdate/installAppUpdate/ignoreAppVersion`。

### Phase 2 — 顶栏「新版本」按钮 UI（M1）

`src/renderer/topbar.html/css/js`：

- 位置建议：`github` 与 `statusBtn` 之间（有更新时出现，隐藏时**不留空位**——
  按钮容器 `display:none`，出现时其他按钮保持原间距规则 4px/跨度 60，回归已有约束）。
- 状态渲染（桥/事件驱动，与既有 `onSidebar`/`onUpdateFlag` 同模式）：
  1. `available`：文案「新版本」，弱强调样式（描边 pill，品牌蓝点缀）
  2. `downloading`：文案「下载中 n%」+ **按钮背景按进度从左向右涂色**：
     - 实现：按钮 `position:relative`，内部绝对定位进度层 `width: calc(var(--app-update-progress, 0) * 1%)`，
       或 `background: linear-gradient(90deg, accent 0..n%, base n%..100%)`（用 CSS 变量切换，transition 平滑）；
       进度层 = 涂色层 = 按钮背景（100% 时恰好涂满按钮）。
  3. `downloaded`：文案「安装」，主按钮样式（反白填充）
  4. `error`：文案「重试」，点击回到 available 分支重下；tooltip 显示错误原因
  5. `installing`：文案「安装中…」，禁用
- 深色/浅色适配走既有 `--bar-*` token；红点（dsh npm 包更新 dot）与新按钮互不干扰
  （红点在 statusBtn 上，新按钮是独立元素）。

### Phase 3 — 下载与安装闭环（M2）

1. 下载：`startDownload()` → `autoUpdater.downloadUpdate()`（后台），`download-progress`
   实时喂 `--app-update-progress`（0~100）与文案。
2. 安装：`installUpdate()` → `autoUpdater.quitAndInstall()`（Squirrel 机制：
   退出前 spawn helper → 替换 .app → 重启）。按用户设想为**手动触发**（不自动装）。
3. 失败处理：下载网络错误 → error 态 + 按钮「重试」；`quitAndInstall` 前如有
   `update-downloaded` 事件缺失/异常 → 提示重新下载。
4. 用户数据：只替换 /Applications 下的 .app，`~/Library/Application Support/DSH Box`
   不受影响（升级前不触碰用户数据，天然成立）。

### Phase 4 — 签名/公证 + 发布流程（M3，正式发布配套）

1. Developer ID Application 证书 + 公证：
   - electron-builder `mac.notarize`（或 `afterSign` + @electron/notarize）；环境变量
     `CSC_LINK/CSC_KEY_PASSWORD/APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID`。
   - `hardenedRuntime: true` + entitlements（应用内 dsh/LS 权限不受影响，按当前 TCC 场景配置）。
2. 发布脚本：`"dist:publish": "electron-builder --mac --publish always"` →
   自动创建/更新 GitHub Release 并上传 `zip/dmg/latest-mac.yml`。
3. 本地验证链（未签名阶段即可跑通的功能验证，签名后重复）：
   - 下载 zip → 清 quarantine（`xattr -dr com.apple.quarantine <app>`，开发机测试用）→ 替换 → 重启。
4. 可选 CI：GitHub Actions tag 触发构建+签名+发布（本 plan 列为后续项，不阻塞 M2 验收）。

### Phase 5 — 测试与回归

- 单测 `scripts/regression-app-updater.js`（新建，纯 Node）：
  - fake autoUpdater 注入 → 状态机全路径（可用→下载中 0/50/100 → 已下载→安装→error 重试→忽略）。
  - `initAppUpdater` dev 守卫（isPackaged=false 时不启动检查）。
- e2e `scripts/regression-app-update-live.js`（可选，本地 fake repo）：
  - 本地静态服务提供 `latest-mac.yml`（版本比本地高）+ zip；
  - 走：check → available → download（采样 progress>0）→ downloaded → 触发 install 回调（测试模式不真退出）。
- `check-main-integrity.js`：REQUIRED_MAIN_SNIPPETS 增 `initAppUpdater`/`dsh:app-update-install` 接入断言。
- `regression-topbar.js`：新按钮存在性 + 状态类切换 + 涂色 width 随 percent 变化 + 隐藏不留空位。
- 全量 `npm run test:regression` 保持 19+ 组全绿。

## 3. 关键决策点（已拍板 2026-08-24）

1. **按钮位置**：顶栏 「github」左侧，**与其保持不小于 30px 间距**（出现时插入）。
2. **手动安装**：下载完成后由用户点击「安装」（不自动装）。
3. **不做「忽略此版本」**。
4. **暂不签名**：走未签名验证方案（测试机清 `com.apple.quarantine`）；签名/公证列为 PR-3 后续项（需要 Apple Developer 证书）。
5. 网络：先 GitHub 直连（feedURL 可覆盖，镜像/CDN 为后续项）。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| mac 自动更新只支持 zip | 发布物始终带 zip（已有）；dmg 仅手动安装 |
| 未签名 → Gatekeeper 拒启 | 正式版必须签名+公证；测试机清 quarantine |
| dev 模式误触发更新 | `app.isPackaged` 守卫 + 测试用 fake/本地 feed |
| 替换后签名变化 | electron-updater 直接用构建产物（签名随包一致） |
| GitHub 拉取失败/慢 | error 态可重试；feedURL 可覆盖为镜像/CDN |
| quitAndInstall 在异常环境失败 | 保留 update-downloaded 后手动重装入口；失败提示重下 |

## 5. 交付顺序（建议按里程碑切 PR）

1. PR-1（M0+M1）：构建 publish 配置 + app-updater 状态机 + 顶栏按钮全状态（本地 fake 事件可演示）
2. PR-2（M2）：真下载闭环（本地测试 repo 验证进度涂色 + 安装接管）+ 回归
3. PR-3（M3）：签名/公证 + 发布脚本 + 正式 Release 验收

---

*配套文档：docs/PERMISSIONS.md（TCC/权限场景）、README.md（顶栏/面板设计）。*