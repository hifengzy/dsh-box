# DSH Box

English | [简体中文](README.md)

A native macOS desktop app that wraps [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/).

## Introduction

- **Built entirely with DeepSeek Harness**: all code in this project was developed inside DeepSeek Harness.
- **An Electron-based shell for dsh**: wraps the DeepSeek Harness WebUI into a native macOS app, letting Harness run as a first-class native application with local filesystem access that browsers can't provide (child processes directly inherit macOS TCC permissions).
- **Version check & one-click upgrade**: proactively detects new DeepSeek Harness releases and supports one-click in-app upgrades (download → sha512 verification → atomic replace → automatic rollback on failure).
- **Bundled [dsh-market](https://github.com/dsh-market/dsh-market) plugin**: browse, search, install, update and uninstall community plugins.
- **Bundled [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) plugin**: enhanced sidebars for Harness (right panel / bottom panel / side cards).
- **dsh bundled in the app, works out of the box**: no need to install Node.js or dsh.

## Screenshots

| Main UI | Status Panel |
|:---:|:---:|
| ![Main UI](screenshot/1.png) | ![Status Panel](screenshot/2.png) |
| **Plugin Market** | **Side Cards & Bottom Panel** |
| ![Plugin Market](screenshot/3.png) | ![Side Cards](screenshot/4.png) |
| **Bottom Panel** | |
| ![Bottom Panel](screenshot/5.png) | |

## How It Works

The Electron main process spawns `dsh web` as a **child process** and loads the Harness WebUI in a `WebContentsView` with a custom top bar. dsh runs via `ELECTRON_RUN_AS_NODE` on the Electron runtime shipped inside the app, so users don't need Node.js. Since dsh runs as a local user process, its shell commands and file operations directly inherit macOS permissions (TCC) — something a browser-based setup cannot do, and the core value of this project. On first launch, grant the app file access in "System Settings → Privacy & Security".

## Architecture

```
┌────────────────────────────────────────────────┐
│  DSH Box.app (Electron)                        │
│                                                │
│  Main process src/main/main.js                 │
│    ├─ spawn ──→ dsh web child process (Node)   │
│    │               └─ spawn ─→ bash / shell    │
│    ├─ WebContentsView top bar (topbar)         │
│    ├─ WebContentsView content (loading → WebUI)│
│    └─ WebContentsView status panel (fallback)  │
│            ▲ contextBridge                     │
│            │                                   │
│        preload.js (minimal IPC bridge)         │
└────────────────────────────────────────────────┘
```

- `src/main/` — main process: dsh service hosting, window management, plugin management, version check & upgrade, tray.
- `src/preload/` — minimal contextBridge IPC bridge.
- `src/renderer/` — loading page, custom top bar, status panel fallback page, about page.
- `custom.css` — user style template injected into the WebUI (uncomment to apply).

## Features

- **dsh service hosting**: start, health check, crash reason feedback, graceful stop; isolated `DSH_HOME` separate from the browser WebUI; global single-instance lock.
- **Native look & feel**: hidden system title bar with a draggable custom top bar; inset rounded content area with vibrancy material; theme follows Harness light/dark setting.
- **Status panel**: service info, DSH & plugin version checks (badge alerts), notification settings, one-click dsh upgrade.
- **Plugin management**: one-click install/update of dsh-market / DSH-better-sidebar with outdated-version alerts.
- **System integration**: menu bar tray, system notifications, about page.

## Getting Started

Requirements: macOS 14+ (Apple Silicon), Node.js ≥ 20.

```bash
# Install dependencies (dsh is installed along with them)
npm install

# Environment check (optional)
npm run doctor

# Start the app
npm start
```

Packaging:

```bash
npm run dist        # Build .app + .dmg into dist/
```

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `DSH_APP_PORT` | `3260` | WebUI listening port |
| `DSH_BIN` | auto-detect | Explicit path to the dsh executable |
| `DSH_HOME` | app data directory | Harness data directory, isolated from the browser WebUI by default |
| `DSH_NPM_REGISTRY` | `https://registry.npmjs.org` | npm mirror for version checks/upgrades (e.g. npmmirror) |

## License

[MIT](LICENSE). DeepSeek Harness itself is also MIT (see its [repository](https://github.com/deepseek-ai/deepseek-harness/)).
