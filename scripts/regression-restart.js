#!/usr/bin/env node
"use strict";

/**
 * regression-restart.js — dsh 服务 stop→start 语义回归(真实子进程):
 *
 *   ISSUE: DshServer.stop() 曾只清 child 不清 ready,导致 main.js 的
 *   startServer() 防重入短路 `if (server.ready || server.child) return;`
 *   在「停止后想重启」时被跳过——插件安装/更新后服务不会自动拉起。
 *
 *   本测试真实启动 dsh web(隔离 DSH_HOME),验证:
 *     1. start() 后 ready === true;
 *     2. stop()  后 ready === false 且 child === null;
 *     3. 再次 start() 成功(ready === true)——等价于安装/更新后的自动重启路径;
 *     4. stop() 幂等安全。
 *
 * 用法: node scripts/regression-restart.js(纯 Node,不需要 Electron)
 */

const path = require("node:path");
const fs = require("node:fs");
const { DshServer, DEFAULT_PORT } = require("../src/main/dsh-server");

const HOME = process.env.DSH_RESTART_HOME || "/tmp/dsh-box-restart-test";
const PORT = Number(process.env.DSH_RESTART_PORT) || 3976;
const LOG_DIR = path.join(HOME, "logs");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

fs.rmSync(path.join(HOME, "profiles"), { recursive: true, force: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

async function main() {
  const server = new DshServer({ port: PORT });

  // 1. 首次启动
  await server.start({ dshHome: HOME, logDir: LOG_DIR });
  assert(server.ready === true, "start() 后 ready 应为 true");
  console.log("[1] 首次启动: ready=true ✓");

  // 2. 停止
  await server.stop();
  assert(server.ready === false, `stop() 后 ready 应为 false,实际 ${server.ready}`);
  assert(server.child === null, "stop() 后 child 应为 null");
  console.log("[2] 停止: ready=false, child=null(关键修复) ✓");

  // 3. 再次启动(模拟插件安装/更新后的自动重启路径)
  await server.start({ dshHome: HOME, logDir: LOG_DIR });
  assert(server.ready === true, "再次 start() 应成功就绪(修复前会被防重入短路跳过)");
  console.log("[3] 再次启动: ready=true(安装后自动重启路径打通) ✓");

  // 4. 停止幂等
  await server.stop();
  await server.stop(); // 二次 stop 不应抛
  assert(server.ready === false, "二次 stop 后 ready 应为 false");
  console.log("[4] 停止幂等安全 ✓");

  console.log("\nPASS ✓ dsh 服务 stop→start 语义回归通过");
}

main().catch((err) => {
  console.error("\nFAIL ✗ dsh 服务 stop→start 语义回归:", err.message);
  process.exit(1);
});