#!/usr/bin/env node
"use strict";

/**
 * doctor.js — 环境诊断脚本。首次运行 `npm start` 之前,先跑 `npm run doctor`,
 * 它会检查 dsh、Node、Electron、端口是否就绪,并给出修复建议。
 *
 * 用法: npm run doctor
 */

const { spawnSync } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.DSH_APP_PORT) || 3260;
const chalk = { green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` };
let failed = false;

function check(name, ok, detail, fix) {
  if (ok) console.log(`  ${chalk.green("✓")} ${name}${detail ? chalk.dim(" — " + detail) : ""}`);
  else {
    failed = true;
    console.log(`  ${chalk.red("✗")} ${name}${detail ? chalk.dim(" — " + detail) : ""}`);
    if (fix) console.log(`      ${chalk.yellow("修复:")} ${fix}`);
  }
}

function run(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000 });
    return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
  } catch {
    return { status: -1, out: "", err: "" };
  }
}

console.log("DSH Desktop 环境诊断\n");

// 1. Node
console.log(chalk.dim("[1/4] Node"));
const nodeV = process.versions.node;
const nodeMajor = Number(nodeV.split(".")[0]);
check("Node.js", nodeMajor >= 20, `v${nodeV}`, "需要 Node ≥ 20(推荐用 nvm 安装 LTS)");

// 2. dsh
console.log(chalk.dim("[2/4] dsh CLI"));
const { resolveDsh } = require("../src/main/dsh-server");
const resolved = resolveDsh();
if (resolved) {
  let version = "?";
  if (resolved.type === "script") {
    // 用当前 Node 跑 dsh --version(打包后 App 用内置 Node,效果等同)
    const v = run(process.execPath, [resolved.path, "--version"]);
    version = v.status === 0 ? v.out : `执行失败: ${v.err}`;
  } else {
    const v = run(resolved.path, ["--version"]);
    version = v.status === 0 ? v.out : `执行失败: ${v.err}`;
  }
  check(
    "dsh",
    version !== "执行失败",
    `${version} (${resolved.path})`,
    "确认 dsh 能正常执行"
  );
} else {
  check("dsh", false, "项目 node_modules 里没有 dsh", "运行 npm install");
}

// 3. Electron
console.log(chalk.dim("[3/4] Electron"));
const electronDir = path.join(__dirname, "..", "node_modules", "electron", "dist");
const electronOk = fs.existsSync(path.join(electronDir, "Electron.app")) || fs.existsSync(electronDir);
const v = electronOk ? run(path.join(__dirname, "..", "node_modules", ".bin", "electron"), ["--version"]) : null;
if (electronOk && v && v.status === 0) {
  check("Electron", true, v.out, "");
} else {
  check("Electron", false, "二进制未下载或损坏", "运行 node node_modules/electron/install.js");
}

// 4. 端口
console.log(chalk.dim(`[4/4] 端口 ${PORT}`));
const free = awaitPort(PORT);
check("端口可用", free, free ? "" : "已有进程占用(可能是另一个 dsh 实例)", "换一个端口: DSH_APP_PORT=3261 npm start");

console.log("");
if (failed) {
  console.log(chalk.red("诊断未通过,按上面的建议修复后再试。"));
  process.exitCode = 1;
} else {
  console.log(chalk.green("全部就绪!运行 npm start 启动。"));
}

function awaitPort(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(false));
    socket.once("timeout", () => done(true));
    socket.once("error", () => done(true));
    socket.connect(port, "127.0.0.1");
  });
}
