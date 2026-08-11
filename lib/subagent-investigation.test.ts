// lib/subagent-investigation.test.ts — 调查摘要/文件纯代码组装测试
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TimelineEvent } from "./subagent-run.ts";
import {
  buildInlineSummary,
  writeInvestigationFile,
  type InvestigationInput,
  type AttemptSnapshot,
} from "./subagent-investigation.ts";

const tl: TimelineEvent[] = [
  { id: "t1", type: "tool", ts: "t", tool: "bash", args: '{"command":"cat src/a.ts"}', ok: true },
  { id: "a1", type: "assistant", ts: "t", text: "准备修改 batch.ts", final: true },
  { id: "l1", type: "lifecycle", ts: "t", state: "timeout", message: "timeout" },
];

function snap(over: Partial<AttemptSnapshot> = {}): AttemptSnapshot {
  return {
    attempt: 1,
    status: "timeout",
    exitCode: 1,
    errorMessage: "Subagent 超时（600s）",
    stderr: "warn\n",
    timeline: tl,
    startedAt: "2026-08-11T00:00:00.000Z",
    finishedAt: "2026-08-11T00:10:00.000Z",
    ...over,
  };
}

function input(over: Partial<InvestigationInput> = {}): InvestigationInput {
  return {
    task: "改 batch.ts 重试逻辑",
    taskId: "batch-x-w1",
    model: "worker",
    cwd: "/tmp/proj",
    attempts: [snap()],
    finalStatus: "timeout",
    maxAttempts: 6,
    startedAt: "2026-08-11T00:00:00.000Z",
    finishedAt: "2026-08-11T00:10:00.000Z",
    ...over,
  };
}

describe("buildInlineSummary", () => {
  it("含 attempts、final、error、last_steps、investigation 路径与读档提示", () => {
    const s = buildInlineSummary(input(), "/tmp/pi-subagent-inv-x/w1.md");
    assert.match(s, /attempts=1\/6/);
    assert.match(s, /final=timeout/);
    assert.match(s, /error:/);
    assert.match(s, /last_steps:/);
    assert.match(s, /investigation: \/tmp\/pi-subagent-inv-x\/w1\.md/);
    assert.match(s, /读档/);
    assert.ok(s.length < 4000, "inline summary must stay compact");
  });
});

describe("writeInvestigationFile", () => {
  it("写出固定章节的轻量 md 并返回路径", () => {
    const path_ = writeInvestigationFile(input({
      attempts: [
        snap({ attempt: 1, status: "failed", errorMessage: "sse cut" }),
        snap({ attempt: 2, status: "timeout" }),
      ],
      finalStatus: "timeout",
    }));
    assert.ok(fs.existsSync(path_));
    const body = fs.readFileSync(path_, "utf-8");
    for (const h of [
      "# Subagent 调查摘要",
      "## 读档指引（主 agent）",
      "## 元信息",
      "## 任务",
      "## 最终结论",
      "## Attempt 摘要",
      "## 最后步骤",
      "## 线索",
    ]) {
      assert.ok(body.includes(h), `missing section ${h}`);
    }
    assert.match(body, /#1 failed/);
    assert.match(body, /#2 timeout/);
    assert.match(body, /src\/a\.ts|batch\.ts/);
    // cleanup
    try { fs.unlinkSync(path_); fs.rmdirSync(path.dirname(path_)); } catch { /* ignore */ }
  });
});
