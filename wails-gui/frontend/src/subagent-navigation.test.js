// subagent-navigation.test.js — 轮询层 selection 归一化与 timeline 自动跟随决策
//
// reconcileNavigation({ viewLevel, selectedId, selectedEventId }, workers)：
//   只归一化 selection 状态，不碰任何滚动值；绝不变异入参 state 或 workers。
//    - agents/timeline 上有效的 selected worker 保持原层级与原 selection；
//      有效的 agents 层 selection 不会因为“它存在”而被清掉。
//    - event 层：worker 仍在且事件仍在 → 全量保留；worker 在但事件消失 →
//      回 timeline，保留 selectedId，selectedEventId 置 null。
//    - 任何层级：selectedId 非空但 worker 已不存在 → 回 agents，两个 ID 置 null。
//    - selectedId 为空 → 归一化到 agents，清掉遗留 selectedEventId。
//    事件存在性一律经 readerEvents(worker) 判定（合成 terminal 记录也算有效事件）。
//
// shouldFollowTimeline({ viewLevel, selectedId, workers, atBottom })：
//   仅当 level=timeline、selected worker 存在、atBottom 为真（“跟随最新”而非
//   “已冻结”）时返回 true；agents/event、缺失 selection/worker、冻结阅读
//   （atBottom=false）一律 false。
//
// 跑法：node --test src/subagent-navigation.test.js

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileNavigation, shouldFollowTimeline } from "./subagent-navigation.js";

const worker = (id, timeline = []) => ({ id, status: "running", timeline });

describe("reconcileNavigation", () => {
  it("keeps a valid agents-level selection unchanged", () => {
    const state = { viewLevel: "agents", selectedId: "w1", selectedEventId: null };
    const result = reconcileNavigation(state, [worker("w1", [{ id: "e1" }])]);
    assert.deepEqual(result, { viewLevel: "agents", selectedId: "w1", selectedEventId: null });
  });

  it("keeps a valid timeline selection unchanged", () => {
    const state = { viewLevel: "timeline", selectedId: "w1", selectedEventId: null };
    const result = reconcileNavigation(state, [worker("w1", [{ id: "e1" }])]);
    assert.deepEqual(result, { viewLevel: "timeline", selectedId: "w1", selectedEventId: null });
  });

  it("never clears a valid agents-level selection merely because it exists", () => {
    const state = { viewLevel: "agents", selectedId: "w1", selectedEventId: "e1" };
    const result = reconcileNavigation(state, [worker("w1", [{ id: "e1" }])]);
    assert.deepEqual(result, { viewLevel: "agents", selectedId: "w1", selectedEventId: "e1" });
  });

  it("preserves a valid event selection when the event is present", () => {
    const state = { viewLevel: "event", selectedId: "w1", selectedEventId: "e1" };
    const result = reconcileNavigation(state, [worker("w1", [{ id: "e1" }, { id: "e2" }])]);
    assert.deepEqual(result, { viewLevel: "event", selectedId: "w1", selectedEventId: "e1" });
  });

  it("returns timeline with the same worker when the selected event has disappeared", () => {
    const state = { viewLevel: "event", selectedId: "w1", selectedEventId: "gone" };
    const result = reconcileNavigation(state, [worker("w1", [{ id: "e1" }])]);
    assert.deepEqual(result, { viewLevel: "timeline", selectedId: "w1", selectedEventId: null });
  });

  it("uses readerEvents so synthetic terminal records count as live events", () => {
    const state = { viewLevel: "event", selectedId: "w1", selectedEventId: "synthetic-terminal-output" };
    const workers = [{ id: "w1", status: "running", timeline: [{ id: "e1" }], output: "final line" }];
    const result = reconcileNavigation(state, workers);
    assert.deepEqual(result, { viewLevel: "event", selectedId: "w1", selectedEventId: "synthetic-terminal-output" });
  });

  it("clears both IDs and returns agents from every level when the worker is gone", () => {
    for (const viewLevel of ["agents", "timeline", "event"]) {
      const state = { viewLevel, selectedId: "gone", selectedEventId: "e1" };
      const result = reconcileNavigation(state, [worker("w1", [{ id: "e1" }])]);
      assert.deepEqual(result, { viewLevel: "agents", selectedId: null, selectedEventId: null }, `from ${viewLevel}`);
    }
  });

  it("normalizes a missing selectedId to agents and clears a stale event id", () => {
    const state = { viewLevel: "event", selectedId: null, selectedEventId: "e1" };
    const result = reconcileNavigation(state, [worker("w1", [{ id: "e1" }])]);
    assert.deepEqual(result, { viewLevel: "agents", selectedId: null, selectedEventId: null });
  });

  it("does not mutate the input state or worker list", () => {
    const timeline = [{ id: "e1" }, { id: "e2" }];
    const w1 = { id: "w1", status: "running", timeline };
    const state = { viewLevel: "event", selectedId: "w1", selectedEventId: "gone" };
    const workers = [w1];
    const stateSnapshot = { ...state };
    const result = reconcileNavigation(state, workers);
    assert.deepEqual(state, stateSnapshot, "输入 state 不得被修改");
    assert.equal(workers.length, 1, "worker 列表不得增删");
    assert.equal(workers[0], w1, "worker 对象引用不得被替换");
    assert.equal(workers[0].timeline, timeline, "timeline 数组不得被替换");
    assert.deepEqual(workers[0].timeline, [{ id: "e1" }, { id: "e2" }], "timeline 内容不得被修改");
    assert.notEqual(result, state, "应返回新的归一化对象");
  });
});

describe("shouldFollowTimeline", () => {
  const live = worker("w1", [{ id: "e1" }]);

  it("accepts a live bottom-following timeline state", () => {
    assert.equal(
      shouldFollowTimeline({ viewLevel: "timeline", selectedId: "w1", workers: [live], atBottom: true }),
      true
    );
  });

  it("rejects agents and event levels", () => {
    assert.equal(shouldFollowTimeline({ viewLevel: "agents", selectedId: "w1", workers: [live], atBottom: true }), false);
    assert.equal(shouldFollowTimeline({ viewLevel: "event", selectedId: "w1", workers: [live], atBottom: true }), false);
  });

  it("rejects a missing selectedId", () => {
    assert.equal(shouldFollowTimeline({ viewLevel: "timeline", selectedId: null, workers: [live], atBottom: true }), false);
  });

  it("rejects a missing worker", () => {
    assert.equal(shouldFollowTimeline({ viewLevel: "timeline", selectedId: "gone", workers: [live], atBottom: true }), false);
  });

  it("rejects a frozen reader (not at bottom)", () => {
    assert.equal(shouldFollowTimeline({ viewLevel: "timeline", selectedId: "w1", workers: [live], atBottom: false }), false);
  });
});
