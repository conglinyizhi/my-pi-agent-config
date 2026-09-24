// held-report.test.ts — 暂存回报（产物 + 限时）与 resume 参数校验
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/held-report.test.ts
//
// 这两块的共同目的：让「续/停」这个决定踩在产物与明确限时上，而不是靠猜。

import assert from "node:assert";
import { describe, it } from "node:test";
import type { TimelineEvent, VisibleWorkerMessage } from "../../lib/subagent-run.ts";
import {
  formatHeldArtifact,
  formatHeldReport,
  HELD_TEXT_BUDGET,
  RESUME_MAX_SECONDS,
  RESUME_MIN_SECONDS,
  validateResumeDecisions,
} from "./held-report.ts";

const conversation: VisibleWorkerMessage[] = [
  { role: "user", content: "改 batch.ts 重试逻辑", ts: "t" },
  { role: "assistant", content: "已定位 planRetry，准备改退避基数。", ts: "t" },
];

const timeline: TimelineEvent[] = [
  { id: "a1", type: "assistant", ts: "t", text: "已定位 planRetry" },
  { id: "t1", type: "tool", ts: "t", tool: "bash", args: '{"command":"pnpm test"}', ok: true },
  { id: "l1", type: "lifecycle", ts: "t", state: "hold", message: "请求暂存" },
];

describe("formatHeldArtifact", () => {
  it("首行给身份与耗时（双格式），后面带产物", () => {
    const lines = formatHeldArtifact({
      workerId: "w1",
      elapsedMs: 238_000,
      reason: "budget",
      conversation,
      timeline,
      stderr: "warn: deprecated\n",
    });
    const text = lines.join("\n");
    assert.match(text, /w1 已跑 238s（00:03:58） · 时间预算快用完了/);
    assert.match(text, /最新产物：已定位 planRetry，准备改退避基数。/);
    assert.match(text, /最后步骤：tool:bash ok/);
    assert.match(text, /pnpm test/);
    assert.match(text, /最后步骤：lifecycle:hold · 请求暂存/);
    assert.match(text, /stderr 尾：warn: deprecated/);
  });

  it("没有可见输出时明说，不把留白留给模型猜", () => {
    const text = formatHeldArtifact({ workerId: "w2", elapsedMs: 5_000, reason: "worker" })
      .join("\n");
    assert.match(text, /w2 已跑 5s（00:00:05） · worker 主动请求/);
    assert.match(text, /（暂停瞬间还没有可见输出）/);
  });

  it("超预算的产物留尾部（最新动向最有用）", () => {
    const long = `${"前".repeat(HELD_TEXT_BUDGET)}结尾标记`;
    const text = formatHeldArtifact({
      workerId: "w1",
      elapsedMs: 1_000,
      reason: "budget",
      conversation: [{ role: "assistant", content: long, ts: "t" }],
    }).join("\n");
    assert.match(text, /…/);
    assert.match(text, /结尾标记/);
    assert.ok(!text.includes("前".repeat(HELD_TEXT_BUDGET + 10)), "超长产物要截");
  });

  it("没有可见往返时退回 output 兜底", () => {
    const text = formatHeldArtifact({
      workerId: "w3",
      elapsedMs: 1_000,
      reason: "budget",
      output: "暂存中（时间预算快用完了）：等主侧决定",
    }).join("\n");
    assert.match(text, /最新产物：暂存中/);
  });
});

describe("formatHeldReport", () => {
  const report = formatHeldReport({
    batchId: "batch-abc",
    finishedCount: 2,
    held: [
      { workerId: "w1", elapsedMs: 238_000, reason: "budget", conversation },
      { workerId: "w2", elapsedMs: 10_000, reason: "worker", timeline },
    ],
  });

  it("抬头写明几个人停下、本批完成几个", () => {
    assert.match(report, /2 个 worker 停在检查点上等你决定（本批已完成 2 个）/);
  });

  it("逐个 worker 带产物", () => {
    assert.match(report, /w1 已跑 238s（00:03:58）/);
    assert.match(report, /最新产物：已定位 planRetry/);
    assert.match(report, /w2 已跑 10s（00:00:10）/);
  });

  it("续跑示例带 batch_id 与 extra_seconds，并写明限时与上限", () => {
    assert.match(report, /subagent_resume\(\{ batch_id: "batch-abc", decisions: \[/);
    assert.match(report, /worker_id: "w1", action: "continue", extra_seconds: 300/);
    assert.match(report, new RegExp(`${RESUME_MIN_SECONDS} 到 ${RESUME_MAX_SECONDS}`));
    assert.match(report, /检查点不会无限期等/);
  });
});

describe("validateResumeDecisions", () => {
  it("continue 带合规限时、stop 不带限时都放行", () => {
    assert.strictEqual(validateResumeDecisions([{ worker_id: "w1", action: "continue", extra_seconds: 300 }]), undefined);
    assert.strictEqual(validateResumeDecisions([{ worker_id: "w1", action: "stop" }]), undefined);
  });

  it("continue 缺限时：整次拒掉，并说清缺什么", () => {
    const err = validateResumeDecisions([{ worker_id: "w1", action: "continue" }]);
    assert.ok(err);
    assert.match(err as string, /w1/);
    assert.match(err as string, /必须给 extra_seconds/);
    assert.match(err as string, /未执行任何决定/);
  });

  it("限时越界（含手滑写很大）也拒", () => {
    for (const seconds of [0, 4, RESUME_MAX_SECONDS + 1, 86_400]) {
      const err = validateResumeDecisions([{ worker_id: "w1", action: "continue", extra_seconds: seconds }]);
      assert.ok(err, `${seconds}s 应被拒`);
      assert.match(err as string, new RegExp(`${RESUME_MIN_SECONDS} 到 ${RESUME_MAX_SECONDS}`));
    }
  });

  it("非数字限时同样拒（NaN / 字符串）", () => {
    assert.ok(validateResumeDecisions([{ worker_id: "w1", action: "continue", extra_seconds: Number.NaN }]));
    assert.ok(validateResumeDecisions([{ worker_id: "w1", action: "continue", extra_seconds: "300" }]));
  });

  it("空数组拒", () => {
    assert.ok(validateResumeDecisions([]));
    assert.ok(validateResumeDecisions(undefined));
  });
});
