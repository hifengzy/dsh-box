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

/**
 * 解析 dsh 可执行文件路径,优先级:
 *   1. 环境变量 DSH_BIN(显式指定,最可靠)
 *   2. PATH 里的 `dsh`(npm i -g @deepseek-ai/dsh 之后就有)
 * @returns {string|null}
 */
function resolveDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  try {
    const probe = spawnSync("which", ["dsh"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim()) {
      return probe.stdout.trim().split("\n")[0];
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
   * @param {string} [options.dshBin] dsh 可执行文件路径(默认自动解析)
   * @param {string} [options.dshHome] DSH_HOME 目录(默认 ~/.dsh)
   * @param {string} [options.logDir] 日志目录(默认系统临时目录)
   * @returns {Promise<string>} 就绪后的服务 URL
   * @emits ready   就绪,payload 为 URL
   * @emits error   启动失败,payload 为 Error
   * @emits exited  子进程意外退出,payload 为 { code, signal }
   */
  async start({ dshBin, dshHome, logDir } = {}) {
    if (this.child) throw new Error("dsh server 已在运行,请先 stop()");

    this.dshBin = dshBin ?? resolveDshBin();
    if (!this.dshBin) {
      const err = new Error(
        "找不到 dsh 命令。请先安装: npm install -g @deepseek-ai/dsh@^0.1.0-rc.6\n" +
          "或者在启动 App 前设置环境变量 DSH_BIN 指向 dsh 可执行文件。"
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

    const args = ["web", "--port", String(this.port)];

    console.log(`[dsh] 启动: ${this.dshBin} ${args.join(" ")}`);
    console.log(`[dsh] DSH_HOME = ${this.dshHome}`);
    console.log(`[dsh] 日志文件 = ${this.logFile}`);

    let child;
    try {
      child = spawn(this.dshBin, args, {
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

module.exports = { DshServer, resolveDshBin, defaultDshHome, DEFAULT_PORT };
