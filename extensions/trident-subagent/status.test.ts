// status.test.ts — 运行时状态快照行为测试（内存快照 + 状态文件）
//
// 覆盖：beginBatch 建立快照、updateWorker 按 id 打补丁、timeline 可选字段
// 随更新写入并在终态保留、未知 id 更新不改快照。测试写真实状态文件（同
// feedback.test.ts 模式），结束后用 after 钩子恢复原内容。
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/status.test.ts

import assert from "node:assert";
import { after, describe, it } from "node:test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beginBatch, updateWorker, getSnapshot, type WorkerRun } from "./status.ts";
import type { TimelineEvent } from "../../lib/subagent-run.ts";

const STATUS_PATH = join(homedir(), ".pi", "subagent-status.json");
let orig = "";
try { orig = readFileSync(STATUS_PATH, "utf-8"); } catch { /* 文件可能不存在 */ }

function makeRun(id: string): WorkerRun {
  return { id, task: "t", model: "m", status: "starting", startedAt: new Date().toISOString() };
}

describe("status snapshot", () => {
  it("beginBatch 建立快照，updateWorker 按 id 打补丁", () => {
    beginBatch([makeRun("w1"), makeRun("w2")]);
    updateWorker("w1", { status: "running", pid: 42 });
    const snap = getSnapshot();
    assert.strictEqual(snap.length, 2);
    assert.strictEqual(snap[0].status, "running");
    assert.strictEqual(snap[0].pid, 42);
    assert.strictEqual(snap[1].status, "starting");
  });

  it("timeline 可选字段随更新写入并在终态保留", () => {
    beginBatch([makeRun("w1")]);
    const tl: TimelineEvent[] = [
      { id: "l1", type: "lifecycle", ts: new Date().toISOString(), state: "starting" },
      { id: "t1", type: "tool", ts: new Date().toISOString(), tool: "bash" },
    ];
    updateWorker("w1", { timeline: tl });
    updateWorker("w1", { status: "success", finishedAt: new Date().toISOString() });
    const w = getSnapshot()[0];
    assert.strictEqual(w.timeline, tl); // 同一引用保留
    assert.strictEqual(w.timeline!.length, 2);
    assert.strictEqual(w.timeline![1].tool, "bash");
    assert.strictEqual(w.status, "success");
    assert(w.finishedAt);
  });

  it("未知 id 更新不改快照", () => {
    beginBatch([]);
    updateWorker("nope", { status: "failed" });
    assert.strictEqual(getSnapshot().length, 0);
  });
});

after(() => {
  try { writeFileSync(STATUS_PATH, orig); } catch { rmSync(STATUS_PATH, { force: true }); }
});
