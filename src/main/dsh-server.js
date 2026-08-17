"use strict";

/**
 * dsh-server.js — 管理 dsh web 子进程的生命周期。
 *
 * 为什么用子进程而不是在主进程里直接 boot Cordis 树:
 *   1. dsh 的 profile 机制(~/.dsh)和插件体系是为独立 CLI 进程设计的,
 *      子进程方式与 `dsh web` 完全等价,升级 dsh 版本时零改动。
 *   2. 权限继承是核心目标:Electron 主进程 spawn 出来的 dsh 子进程,
 *      以及 dsh 再 spawn 的 bash/shell,都属于同一个原生 App 进程树,
 *      macOS 的 TCC 权限(全磁盘访问 / 文件夹访问)会沿进程树继承。
 *   3. 崩溃隔离:dsh 出问题时不会拖垮 Electron 主进程,可以干净地重启。
 *
 * 运行方式(关键):dsh 作为「依赖」被打进 App(node_modules 里),
 * 这里用 ELECTRON_RUN_AS_NODE=1 + 当前可执行文件(process.execPath)
 * 来运行它——App 自带的 Electron 就是 Node 运行时,用户不需要装
 * Node 也不需要全局装 dsh。打包后的 dsh 服务、以及它派生的 shell,
 * 都是同一个原生 App 进程树的一部分。
 *
 * 就绪检测:dsh web 没有 stdout 就绪标记(webserver 只在启动完成后
 * 接受请求,之前一律 404),所以这里轮询 HTTP 直到返回 2xx/3xx。
 */

const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 默认监听端口。不用 3080(那是 dsh 开发 GUI 的常用端口),避免冲突。 */
const DEFAULT_PORT = 3260;
/** 从启动到就绪的最长等待时间 */
const START_TIMEOUT_MS = 60_000;
/** 健康检查轮询间隔 */
const HEALTH_INTERVAL_MS = 500;
/** 停止子进程时的宽限期,超时后 SIGKILL */
const STOP_GRACE_MS = 5_000;

/** dsh 的入口脚本,相对其包目录 */
const DSH_BIN_JS = path.join("lib", "bin.js");

/**
 * 打包后的 dsh 脚本路径候选:
 * 本项目用 asar:false 打包(ELECTRON_RUN_AS_NODE 模式读不了 asar 归档,
 * 且 dsh 依赖树需要真实路径),所以打包后是 Resources/app/node_modules/…;
 * 这里同时保留 app.asar.unpacked 的候选,兼容以后开回 asar 的情况。
 * 开发模式:本项目自己的 node_modules。
 * @returns {string[]}
 */
function bundledDshPath() {
  const rel = path.join("node_modules", "@deepseek-ai", "dsh", DSH_BIN_JS);
  if (process.resourcesPath && !process.defaultApp) {
    return [
      path.join(process.resourcesPath, "app", rel),
      path.join(process.resourcesPath, "app.asar.unpacked", rel),
    ];
  }
  return [path.join(__dirname, "..", "..", rel)];
}

/**
 * 解析 dsh 入口,返回 { type, path }:
 *   - type "script":dsh 的 bin.js,需要用 Node 运行(推荐)
 *   - type "binary":独立可执行文件,直接运行
 * 优先级:
 *   1. 环境变量 DSH_BIN(显式指定,测试/调试用)
 *   2. 打进 App 的 dsh(打包后 / 本项目 node_modules)
 *   3. PATH 里的 `dsh`(兜底,比如用户全局装过)
 * @returns {{type: "script"|"binary", path: string}|null}
 */
function resolveDsh() {
  const candidates = [];
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN);
  candidates.push(...bundledDshPath());

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const real = fs.realpathSync(candidate); // 解开软链(如全局 bin/dsh)
      if (real.endsWith("bin.js")) {
        return { type: "script", path: real };
      }
      // 指向编译好的可执行文件,直接运行
      return { type: "binary", path: real };
    } catch {
      /* 该候选不存在,试下一个 */
    }
  }

  // 兜底:PATH 上的 dsh(npm -g 装的,bin/dsh 是指向 bin.js 的软链)
  try {
    const probe = spawnSync("which", ["dsh"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim()) {
      const real = fs.realpathSync(probe.stdout.trim().split("\n")[0]);
      if (fs.existsSync(real)) {
        return real.endsWith("bin.js")
          ? { type: "script", path: real }
          : { type: "binary", path: real };
      }
    }
  } catch {
    /* 继续走 fallback */
  }
  return null;
}

/**
 * 默认 DSH_HOME:继承环境变量,否则 ~/.dsh(与命令行 `dsh` 共用同一套
 * profile / 会话,数据互通)。
 */
function defaultDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), ".dsh");
}

class DshServer extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.port] 监听端口
   */
  constructor({ port = DEFAULT_PORT } = {}) {
    super();
    this.port = port;
    /** @type {import("node:child_process").ChildProcess|null} */
    this.child = null;
    this.stopping = false;
    this.ready = false;
    this.dshBin = null;
    this.dshHome = null;
    this.logFile = null;
    /** 子进程退出码(start 期间子进程提前退出时用于快速失败) */
    this.childExitCode = null;
  }

  /** @returns {string} 服务地址 */
  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * 启动 dsh web 子进程,并轮询直到就绪或超时。
   * @param {object} [options]
   * @param {string} [options.dshBin] dsh 入口(自动解析,一般不用传)
   * @param {string} [options.dshHome] DSH_HOME 目录(默认 ~/.dsh)
   * @param {string} [options.logDir] 日志目录(默认系统临时目录)
   * @returns {Promise<string>} 就绪后的服务 URL
   * @emits ready   就绪,payload 为 URL
   * @emits error   启动失败,payload 为 Error
   * @emits exited  子进程意外退出,payload 为 { code, signal }
   */
  async start({ dshBin, dshHome, logDir } = {}) {
    if (this.child) throw new Error("dsh server 已在运行,请先 stop()");

    const resolved = resolveDsh();
    this.dshBin = dshBin ?? (resolved ? resolved.path : null);
    const dshType = resolved ? resolved.type : "script";
    if (!this.dshBin) {
      const err = new Error(
        "找不到 dsh。打包后的 App 应该自带 dsh(node_modules/@deepseek-ai/dsh)," +
          "如果开发模式下报这个错,请先 npm install。"
      );
      err.code = "DSH_NOT_FOUND";
      this.emit("error", err);
      throw err;
    }

    this.dshHome = dshHome ?? defaultDshHome();
    this.stopping = false;
    this.ready = false;
    this.childExitCode = null;

    // 启动前清理残留:App 被强制退出/崩溃时,dsh 子进程可能变孤儿继续存活,
    // 占用端口导致本次 spawn 的 dsh 绑定失败(EADDRINUSE),却因健康检查
    // 命中残留服务而误报"服务启动失败"。只清理"父进程已死(PPID=1)"且
    // 命令行匹配本 App dsh 子进程签名的进程,不影响其它进程。
    await this._reapStaleServers(this.port);

    const logDirResolved = logDir ?? path.join(os.tmpdir(), "dsh-box");
    fs.mkdirSync(logDirResolved, { recursive: true });
    this.logFile = path.join(logDirResolved, `dsh-server-${Date.now()}.log`);
    const logStream = fs.createWriteStream(this.logFile, { flags: "a" });

    const env = {
      ...process.env,
      DSH_HOME: this.dshHome,
      // 关掉遥测(本地桌面 App 不应上报)
      DSH_TELEMETRY_DISABLED: "1",
    };

    // 运行方式:
    //   script → 用当前 Electron/Node 运行,ELECTRON_RUN_AS_NODE 让
    //            Electron 二进制退化成纯 Node 运行时(不需要系统 Node)
    //   binary → 直接运行
    // 注:dsh 的 HMR 插件需要 --expose-internals(Node < 25 默认不给),
    // 所以跑 script 时显式带上;对较新的 Node 也是无害的。
    let command;
    const args = ["web", "--port", String(this.port)];
    if (dshType === "script") {
      command = process.execPath;
      args.unshift("--expose-internals", this.dshBin);
      env.ELECTRON_RUN_AS_NODE = "1";
    } else {
      command = this.dshBin;
    }

    console.log(`[dsh] 启动: ${command} ${args.join(" ")}`);
    console.log(`[dsh] 入口 = ${this.dshBin} (${dshType === "script" ? "用内置 Node 运行" : "直接运行"})`);
    console.log(`[dsh] DSH_HOME = ${this.dshHome}`);
    console.log(`[dsh] 日志文件 = ${this.logFile}`);

    let child;
    try {
      child = spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      logStream.end();
      const err = new Error(`无法启动 dsh 进程: ${error.message}`, { cause: error });
      err.code = "DSH_SPAWN_FAILED";
      this.emit("error", err);
      throw err;
    }
    this.child = child;

    const pipe = (streamName) => (chunk) => {
      const line = chunk.toString();
      logStream.write(line);
      // 带前缀打到主进程 stdout,终端里 `npm start` 能看到
      for (const l of line.split("\n")) {
        if (l.trim()) console.log(`[dsh:${streamName}] ${l}`);
      }
    };
    child.stdout.on("data", pipe("out"));
    child.stderr.on("data", pipe("err"));

    child.on("exit", (code, signal) => {
      logStream.end();
      this.childExitCode = code;
      if (this.stopping) return;
      this.ready = false;
      this.child = null;
      console.log(`[dsh] 进程意外退出 code=${code} signal=${signal}`);
      this.emit("exited", { code, signal });
    });
    child.on("error", (error) => {
      logStream.end();
      if (this.stopping) return;
      this.ready = false;
      this.child = null;
      console.error("[dsh] 子进程错误:", error);
      this.emit("error", error);
    });

    // 轮询健康检查直到就绪
    try {
      await this._waitReady();
    } catch (error) {
      await this.stop();
      error.code = "DSH_START_TIMEOUT";
      error.message = `dsh 服务在 ${START_TIMEOUT_MS / 1000}s 内未就绪(端口 ${this.port})。` +
        `请查看日志: ${this.logFile}\n原因: ${error.message}`;
      this.emit("error", error);
      throw error;
    }

    this.ready = true;
    console.log(`[dsh] 就绪: ${this.url}`);
    this.emit("ready", this.url);
    return this.url;
  }

  /**
   * 停止子进程:SIGTERM → 宽限期 → SIGKILL。
   * @returns {Promise<void>}
   */
  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;

    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    this.stopping = false;
    console.log("[dsh] 已停止");
  }

  /** 轮询 HTTP,直到确认「端口上是真正的 dsh」或超时。 */
  async _waitReady() {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.stopping) throw new Error("服务已停止");
      // 子进程提前退出(典型:端口被别的服务占用,EADDRINUSE)→ 立即失败,
      // 不要等满超时,也不要被端口上其它服务返回的 2xx 骗过。
      if (this.childExitCode !== null) {
        throw new Error(`dsh 进程启动后立即退出 (code=${this.childExitCode}),端口 ${this.port} 可能被占用`);
      }
      try {
        const res = await fetch(this.url, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.status >= 200 && res.status < 400) {
          // 只认真正的 dsh:首页必须带 __DSH_BOOT__ 引导标记。
          // 端口被任意本地 HTTP 服务占用时,健康检查不能把它的页面当 WebUI。
          const html = await res.text();
          if (html.includes("__DSH_BOOT__")) return;
        }
      } catch {
        // 连接被拒:还没监听,继续等
      }
      await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
    }
    throw new Error(`端口 ${this.port} 上的服务始终未就绪`);
  }

  /**
   * 清理占用指定端口的残留 dsh 服务进程,并等待端口释放。
   *
   * 背景:App 被强制退出/崩溃时,dsh 子进程可能变孤儿继续存活并占用端口,
   * 导致下次启动时新 spawn 的 dsh 绑定失败(EADDRINUSE),而健康检查又命中
   * 残留服务,造成"服务启动失败"红字误报。启动前把占用本端口的残留清掉。
   *
   * 安全性:只清理"父进程已死(PPID=1)"的孤儿进程 —— 父进程存活的
   * 是本 App 正在运行的另一个实例的活服务,绝不误杀。若系统没有 ps
   * (拿不到 PPID),保守起见不清理。匹配仍按"本 App dsh 入口 + 端口"
   * 签名,不匹配的进程不动。
   *
   * @param {number} port 监听端口
   * @returns {Promise<number>} 清理数量
   */
  async _reapStaleServers(port) {
    let reaped = 0;
    try {
      const probe = spawnSync("pgrep", ["-f", `dsh/lib/bin.js web --port ${port}`], {
        encoding: "utf8",
      });
      const pids = (probe.stdout || "").trim().split("\n").filter((p) => /^\d+$/.test(p));
      for (const pid of pids) {
        const ps = spawnSync("ps", ["-o", "ppid=", "-p", pid], { encoding: "utf8" });
        const ppid = (ps.stdout || "").trim();
        if (ppid !== "1") continue; // 父进程存活 = 活实例的服务,不碰;ps 不可用时也不碰
        console.log(`[dsh] 清理残留的 dsh 孤儿进程 pid=${pid} port=${port}`);
        try {
          process.kill(Number(pid), "SIGTERM");
          reaped++;
        } catch {
          /* 进程可能已消失 */
        }
      }
    } catch {
      /* 系统没有 pgrep 时跳过清理 */
    }
    if (reaped === 0) return 0;
    // 等端口释放(最多 2s):SIGTERM 是异步的,直接 spawn 可能仍撞 EADDRINUSE
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(300) });
      } catch {
        return reaped; // 连不上 = 端口已释放
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    console.log(`[dsh] 端口 ${port} 在清理后仍被占用`);
    return reaped;
  }
}

module.exports = { DshServer, resolveDsh, bundledDshPath, defaultDshHome, DEFAULT_PORT };
