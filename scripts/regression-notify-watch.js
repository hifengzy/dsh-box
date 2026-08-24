#!/usr/bin/env node
"use strict";

/**
 * regression-notify-watch.js — notify-watch.js(通知事件流 watcher)单元回归
 * (纯 Node,无 Electron / 无真实网络):
 *
 *   1. 分类:turn/end completed → task-end(带会话标题);turn/end error →
 *      task-fail(带失败文案);question/requested → question(取首个问题文本);
 *      approval/requested → approval(toolName · reason);
 *   2. 子代理过滤:host/session-added origin=="subagent" 的会话,任务/提问/
 *      授权一律不通知;
 *   3. 提问/授权 rpcId 重放去重:同 rpcId 只通知一次(模拟断线重连后的挂起重放);
 *   4. 失败去重:同会话 turn/end error 与 host/agent-error 成对到达只通知一次;
 *      超过时间窗后新 host/agent-error 再通知;
 *   5. 重连:一侧断开 → 双流重建(新 socket 对),恢复后继续出事件;
 *   6. stop:关闭双流、不再重连、不再出事件。
 *
 * 用法: node scripts/regression-notify-watch.js
 */

const assert = require("node:assert");
const { createNotifyWatcher } = require("../src/main/notify-watch");

const silentLog = { info() {}, warn() {}, error() {} };

// ---------- Fake WebSocket(逐测试隔离实例) ----------
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.listeners = {};
    FakeWebSocket.instances.push(this);
    // 模拟 ws 库:构造后异步触发 open
    queueMicrotask(() => this.emit("open"));
  }
  on(evt, fn) {
    (this.listeners[evt] = this.listeners[evt] || []).push(fn);
  }
  emit(evt, arg) {
    for (const fn of this.listeners[evt] || []) fn(arg);
  }
  /** 服务端推一帧(JSON 字符串,与真实 WS 一致) */
  feed(payload, rpcId = `rpc-${Math.random().toString(36).slice(2)}`) {
    this.emit("message", JSON.stringify({ rpcId, payload }));
  }
  /** 服务端关闭连接 */
  serverClose() {
    if (this.readyState !== FakeWebSocket.CLOSED) {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close");
    }
  }
  close() {
    if (this.readyState !== FakeWebSocket.CLOSED) {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close");
    }
  }
  fail(message) {
    this.emit("error", new Error(message));
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 取最新一代 socket(0=mux,1=host);重连后实例累积,必须取末尾 */
function sockets() {
  const all = FakeWebSocket.instances;
  const mux = all.filter((s) => s.url.includes("events.mux")).pop();
  const host = all.filter((s) => s.url.includes("events.host")).pop();
  return { mux, host };
}

async function main() {
  let failed = false;

  // ========== 1. 分类 + 标题捕获 ==========
  {
    FakeWebSocket.instances = [];
    const events = [];
    const w = createNotifyWatcher({
      muxUrl: "ws://127.0.0.1:3260/api/events.mux",
      hostUrl: "ws://127.0.0.1:3260/api/events.host",
      WebSocket: FakeWebSocket,
      log: silentLog,
      failDedupeMs: 150,
      onEvent: (ev) => events.push(ev),
    });
    w.start();
    const { mux, host } = sockets();
    assert.ok(mux && host, "应建立 mux + host 双流");
    await wait(10);

    // 标题
    mux.feed({
      type: "session/event",
      sessionId: "sess-A",
      event: { type: "session/title", seq: 1, time: Date.now(), data: { title: "我的分析任务" } },
    });
    // 任务结束
    mux.feed({
      type: "session/event",
      sessionId: "sess-A",
      event: { type: "turn/end", seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: "completed" } } },
    });
    // 任务失败(turn/end error)
    mux.feed({
      type: "session/event",
      sessionId: "sess-B",
      event: { type: "turn/end", seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: "error", error: { message: "模型调用超时", code: "TIMEOUT" } } } },
    });
    // 提问
    mux.feed({
      type: "question/requested",
      sessionId: "sess-A",
      questions: [{ id: "q1", question: "请确认目标目录?" }],
    }, "rpc-quest-1");
    // 授权
    mux.feed({
      type: "approval/requested",
      sessionId: "sess-A",
      approvalId: "a1",
      toolName: "bash",
      reason: "一次性的命令执行",
    }, "rpc-appr-1");
    await wait(20);

    const kinds = events.map((e) => e.kind).join(",");
    assert.strictEqual(kinds, "task-end,task-fail,question,approval", `事件顺序/种类错误: ${kinds}`);
    assert.strictEqual(events[0].sessionId, "sess-A");
    assert.strictEqual(events[0].title, "我的分析任务", "task-end 应携带会话标题");
    assert.strictEqual(events[1].title, "", "无标题会话 → 标题为空串");
    assert.strictEqual(events[1].message, "模型调用超时", "失败文案应取 reason.error.message");
    assert.strictEqual(events[2].message, "请确认目标目录?", "提问文案应取问题文本");
    assert.strictEqual(events[3].message, "bash · 一次性的命令执行", "授权文案应取 toolName · reason");
    w.stop();
    console.log("[1] 分类:task-end/task-fail/question/approval + 标题 + 文案 ✓");
  }

  // ========== 2. 子代理过滤 ==========
  {
    FakeWebSocket.instances = [];
    const events = [];
    const w = createNotifyWatcher({
      muxUrl: "ws://127.0.0.1:3260/api/events.mux", hostUrl: "ws://127.0.0.1:3260/api/events.host", WebSocket: FakeWebSocket, log: silentLog,
      onEvent: (ev) => events.push(ev),
    });
    w.start();
    const { mux, host } = sockets();
    await wait(10);
    host.feed({ type: "host/session-added", sessionId: "sub-1", origin: "subagent" });
    mux.feed({
      type: "session/event",
      sessionId: "sub-1",
      event: { type: "turn/end", seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: "completed" } } },
    });
    mux.feed({ type: "question/requested", sessionId: "sub-1", questions: [{ id: "q", question: "?" }] }, "rpc-q-sub");
    mux.feed({ type: "approval/requested", sessionId: "sub-1", approvalId: "a", toolName: "bash" }, "rpc-a-sub");
    host.feed({ type: "host/agent-error", sessionId: "sub-1", message: "子代理错误" });
    await wait(20);
    assert.strictEqual(events.length, 0, `子代理会话不应产生任何通知,实际 ${JSON.stringify(events)}`);
    // 主会话(origin 非 subagent)→ 恢复通知
    host.feed({ type: "host/session-added", sessionId: "main-1" });
    mux.feed({
      type: "session/event",
      sessionId: "main-1",
      event: { type: "turn/end", seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: "completed" } } },
    });
    await wait(20);
    assert.strictEqual(events.length, 1, "主会话应恢复通知");
    assert.strictEqual(events[0].kind, "task-end");
    w.stop();
    console.log("[2] 子代理过滤:subagent 会话任务/提问/授权/错误全屏蔽 ✓");
  }

  // ========== 3. rpcId 重放去重(提问/授权) ==========
  {
    FakeWebSocket.instances = [];
    const events = [];
    const w = createNotifyWatcher({
      muxUrl: "ws://127.0.0.1:3260/api/events.mux", hostUrl: "ws://127.0.0.1:3260/api/events.host", WebSocket: FakeWebSocket, log: silentLog,
      onEvent: (ev) => events.push(ev),
    });
    w.start();
    const { mux } = sockets();
    await wait(10);
    const quest = { type: "question/requested", sessionId: "s", questions: [{ id: "q", question: "重复?" }] };
    const appr = { type: "approval/requested", sessionId: "s", approvalId: "a", toolName: "bash" };
    mux.feed(quest, "rpc-stable-q");
    mux.feed(quest, "rpc-stable-q"); // 重放(断线重连后挂起项重推)
    mux.feed(appr, "rpc-stable-a");
    mux.feed(appr, "rpc-stable-a");
    await wait(20);
    assert.strictEqual(events.length, 2, `同 rpcId 重放应去重,实际 ${JSON.stringify(events.map((e) => e.kind))}`);
    assert.strictEqual(events[0].kind, "question");
    assert.strictEqual(events[1].kind, "approval");
    w.stop();
    console.log("[3] rpcId 重放去重:提问/授权同 rpcId 只通知一次 ✓");
  }

  // ========== 4. 失败去重 + 时间窗后恢复 ==========
  {
    FakeWebSocket.instances = [];
    const events = [];
    const w = createNotifyWatcher({
      muxUrl: "ws://127.0.0.1:3260/api/events.mux", hostUrl: "ws://127.0.0.1:3260/api/events.host", WebSocket: FakeWebSocket, log: silentLog, failDedupeMs: 80,
      onEvent: (ev) => events.push(ev),
    });
    w.start();
    const { mux, host } = sockets();
    await wait(10);
    // turn/end error 先到 → host/agent-error 成对到达 → 去重
    mux.feed({
      type: "session/event",
      sessionId: "s",
      event: { type: "turn/end", seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: "error", error: { message: "底层失败" } } } },
    });
    host.feed({ type: "host/agent-error", sessionId: "s", message: "底层失败" });
    await wait(20);
    assert.strictEqual(events.length, 1, `成对失败应只通知一次,实际 ${JSON.stringify(events)}`);
    assert.strictEqual(events[0].message, "底层失败");
    // 超过时间窗后新的 agent-error → 再次通知
    await wait(100);
    host.feed({ type: "host/agent-error", sessionId: "s", message: "第二起错误" });
    await wait(20);
    assert.strictEqual(events.length, 2, "时间窗后新失败应再通知");
    assert.strictEqual(events[1].message, "第二起错误");
    w.stop();
    console.log("[4] 失败去重:turn/end error 与 agent-error 成对去重 + 时间窗后恢复 ✓");
  }

  // ========== 5. 重连:一侧断开 → 双流整体重建 + 恢复出事件 ==========
  {
    FakeWebSocket.instances = [];
    const events = [];
    const w = createNotifyWatcher({
      muxUrl: "ws://127.0.0.1:3260/api/events.mux", hostUrl: "ws://127.0.0.1:3260/api/events.host", WebSocket: FakeWebSocket, log: silentLog,
      backoffBaseMs: 30, backoffMaxMs: 60,
      onEvent: (ev) => events.push(ev),
    });
    w.start();
    await wait(10);
    const first = sockets();
    first.mux.serverClose(); // mux 断开
    await wait(150); // 退避重连
    const second = sockets();
    assert.ok(second.mux && second.host, "重连后应重建 mux + host 双流");
    assert.notStrictEqual(second.mux, first.mux, "mux 应为新实例");
    assert.notStrictEqual(second.host, first.host, "host 应被整体重建");
    second.mux.feed({
      type: "session/event",
      sessionId: "s",
      event: { type: "turn/end", seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: "completed" } } },
    });
    await wait(20);
    assert.strictEqual(events.length, 1, "重连后应继续出事件");
    assert.strictEqual(events[0].kind, "task-end");
    w.stop();
    console.log("[5] 重连:一侧断开 → 双流重建 + 恢复出事件 ✓");
  }

  // ========== 6. stop:关流、不重连、不出事件 ==========
  {
    FakeWebSocket.instances = [];
    const events = [];
    const w = createNotifyWatcher({
      muxUrl: "ws://127.0.0.1:3260/api/events.mux", hostUrl: "ws://127.0.0.1:3260/api/events.host", WebSocket: FakeWebSocket, log: silentLog,
      backoffBaseMs: 20, backoffMaxMs: 40,
      onEvent: (ev) => events.push(ev),
    });
    w.start();
    await wait(10);
    w.stop();
    const instancesAfterStop = FakeWebSocket.instances.length;
    const { mux } = sockets();
    mux.feed({
      type: "session/event",
      sessionId: "s",
      event: { type: "turn/end", seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: "completed" } } },
    });
    await wait(120);
    assert.strictEqual(events.length, 0, "stop 后不应再出事件");
    assert.strictEqual(FakeWebSocket.instances.length, instancesAfterStop, "stop 后不应继续重连建实例");
    assert.ok(w.state().stopped, "state().stopped 应为 true");
    console.log("[6] stop:关流 + 取消重连 + 事件静默 ✓");
  }

  console.log("\nPASS ✓ notify-watch 通知事件流回归通过");
  process.exit(0);
}

main().catch((error) => {
  console.error("\nFAIL ✗ notify-watch 通知事件流回归:", error.message);
  process.exit(1);
});