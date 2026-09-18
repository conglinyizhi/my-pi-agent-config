// batch.test.ts — 终态分类、catch 补丁构造与并发节流测试（I-1 超时状态一致性）
//
// runBatch 的真实子进程路径无法在单测中可靠触发超时/外部中止，这里直接测 catch
// 路径复用的纯函数：classifyTerminalError / buildTerminalPatch，覆盖：
//   - timeout → status "timeout"（batch 的 WorkerStatus / BatchItemResult.status / lifecycle）
//   - 外部 abort → status "aborted"
//   - 最终 timeline 随错误保留；undefined 不得写入补丁（不覆盖已有实时 timeline）
//   - 分类不依赖错误消息文本（不再用 /超时/ 正则误判）
//
// 另覆盖并发节流 runWithConcurrency：同时在飞数不超过额度、结果与输入同序、
// 单个失败不拖死其他任务、非法额度被夹到 [1, items.length]。
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/batch.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import type { HoldDeferHandle } from "../../lib/subagent-hold.ts";
import { SubagentError, type TimelineEvent } from "../../lib/subagent-run.ts";
import {
  classifyTerminalError,
  buildTerminalPatch,
  formatCatchOutput,
  runWithConcurrency,
  MAX_PARALLEL_WORKERS_SAFETY_CAP,
  createDeferQueue,
} from "./batch.ts";

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

describe("runWithConcurrency（并发节流）", () => {
  /** 造一个能观测「同时在飞」峰值的任务：进入即 +1，离开即 -1 */
  function tracker() {
    const state = { inFlight: 0, peak: 0, started: [] as number[], done: [] as number[] };
    return {
      state,
      task: async (item: number, index: number) => {
        state.inFlight++;
        state.peak = Math.max(state.peak, state.inFlight);
        state.started.push(index);
        await new Promise((r) => setTimeout(r, 5));
        state.inFlight--;
        state.done.push(index);
        return item * 10;
      },
    };
  }

  it("同时最多 limit 个在飞，且全部跑完", async () => {
    const { state, task } = tracker();
    const out = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 2, task);
    assert.strictEqual(state.peak, 2, "峰值并发必须被限在 2");
    assert.strictEqual(out.length, 7);
    assert.strictEqual(state.done.length, 7);
  });

  it("结果与输入同序（汇报按输入顺序逐项列出）", async () => {
    const { task } = tracker();
    const out = await runWithConcurrency([1, 2, 3], 1, task);
    assert.deepStrictEqual(out, [10, 20, 30]);
  });

  it("额度为 1 时严格串行，不产生重叠", async () => {
    const { state, task } = tracker();
    await runWithConcurrency([1, 2, 3], 1, task);
    assert.strictEqual(state.peak, 1);
    // 串行语义：started/done 顺序必须一致
    assert.deepStrictEqual(state.started, state.done);
  });

  it("额度大于任务数时只开任务数条协程", async () => {
    const { state, task } = tracker();
    await runWithConcurrency([1, 2], 99, task);
    assert.strictEqual(state.peak, 2);
    assert.strictEqual(state.done.length, 2);
  });

  it("非法额度（0 / 负数 / 小数）被夹到合法范围", async () => {
    for (const limit of [0, -3, 1.7]) {
      const { state, task } = tracker();
      await runWithConcurrency([1, 2, 3], limit, task);
      assert.ok(state.peak >= 1 && state.peak <= 3, `limit=${limit} 峰值 ${state.peak}`);
      assert.strictEqual(state.done.length, 3);
    }
  });

  it("空输入立即返回空数组（不启动任何任务）", async () => {
    let calls = 0;
    const out = await runWithConcurrency([], 2, async () => {
      calls++;
      return 0;
    });
    assert.deepStrictEqual(out, []);
    assert.strictEqual(calls, 0);
  });

  it("单个任务抛错会向上冒泡（终态消化由 runWorker 负责，池不吞）", async () => {
    await assert.rejects(
      () => runWithConcurrency([1, 2, 3], 2, async (_item, index) => {
        if (index === 1) throw new Error("worker 内部错误");
        return index;
      }),
      /worker 内部错误/,
    );
  });

  it("并发安全阀只挡极端大批次（正常批次齐射，上游限速走退避重试）", () => {
    assert.ok(MAX_PARALLEL_WORKERS_SAFETY_CAP >= 4, "安全阀不该低到变成日常节流");
    assert.ok(MAX_PARALLEL_WORKERS_SAFETY_CAP <= 16, "安全阀也不该高到形同虚设");
  });
});

describe("createDeferQueue：暂存句柄队列", () => {
  const handle = (id: string): HoldDeferHandle => ({
    request: { version: 1, requestId: id, reason: "budget", elapsedMs: 1000, remainingMs: 0, createdAt: new Date().toISOString() },
    resume: () => {},
  });

  it("push 之后 wait 立即返回（不挂住）", async () => {
    const q = createDeferQueue();
    q.push("w1", handle("r1"));
    const settled = await Promise.race([q.wait().then(() => "resolved"), new Promise((r) => setTimeout(() => r("hung"), 20))]);
    assert.strictEqual(settled, "resolved");
  });

  it("先 wait 后 push：等待者被唤醒", async () => {
    const q = createDeferQueue();
    let woke = false;
    const waiting = q.wait().then(() => { woke = true; });
    assert.strictEqual(woke, false);
    q.push("w1", handle("r1"));
    await waiting;
    assert.strictEqual(woke, true);
  });

  it("takePending 取走即清空，同一个请求不会被决策两次", () => {
    const q = createDeferQueue();
    q.push("w1", handle("r1"));
    assert.strictEqual(q.takePending().length, 1);
    assert.strictEqual(q.takePending().length, 0);
  });

  it("resume 把决定交回句柄，并消费掉它", () => {
    const q = createDeferQueue();
    const seen: string[] = [];
    q.push("w1", { ...handle("r1"), resume: (d) => seen.push(d.action) });
    assert.strictEqual(q.resume("w1", { action: "continue" }), true);
    assert.deepStrictEqual(seen, ["continue"]);
    assert.strictEqual(q.resume("w1", { action: "stop" }), false, "同一个请求不该被决策第二次");
  });

  it("resume 一个没收过暂存的 worker 返回 false", () => {
    const q = createDeferQueue();
    assert.strictEqual(q.resume("w9", { action: "continue" }), false);
  });

  it("同一个 worker 续跑后又暂存：旧句柄被新句柄替换", () => {
    const q = createDeferQueue();
    const seen: string[] = [];
    q.push("w1", { ...handle("r1"), resume: () => seen.push("旧") });
    q.push("w1", { ...handle("r2"), resume: () => seen.push("新") });
    assert.strictEqual(q.resume("w1", { action: "continue" }), true);
    assert.deepStrictEqual(seen, ["新"], "该走最新的那次暂存，旧句柄已经过期");
  });

  it("多个 worker 各自待决，互不串台", () => {
    const q = createDeferQueue();
    const seen: string[] = [];
    q.push("w1", { ...handle("r1"), resume: (d) => seen.push(`w1:${d.action}`) });
    q.push("w2", { ...handle("r2"), resume: (d) => seen.push(`w2:${d.action}`) });
    assert.strictEqual(q.takePending().length, 2);
    q.resume("w2", { action: "stop" });
    q.resume("w1", { action: "continue" });
    assert.deepStrictEqual(seen, ["w2:stop", "w1:continue"]);
  });
});
