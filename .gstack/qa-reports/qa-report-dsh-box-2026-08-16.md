# QA 报告 — DSH Box (dsh-box) /qa 修复轮

- **日期**: 2026-08-16
- **分支**: main(基线 8c4c33b → 修复后 98259e7,10 个原子提交)
- **模式**: /qa Standard 档(修复 critical + high + medium)
- **健康分**: **79/100 → 96/100**(+17)

## 修复摘要

| Issue | 严重度 | 状态 | Commit | 回归测试 |
|---|---|---|---|---|
| ISSUE-001 关窗重开卡加载页、注入丢失 | HIGH | ✅ verified | `a961cda` | `scripts/regression-reopen.js` ✅ |
| ISSUE-002 加载页「服务启动失败」常显 | HIGH | ✅ verified | `8d2d45a` | `scripts/regression-loading-visibility.js` ✅ |
| ISSUE-003 端口占用误判就绪、加载假服务 | MEDIUM | ✅ verified | `33dd9a9` | `scripts/regression-port-conflict.js` ✅ |
| ISSUE-004 URL 前缀匹配信任边界绕过 | MEDIUM | ✅ verified | `198a12a` | `scripts/regression-url-guard.js` ✅ |
| ISSUE-005 dsh 崩溃时 UI 无错误反馈 | MEDIUM | ✅ verified | `98259e7` | `scripts/regression-crash-feedback.js` ✅ |

全部 5 个修复均通过真实 Electron 驱动复验 + 回归测试;`npm run smoke` / `smoke:e2e` / `test:theme` 无回归。

## 各修复说明

### ISSUE-001 — 关窗重开(verified)
- **根因**: `installWebUIInjection()` 与注入只在第一个窗口的 webContents 上注册一次;`server.on("ready")` 只触发一次,重开窗口无人导航。
- **修复** (`src/main/main.js`): 注入改到 `createWindow()` 内按窗口注册;服务已就绪时新窗口直接 `loadURL(server.url)`,否则走加载页等 ready。
- **验证**: 重开窗口 URL=`http://127.0.0.1:3301/`(WebUI),`pointerGuard=true`、`themeWatcher=true`。

### ISSUE-002 — 加载页 hidden 契约(verified)
- **根因**: 作者样式 `.error/.loading { display:flex }` 覆盖 UA 的 `[hidden] { display:none }`,错误与加载动画永远同时可见。
- **修复** (`src/renderer/style.css`): 新增 `[hidden] { display: none !important; }`。
- **验证**: 初始/错误/加载三态 computed display 均正确。

### ISSUE-003 — 健康检查身份校验(verified)
- **根因**: `_waitReady` 对端口上任意 2xx 服务都判就绪。
- **修复** (`src/main/dsh-server.js`): 首页必须含 `__DSH_BOOT__` 标记才算就绪;子进程提前退出(如 EADDRINUSE)立即失败,不等 60s。
- **验证**: 假服务占端口 → 0 个视图加载假页面,加载页进入错误状态,错误信息含「端口 3302 可能被占用」。

### ISSUE-004 — URL 信任边界精确匹配(verified)
- **根因**: `startsWith` 前缀匹配可被 `http://127.0.0.1:3260@evil.com/`(userinfo)与 `http://127.0.0.1:32600/`(端口前缀)绕过。
- **修复**: 新增 `src/main/url-guard.js`(`new URL()` 精确比对 origin);`will-navigate`、`did-finish-load` 注入判断、权限 handler 全部接入;空 requestingOrigin 的内部检查放行。
- **验证**: 9 组 URL 用例 + file:// 信任用例全部符合预期。

### ISSUE-005 — 崩溃反馈闭环(verified)
- **根因**: 错误只广播给加载页;dsh 运行中崩溃时加载页没在显示,用户面对死页面。
- **修复** (`src/main/main.js` + `src/renderer/renderer.js`): 主进程维护 `lastError` 并随 `getInfo()` 下发;`exited` 时若内容视图正显示 WebUI 则切回加载页;加载页加载时拉取错误状态立即呈现。
- **验证**: SIGKILL dsh → 自动切回加载页并显示「dsh 服务意外退出 (code=null, signal=SIGKILL)。点击重试重新启动。」→ 点重试 → WebUI 重新加载。

## 健康分明细

| 类别(权重) | 基线 | 修复后 | 说明 |
|---|---|---|---|
| Console (15%) | 100 | 100 | WebUI 0 错误(唯一告警来自 dsh 前端 CSP,第三方) |
| Links (10%) | 90 | 100 | 外链处理随窗口注册(ISSUE-001) |
| Visual (10%) | 60 | 100 | ISSUE-002 修复 |
| Functional (20%) | 60 | 100 | ISSUE-001/003 修复 |
| UX (15%) | 69 | 97 | ISSUE-005 修复;第二实例静默退出(低)未修 |
| Performance (10%) | 80 | 80 | 打包体积 495MB 未动 |
| Content (5%) | 94 | 94 | README 内缩 8px/4px 不一致(低)未修 |
| Accessibility (15%) | 90 | 90 | 未发现新问题 |

## 遗留(Standard 档已标记 deferred,均为 LOW/INFO)

1. 第二实例静默退出无用户提示(锁被占时只打日志)——建议后续加弹窗/激活已有窗口。
2. 全局锁 PID 复用误判、锁目录可被本机进程 DoS——建议锁里带启动时间戳校验。
3. `dist/` 残留旧配置产物(8-14 构建的 `DeepSeek Harness-*.dmg/.zip`、旧 `builder-effective-config.yaml`),发布前清理,防误发旧包。
4. `"@deepseek-ai/dsh": "^0.1.0-rc.6"` 预发布 caret 范围,`npm install` 可能漂移到更新 rc——建议锁 exact。
5. README 第 52 行「内容区内缩 8px」与代码 `CONTENT_INSET=4` 不符(第 56 行正确)。
6. 顶栏右侧「功能入口区域」占位文案可见。
7. 打包版菜单含 reload / toggleDevTools(开发者友好,最终用户非必需)。
8. 未签名 + `hardenedRuntime:false` + 未公证(路线图已声明);`asar:false` 代码明文(可接受)。
9. 打包体积 ~495MB(Electron 275MB + node_modules 219MB)。

## 测试基建

- 新增 `npm run test:regression`(5 个回归脚本,沿用项目现有 node/electron 脚本惯例,零新依赖)。
- 覆盖:窗口生命周期(重开)、加载页 CSS 契约、端口冲突、URL 信任边界、崩溃恢复。
- 测试产物: `.runtime/regression/`(gitignore);报告 `.gstack/qa-reports/`。

## 结论

5/5 问题修复并 verified,健康分 79 → 96,`smoke`/`smoke:e2e`/`test:theme` 全部通过,无回归。
