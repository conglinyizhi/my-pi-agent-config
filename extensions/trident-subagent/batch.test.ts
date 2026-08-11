// batch.test.ts — 终态分类与 catch 补丁构造测试（I-1 超时状态一致性）
//
// runBatch 的真实子进程路径无法在单测中可靠触发超时/外部中止，这里直接测 catch
// 路径复用的纯函数：classifyTerminalError / buildTerminalPatch，覆盖：
//   - timeout → status "timeout"（batch 的 WorkerStatus / BatchItemResult.status / lifecycle）
//   - 外部 abort → status "aborted"
//   - 最终 timeline 随错误保留；undefined 不得写入补丁（不覆盖已有实时 timeline）
//   - 分类不依赖错误消息文本（不再用 /超时/ 正则误判）
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/batch.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { SubagentError, type TimelineEvent } from "../../lib/subagent-run.ts";
import { classifyTerminalError, buildTerminalPatch, formatCatchOutput } from "./batch.ts";

describe("classifyTerminalError / buildTerminalPatch", () => {
  const tl: TimelineEvent[] = [
    { id: "l1", type: "lifecycle", ts: "t", state: "starting" },
    { id: "t1", type: "tool", ts: "t", tool: "bash" },
  ];
  const FINISHED = "2026-08-07T00:00:00.000Z";

  it("timeout 错误映射为 timeout 并保留最终 timeline", () => {
    const err = new SubagentError("timeout", "Subagent 超时（600s）", tl);
    const patch = buildTerminalPatch(err, FINISHED);
    assert.strictEqual(patch.status, "timeout");
    assert.strictEqual(patch.timeline, tl);
    assert.strictEqual(patch.finishedAt, FINISHED);
  });

  it("外部 abort 映射为 aborted 并保留最终 timeline", () => {
    const err = new SubagentError("aborted", "Subagent 已中止", tl);
    const patch = buildTerminalPatch(err, FINISHED);
    assert.strictEqual(patch.status, "aborted");
    assert.strictEqual(patch.timeline, tl);
  });

  it("无 timeline 的错误：补丁不含 timeline 键（不覆盖已有实时 timeline）", () => {
    const err = new SubagentError("aborted", "Subagent 已中止"); // 未带 timeline
    const patch = buildTerminalPatch(err, FINISHED);
    assert.strictEqual(patch.status, "aborted");
    assert(!("timeline" in patch), "timeline: undefined 不得写入补丁");
  });

  it("未知错误兜底为 aborted（不误标 timeout）", () => {
    const patch = buildTerminalPatch(new Error("boom"), FINISHED);
    assert.strictEqual(patch.status, "aborted");
    assert(!("timeline" in patch));
  });

  it("分类由结构化 status 决定，不依赖错误消息文本（不再用 /超时/ 正则）", () => {
    // 即便把消息改成任意文本，timeout 仍归 timeout、abort 仍归 aborted
    assert.strictEqual(classifyTerminalError(new SubagentError("timeout", "任意消息", tl)).status, "timeout");
    assert.strictEqual(classifyTerminalError(new SubagentError("aborted", "任意消息", tl)).status, "aborted");
    // 而纯文本错误（即使含"超时"字样）不误标为 timeout
    assert.strictEqual(classifyTerminalError(new Error("Subagent 超时（600s）")).status, "aborted");
  });

  it("SubagentError 携带 investigationPath 时 catch 输出附读档指引（结果层保留）", () => {
    const err = new SubagentError("timeout", "Subagent 超时（600s）", tl, "/tmp/inv.md");
    assert.strictEqual(err.investigationPath, "/tmp/inv.md");
    const out = formatCatchOutput(err, "timeout");
    assert(out.includes("/tmp/inv.md"), "输出含调查文件路径");
    assert(out.includes("读档"), "输出含读档指引");
    assert(out.includes("FAILED final=timeout"));
  });

  it("无 investigationPath 的错误：formatCatchOutput 回退空串，由调用方兜底 String(err)", () => {
    assert.strictEqual(formatCatchOutput(new Error("boom"), "aborted"), "");
    assert.strictEqual(formatCatchOutput(new SubagentError("aborted", "Subagent 已中止"), "aborted"), "");
  });
});
