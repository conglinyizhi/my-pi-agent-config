// silence.test.ts — 静默崩溃判定与看门狗
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/silence.test.ts
//
// 盯四件事：
//   1 阈值：不到 30 秒不判（阈值可注入，测试用短值）
//   2 豁免：在跑工具 / 等审批 / 暂存 / 排队都不算静默（go build 两分钟没输出不该判崩）
//   3 看门狗：判崩就写状态 + 中止，且同一条只判一次
//   4 终态改写：崩溃不被「怎么中止的」盖掉

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TimelineEvent } from "../../lib/subagent-run.ts";
import type { WorkerRun } from "./status.ts";
import {
  SILENT_CRASH_MS,
  applyCrashMark,
  detectSilentCrashes,
  hasToolInFlight,
  lastNonLifecycle,
  quietCrashOf,
  silentCrashReason,
  silentMsOf,
  startSilenceWatch,
  type SilentCrash,
} from "./silence.ts";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");

function run(over: Partial<WorkerRun> = {}): WorkerRun {
  return {
    id: "w1",
    inboxId: "batch-1-w1",
    task: "t",
    model: "m",
    status: "running",
    startedAt: new Date(NOW - 60_000).toISOString(),
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

const toolEvent = (over: Partial<TimelineEvent> = {}): TimelineEvent =>
  ({ id: "t1", type: "tool", ts: "t", tool: "bash", ...over }) as TimelineEvent;

describe("阈值与静默时长", () => {
  it("不到阈值不判", () => {
    const w = run({ lastActivityAt: new Date(NOW - (SILENT_CRASH_MS - 1)).toISOString() });
    assert.equal(quietCrashOf(w, NOW), undefined);
  });

  it("到阈值就判，说明里带上秒数", () => {
    const w = run({ lastActivityAt: new Date(NOW - SILENT_CRASH_MS).toISOString() });
    const crash = quietCrashOf(w, NOW);
    assert.ok(crash);
    assert.equal(crash.silentMs, SILENT_CRASH_MS);
    assert.match(crash.reason, /静默 30 秒/);
    assert.match(crash.reason, /判定为崩溃并中止/);
  });

  it("阈值可注入（测试用短值）", () => {
    const w = run({ lastActivityAt: new Date(NOW - 1500).toISOString() });
    assert.equal(quietCrashOf(w, NOW), undefined);
    assert.ok(quietCrashOf(w, NOW, 1000));
  });

  it("没有 lastActivityAt 就从 startedAt 起算", () => {
    const w = run({ lastActivityAt: undefined, startedAt: new Date(NOW - 40_000).toISOString() });
    assert.equal(silentMsOf(w, NOW), 40_000);
    assert.ok(quietCrashOf(w, NOW));
  });

  it("已终态一律不算", () => {
    const w = run({ finishedAt: new Date(NOW - 1000).toISOString(), lastActivityAt: new Date(NOW - 90_000).toISOString() });
    assert.equal(silentMsOf(w, NOW), 0);
    assert.equal(quietCrashOf(w, NOW), undefined);
  });
});

describe("豁免：不是在卡，是在等", () => {
  it("工具还在飞（默认 bash 长构建）不算", () => {
    const w = run({ lastActivityAt: new Date(NOW - 120_000).toISOString(), timeline: [toolEvent()] });
    assert.equal(hasToolInFlight(w), true);
    assert.equal(quietCrashOf(w, NOW), undefined);
  });

  it("工具已经回来了：不再豁免", () => {
    const w = run({ lastActivityAt: new Date(NOW - 120_000).toISOString(), timeline: [toolEvent({ ok: true })] });
    assert.equal(hasToolInFlight(w), false);
    assert.ok(quietCrashOf(w, NOW));
  });

  it("lifecycle 事件不参与「工具在飞」的判定", () => {
    const w = run({
      lastActivityAt: new Date(NOW - 120_000).toISOString(),
      timeline: [toolEvent(), { id: "l1", type: "lifecycle", ts: "t", state: "running" } as TimelineEvent],
    });
    assert.equal(hasToolInFlight(w), true, "尾部是 lifecycle 也要往前找到那条 tool");
    assert.equal(lastNonLifecycle(w.timeline as TimelineEvent[])?.type, "tool");
  });

  it("等审批 / 暂存 / 排队都不算静默", () => {
    for (const status of ["needs_approval", "holding", "queued"] as const) {
      const w = run({ status, lastActivityAt: new Date(NOW - 300_000).toISOString() });
      assert.equal(quietCrashOf(w, NOW), undefined, status);
    }
  });

  it("启动后一声不吭要算（上游握手卡住也属这一类）", () => {
    const w = run({ status: "starting", lastActivityAt: new Date(NOW - 40_000).toISOString() });
    assert.ok(quietCrashOf(w, NOW));
  });
});

describe("一轮检查", () => {
  it("只挑在飞且没被判过的", () => {
    const silent = run({ id: "w1", lastActivityAt: new Date(NOW - 60_000).toISOString() });
    const busy = run({ id: "w2", lastActivityAt: new Date(NOW - 1000).toISOString() });
    const marked = run({ id: "w3", lastActivityAt: new Date(NOW - 60_000).toISOString() });
    const hits = detectSilentCrashes([silent, busy, marked], NOW, { alreadyMarked: new Set(["w3"]) });
    assert.deepEqual(hits.map((h) => h.run.id), ["w1"]);
  });
});

describe("看门狗", () => {
  /** 跑一轮 tick：用假时钟 + 手动推间隔 */
  async function driveWatch(input: {
    runs: WorkerRun[];
    controllers?: Map<string, AbortController>;
    now: () => number;
  }): Promise<{ marks: Map<string, SilentCrash>; marked: string[]; guard: () => void }> {
    const marks = new Map<string, SilentCrash>();
    const marked: string[] = [];
    const guard = startSilenceWatch({
      controllers: input.controllers ?? new Map(),
      marks,
      runs: () => input.runs,
      markStatus: (_run, crash) => {
        marked.push(crash.reason);
      },
      thresholdMs: 1000,
      intervalMs: 5,
      now: input.now,
    });
    await new Promise((r) => setTimeout(r, 25));
    guard();
    return { marks, marked, guard };
  }

  it("判崩：写状态一次、中止一次，同一个 worker 不重复判", async () => {
    const controller = new AbortController();
    const controllers = new Map([["w1", controller]]);
    const w = run({ lastActivityAt: new Date(NOW - 60_000).toISOString() });
    const { marks, marked } = await driveWatch({ runs: [w], controllers, now: () => NOW });
    assert.equal(marked.length, 1, "同一个 worker 只该判一次");
    assert.ok(marks.has("w1"));
    assert.equal(controller.signal.aborted, true);
    // 中止理由带崩溃说明：worker 自己的轨迹里会写「外部停止：…」而不是「用户强停」
    assert.match((controller.signal.reason as Error).message, /静默 60 秒/);
  });

  it("没到阈值不动手", async () => {
    const controller = new AbortController();
    const w = run({ lastActivityAt: new Date(NOW).toISOString() });
    const { marks, marked } = await driveWatch({ runs: [w], controllers: new Map([["w1", controller]]), now: () => NOW });
    assert.equal(marked.length, 0);
    assert.equal(marks.size, 0);
    assert.equal(controller.signal.aborted, false);
  });

  it("没有取消句柄也不会抛（只标状态）", async () => {
    const w = run({ lastActivityAt: new Date(NOW - 60_000).toISOString() });
    const { marks } = await driveWatch({ runs: [w], now: () => NOW });
    assert.ok(marks.has("w1"));
  });

  it("停止函数摘掉定时器", async () => {
    const w = run({ lastActivityAt: new Date(NOW - 60_000).toISOString() });
    const { guard } = await driveWatch({ runs: [w], now: () => NOW });
    guard(); // 幂等
  });

  it("中止理由是个普通 Error（不是用户强停）", () => {
    const err = silentCrashReason({ silentMs: 30_000, reason: "静默 30 秒" });
    assert.equal(err.name, "Error");
    assert.equal(err.message, "静默 30 秒");
  });
});

describe("终态改写：崩溃不被「怎么中止的」盖掉", () => {
  const crash: SilentCrash = { silentMs: 31_000, reason: "静默 31 秒没有任何事件，判定为崩溃并中止" };

  it("aborted 被改写成 crashed，说明换成崩溃原因", () => {
    const patch: { status?: string; output?: string; finishedAt: string } = applyCrashMark(
      { status: "aborted", output: "原来的说明", finishedAt: "t" },
      crash,
    );
    assert.equal(patch.status, "crashed");
    assert.equal(patch.output, crash.reason);
    assert.equal(patch.finishedAt, "t", "其它字段照旧");
  });

  it("没标记就原样返回（普通中止不受影响）", () => {
    const patch = applyCrashMark<{ status?: string; output?: string }>({ status: "aborted" }, undefined);
    assert.equal(patch.status, "aborted");
    assert.equal(patch.output, undefined);
  });
});
