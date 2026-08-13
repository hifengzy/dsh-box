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

    const logDirResolved = logDir ?? path.join(os.tmpdir(), "dsh-macos");
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

  /** 轮询 HTTP,直到收到 2xx/3xx 响应或超时。 */
  async _waitReady() {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.stopping) throw new Error("服务已停止");
      try {
        const res = await fetch(this.url, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.status >= 200 && res.status < 400) return;
        // 4xx/5xx:服务器在监听但还没准备好,继续等
      } catch {
        // 连接被拒:还没监听,继续等
      }
      await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
    }
    throw new Error(`端口 ${this.port} 上的服务始终未就绪`);
  }
}

module.exports = { DshServer, resolveDsh, bundledDshPath, defaultDshHome, DEFAULT_PORT };
