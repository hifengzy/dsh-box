#!/usr/bin/env node
"use strict";

/**
 * regression-crash-reason.js — dsh 启动崩溃「可读原因提取」回归(纯 Node,不弹窗口):
 *
 *   1. extractCrashReason:从 dsh 崩溃日志提取可读原因 ——
 *      1a. 插件重复加载(duplicate prefix route,聚合包与已装插件冲突场景);
 *      1b. 端口占用(EADDRINUSE);
 *      1c. 无 Error 行 → null(回退到旧的"端口可能被占用"猜测);
 *   2. crashAdvice:duplicate → 给出 dsh.profile.bundles 修复建议;EADDR →
 *      「端口被占用」建议;其它 → ""。
 *   3. 集成(DshServer 真实子进程):假 dsh bin 启动即打印崩溃堆栈并 exit(1)
 *      → start() 抛 DSH_START_TIMEOUT 且 message 包含「原因:」与 duplicate
 *      根因(而非误导性的"端口可能被占用")。
 *
 * 用法: node scripts/regression-crash-reason.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DshServer, extractCrashReason, crashAdvice } = require("../src/main/dsh-server");

// 与本案例同构的崩溃日志(聚合包双加载 → duplicate prefix route)
const LOG_DUPLICATE = `file:///Users/fengzy/DevProjects/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1186
\tthrow new Error(\`\${binName}: \${stage}: \${detail}\${stack}\`, { cause });
\t      ^

Error: dsh: plugin tree failed to load: failed to apply loader entry web-ui-better-sidebar (dsh-better-sidebar): webserver: duplicate prefix route "/sidebar/api"
    at Proxy.register (file:///.../dsh-host-webserver/lib/index.js:55:36)
Error: webserver: duplicate prefix route "/sidebar/api"
    at Proxy.register (file:///.../dsh-host-webserver/lib/index.js:55:36)

Node.js v24.18.1
`;

// 端口占用日志
const LOG_EADDR = `Error: failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): listen EADDRINUSE: address already in use 127.0.0.1:3260
    at updateError (file:///.../cordis-plugin-loader/lib/index.js:299:9)
`;

// 无 Error 行的日志(仅告警)
const LOG_PLAIN = `[warn] some plugin skipped because of missing peer
`;

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fixtureLog(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-crash-reason-"));
  const file = path.join(dir, "server.log");
  fs.writeFileSync(file, content);
  return { dir, file };
}

appMain().catch((err) => {
  console.error("\nFAIL ✗ 崩溃原因提取回归:", err.message);
  process.exit(1);
});

async function appMain() {
  // ========== 1. extractCrashReason ==========
  const d1 = fixtureLog(LOG_DUPLICATE);
  const r1 = extractCrashReason(d1.file);
  check(
    r1 && r1.includes('duplicate prefix route "/sidebar/api"'),
    `重复路由日志应提取到 duplicate 根因,实际 ${JSON.stringify(r1)}`
  );
  console.log("[1a] 插件重复加载日志 → 提取到可读根因 ✓");

  const d2 = fixtureLog(LOG_EADDR);
  const r2 = extractCrashReason(d2.file);
  check(r2 && /EADDRINUSE|address already in use/i.test(r2), `端口占用日志应提取到 EADDR,实际 ${JSON.stringify(r2)}`);
  console.log("[1b] 端口占用日志 → 提取到 EADDR ✓");

  const d3 = fixtureLog(LOG_PLAIN);
  const r3 = extractCrashReason(d3.file);
  check(r3 === null, `无 Error 行应返回 null(回退旧猜测),实际 ${JSON.stringify(r3)}`);
  console.log("[1c] 无 Error 行 → null(回退旧提示) ✓");

  // ========== 2. crashAdvice ==========
  const a1 = crashAdvice(r1);
  check(a1.includes("dsh.profile.bundles"), `duplicate 建议应指向 bundles 修复,实际 ${JSON.stringify(a1)}`);
  console.log("[2a] duplicate → 「移除 dsh.profile.bundles 重复条目」建议 ✓");
  const a2 = crashAdvice(r2);
  check(a2.includes("端口被占用"), `EADDR 建议应提示端口,实际 ${JSON.stringify(a2)}`);
  console.log("[2b] EADDR → 「端口被占用」建议 ✓");
  check(crashAdvice("something else") === "", "无关原因 → 无建议 ✓");
  console.log("[2c] 无关原因 → 无建议 ✓");

  // ========== 3. 集成:DshServer 真实子进程 ==========
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-crash-server-"));
  const fakeBin = path.join(work, "fake-dsh-bin.js");
  fs.writeFileSync(
    fakeBin,
    `console.error('Error: dsh: plugin tree failed to load: failed to apply loader entry web-ui-better-sidebar (dsh-better-sidebar): webserver: duplicate prefix route "/sidebar/api"');
console.error('    at Proxy.register (file:///.../dsh-host-webserver/lib/index.js:55:36)');
process.exit(1);
`
  );
  const server = new DshServer({ port: 3590 });
  let caught = null;
  let errorEvent = null;
  server.on("error", (e) => { errorEvent = e; });
  try {
    await server.start({ dshBin: fakeBin, dshHome: work, logDir: work });
  } catch (err) {
    caught = err;
  }
  check(caught !== null, "假崩溃 bin 应导致 start() 抛错");
  // P3-06:子进程提前退出 = 崩溃(DSH_CRASHED),不再被误包装成"未就绪超时"
  check(caught.code === "DSH_CRASHED", `错误码应为 DSH_CRASHED(提前退出),实际 ${caught.code}`);
  check(
    caught.message.includes("原因:") && caught.message.includes("duplicate prefix route"),
    `错误消息应含可读原因(而非误导的"端口可能被占用"),实际: ${caught.message}`
  );
  check(!/端口 .* 可能被占用/.test(caught.message), "有可读原因时不应再猜测端口被占用");
  check(caught.message.includes("dsh.profile.bundles"), "集成错误应带修复建议");
  check(errorEvent !== null, "应发出 error 事件");
  await server.stop().catch(() => {});
  console.log("[3] 集成:崩溃子进程 → DSH_CRASHED 含「原因: duplicate + 修复建议」✓");

  console.log("\nPASS ✓ 崩溃原因提取回归通过");
}