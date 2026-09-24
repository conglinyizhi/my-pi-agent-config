import test from "node:test";
import assert from "node:assert/strict";
import {
  formatWorkerKey,
  listActiveWorkers,
  parseWorkerKey,
  registerWorkerAbort,
  resetActiveWorkers,
  stopAllWorkers,
  stopWorker,
  unregisterWorkerAbort,
} from "./active-workers.ts";
import { externalStopReason, isUserStop } from "../../lib/subagent-run.ts";

function key(batchId: string, workerId: string) {
  return { batchId, workerId };
}

test("登记后出现在活动表，注销后消失", () => {
  resetActiveWorkers();
  const c = new AbortController();
  registerWorkerAbort(key("batch-a", "w1"), c);
  assert.deepEqual(listActiveWorkers(), [key("batch-a", "w1")]);
  unregisterWorkerAbort(key("batch-a", "w1"));
  assert.deepEqual(listActiveWorkers(), []);
});

test("同名 worker 在不同批次里互不干扰", () => {
  resetActiveWorkers();
  const a = new AbortController();
  const b = new AbortController();
  registerWorkerAbort(key("batch-a", "w1"), a);
  registerWorkerAbort(key("batch-b", "w1"), b);
  assert.equal(stopWorker(key("batch-a", "w1"), "停 A"), true);
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false, "另一个批次的同名 worker 不该被连坐");
});

test("停一个 worker 会把理由挂到 abort reason 上", () => {
  resetActiveWorkers();
  const c = new AbortController();
  registerWorkerAbort(key("batch-a", "w2"), c);
  assert.equal(stopWorker(key("batch-a", "w2"), "方向跑偏了"), true);
  assert.equal(c.signal.aborted, true);
  assert.equal((c.signal.reason as Error).message, "方向跑偏了");
});

// worker 侧靠这个标记分辨「用户叫停」与「超时/失联」：理由可以空，标记必须在
test("命令层停下的 reason 带用户强停标记（不写理由也不丢）", () => {
  resetActiveWorkers();
  const withReason = new AbortController();
  const blank = new AbortController();
  registerWorkerAbort(key("batch-a", "w1"), withReason);
  registerWorkerAbort(key("batch-a", "w2"), blank);
  stopWorker(key("batch-a", "w1"), "方向跑偏了");
  stopWorker(key("batch-a", "w2"), "");
  assert.equal(isUserStop(withReason.signal), true);
  assert.equal(isUserStop(blank.signal), true);
  assert.equal(externalStopReason(blank.signal), "未写理由");
});

test("停全部同样带标记", () => {
  resetActiveWorkers();
  const c = new AbortController();
  registerWorkerAbort(key("batch-a", "w1"), c);
  stopAllWorkers("清场");
  assert.equal(isUserStop(c.signal), true);
});

test("停不存在的 worker 返回 false，不抛错", () => {
  resetActiveWorkers();
  assert.equal(stopWorker(key("batch-x", "w9"), "无此人"), false);
});

test("同 key 重复登记以最后一次为准", () => {
  resetActiveWorkers();
  const oldOne = new AbortController();
  const newOne = new AbortController();
  registerWorkerAbort(key("batch-a", "w1"), oldOne);
  registerWorkerAbort(key("batch-a", "w1"), newOne); // 重试轮次重建进程
  assert.equal(stopWorker(key("batch-a", "w1"), "停"), true);
  assert.equal(newOne.signal.aborted, true);
  assert.equal(oldOne.signal.aborted, false, "旧句柄停不到新进程，也不该被误触");
});

test("停全部：只数真正被停下的，已 abort 的不重复计", () => {
  resetActiveWorkers();
  const a = new AbortController();
  const b = new AbortController();
  const c = new AbortController();
  registerWorkerAbort(key("batch-a", "w1"), a);
  registerWorkerAbort(key("batch-a", "w2"), b);
  registerWorkerAbort(key("batch-b", "w1"), c);
  b.abort(new Error("先自己停了"));
  assert.equal(stopAllWorkers("清场"), 2);
  assert.equal(a.signal.aborted, true);
  assert.equal(c.signal.aborted, true);
  assert.equal((c.signal.reason as Error).message, "清场");
});

test("没有活动 worker 时停全部返回 0", () => {
  resetActiveWorkers();
  assert.equal(stopAllWorkers("清场"), 0);
});

test("key 编解码：往返一致，畸形输入返回 undefined 而不是猜", () => {
  const k = key("batch-mu5kp0go-4b5030db", "w1");
  assert.equal(formatWorkerKey(k), "batch-mu5kp0go-4b5030db/w1");
  assert.deepEqual(parseWorkerKey(formatWorkerKey(k)), k);
  assert.equal(parseWorkerKey("没有分隔符"), undefined);
  assert.equal(parseWorkerKey("/w1"), undefined);
  assert.equal(parseWorkerKey("batch-a/"), undefined);
});

test("畸形 key 不进入活动表，避免命令层拿到停不掉的条目", () => {
  resetActiveWorkers();
  registerWorkerAbort(key("在/中间切一刀", "w1"), new AbortController());
  assert.deepEqual(listActiveWorkers(), []);
});
