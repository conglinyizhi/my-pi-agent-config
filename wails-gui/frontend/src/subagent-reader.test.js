// subagent-reader.test.js — 事件列表与上一条/下一条边界逻辑
//
// readerEvents(worker)：把 worker.timeline 原样保留（对象与顺序不变、不改入参数组），
// 末尾追加非空 output/stderr 的合成 terminal 记录。合成 ID 使用不与原 timeline ID
// 碰撞的稳定前缀（synthetic-terminal-*），若与现有事件 ID 重名则追加 -N 兜底。
// 空字符串/纯空白 output/stderr 一律不生成记录。
//
// adjacentEventId(events, eventId, direction)：direction 仅接受 -1 | 1；
// 未知 eventId、越界、非法方向一律返回 null。
//
// 跑法：node --test src/subagent-reader.test.js

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adjacentEventId, eventIndex, readerEvents } from "./subagent-reader.js";

const TERMINAL_OUTPUT_ID = "synthetic-terminal-output";
const TERMINAL_STDERR_ID = "synthetic-terminal-stderr";

describe("readerEvents", () => {
  it("keeps timeline order and appends non-empty terminal records", () => {
    const timeline = [{ id: "m1", type: "assistant" }];
    const events = readerEvents({ timeline, output: "final", stderr: "warning" });
    assert.deepEqual(events.map((e) => e.id), ["m1", TERMINAL_OUTPUT_ID, TERMINAL_STDERR_ID]);
  });

  it("preserves timeline object identity and does not mutate the input array", () => {
    const timeline = [{ id: "m1", type: "assistant" }];
    const snapshot = [...timeline];
    const events = readerEvents({ timeline, output: "final", stderr: "warning" });
    assert.equal(events[0], timeline[0], "原 timeline 对象引用必须保持不变");
    assert.equal(timeline.length, 1, "不得向入参数组追加合成记录");
    assert.deepEqual(timeline, snapshot, "入参数组内容不得被修改");
  });

  it("drops empty and whitespace-only output/stderr", () => {
    const events = readerEvents({
      timeline: [{ id: "m1" }],
      output: "",
      stderr: "   \n\t  ",
    });
    assert.deepEqual(events.map((e) => e.id), ["m1"]);
  });

  it("keeps whitespace-padded non-empty text verbatim", () => {
    const events = readerEvents({ timeline: [], output: "  done  " });
    assert.equal(events.length, 1);
    assert.equal(events[0].stream, "output");
    assert.equal(events[0].type, "terminal");
    assert.equal(events[0].text, "  done  ");
  });

  it("handles missing worker/timeline gracefully", () => {
    assert.deepEqual(readerEvents(), []);
    assert.deepEqual(readerEvents({}), []);
    const events = readerEvents({ timeline: null, output: "x" });
    assert.deepEqual(events.map((e) => e.id), [TERMINAL_OUTPUT_ID]);
  });

  it("uses collision-safe suffixed id when a timeline event already carries the synthetic id", () => {
    const timeline = [{ id: TERMINAL_OUTPUT_ID, type: "tool" }];
    const events = readerEvents({ timeline, output: "x" });
    assert.equal(events.length, 2);
    assert.equal(events[1].id, `${TERMINAL_OUTPUT_ID}-2`);
  });
});

describe("eventIndex", () => {
  it("finds event by id and returns -1 for unknown id", () => {
    const events = [{ id: "a" }, { id: "b" }];
    assert.equal(eventIndex(events, "a"), 0);
    assert.equal(eventIndex(events, "b"), 1);
    assert.equal(eventIndex(events, "missing"), -1);
  });

  it("returns -1 for non-array input", () => {
    assert.equal(eventIndex(undefined, "a"), -1);
    assert.equal(eventIndex(null, "a"), -1);
    assert.equal(eventIndex("nope", "a"), -1);
  });
});

describe("adjacentEventId", () => {
  const events = [{ id: "one" }, { id: "two" }];

  it("does not navigate beyond either boundary", () => {
    assert.equal(adjacentEventId(events, "one", -1), null);
    assert.equal(adjacentEventId(events, "one", 1), "two");
    assert.equal(adjacentEventId(events, "two", 1), null);
    assert.equal(adjacentEventId(events, "two", -1), "one");
  });

  it("returns null for unknown eventId", () => {
    assert.equal(adjacentEventId(events, "missing", 1), null);
    assert.equal(adjacentEventId(events, "missing", -1), null);
  });

  it("returns null for invalid directions (only -1 and 1 are valid)", () => {
    const three = [{ id: "one" }, { id: "two" }, { id: "three" }];
    assert.equal(adjacentEventId(three, "two", 0), null);
    assert.equal(adjacentEventId(three, "two", 2), null);
    assert.equal(adjacentEventId(three, "two", -2), null);
    assert.equal(adjacentEventId(three, "two", NaN), null);
    assert.equal(adjacentEventId(three, "two", undefined), null);
  });

  it("returns null for empty or single-element lists", () => {
    assert.equal(adjacentEventId([{ id: "only" }], "only", 1), null);
    assert.equal(adjacentEventId([], "x", 1), null);
  });
});
