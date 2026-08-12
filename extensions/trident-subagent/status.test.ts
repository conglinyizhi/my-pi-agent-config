// status.test.ts — 运行时状态快照行为测试（内存快照 + 状态文件）
//
// 覆盖：beginBatch 建立快照、updateWorker 按 id 打补丁、timeline 可选字段
// 随更新写入并在终态保留、未知 id 更新不改快照。测试写真实状态文件（同
// feedback.test.ts 模式），结束后用 after 钩子恢复原内容。
//
// I-2 热路径 I/O：用注入的内存写入器 + 手动推进的假调度器，确定性验证——
//   连发实时更新合并为单次落盘（有界延迟 COALESCE_DELAY_MS），写入最新 snapshot
//   不丢终态；启动/终态/显式 flush 立即落盘并取消挂起合并写。
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/status.test.ts

import assert from "node:assert";
import { after, describe, it } from "node:test";
import { readFileSync, writeFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginBatch,
  updateWorker,
  getSnapshot,
  flushStatusFile,
  configureStatusFile,
  resetStatusFile,
  COALESCE_DELAY_MS,
  type WorkerRun,
} from "./status.ts";
// batch.ts 新增的 inbox 前置准备助手（validateWorkerInboxIds / prepareInboxes）在此覆盖：
// batch.test.ts 不在 Task 3 允许修改的文件清单内，测试集中在允许的 status.test.ts 中。
import { validateWorkerInboxIds, prepareInboxes } from "./batch.ts";
import type { TimelineEvent } from "../../lib/subagent-run.ts";

const STATUS_PATH = join(homedir(), ".pi", "subagent-status.json");
let orig = "";
try { orig = readFileSync(STATUS_PATH, "utf-8"); } catch { /* 文件可能不存在 */ }

function makeRun(id: string, inboxId?: string): WorkerRun {
  return {
    id,
    inboxId: inboxId ?? `batch-1-abc-${id}`,
    task: "t", model: "m", status: "starting", startedAt: new Date().toISOString(),
  };
}

/** 注入 IO：内存写入器 + 可手动推进的假调度器（确定性，不等真实 250ms） */
function makeInjectedIO() {
  const writes: string[] = [];
  const pending = new Map<number, () => void>();
  let seq = 0;
  let lastDelay = 0;
  return {
    writes,
    /** configureStatusFile 的 schedule 实现：记录延迟、入队，不启动真实定时器 */
    schedule: (fn: () => void, delayMs: number) => {
      lastDelay = delayMs;
      const id = ++seq;
      pending.set(id, fn);
      return id;
    },
    cancel: (id: unknown) => { pending.delete(id as number); },
    /** 手动推进：执行全部挂起定时器（模拟 COALESCE_DELAY_MS 到期） */
    firePending: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    pendingCount: () => pending.size,
    lastDelay: () => lastDelay,
    lastJson: () => (writes.length ? JSON.parse(writes[writes.length - 1]) : null),
  };
}

/** 装好注入 IO 并 beginBatch 一个 worker，返回 io 句柄 */
function setupInjected(runs: WorkerRun[] = [makeRun("w1")]) {
  resetStatusFile(); // 清掉前序测试挂起写，恢复默认 IO
  const io = makeInjectedIO();
  configureStatusFile({
    path: "/fake/subagent-status.json",
    writeFile: (_p, d) => io.writes.push(d),
    now: () => "2026-08-07T00:00:00.000Z",
    schedule: io.schedule,
    cancel: io.cancel,
  });
  beginBatch(runs);
  return io;
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

  it("inboxId 随快照与状态文件保留（仅安全 id，不暴露队列文件路径）", () => {
    const io = setupInjected([makeRun("w1", "batch-abc123-w1")]);
    updateWorker("w1", { status: "running", pid: 9 });
    updateWorker("w1", { status: "success", finishedAt: "t" });
    const w = getSnapshot()[0];
    assert.strictEqual(w.inboxId, "batch-abc123-w1");
    assert.strictEqual(w.status, "success");
    const json = io.lastJson();
    assert.strictEqual(json.workers[0].inboxId, "batch-abc123-w1");
    assert(!JSON.stringify(json).includes("subagent-supplements"), "快照不暴露队列文件路径");
  });
});

describe("status coalesced writes (I-2 热路径 I/O)", () => {
  it("连发实时更新合并为单次落盘，且写入最新 snapshot（不丢最终状态）", () => {
    const io = setupInjected();
    assert.strictEqual(io.writes.length, 1); // beginBatch 立即写

    for (let i = 1; i <= 50; i++) {
      updateWorker("w1", { stderr: `line ${i}` }); // 非终态 → 合并
    }
    assert.strictEqual(io.writes.length, 1); // 尚未落盘（合并中）
    assert.strictEqual(io.pendingCount(), 1); // 只有一个挂起定时器
    assert.strictEqual(io.lastDelay(), COALESCE_DELAY_MS); // 有界延迟上限

    io.firePending(); // 模拟 COALESCE_DELAY_MS 到期
    assert.strictEqual(io.writes.length, 2); // 50 连发合并为一次落盘
    const last = io.lastJson();
    assert.strictEqual(last.updatedAt, "2026-08-07T00:00:00.000Z");
    assert.strictEqual(last.workers[0].stderr, "line 50"); // 最新 snapshot，未丢
    assert.strictEqual(last.workers[0].status, "starting");
  });

  it("终态立即落盘并取消挂起合并写（终态快照含最新实时字段）", () => {
    const io = setupInjected();
    const before = io.writes.length;
    updateWorker("w1", { stderr: "x" }); // 合并，未落盘
    updateWorker("w1", { stderr: "y" }); // 合并，未落盘
    assert.strictEqual(io.writes.length, before);
    assert.strictEqual(io.pendingCount(), 1);

    updateWorker("w1", { status: "success", finishedAt: "t2" }); // 终态 → 立即
    assert.strictEqual(io.writes.length, before + 1);
    assert.strictEqual(io.pendingCount(), 0); // 挂起写已取消（本次写入已含最新快照）
    const snap = io.lastJson();
    assert.strictEqual(snap.workers[0].status, "success");
    assert.strictEqual(snap.workers[0].stderr, "y"); // 终态快照保留合并期最新实时字段

    io.firePending(); // 取消后无残留写
    assert.strictEqual(io.writes.length, before + 1);
  });

  it("启动状态（starting）立即落盘，不合并", () => {
    const io = setupInjected();
    const before = io.writes.length;
    updateWorker("w1", { status: "starting", pid: 7 });
    assert.strictEqual(io.writes.length, before + 1);
    assert.strictEqual(io.pendingCount(), 0);
    assert.strictEqual(io.lastJson().workers[0].status, "starting");
  });

  it("flushStatusFile 显式落盘挂起合并写", () => {
    const io = setupInjected();
    const before = io.writes.length;
    updateWorker("w1", { stderr: "pending" }); // 合并，未落盘
    assert.strictEqual(io.writes.length, before);
    assert.strictEqual(io.pendingCount(), 1);

    flushStatusFile(); // 显式 flush → 立即落盘
    assert.strictEqual(io.writes.length, before + 1);
    assert.strictEqual(io.pendingCount(), 0);
    assert.strictEqual(io.lastJson().workers[0].stderr, "pending");
  });

  it("timeline: undefined 的补丁不覆盖已有实时 timeline（I-1 catch 保留语义）", () => {
    const io = setupInjected();
    const tl: TimelineEvent[] = [
      { id: "l1", type: "lifecycle", ts: "t", state: "starting" },
    ];
    updateWorker("w1", { timeline: tl }); // 实时轨迹先写入
    // 终态补丁不含 timeline 键（等价 buildTerminalPatch 对无 timeline 错误的输出）
    updateWorker("w1", { status: "timeout", finishedAt: "t2" });
    const w = getSnapshot()[0];
    assert.strictEqual(w.status, "timeout");
    assert.strictEqual(w.timeline, tl); // 已有实时 timeline 未被 undefined 抹掉
    assert.strictEqual(w.timeline!.length, 1);
  });
});

describe("默认写入器原子落盘（临时文件 + rename，无半截文件）", () => {
  it("写入完整 JSON、覆盖旧内容、不残留临时文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-atomic-"));
    const path = join(dir, "subagent-status.json");
    try {
      // 只注入 path，writeFile 缺省 → 走默认原子写入器
      configureStatusFile({ path, now: () => "2026-08-12T00:00:00.000Z" });
      beginBatch([makeRun("w1")]);
      const first = JSON.parse(readFileSync(path, "utf-8"));
      assert.strictEqual(first.workers[0].id, "w1");

      updateWorker("w1", { status: "success", finishedAt: "t2" }); // 终态立即落盘（同一路径二次 rename 覆盖）
      const second = JSON.parse(readFileSync(path, "utf-8"));
      assert.strictEqual(second.workers[0].status, "success");

      const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
      assert.deepStrictEqual(leftovers, []); // rename 后不残留临时文件
    } finally {
      resetStatusFile();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("batch inbox 前置准备（validateWorkerInboxIds / prepareInboxes）", () => {
  it("validateWorkerInboxIds：长度必须与 tasks 一致（缺失/多余都拒绝）", () => {
    assert.throws(() => validateWorkerInboxIds(["a", "b"], ["only-one"]), /length/);
    assert.throws(() => validateWorkerInboxIds(["a"], []), /length/);
    assert.doesNotThrow(() => validateWorkerInboxIds(["a", "b"], ["batch-1-w1", "batch-1-w2"]));
  });

  it("validateWorkerInboxIds：非法 id 拒绝（路径穿越 / 空 / 超长）", () => {
    assert.throws(() => validateWorkerInboxIds(["a"], ["../evil"]), /invalid worker inboxId/);
    assert.throws(() => validateWorkerInboxIds(["a"], [""]), /invalid worker inboxId/);
    assert.throws(() => validateWorkerInboxIds(["a"], ["x".repeat(129)]), /invalid worker inboxId/);
  });

  it("prepareInboxes：按序对每个 inboxId 恰好 create 一次（spawn 前完成，无并发重复）", async () => {
    const created: string[] = [];
    await prepareInboxes(["batch-1-w1", "batch-1-w2", "batch-1-w3"], async (id) => {
      created.push(id);
    });
    assert.deepStrictEqual(created, ["batch-1-w1", "batch-1-w2", "batch-1-w3"]);
  });

  it("prepareInboxes：任一 create 失败即整体拒绝，后续 inbox 不再创建（不留半批）", async () => {
    const created: string[] = [];
    await assert.rejects(
      () => prepareInboxes(["batch-1-w1", "batch-1-w2", "batch-1-w3"], async (id) => {
        created.push(id);
        if (id === "batch-1-w2") throw new Error("create failed");
      }),
      /create failed/,
    );
    assert.deepStrictEqual(created, ["batch-1-w1", "batch-1-w2"]); // 失败即停：w3 未创建
  });
});

after(() => {
  resetStatusFile(); // 取消挂起写、恢复默认 IO（顺序在恢复文件内容之前）
  try { writeFileSync(STATUS_PATH, orig); } catch { rmSync(STATUS_PATH, { force: true }); }
});
