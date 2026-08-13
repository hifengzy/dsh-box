#!/usr/bin/env node
"use strict";

/**
 * smoke.js — 冒烟测试:验证「spawn dsh web → 健康检查 → 加载 → 停止」核心链路。
 *
 * 纯 Node 运行,不弹窗口,适合 CI / 开发自检。
 * 用法: node scripts/smoke.js
 *
 * 注意:DSH_HOME 指向工作区内的 .runtime/ 临时目录,避免污染 ~/.dsh。
 */

const path = require("node:path");
const fs = require("node:fs");
const { DshServer, resolveDsh, DEFAULT_PORT } = require("../src/main/dsh-server");

const ROOT = path.join(__dirname, "..");
const RUNTIME = path.join(ROOT, ".runtime", "smoke");
const PORT = Number(process.env.DSH_SMOKE_PORT) || 3277;

async function main() {
  console.log(`[smoke] 冒烟测试开始 (port=${PORT})`);
  fs.mkdirSync(path.join(RUNTIME, "logs"), { recursive: true });

  const resolved = resolveDsh();
  if (!resolved) {
    console.error("[smoke] FAIL: 找不到 dsh(项目内 node_modules 没有,请 npm install)");
    process.exit(1);
  }
  console.log(`[smoke] dsh = ${resolved.path} (${resolved.type})`);

  const server = new DshServer({ port: PORT });

  // 1. 启动
  const url = await server.start({
    dshHome: path.join(RUNTIME, "dsh-home"),
    logDir: path.join(RUNTIME, "logs"),
  });
  console.log(`[smoke] 1/4 启动成功: ${url}`);

  // 2. 首页可访问
  const res = await fetch(url);
  const html = await res.text();
  if (res.status !== 200) throw new Error(`首页返回 ${res.status}`);
  if (!html.includes("<html") && !html.includes("<!doctype")) {
    throw new Error("首页不是 HTML 内容");
  }
  console.log(`[smoke] 2/4 首页 200,${(html.length / 1024).toFixed(0)} KB HTML`);

  // 3. 就绪状态正确
  if (!server.ready) throw new Error("server.ready 应为 true");
  console.log("[smoke] 3/4 server.ready = true");

  // 4. 优雅停止
  await server.stop();
  if (server.child !== null) throw new Error("stop() 后 child 应清空");
  console.log("[smoke] 4/4 优雅停止成功");

  console.log("[smoke] PASS ✓ 核心链路正常");
}

main().catch((error) => {
  console.error("[smoke] FAIL ✗", error);
  process.exit(1);
});
