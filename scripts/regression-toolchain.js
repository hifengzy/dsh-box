#!/usr/bin/env node
"use strict";

/**
 * regression-toolchain.js — 工具链解析回归(需求 3 方案 B,纯 Node):
 *
 *   npm 选用优先级:DSH_NPM_CMD(env)→ 用户本地(node ≥ 20 + npm 可用)
 *   → 内置运行时(bundledDir)→ 明确报错;
 *   pnpm PATH:用户 pnpm 命中 → PATH 原样;缺失 → 内置 bin 前置;都没有 → 原样交给 dsh CLI。
 *
 * 用 fake 可执行脚本(node/npm/pnpm)模拟用户与内置工具链,不碰真实 npm。
 *
 * 用法: node scripts/regression-toolchain.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const toolchain = require("../src/main/toolchain");

const RUNTIME = path.join(__dirname, "..", ".runtime", "regression", "toolchain");
fs.rmSync(RUNTIME, { recursive: true, force: true });

let failed = 0;
const check = (label, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? `(${extra})` : ""}`);
  if (!cond) failed++;
};

/** 造一个 fake 工具链目录:node 打印指定主版本;npm/pnpm 打印版本 */
function makeFakeBin({ nodeMajor = 25, withNpm = true, withPnpm = true }) {
  const dir = path.join(RUNTIME, `bin-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const sh = fs.readFileSync("/bin/sh");
  const node = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v${nodeMajor}.0.0"; else echo "9.11.1"; fi\n`;
  fs.writeFileSync(path.join(dir, "node"), node, { mode: 0o755 });
  if (withNpm) fs.writeFileSync(path.join(dir, "npm"), "#!/bin/sh\necho 9.11.1\n", { mode: 0o755 });
  if (withPnpm) fs.writeFileSync(path.join(dir, "pnpm"), "#!/bin/sh\necho 9.15.5\n", { mode: 0o755 });
  return dir;
}

/** 造一个 fake 内置运行时:<nodeDir>/bin/node + lib/node_modules/npm/bin/npm-cli.js(+bin/pnpm) */
function makeFakeBundled({ nodeMajor = 25, withPnpm = true, broken = false } = {}) {
  const nodeDir = path.join(RUNTIME, `bundle-${Math.random().toString(36).slice(2)}`, "node");
  const binDir = path.join(nodeDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const npmCliDir = path.join(nodeDir, "lib", "node_modules", "npm", "bin");
  fs.mkdirSync(npmCliDir, { recursive: true });
  const node = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v${nodeMajor}.0.0"; else echo "10.9.2"; fi\n`;
  fs.writeFileSync(path.join(binDir, "node"), node, { mode: 0o755 });
  fs.writeFileSync(path.join(npmCliDir, "npm-cli.js"), "#!/usr/bin/env node\nconsole.log('10.9.2')\n", { mode: 0o755 });
  if (withPnpm) fs.writeFileSync(path.join(binDir, "pnpm"), "#!/bin/sh\necho 9.15.5\n", { mode: 0o755 });
  if (broken) fs.rmSync(path.join(binDir, "node")); // 缺 node → 认定未就绪
  return nodeDir;
}

(async () => {
  // 逻辑分支测试期间隔离本机 Homebrew(GUI 兜底注入会干扰 fake bins 的
  // 优先级断言;GUI 兜底自身的回归放到文件末尾单独测)
  process.env.DSH_DISABLE_HOMEBREW_PATH = "1";

  console.log("[1] nodeMajor 解析");
  check("v20.11.0 → 20", toolchain.nodeMajor("v20.11.0") === 20);
  check("v18 → 18", toolchain.nodeMajor("v18") === 18);
  check("v25.9.0 → 25", toolchain.nodeMajor("v25.9.0") === 25);
  check("垃圾输入 → null", toolchain.nodeMajor("abc") === null);

  console.log("[2] shellPath 重建");
  check("env.PATH 优先", toolchain.shellPath({ PATH: "/x:/y" }) === "/x:/y");
  const empty = toolchain.shellPath({});
  check("无 PATH → 非空兜底(launchctl/默认)", typeof empty === "string" && empty.length > 0);

  console.log("[3] 用户本地 npm 探测(版本门槛)");
  const good = makeFakeBin({ nodeMajor: 25 });
  const userGood = toolchain.probeUserNpm(good);
  check("node 25 + npm → 用户 npm 命中", userGood && userGood.source === "user", userGood ? userGood.npmVersion : "null");
  const old = makeFakeBin({ nodeMajor: 18 });
  const userOld = toolchain.probeUserNpm(old);
  check("node 18 → 拒绝(< 20)", userOld === null);
  const noNpm = makeFakeBin({ nodeMajor: 25, withNpm: false });
  check("无 npm → 拒绝", toolchain.probeUserNpm(noNpm) === null);

  console.log("[4] 内置运行时探测");
  const bundle = makeFakeBundled();
  const bundled = toolchain.probeBundledNpm(bundle);
  check("完整内置 → 命中", bundled && bundled.source === "bundled");
  check("argsPrefix = npm-cli", bundled && bundled.argsPrefix.length === 1 && bundled.argsPrefix[0].endsWith("npm-cli.js"));
  const bundleBroken = makeFakeBundled({ broken: true });
  check("缺 node → 未就绪", toolchain.probeBundledNpm(bundleBroken) === null);
  check("null 目录 → 未就绪", toolchain.probeBundledNpm(null) === null);

  console.log("[5] resolveNpm 优先级");
  const envCmd = toolchain.resolveNpm({ env: { DSH_NPM_CMD: "/my/npm", PATH: good } });
  check("DSH_NPM_CMD 覆盖(不探测)", envCmd.ok && envCmd.source === "env" && envCmd.cmd === "/my/npm");
  const user = toolchain.resolveNpm({ env: { PATH: good } });
  check("用户 node≥20 → source=user", user.ok && user.source === "user");
  const fallback = toolchain.resolveNpm({ env: { PATH: old }, bundledDir: bundle });
  check("用户 node18 → 内置兜底", fallback.ok && fallback.source === "bundled");
  const missing = toolchain.resolveNpm({ env: { PATH: noNpm }, bundledDir: null });
  check("都没有 → ok:false + 引导文案", !missing.ok && /Node ≥ 20/.test(missing.error));
  const missingWithBundle = toolchain.resolveNpm({ env: { PATH: noNpm }, bundledDir: bundleBroken });
  check("内置未就绪 → ok:false(提示内置路径)", !missingWithBundle.ok && /内置运行时/.test(missingWithBundle.error));

  console.log("[6] resolvePnpmPath(PATH 注入)");
  const userPnp = toolchain.resolvePnpmPath({ env: { PATH: good } });
  check("用户 pnpm → PATH 原样 + source=user", userPnp.ok && userPnp.source === "user" && userPnp.path === good);
  const noUserPnp = makeFakeBin({ withPnpm: false });
  const bundledPnp = toolchain.resolvePnpmPath({ env: { PATH: noUserPnp }, bundledDir: bundle });
  check("用户无 pnpm → 内置 bin 前置", bundledPnp.ok && bundledPnp.source === "bundled" && bundledPnp.path.startsWith(path.join(bundle, "bin")));
  const none = toolchain.resolvePnpmPath({ env: { PATH: noUserPnp }, bundledDir: null });
  check("都没有 → source=none、PATH 原样", none.ok && none.source === "none" && none.path === noUserPnp);

  // 0.1.7 实报回归(隔离解除,真实 Homebrew 环境):GUI 进程 PATH 只有
  // /usr/bin:/bin:...,Homebrew 前缀缺失 → dsh CLI 报「pnpm not found on
  // PATH」。shellPath 必须把存在的 Homebrew bin 前缀前置;且本机有 Homebrew
  // 时 resolvePnpmPath 应能命中用户 pnpm。
  delete process.env.DSH_DISABLE_HOMEBREW_PATH;
  if (process.platform === "darwin") {
    const guiPath = toolchain.shellPath({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    const homebrewBins = ["/opt/homebrew/bin", "/usr/local/bin"].filter((d) => require("node:fs").existsSync(d));
    check(
      `GUI 兜底 PATH 前置 Homebrew bin(${homebrewBins.join(",") || "本机无 Homebrew"})`,
      homebrewBins.length === 0 || homebrewBins.every((d) => guiPath.includes(d))
    );
    if (homebrewBins.length > 0) {
      const guiPnp = toolchain.resolvePnpmPath({ env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
      check(
        `GUI 场景 resolvePnpmPath 命中用户 pnpm(source=${guiPnp.source})`,
        guiPnp.ok && guiPnp.source === "user" && guiPnp.pnpmVersion
      );
    }
  } else {
    check("非 mac:Homebrew 注入不生效(平台守卫)", toolchain.shellPath({ PATH: "/x" }) === "/x");
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} ✓ 工具链解析回归通过(${failed === 0 ? "全部" : failed + " 项失败"})`);
  process.exit(failed === 0 ? 0 : 1);
})();