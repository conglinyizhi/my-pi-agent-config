// subagent-run.test.ts — runSubagent 参数构造、最终输出提取与 timeline 归一化行为测试
//
// 背景：worker 子进程需要显式加载 custom-providers 扩展（providers.toml 的动态模型），
// 同时保持隔离（--no-extensions 等）；反馈模式下 --tools 白名单只放 read/bash/be-*。
// timeline：把 pi JSON stdout 事件归一化成有界 per-worker 轨迹（assistant/tool/lifecycle）。
//
// 跑法：node --experimental-strip-types lib/subagent-run.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import {
  buildSubagentArgs,
  extractAgentEndOutput,
  TimelineBuilder,
  resolveTerminalState,
  SubagentError,
  TIMELINE_MAX_ENTRIES,
  TIMELINE_MAX_TEXT,
  TIMELINE_MAX_FIELD,
  type TimelineEvent,
} from "./subagent-run.ts";

describe("buildSubagentArgs", () => {
  const base = { task: "t", cwd: "/tmp", model: "m" };

  it("启用 custom-providers 扩展并禁用扩展发现", () => {
    const args = buildSubagentArgs(base);
    assert(args.includes("--no-extensions"));
    const extIdxs: number[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "--extension") extIdxs.push(i + 1);
    assert(extIdxs.length >= 2);
    assert(extIdxs.some((i) => args[i].includes("custom-providers")));
    assert(extIdxs.some((i) => args[i].includes("pi-mcp-adapter")));
    assert(args.includes("--no-session"));
    assert(args.includes("--no-skills"));
    assert(args.includes("--no-prompt-templates"));
    assert(args.includes("--no-context-files"));
  });

  it("tools 白名单拼成逗号分隔精确名单", () => {
    const args = buildSubagentArgs({ ...base, tools: ["read", "bash", "be-read", "be-replace"] });
    const idx = args.indexOf("--tools");
    assert(idx !== -1);
    assert.strictEqual(args[idx + 1], "read,bash,be-read,be-replace");
  });

  it("extraExtensions 逐个显式加载", () => {
    const args = buildSubagentArgs({ ...base, extraExtensions: ["/ext/be-error-recorder/index.ts"] });
    const extIdxs: number[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "--extension") extIdxs.push(i + 1);
    assert(extIdxs.length >= 2);
    assert(extIdxs.some((i) => args[i].includes("be-error-recorder")));
  });

  it("无 tools 时不传 --tools", () => {
    const args = buildSubagentArgs(base);
    assert(!args.includes("--tools"));
  });

  it("保留提示词与任务注入参数", () => {
    const args = buildSubagentArgs({ ...base, promptPath: "/tmp/prompt.md" });
    assert(args.includes("--append-system-prompt"));
    const idx = args.indexOf("--append-system-prompt");
    assert.strictEqual(args[idx + 1], "/tmp/prompt.md");
    assert(args.some((a) => a === "任务：t"));
  });
});

describe("extractAgentEndOutput", () => {
  it("从 agent_end 的 messages 数组提取最终文本", () => {
    const out = extractAgentEndOutput(JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "完成。" }] },
      ],
    }));
    assert.strictEqual(out, "完成。");
  });

  it("无有效输出返回空串", () => {
    assert.strictEqual(extractAgentEndOutput(JSON.stringify({ type: "agent_end", messages: [] })), "");
    assert.strictEqual(extractAgentEndOutput("not json"), "");
  });
});

describe("SubagentError 结构化终态", () => {
  it("携带 status（timeout/aborted）与最终 timeline", () => {
    const tl: TimelineEvent[] = [{ id: "l1", type: "lifecycle", ts: "t", state: "starting" }];
    const t = new SubagentError("timeout", "Subagent 超时（600s）", tl);
    assert(t instanceof Error);
    assert.strictEqual(t.name, "SubagentError");
    assert.strictEqual(t.status, "timeout");
    assert.strictEqual(t.message, "Subagent 超时（600s）");
    assert.strictEqual(t.timeline, tl);

    const a = new SubagentError("aborted", "Subagent 已中止");
    assert.strictEqual(a.status, "aborted");
    assert.strictEqual(a.timeline, undefined);
  });

  it("status 只有 timeout | aborted 两种可识别终态", () => {
    const t = new SubagentError("timeout", "Subagent 超时（1s）");
    const a = new SubagentError("aborted", "Subagent 已中止");
    // 类型上即收窄为两种取值；运行期断言保证分类面不漂移
    assert(["timeout", "aborted"].includes(t.status));
    assert(["timeout", "aborted"].includes(a.status));
  });
});

describe("TimelineBuilder 工具事件归一化", () => {
  it("工具 start/update/end 合并为一条 coherent tool 记录", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { cmd: "ls" } }));
    tl.handleLine(JSON.stringify({ type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: { cmd: "ls" }, partialResult: { stdout: "a" } }));
    tl.handleLine(JSON.stringify({ type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: { cmd: "ls" }, partialResult: { stdout: "ab" } }));
    tl.handleLine(JSON.stringify({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { stdout: "abc" }, isError: false }));

    assert.strictEqual(tl.events.length, 1);
    const ev = tl.events[0];
    assert.strictEqual(ev.type, "tool");
    assert.strictEqual(ev.id, "call_1");
    assert.strictEqual(ev.tool, "bash");
    assert(ev.args!.includes("ls"));
    assert.strictEqual(ev.preview, JSON.stringify({ stdout: "ab" }));
    assert.strictEqual(ev.result, JSON.stringify({ stdout: "abc" }));
    assert.strictEqual(ev.ok, true);
  });

  it("工具失败时 ok=false 且保留错误结果", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "/x" } }));
    tl.handleLine(JSON.stringify({ type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: { error: "ENOENT" }, isError: true }));
    const ev = tl.events[0];
    assert.strictEqual(ev.type, "tool");
    assert.strictEqual(ev.ok, false);
    assert(ev.result!.includes("ENOENT"));
  });

  it("end 先于 start 到达时仍产出记录（防御）", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "tool_execution_end", toolCallId: "c9", toolName: "bash", result: { ok: 1 }, isError: false }));
    assert.strictEqual(tl.events.length, 1);
    assert.strictEqual(tl.events[0].id, "c9");
    assert.strictEqual(tl.events[0].ok, true);
  });
});

describe("TimelineBuilder assistant 事件归一化", () => {
  it("message_update 文本增量合并为一条记录，message_end 终结", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } }));
    tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "完成" } }));
    tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "了。" } }));
    tl.handleLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "完成了。" }], timestamp: 1 } }));

    assert.strictEqual(tl.events.length, 1);
    const ev = tl.events[0];
    assert.strictEqual(ev.type, "assistant");
    assert.strictEqual(ev.final, true);
    assert.strictEqual(ev.text, "完成了。"); // message_end 提供权威全文
  });

  it("thinking 增量不进轨迹（不捕获隐藏推理）", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } }));
    tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "秘密推理" } }));
    tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "可见回答" } }));
    tl.handleLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "可见回答" }, { type: "thinking", thinking: "秘密推理" }], timestamp: 1 } }));
    const ev = tl.events[0];
    assert.strictEqual(ev.text, "可见回答");
    assert(!ev.text!.includes("秘密推理"));
  });

  it("delta 先于 start 到达时合成记录（防御）", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "早到" } }));
    assert.strictEqual(tl.events.length, 1);
    assert.strictEqual(tl.events[0].type, "assistant");
    assert.strictEqual(tl.events[0].text, "早到");
  });

  it("非文本 content（仅 toolCall / image）不进可见文本", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], timestamp: 1 } }));
    const ev = tl.events[0];
    assert.strictEqual(ev.type, "assistant");
    assert.strictEqual(ev.text ?? "", "");
    assert.strictEqual(ev.final, true);
  });
});

describe("TimelineBuilder 容错与有界性", () => {
  it("malformed / unknown 行被安全忽略", () => {
    const tl = new TimelineBuilder();
    tl.addLifecycle("starting");
    tl.handleLine("not json {");
    tl.handleLine("");
    tl.handleLine("{}");
    tl.handleLine(JSON.stringify({ foo: 1 }));
    tl.handleLine(JSON.stringify({ type: "unknown_event" }));
    tl.handleLine(JSON.stringify({ type: "message_update" })); // 缺 assistantMessageEvent
    tl.handleLine("null");
    tl.handleLine("[1,2,3]");
    tl.handleLine(JSON.stringify({ type: "agent_end", messages: [] }));
    assert.strictEqual(tl.events.length, 1); // 只有 starting lifecycle
    assert.strictEqual(tl.events[0].state, "starting");
  });

  it("超大工具参数被截断且有界", () => {
    const tl = new TimelineBuilder();
    const huge = "x".repeat(50_000);
    tl.handleLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "c5", toolName: "bash", args: { cmd: huge } }));
    const ev = tl.events[0];
    assert(ev.args!.length <= TIMELINE_MAX_FIELD + 1); // +1 为省略号
  });

  it("assistant 累积文本超限被截断且有界", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } }));
    const chunk = "a".repeat(3000);
    for (let i = 0; i < 5; i++) {
      tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } }));
    }
    const ev = tl.events[0];
    assert(ev.text!.length <= TIMELINE_MAX_TEXT + 1);
  });

  it("遥测归一化错误被隔离，不中断后续采集", () => {
    const tl = new TimelineBuilder();
    // 深度嵌套 JSON：JSON.parse 可能成功，但内部再序列化会抛错（防御路径）；无论哪种都不抛
    const deep = "[" + "[".repeat(100_000) + "]".repeat(100_000) + "]";
    tl.handleLine(deep);
    tl.handleLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "c4", toolName: "bash", args: { x: 1 } }));
    assert.strictEqual(tl.events.length, 1);
    assert.strictEqual(tl.events[0].tool, "bash");
  });

  it("500 条上限：超限丢弃最旧并置 truncated 标记", () => {
    const tl = new TimelineBuilder();
    for (let i = 0; i < TIMELINE_MAX_ENTRIES + 10; i++) {
      tl.handleLine(JSON.stringify({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: "bash", args: { i } }));
      tl.handleLine(JSON.stringify({ type: "tool_execution_end", toolCallId: `c${i}`, toolName: "bash", result: { i }, isError: false }));
    }
    assert.strictEqual(tl.events.length, TIMELINE_MAX_ENTRIES);
    const first = tl.events[0];
    assert.strictEqual(first.type, "lifecycle");
    assert.strictEqual(first.truncated, true);
    assert.strictEqual(first.state, "truncated");
    // 最新记录保留
    assert.strictEqual(tl.events[tl.events.length - 1].id, `c${TIMELINE_MAX_ENTRIES + 9}`);
  });

  it("截断标记替换最旧记录（注入小上限验证语义）", () => {
    const tl = new TimelineBuilder({ maxEntries: 5 });
    for (let i = 0; i < 8; i++) tl.addLifecycle(`step-${i}`);
    assert.strictEqual(tl.events.length, 5);
    assert.strictEqual(tl.events[0].truncated, true);
    assert.strictEqual(tl.events[tl.events.length - 1].state, "step-7");
    // truncated 标记唯一
    assert.strictEqual(tl.events.filter((e) => e.truncated).length, 1);
  });
});

describe("TimelineBuilder.handleLine 内容变化报告", () => {
  it("原地修改（tool update/end、assistant delta/end）也报告变化", () => {
    const tl = new TimelineBuilder();
    // tool start（新增 → 变化）
    assert.strictEqual(
      tl.handleLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { cmd: "ls" } })),
      true,
    );
    // tool update：原地改 preview（不改变条数）→ 必须报告
    assert.strictEqual(
      tl.handleLine(JSON.stringify({ type: "tool_execution_update", toolCallId: "c1", partialResult: { stdout: "a" } })),
      true,
    );
    // tool end：原地写 result/ok → 必须报告
    assert.strictEqual(
      tl.handleLine(JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", result: { stdout: "ab" }, isError: false })),
      true,
    );
    // message_start（assistant，新增）
    assert.strictEqual(
      tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } })),
      true,
    );
    // text_delta：原地累积文本 → 必须报告（GUI 实时刷新依赖它）
    assert.strictEqual(
      tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "答" } })),
      true,
    );
    // message_end：原地终结 → 必须报告
    assert.strictEqual(
      tl.handleLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "答" }] } })),
      true,
    );
  });

  it("无可见变化的事件不报告（thinking_delta / 未知工具 update / malformed）", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
    assert.strictEqual(
      tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "推理" } })),
      false, // 隐藏推理不进轨迹 → 无可见变化
    );
    assert.strictEqual(
      tl.handleLine(JSON.stringify({ type: "tool_execution_update", toolCallId: "nope", partialResult: { x: 1 } })),
      false, // 未知进行中工具 → 忽略
    );
    assert.strictEqual(tl.handleLine("not json"), false);
    assert.strictEqual(tl.handleLine(JSON.stringify({ type: "unknown" })), false);
    assert.strictEqual(tl.handleLine(JSON.stringify({ type: "message_update" })), false); // 缺 assistantMessageEvent
  });

  it("追加 delta 到已满文本不报告变化（上限内无可见变化）", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
    tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(TIMELINE_MAX_TEXT + 100) } }));
    // 已达上限：后续 delta 不再有可见变化
    assert.strictEqual(
      tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y" } })),
      false,
    );
  });
});

describe("TimelineBuilder role 过滤（user/toolResult 不进轨迹）", () => {
  it("仅 user/toolResult 的 start/end 不产生任何轨迹", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "worker 用户输入" }], id: "u1" } }));
    tl.handleLine(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "worker 用户输入" }], id: "u1" } }));
    tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "tool", content: [{ type: "toolResult", toolCallId: "c1", content: "ls 输出" }], id: "tr1" } }));
    tl.handleLine(JSON.stringify({ type: "message_end", message: { role: "tool", content: [{ type: "toolResult", toolCallId: "c1", content: "ls 输出" }], id: "tr1" } }));
    assert.strictEqual(tl.events.length, 0);
    assert(!JSON.stringify(tl.events).includes("worker 用户输入"));
    assert(!JSON.stringify(tl.events).includes("ls 输出"));
  });

  it("user 输入不混入 assistant 轨迹（delta 只来自 assistant）", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "秘密用户输入" }], id: "u1" } }));
    tl.handleLine(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "秘密用户输入" }], id: "u1" } }));
    tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [], id: "a1" } }));
    tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "可见回答" } }));
    tl.handleLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "可见回答" }], id: "a1" } }));
    assert.strictEqual(tl.events.length, 1);
    const ev = tl.events[0];
    assert.strictEqual(ev.type, "assistant");
    assert.strictEqual(ev.text, "可见回答");
    assert(!JSON.stringify(tl.events).includes("秘密用户输入"));
  });

  it("user 的 message_end 不终结进行中的 assistant 记录（异常顺序防御）", () => {
    const tl = new TimelineBuilder();
    tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [], id: "a1" } }));
    tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "前半" } }));
    // 异常顺序：user 的 start/end 穿插在 assistant 流中，不得终结或污染
    tl.handleLine(JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "穿插输入" }], id: "u1" } }));
    tl.handleLine(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "穿插输入" }], id: "u1" } }));
    tl.handleLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "后半" } }));
    tl.handleLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "前半后半" }], id: "a1" } }));
    assert.strictEqual(tl.events.length, 1);
    const ev = tl.events[0];
    assert.strictEqual(ev.text, "前半后半");
    assert.strictEqual(ev.final, true);
    assert(!JSON.stringify(tl.events).includes("穿插输入"));
  });
});

describe("TimelineBuilder lifecycle 与终态", () => {
  it("lifecycle 记录：starting 与终态（带注入时钟）", () => {
    const tl = new TimelineBuilder({ now: () => "2026-08-07T00:00:00.000Z" });
    tl.addLifecycle("starting");
    tl.addLifecycle("success", "执行完成");
    assert.strictEqual(tl.events.length, 2);
    assert.strictEqual(tl.events[0].type, "lifecycle");
    assert.strictEqual(tl.events[0].state, "starting");
    assert.strictEqual(tl.events[1].state, "success");
    assert.strictEqual(tl.events[1].message, "执行完成");
    assert.strictEqual(tl.events[1].ts, "2026-08-07T00:00:00.000Z");
  });

  it("终态推导：success/failed/aborted/timeout", () => {
    assert.strictEqual(resolveTerminalState({ aborted: false, timedOut: false, exitCode: 0 }), "success");
    assert.strictEqual(resolveTerminalState({ aborted: false, timedOut: false, exitCode: 1 }), "failed");
    assert.strictEqual(resolveTerminalState({ aborted: false, timedOut: false, exitCode: 0, stopReason: "error" }), "failed");
    assert.strictEqual(resolveTerminalState({ aborted: true, timedOut: true, exitCode: 0 }), "timeout");
    assert.strictEqual(resolveTerminalState({ aborted: true, timedOut: false, exitCode: 0 }), "aborted");
    assert.strictEqual(resolveTerminalState({ aborted: false, timedOut: false, exitCode: 0, stopReason: "aborted" }), "aborted");
  });
});
