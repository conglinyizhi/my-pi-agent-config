import test from "node:test";
import assert from "node:assert/strict";
import {
  CANCEL,
  CONFIRM_WITHOUT_REASON,
  CONFIRM_WITH_REASON,
  describeWorker,
  runStopAllCommand,
  runStopCommand,
  type StopCommandDeps,
  type StopUi,
} from "./stop-commands.ts";
import type { WorkerRun } from "./status.ts";
import type { WorkerKey } from "./active-workers.ts";

function run(overrides: Partial<WorkerRun> = {}): WorkerRun {
  return {
    id: "w1",
    inboxId: "batch-a-w1",
    task: "用 bash 执行 sleep 45\n然后汇报",
    model: "test-model",
    status: "running",
    startedAt: new Date(Date.now() - 12_000).toISOString(),
    ...overrides,
  };
}

function makeUi(answers: { select?: (string | undefined)[]; input?: (string | undefined)[] } = {}) {
  const selects: { title: string; options: string[] }[] = [];
  const inputs: string[] = [];
  const notes: { message: string; level: string }[] = [];
  const selectQueue = [...(answers.select ?? [])];
  const inputQueue = [...(answers.input ?? [])];
  const ui: StopUi = {
    async select(title, options) {
      selects.push({ title, options });
      return selectQueue.shift();
    },
    async input(title) {
      inputs.push(title);
      return inputQueue.shift();
    },
    notify(message, level) {
      notes.push({ message, level });
    },
  };
  return { ui, selects, inputs, notes };
}

function makeDeps(active: WorkerKey[], runs: WorkerRun[]) {
  const stopped: { key: WorkerKey; reason: string }[] = [];
  const stopAllReasons: string[] = [];
  const deps: StopCommandDeps = {
    listActive: () => active,
    snapshot: () => runs,
    stopOne: (key, reason) => {
      stopped.push({ key, reason });
      return active.some((k) => k.batchId === key.batchId && k.workerId === key.workerId);
    },
    stopAll: (reason) => {
      stopAllReasons.push(reason);
      return active.length;
    },
  };
  return { deps, stopped, stopAllReasons };
}

const KEY = { batchId: "batch-a", workerId: "w1" };

test("没有在跑的 worker：只通知，不弹选人屏", async () => {
  const { ui, selects, notes } = makeUi();
  const { deps, stopped } = makeDeps([], []);
  await runStopCommand(ui, deps);
  assert.equal(selects.length, 0);
  assert.equal(stopped.length, 0);
  assert.match(notes[0].message, /没有在跑/);
});

test("选人屏取消：什么都不停", async () => {
  const { ui, selects, notes } = makeUi({ select: [undefined] });
  const { deps, stopped } = makeDeps([KEY], [run()]);
  await runStopCommand(ui, deps);
  assert.equal(selects.length, 1, "取消后不该继续弹下一屏");
  assert.equal(stopped.length, 0);
  assert.equal(notes.length, 0);
});

test("第三屏取消：确认屏弹了，但不停", async () => {
  const { ui, selects, notes } = makeUi({ select: ["w1 · 运行 · 已跑 12s · 用 bash 执行 sleep 45", CANCEL] });
  const { deps, stopped } = makeDeps([KEY], [run()]);
  await runStopCommand(ui, deps);
  assert.equal(selects.length, 2);
  assert.equal(selects[1].options.length, 3, "第三屏是三选一");
  assert.equal(stopped.length, 0);
  assert.equal(notes.length, 0);
});

test("额外填写理由后确认：理由进 stopOne", async () => {
  const label = describeWorker(KEY, run());
  const { ui, inputs, notes } = makeUi({ select: [label, CONFIRM_WITH_REASON], input: ["方向跑偏了"] });
  const { deps, stopped } = makeDeps([KEY], [run()]);
  await runStopCommand(ui, deps);
  assert.equal(inputs.length, 1);
  assert.deepEqual(stopped, [{ key: KEY, reason: "方向跑偏了" }]);
  assert.match(notes[0].message, /已停 w1：方向跑偏了/);
});

test("不书写理由直接确认：不弹输入框，理由为空", async () => {
  const label = describeWorker(KEY, run());
  const { ui, inputs, notes } = makeUi({ select: [label, CONFIRM_WITHOUT_REASON] });
  const { deps, stopped } = makeDeps([KEY], [run()]);
  await runStopCommand(ui, deps);
  assert.equal(inputs.length, 0);
  assert.deepEqual(stopped, [{ key: KEY, reason: "" }]);
  assert.match(notes[0].message, /^已停 w1$/);
});

test("选了填写理由但留空：按没写处理，不带半截理由进诊断", async () => {
  const label = describeWorker(KEY, run());
  const { ui } = makeUi({ select: [label, CONFIRM_WITH_REASON], input: ["   "] });
  const { deps, stopped } = makeDeps([KEY], [run()]);
  await runStopCommand(ui, deps);
  assert.deepEqual(stopped, [{ key: KEY, reason: "" }]);
});

test("目标在确认期间已经跑完：如实说「已经不在跑」，不假报停成功", async () => {
  const label = describeWorker(KEY, run());
  const { ui, notes } = makeUi({ select: [label, CONFIRM_WITHOUT_REASON] });
  // 选人时它还在，确认时已经收尾：两次 listActive 结果不同
  let calls = 0;
  const deps: StopCommandDeps = {
    listActive: () => (++calls === 1 ? [KEY] : []),
    snapshot: () => [run()],
    stopOne: () => false,
    stopAll: () => 0,
  };
  await runStopCommand(ui, deps);
  assert.equal(notes[0].level, "warning");
  assert.match(notes[0].message, /已经不在跑/);
});

test("stop-all：跳过选人屏，直接三选一", async () => {
  const keys = [KEY, { batchId: "batch-a", workerId: "w2" }];
  const { ui, selects, notes } = makeUi({ select: [CONFIRM_WITHOUT_REASON] });
  const { deps, stopAllReasons } = makeDeps(keys, [run(), run({ id: "w2" })]);
  await runStopAllCommand(ui, deps);
  assert.equal(selects.length, 1, "stop-all 不该弹选人屏");
  assert.match(selects[0].title, /全部 2 个/);
  assert.deepEqual(stopAllReasons, [""]);
  assert.match(notes[0].message, /已停 2 个 worker/);
});

test("stop-all 取消：一个都不停", async () => {
  const keys = [KEY];
  const { ui } = makeUi({ select: [CANCEL] });
  const { deps, stopAllReasons } = makeDeps(keys, [run()]);
  await runStopAllCommand(ui, deps);
  assert.equal(stopAllReasons.length, 0);
});

test("stop-all 期间没人在跑：只通知", async () => {
  const { ui, selects, notes } = makeUi();
  const { deps } = makeDeps([], []);
  await runStopAllCommand(ui, deps);
  assert.equal(selects.length, 0);
  assert.match(notes[0].message, /没有在跑/);
});

test("选人屏内容：workerId、状态、已跑时长、任务首行都在，认得出是哪个", () => {
  const label = describeWorker(KEY, run({ status: "holding" }));
  assert.match(label, /^w1 · 暂存 · 已跑 12s · 用 bash 执行 sleep 45/);
});

test("快照里查不到这个 worker：不假装知道状态", () => {
  assert.equal(describeWorker(KEY, undefined), "w1 · 状态未知");
});
