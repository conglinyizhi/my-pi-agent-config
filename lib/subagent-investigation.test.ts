// lib/subagent-investigation.test.ts — 调查摘要/文件纯代码组装测试
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TimelineEvent } from "./subagent-run.ts";
import {
  buildInlineSummary,
  buildTranscriptBody,
  writeIncidentFiles,
  writeInvestigationFile,
  TRANSCRIPT_CONVERSATION_BYTES,
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

  it("带全量档时给出 transcript 路径（模型只拿路径，不拿内容）", () => {
    const s = buildInlineSummary(input(), "/tmp/inv/w1.md", "/tmp/inv/w1-transcript.md");
    assert.match(s, /investigation: \/tmp\/inv\/w1\.md/);
    assert.match(s, /transcript: \/tmp\/inv\/w1-transcript\.md/);
    assert.ok(s.length < 4000);
  });
});

describe("buildTranscriptBody（全量档）", () => {
  const conv = [
    { role: "user" as const, content: "改 batch.ts 重试逻辑", ts: "2026-08-11T00:00:00.000Z" },
    { role: "assistant" as const, content: "先看 retry 策略，再改 planRetry。", ts: "2026-08-11T00:01:00.000Z" },
  ];

  it("含元信息、任务原文、完整可见往返、轨迹与 stderr", () => {
    const body = buildTranscriptBody(input({ attempts: [snap({ visibleConversation: conv })] }));
    for (const h of [
      "# Subagent 全量档（内存盘）",
      "## 元信息",
      "## 任务原文",
      "## 可见往返",
      "## 执行轨迹",
      "## stderr",
    ]) {
      assert.ok(body.includes(h), `missing section ${h}`);
    }
    assert.match(body, /改 batch\.ts 重试逻辑/);
    assert.match(body, /先看 retry 策略，再改 planRetry。/);
    assert.match(body, /cat src\/a\.ts/, "工具参数要完整出现（不按 120 字截）");
    assert.match(body, /warn/);
  });

  // 时间线单条字段在实时轨迹里已经截过；全量档不再叠一层 120 字截断
  it("长工具输出不被 120 字截断卡住", () => {
    const long = "x".repeat(5000);
    const body = buildTranscriptBody(input({
      attempts: [snap({
        timeline: [{ id: "t9", type: "tool", ts: "t", tool: "bash", args: `{"command":"${long}"}`, result: long, ok: true }],
      })],
    }));
    assert.ok(body.includes(long), "完整字段应原样进入全量档");
  });

  it("超总量时裁中间并明写裁了多少（内存盘不能敞开写）", () => {
    const huge = "y".repeat(TRANSCRIPT_CONVERSATION_BYTES + 200_000);
    const body = buildTranscriptBody(input({
      attempts: [snap({ visibleConversation: [{ role: "assistant", content: huge, ts: "t" }] })],
    }));
    assert.match(body, /省略 \d+ 字节/);
    assert.match(body, /## 裁剪说明\n- 可见往返裁掉 \d+ 字节/);
  });
});

describe("writeIncidentFiles（摘要 + 全量档同目录）", () => {
  it("两个文件都写出，且摘要的读档指引指向全量档", () => {
    const files = writeIncidentFiles(input({
      attempts: [snap({
        visibleConversation: [{ role: "assistant", content: "进度：已定位 planRetry", ts: "t" }],
      })],
    }));
    assert.ok(fs.existsSync(files.investigationPath));
    assert.ok(fs.existsSync(files.transcriptPath));
    assert.strictEqual(path.dirname(files.investigationPath), files.dir);
    assert.strictEqual(path.dirname(files.transcriptPath), files.dir);

    const summary = fs.readFileSync(files.investigationPath, "utf-8");
    const transcript = fs.readFileSync(files.transcriptPath, "utf-8");
    assert.ok(summary.includes(files.transcriptPath), "摘要把全量档路径写进读档指引");
    assert.match(transcript, /进度：已定位 planRetry/);

    try { fs.rmSync(files.dir, { recursive: true, force: true }); } catch { /* ignore */ }
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
