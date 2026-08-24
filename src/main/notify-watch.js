"use strict";

/**
 * notify-watch.js — 监听 dsh 服务的事件流,把「任务节点」归一化成通知事件。
 *
 * 数据源(dsh web 传输层的两条下行流,见 @deepseek-ai/dsh-client-connection):
 *   - ws://<host>/api/events.mux   会话事件 / 提问 / 授权(mux 帧)
 *   - ws://<host>/api/events.host  会话增删 / 运行状态 / 代理错误(host 帧)
 * 两条流均为「纯下行」(客户端只读,发送即断);信任围栏对 loopback + 无
 * Origin 头(dsh Box 主进程直连)放行,故无需鉴权。
 *
 * 通知触发项 → 帧映射(需求:DSH 主代理):
 *   - 任务结束   → mux `session/event` 中 `turn/end` 且 reason.kind==="completed"
 *   - 任务失败   → mux `turn/end` 且 reason.kind==="error"(文案取 reason.error.message)
 *                 或 host `host/agent-error`(同会话与 turn/end 错误按时间窗去重)
 *   - 弹出提问   → mux `question/requested`(文案取 questions[0].question)
 *   - 弹出授权   → mux `approval/requested`(文案取 toolName · reason)
 *
 * 过滤与去重:
 *   - 子代理会话(host/session-added origin==="subagent")一律不通知;
 *   - 提问/授权帧在每次连接时按「稳定 rpcId」重放(未答复的挂起项) →
 *     用 rpcId 集合去重,重连/服务重启不会重复通知;
 *   - 同会话 turn/end(error) 与 host/agent-error 可能成对到达 → 按会话
 *     时间窗(默认 2s)去重。
 *
 * 纯 Node、零 Electron 依赖:WebSocket 实现可注入(单测用 fake),便于与
 * 既有模块(plugin-manager / theme-sync)同样做独立单测。
 */

/** 默认连接器:ws 库(已在 node_modules;打包 files 含 node_modules/**) */
function defaultWebSocket() {
  // eslint-disable-next-line global-require
  return require("ws");
}

/**
 * @param {object} options
 * @param {string} options.muxUrl  mux 流 ws:// 地址(如 http://127.0.0.1:3260 → ws://…/api/events.mux)
 * @param {string} options.hostUrl host 流 ws:// 地址
 * @param {Function} [options.WebSocket] WebSocket 构造器(默认 ws 库;单测注入 fake)
 * @param {object} [options.log] 日志器(console 形状)
 * @param {(event: {kind:string, sessionId?:string, title:string, message:string}) => void} [options.onEvent]
 *   归一化通知事件回调。kind ∈ task-end | task-fail | question | approval。
 * @param {number} [options.failDedupeMs] 同会话失败文案去重窗(默认 2000ms)
 * @param {number} [options.backoffBaseMs] 重连退避基数(默认 500ms)
 * @param {number} [options.backoffMaxMs] 重连退避上限(默认 10s)
 * @returns {{start: () => void, stop: () => void, state: () => object, _reset: () => void}}
 */
function createNotifyWatcher({
  muxUrl,
  hostUrl,
  WebSocket = defaultWebSocket(),
  log = console,
  onEvent = () => {},
  failDedupeMs = 2000,
  backoffBaseMs = 500,
  backoffMaxMs = 10000,
}) {
  const MAX_SEEN_RPC = 512;

  /** 子代理会话(不通知) */
  const subagents = new Set();
  /** 会话最近一次已知标题(session/title 事件;无标题 → "") */
  const titles = new Map();
  /** 已消费的 rpcId(提问/授权重放去重,LRU) */
  const seenRpc = new Set();
  const seenRpcOrder = [];
  /** 会话最近一次任务失败通知时刻(host/agent-error 与 turn/end 错误去重) */
  const lastFailAt = new Map();

  let stopped = true;
  let attempt = 0;
  let active = null; // { mux, host, reconnectScheduled }
  let reconnectTimer = null;

  const isSub = (sessionId) => subagents.has(sessionId);
  const titleOf = (sessionId) => titles.get(sessionId) || "";

  /** 记录 rpcId;已见过(重放)→ false */
  function rememberRpc(rpcId) {
    if (!rpcId || seenRpc.has(rpcId)) return false;
    seenRpc.add(rpcId);
    seenRpcOrder.push(rpcId);
    if (seenRpcOrder.length > MAX_SEEN_RPC) {
      const oldest = seenRpcOrder.shift();
      seenRpc.delete(oldest);
    }
    return true;
  }

  /** 输出归一化事件 */
  function emit(kind, sessionId, message) {
    onEvent({
      kind,
      sessionId,
      title: titleOf(sessionId),
      message: message || "",
    });
  }

  /** 处理 mux 帧(rpcId 在 ServerRequest 信封上,提问/授权重放按它去重) */
  function handleMuxFrame(rpcId, payload) {
    switch (payload.type) {
      case "session/event": {
        handleSessionEvent(payload.sessionId, payload.event);
        break;
      }
      case "question/requested": {
        if (isSub(payload.sessionId)) return;
        if (!rememberRpc(rpcId)) return;
        const first = Array.isArray(payload.questions) ? payload.questions[0] : null;
        emit("question", payload.sessionId, first && first.question ? String(first.question) : "");
        break;
      }
      case "approval/requested": {
        if (isSub(payload.sessionId)) return;
        if (!rememberRpc(rpcId)) return;
        const parts = [payload.toolName, payload.reason].filter(Boolean);
        emit("approval", payload.sessionId, parts.join(" · "));
        break;
      }
      default:
        break;
    }
  }

  /** 处理 host 帧 */
  function handleHostFrame(payload) {
    switch (payload.type) {
      case "host/session-added":
        if (payload.origin === "subagent") subagents.add(payload.sessionId);
        else subagents.delete(payload.sessionId);
        break;
      case "host/session-removed":
        subagents.delete(payload.sessionId);
        titles.delete(payload.sessionId);
        lastFailAt.delete(payload.sessionId);
        break;
      case "host/agent-error": {
        if (isSub(payload.sessionId)) return;
        const last = lastFailAt.get(payload.sessionId) || 0;
        if (Date.now() - last < failDedupeMs) return; // 与 turn/end error 成对到达 → 去重
        lastFailAt.set(payload.sessionId, Date.now());
        emit("task-fail", payload.sessionId, payload.message ? String(payload.message) : "任务异常终止");
        break;
      }
      default:
        break;
    }
  }

  /** 处理 mux 帧内的 session/event */
  function handleSessionEvent(sessionId, event) {
    if (!event || typeof event.type !== "string") return;
    switch (event.type) {
      case "session/title": {
        const title = event.data && event.data.title;
        if (typeof title === "string" && title) titles.set(sessionId, title);
        break;
      }
      case "turn/end": {
        if (isSub(sessionId)) return;
        const reason = event.data && event.data.reason;
        if (!reason || typeof reason.kind !== "string") return;
        if (reason.kind === "completed") {
          emit("task-end", sessionId, "");
        } else if (reason.kind === "error") {
          const message =
            (reason.error && (reason.error.message || reason.error.code)) || "任务异常终止";
          lastFailAt.set(sessionId, Date.now());
          emit("task-fail", sessionId, String(message));
        }
        break;
      }
      default:
        break;
    }
  }

  /** 解析一行 WS 帧并分发(流名仅用于日志) */
  function handleMessage(stream, data) {
    if (stopped) return; // stop 后即使有迟到帧也一律静默
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || !msg.payload || typeof msg.payload.type !== "string") return;
    if (stream === "mux") handleMuxFrame(msg.rpcId, msg.payload);
    else handleHostFrame(msg.payload);
  }

  /** 关闭一代的所有 socket(幂等;关闭事件可能异步到达,由重连守卫去重) */
  function closeSockets(cur) {
    if (!cur) return;
    for (const key of ["mux", "host"]) {
      const sock = cur[key];
      if (sock && sock.readyState === 1 /* OPEN */) {
        try {
          sock.close();
        } catch {
          /* 忽略关闭异常 */
        }
      }
      cur[key] = null;
    }
  }

  function scheduleReconnect(gen) {
    if (stopped || gen !== attempt || reconnectTimer) return;
    const backoff = Math.min(
      backoffMaxMs,
      backoffBaseMs * 2 ** Math.max(0, attempt - 1)
    );
    const delay = Math.round(backoff / 2 + Math.random() * (backoff / 2));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped || gen !== attempt) return;
      connect();
    }, delay);
  }

  /** 打开一代双流连接(失败任一侧 → 整体重连) */
  function connect() {
    if (stopped) return;
    attempt += 1;
    const gen = attempt;
    const cur = { mux: null, host: null };
    active = cur;
    log.info?.(`[notify-watch] 连接 dsh 事件流(第 ${attempt} 次尝试)…`);

    const onSideClosed = () => {
      // 先登记重连(此时 gen 仍有效),再关另一侧——另一侧的 close 事件
      // 会再次进入,但 reconnectTimer 已占位,不会重复调度。
      if (!stopped && gen === attempt) scheduleReconnect(gen);
      closeSockets(cur);
    };

    const openSocket = (key, url) => {
      let sock;
      try {
        sock = new WebSocket(url);
      } catch (error) {
        log.warn?.(`[notify-watch] ${key} 连接失败: ${error && error.message}`);
        onSideClosed();
        return;
      }
      cur[key] = sock;
      sock.on("open", () => {
        log.info?.(`[notify-watch] ${key} 事件流已连接`);
      });
      sock.on("message", (data) => handleMessage(key, data));
      sock.on("close", () => {
        if (cur[key]) cur[key] = null;
        onSideClosed();
      });
      sock.on("error", (error) => {
        log.warn?.(`[notify-watch] ${key} 连接错误: ${error && error.message ? error.message : String(error)}`);
      });
    };

    openSocket("mux", muxUrl);
    openSocket("host", hostUrl);
  }

  return {
    /**
     * 开始监听(幂等)。服务就绪后调用;断线自动指数退避重连。
     */
    start() {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      connect();
    },
    /**
     * 停止监听(幂等):关闭双流、取消重连定时器。
     */
    stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      closeSockets(active);
      active = null;
    },
    /** 诊断状态(回归/排查用) */
    state() {
      return {
        stopped,
        attempt,
        connected: !!(active && (active.mux || active.host)),
      };
    },
    /** 清空内部追踪状态(单测用;正常生命周期不需要) */
    _reset() {
      subagents.clear();
      titles.clear();
      seenRpc.clear();
      seenRpcOrder.length = 0;
      lastFailAt.clear();
    },
  };
}

module.exports = { createNotifyWatcher };