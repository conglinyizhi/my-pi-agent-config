// fleet-watch.test.ts — 工具行实时投影订阅
//
// 纯调度：注入快照、订阅、时钟与 interval，不 spawn、不写盘。
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/fleet-watch.test.ts

import assert from "node:assert";
import { after, describe, it } from "node:test";
import { watchFleet, fleetSummaryText, FLEET_TICK_MS } from "./fleet-watch.ts";
import {
  beginBatch,
  updateWorker,
  resetStatusFile,
  configureStatusFile,
  type WorkerRun,
} from "./status.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function run(overrides: Partial<WorkerRun> = {}): WorkerRun {
  return {
    id: "w1",
    inboxId: "batch-x-w1",
    task: "任务",
    model: "test/model",
    status: "running",
    startedAt: new Date(T0).toISOString(),
    lastActivityAt: new Date(T0 + 10_000).toISOString(),
    ...overrides,
  };
}

describe("fleetSummaryText", () => {
  it("把 holding 从运行里拆出来，不当成还在跑", () => {
    const text = fleetSummaryText([
      run({ id: "w1", status: "holding" }),
      run({ id: "w2", status: "running" }),
      run({ id: "w3", status: "success" }),
    ]);
    assert.match(text, /运行 1/);
    assert.match(text, /完成 1/);
    assert.match(text, /1 暂存/);
    assert.doesNotMatch(text, /运行 2/);
  });
});

describe("watchFleet", () => {
  after(() => {
    resetStatusFile();
  });

  function harness(workers: WorkerRun[]) {
    const frames: Array<{ text: string; ids: string[]; statuses: string[] }> = [];
    const listeners = new Set<(next: WorkerRun[]) => void>();
    let snapshot = workers;
    let clock = T0;
    const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const timers: Array<{ at: number; fn: () => void; canceled: boolean }> = [];

    const watch = watchFleet((partial) => {
      const fleet = partial.details.fleet;
      frames.push({
        text: partial.content[0].text,
        ids: fleet.map((w) => w.id),
        statuses: fleet.map((w) => w.status),
      });
    }, {
      emitIntervalMs: 0,
      tickMs: 250,
      now: () => clock,
      getWorkers: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      scheduler: {
        now: () => clock,
        schedule: (fn, ms) => {
          const t = { at: clock + ms, fn, canceled: false, unref: () => undefined };
          timers.push(t);
          return t;
        },
        cancel: (h) => {
          (h as { canceled: boolean }).canceled = true;
        },
        interval: (fn, ms) => {
          const handle = { fn, ms, cleared: false, unref: () => undefined };
          intervals.push(handle);
          return handle;
        },
        clearInterval: (handle) => {
          (handle as { cleared: boolean }).cleared = true;
        },
      },
    });

    const notify = (next: WorkerRun[]) => {
      snapshot = next;
      for (const listener of listeners) listener(next);
    };
    const advance = (ms: number) => {
      clock += ms;
      for (const t of timers) {
        if (!t.canceled && t.at <= clock) {
          t.canceled = true;
          t.fn();
        }
      }
      for (const interval of intervals) {
        if (interval.cleared) continue;
        // 简化：每次推进若跨过一个 tick 就打一拍
        if (ms >= interval.ms) interval.fn();
      }
    };

    return { watch, frames, notify, advance, listeners, intervals };
  }

  it("首帧立即送达当前快照，不 beginBatch", () => {
    const workers = [run({ status: "holding" }), run({ id: "w2", status: "success" })];
    const { watch, frames } = harness(workers);
    assert.strictEqual(frames.length, 1);
    assert.deepStrictEqual(frames[0].ids, ["w1", "w2"]);
    assert.deepStrictEqual(frames[0].statuses, ["holding", "success"]);
    assert.match(frames[0].text, /1 暂存/);
    watch.stop();
  });

  it("快照变更推新帧；stop 后退订，后续变更不再进这一行", () => {
    const { watch, frames, notify, listeners } = harness([run({ status: "holding" })]);
    assert.strictEqual(frames.length, 1);
    notify([run({ status: "running" })]);
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[1].statuses[0], "running");
    watch.stop();
    assert.strictEqual(listeners.size, 0);
    const before = frames.length;
    notify([run({ status: "success" })]);
    assert.strictEqual(frames.length, before);
  });

  it("无事件时 tick 仍重投影", () => {
    const { watch, frames, advance, intervals } = harness([run({ status: "running" })]);
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(intervals.length, 1);
    assert.strictEqual(intervals[0].ms, FLEET_TICK_MS);
    advance(250);
    assert.ok(frames.length >= 2, `tick 后应有新帧，实际 ${frames.length}`);
    watch.stop();
    assert.strictEqual(intervals[0].cleared, true);
  });

  it("接真实 status 快照：resume 路径只订阅，不覆盖批次", () => {
    resetStatusFile();
    configureStatusFile({
      path: "/fake/subagent-status.json",
      writeFile: () => undefined,
      now: () => new Date(T0).toISOString(),
      schedule: () => 1,
      cancel: () => undefined,
    });
    beginBatch([
      run({ id: "w1", status: "holding" }),
      run({ id: "w2", status: "success" }),
    ]);
    const frames: string[][] = [];
    const watch = watchFleet((partial) => {
      frames.push(partial.details.fleet.map((w) => `${w.id}:${w.status}`));
    }, { tickMs: 60_000, emitIntervalMs: 0 });
    try {
      assert.deepStrictEqual(frames[0], ["w1:holding", "w2:success"]);
      updateWorker("w1", { status: "running" });
      assert.deepStrictEqual(frames.at(-1), ["w1:running", "w2:success"]);
    } finally {
      watch.stop();
    }
    // 停了之后真实快照还在，证明没 beginBatch 清表
    updateWorker("w1", { status: "success" });
    assert.deepStrictEqual(frames.at(-1), ["w1:running", "w2:success"]);
  });

  it("stop 把节流里挂起的末帧刷出去", () => {
    const frames: string[][] = [];
    const listeners = new Set<(next: WorkerRun[]) => void>();
    let snapshot = [run({ status: "holding" })];
    let clock = T0;
    const timers: Array<{ at: number; fn: () => void; canceled: boolean }> = [];
    const watch = watchFleet((partial) => {
      frames.push(partial.details.fleet.map((w) => w.status));
    }, {
      emitIntervalMs: 150,
      tickMs: 60_000,
      now: () => clock,
      getWorkers: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      scheduler: {
        now: () => clock,
        schedule: (fn, ms) => {
          const t = { at: clock + ms, fn, canceled: false, unref: () => undefined };
          timers.push(t);
          return t;
        },
        cancel: (h) => {
          (h as { canceled: boolean }).canceled = true;
        },
        interval: (fn) => ({ fn, unref: () => undefined }),
        clearInterval: () => undefined,
      },
    });
    assert.deepStrictEqual(frames[0], ["holding"]);
    snapshot = [run({ status: "running" })];
    for (const listener of listeners) listener(snapshot);
    assert.strictEqual(frames.length, 1, "间隔内应还挂着，没立刻送达");
    watch.stop();
    assert.deepStrictEqual(frames.at(-1), ["running"]);
    assert.strictEqual(listeners.size, 0);
  });
});
