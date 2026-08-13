# DeepSeek Harness for macOS (dsh-macos)

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 封装成**原生 macOS 桌面 App**(基于 Electron)。

> 目标:相比在浏览器里用 Harness 的 WebUI,桌面 App 能让 Harness 以**原生应用的身份**运行,从而获得更完整的**本地文件系统权限与操作能力**——这是浏览器做不到的。原理见 [docs/PERMISSIONS.md](docs/PERMISSIONS.md)。

## 快速开始

环境要求:macOS 14+(Apple Silicon,本项目按 M4 Pro 开发)、Node.js ≥ 20、npm。

```bash
# 1. 安装 dsh CLI(全局,让 App 能找到它)
npm install -g @deepseek-ai/dsh@^0.1.0-rc.6

# 2. 安装本项目依赖
npm install

# 3. 环境体检(可选但推荐)
npm run doctor

# 4. 启动 App
npm start
```

启动后,窗口先显示加载页,等 dsh 服务就绪后自动切换到 Harness WebUI(默认端口 `3260`,可用环境变量 `DSH_APP_PORT` 覆盖)。

## 架构

```
┌────────────────────────────────────────────────────┐
│  DeepSeek Harness.app (Electron)                   │
│                                                    │
│  主进程 src/main/main.js                           │
│    ├─ spawn ──→ dsh web 子进程 (Node)              │  ← 同一原生进程树
│    │               └─ spawn ─→ bash / shell        │     → 继承 App 的
│    ├─ 轮询 HTTP 就绪后加载 WebUI                   │       macOS 权限(TCC)
│    └─ BrowserWindow (加载页 → WebUI)               │
│            ▲ contextBridge                         │
│            │                                       │
│        preload.js (最小 IPC 桥,不暴露 Node)         │
└────────────────────────────────────────────────────┘
```

- **主进程** (`src/main/`) 负责启动/停止 dsh 服务、管理窗口与权限。
- **dsh-server.js** 把 `dsh web` 作为子进程拉起:环境变量 `DSH_BIN` 或 PATH 里的 `dsh`;`DSH_HOME` 默认 `~/.dsh`,与命令行共用同一套 profile 和会话。
- **渲染进程** 只显示启动状态,真正的 UI 是 dsh 自己服务的 WebUI。

## 目录结构

```
src/
  main/
    main.js          Electron 入口:窗口、菜单、权限、生命周期
    dsh-server.js    dsh 子进程管理:启动、健康检查、优雅停止
  preload/
    preload.js       contextBridge 最小桥(getInfo / onStatus / retry)
  renderer/
    index.html       启动页(等待 dsh 就绪)
    renderer.js      启动页逻辑(状态渲染、重试)
    style.css
scripts/
  doctor.js          环境诊断:npm run doctor
  smoke.js           核心链路冒烟测试(纯 Node):npm run smoke
  make-icon.mjs      生成占位图标:npm run make-icon
assets/
  icon.png           应用图标(占位,1024×1024)
docs/
  PERMISSIONS.md     macOS 权限原理与配置(重点读这篇)
```

## 自检 / 测试

```bash
npm run doctor    # 环境体检:Node / dsh / Electron / 端口
npm run smoke     # 核心链路冒烟测试(纯 Node,不弹窗口)
npm run smoke:e2e # 完整 E2E:启动真实 App → 拉起 dsh → 加载 WebUI → 退出
```

> `smoke:e2e` 会短暂弹出应用窗口,并把临时数据放到 `.runtime/`(已 gitignore)。`--no-sandbox` 只用于测试环境(沙箱受限的 CI/容器)。

## 打包成 .app / .dmg

```bash
npm run dist        # 打包当前架构的 .app + .dmg (输出到 dist/)
npm run dist:dir    # 只生成解包后的 .app,最快
npm run dist:dmg    # 只生成 .dmg
```

打包产物在 `dist/`。打开 `DeepSeek Harness.app` 后,**需要先给它授予文件权限**(系统设置 → 隐私与安全性),具体见 [docs/PERMISSIONS.md](docs/PERMISSIONS.md)。

> 说明:目前 `hardenedRuntime` 为 `false`(未开启公证/签名)。发布到其他机器需要 Apple Developer 证书 + notarization,这是后续路线,见文末。

## 常用配置(环境变量)

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_APP_PORT` | `3260` | dsh WebUI 监听端口(避开开发常用的 3080) |
| `DSH_BIN` | 自动查找 | 显式指定 dsh 可执行文件路径 |
| `DSH_HOME` | `~/.dsh` | Harness 数据目录(profile/会话) |

## 常见问题

**`找不到 dsh 命令`**
运行 `npm run doctor` 看提示;然后 `npm install -g @deepseek-ai/dsh@^0.1.0-rc.6`,或设置 `DSH_BIN`。

**启动后一直停在加载页**
看日志:主进程终端会打印 `[dsh:err] ...`,完整日志在 `~/Library/Application Support/DeepSeek Harness/logs/`。最常见原因:端口被占用(换 `DSH_APP_PORT`)或 `~/.dsh` 里的 profile 配置损坏。

**WebUI 里执行 shell 命令没有权限(比如访问桌面/文档/下载)**
这是 macOS 的 TCC 限制,与 Harness 无关。按 [docs/PERMISSIONS.md](docs/PERMISSIONS.md) 给 App 授予「完全磁盘访问权限」即可——这是本方案相对浏览器的核心优势。

**关掉窗口后 App 还在后台?**
macOS 惯例:关窗不退出,点 Dock 图标重新开窗,dsh 服务保持运行(再次打开秒开)。要彻底退出:菜单栏 App 名 → 退出,或 ⌘Q。

## 路线图

- [x] Electron 壳:dsh 子进程托管 + WebUI 加载
- [x] 权限继承方案(进程树继承 TCC)
- [ ] 正式图标、关于页
- [ ] 打包签名 + notarization(hardened runtime)
- [ ] 自动更新
- [ ] 会话/Profile 管理界面(切换 DSH_HOME)

## 许可

MIT。DeepSeek Harness 本身是 MIT(见其[仓库](https://github.com/deepseek-ai/deepseek-harness))。
