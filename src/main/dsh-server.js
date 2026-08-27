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
 * 从 dsh 崩溃日志中提取可读的失败原因(供界面展示;无则 null)。
 * 日志 = 子进程 stdout/stderr 原文,dsh 启动崩溃时以 "Error: <msg>" 行
 * 呈现(boot 级或 cause 链根因行)。优先取含根因关键词的行
 * (duplicate/EADDR/模块缺失/插件树失败等),避免取到无信息的堆栈行。
 * @param {string} logFile dsh 日志文件路径
 * @returns {string|null}
 */
function extractCrashReason(logFile) {
  // 只读文件尾部(最近 200KB):防日志无限累积(单次运行无限追加 + 跨重启
  // 文件永不轮转)时整文件同步读阻塞主进程(对抗审查 P3-01)。
  let tail;
  try {
    const stat = fs.statSync(logFile);
    const START = 200 * 1024;
    let fd;
    try {
      fd = fs.openSync(logFile, "r");
      const buf = Buffer.alloc(Math.min(stat.size, START));
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, stat.size - buf.length));
      tail = buf.toString("utf8");
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = tail.split("\n");
  const prefer = lines.find((l) =>
    /^Error:\s*(?:duplicate|EADDR|Cannot find module|listen|failed|plugin tree|Unexpected|Syntax)/i.test(l)
  );
  const any = lines.find((l) => /^Error:\s*\S/.test(l));
  const line = prefer || any;
  if (!line) return null;
  const msg = line.replace(/^Error:\s*/, "").trim();
  return msg.length > 240 ? msg.slice(0, 240) + "…" : msg;
}

/** 常见崩溃原因的可操作建议(无匹配返回 "") */
function crashAdvice(reason) {
  if (!reason) return "";
  if (/duplicate\s+prefix\s+route/i.test(reason)) {
    return (
      "插件重复加载:常见于聚合插件(如 dsh-web-ui-all)与已装的同一插件并存。" +
      "可在 <DSH_HOME>/profiles/web/package.json 的 dsh.profile.bundles 里移除重复条目,或卸载其一后重试"
    );
  }
  if (/EADDRINUSE|address already in use/i.test(reason)) {
    return "端口被占用:请结束占用该端口的进程后重试";
  }
  return "";
}

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
  async start({ port = this.port, dshBin, dshHome, logDir } = {}) {
    if (this.child) throw new Error("dsh server 已在运行,请先 stop()");
    // 端口可在启动时覆盖(端口被占用时主进程逐候选重试:3260 → 3261 → …),
    // 迁移后 url / info 全部以新端口为准,UI 如实展示。
    this.port = port;

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
    await this.reapStaleServers(this.port);

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
    // 注:dsh web 启动成功后默认会用「系统默认浏览器打开页面」;DSH Box 本身
    // 就是浏览器/客户端(内容视图加载 dsh UI),必须 --no-open 禁用,否则每次
    // 服务启动/升级重启都会弹系统浏览器(实测跳出 Chrome)。
    let command;
    const args = ["web", "--port", String(this.port), "--no-open"];
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
      // 停止流程的迟到 exit(SIGKILL 后事件在下一轮事件循环才投递)必须按
      // 「正常停止」处理,绝不落入「意外退出」——否则 stop() 已返回后迟到的
      // exit 会把"服务意外退出"广播到 UI(服务实际在跑、界面显示崩溃)。
      // stopping 在这里消化并复位(不在 stop() 尾部复位)。
      if (this.stopping) {
        this.stopping = false;
        return;
      }
      // 代际防线:stop 后已重新 start(新 child)时,旧 child 的迟到 exit
      // 一律按正常停止流程处理(不影响新服务状态)。
      if (this.child !== null && this.child !== child) return;
      this.ready = false;
      this.child = null;
      console.log(`[dsh] 进程意外退出 code=${code} signal=${signal}`);
      this.emit("exited", { code, signal });
    });
    child.on("error", (error) => {
      logStream.end();
      if (this.stopping) {
        this.stopping = false;
        return;
      }
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
      // 用户在就绪窗口内主动点「停止」(stopping 使 _waitReady 抛"服务已停止")
      // → 平稳退出:不包装成启动超时、不广播错误(否则与 stopped 终态竞态,
      // 状态页可能定格在错误的失败文案并污染 lastError)。
      if (error && error.message === "服务已停止") return;
      // 子进程提前退出:_waitReady 已读日志给出可读原因,原样上报即可,
      // 不要再包装成「N 秒内未就绪」掩盖真实原因(对抗审查 P3-06)
      if (error && /立即退出/.test(error.message)) {
        error.code = "DSH_CRASHED";
        this.emit("error", error);
        throw error;
      }
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
    // 关键复位:ready 必须置 false —— main.js 的 startServer() 用
    // `if (server.ready || server.child) return;` 做防重入短路,若停止后
    // 不复位,安装/更新插件后、升级 dsh 后的「自动重启」会被该短路直接
    // 跳过(服务停着但不再拉起)。
    this.ready = false;
    // 注意:stopping 不在 stop() 尾部复位 —— SIGKILL 宽限路径下子进程的
    // exit 事件在 stop() 返回后才投递,若这里复位会把迟到 exit 误判为
    // 「意外退出」。stopping 由 exit/error 处理器消化并复位(见上),start()
    // 也会复位,不存在卡死路径。
    console.log("[dsh] 已停止");
  }

  /** 轮询 HTTP,直到确认「端口上是真正的 dsh」或超时。 */
  async _waitReady() {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.stopping) throw new Error("服务已停止");
      // 子进程提前退出(典型:插件树加载失败 / 端口被占用)→ 立即失败,
      // 不要等满超时,也不要被端口上其它服务返回的 2xx 骗过。
      if (this.childExitCode !== null) {
        // 读日志给出可读原因(避免只抛误导性的"端口可能被占用"猜测)
        const reason = extractCrashReason(this.logFile);
        const advice = crashAdvice(reason);
        throw new Error(
          reason
            ? `dsh 进程启动后立即退出 (code=${this.childExitCode}); 原因: ${reason}${advice ? `; ${advice}` : ""}`
            : `dsh 进程启动后立即退出 (code=${this.childExitCode}),端口 ${this.port} 可能被占用`
        );
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
   * (拿不到 PPID),保守起见不清理。匹配仍按"本 App dsh 入口 + 端口"签名,
   * 不匹配的进程不动。签名带 --no-open(DSH Box 启动 dsh 必带):把用户自己
   * 以 `dsh web --port N` 起的独立 dsh 排除在外,绝不误杀用户的服务
   * (它默认不带 --no-open)。
   *
   * @param {number} port 监听端口
   * @returns {Promise<number>} 清理数量
   */
  async reapStaleServers(port) {
    let reaped = 0;
    try {
      // pgrep -f 按扩展正则匹配整条命令行;`bin.js` 的 "." 必须转义成 `\.`,
      // 否则会误配 mydsh/lib/binXjs 之类模仿进程(对抗审查 P2-A6)。保持子串
      // 匹配(不加 ^ 锚):实际命令行形如 `node /path/dsh/lib/bin.js web ...`。
      const pattern = `dsh/lib/bin\\.js web --port ${port} --no-open`;
      const probe = spawnSync("pgrep", ["-f", pattern], {
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

  /**
   * 探测端口是否已被其它服务占用(任何 HTTP 响应即视为占用)。
   *
   * 用途:端口冲突并存 —— 启动前预检,被占直接换下一候选端口,不 spawn、
   * 不误报。判定规则:
   *   - 有 HTTP 响应 → 占用(无论 2xx/4xx/5xx);
   *   - 连接被拒(ECONNREFUSED)/无此地址(ENOTFOUND)→ 空闲;
   *   - 其它(超时 / 非 HTTP 协议)→ 保守视为占用(跳过该端口无害)。
   *
   * @param {number} port 监听端口
   * @returns {Promise<boolean>} true = 端口被占用
   */
  async probePort(port) {
    try {
      await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(800) });
      return true;
    } catch (error) {
      const code = error?.cause?.code ?? error?.code ?? "";
      // 明确「无服务」(连接拒绝/域名解析失败)→ 可用。
      if (code === "ECONNREFUSED" || code === "ENOTFOUND") return false;
      // 超时(防火墙 drop / 服务吞包等, AbortError 无 code)或其它错误:先
      // 重探一次排除瞬时抖动(对抗审查 P3-05,避免 10 个候选全被假占用而
      // 误报「端口均被占用」);仍无法确认 → 保守视为占用(未知比误用安全)。
      if (!code) {
        try {
          await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(800) });
          return true;
        } catch (retryError) {
          const retryCode = retryError?.cause?.code ?? retryError?.code ?? "";
          return !(retryCode === "ECONNREFUSED" || retryCode === "ENOTFOUND");
        }
      }
      return true; // 其它明确错误(如权限/畸形响应)保守视为占用
    }
  }
}

module.exports = {
  DshServer,
  resolveDsh,
  bundledDshPath,
  defaultDshHome,
  DEFAULT_PORT,
  extractCrashReason,
  crashAdvice,
};
