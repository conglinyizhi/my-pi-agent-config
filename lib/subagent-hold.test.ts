// subagent-hold.test.ts — 暂存通道契约单测
//
// 跑法：node --experimental-strip-types lib/subagent-hold.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_HOLD_EXTRA_MS,
  MIN_HOLD_WINDOW_MS,
  buildHoldDecision,
  buildHoldWanted,
  makeHoldRequest,
  shouldRequestHold,
  validateHoldDecision,
  validateHoldRequest,
  validateHoldWanted,
  waitForHoldDecision,
} from "./subagent-hold.ts";

describe("shouldRequestHold（预算阈值）", () => {
  it("600s 预算：剩余低于 max(60s, 15%) = 90s 时请求", () => {
    assert.equal(shouldRequestHold(600_000, 600_000), false);
    assert.equal(shouldRequestHold(100_000, 600_000), false);
    assert.equal(shouldRequestHold(90_000, 600_000), true);
    assert.equal(shouldRequestHold(80_000, 600_000), true);
    assert.equal(shouldRequestHold(1_000, 600_000), true);
  });

  it("剩余为 0 或负数一律请求（已经到点）", () => {
    assert.equal(shouldRequestHold(0, 600_000), true);
    assert.equal(shouldRequestHold(-5, 600_000), true);
  });

  it("短预算任务不会一开局就请求暂存", () => {
    // 30s 预算比最小窗口还小：按比例算（4.5s）而不是直接触发
    assert.equal(shouldRequestHold(30_000, 30_000), false);
    assert.equal(shouldRequestHold(10_000, 30_000), false);
    assert.equal(shouldRequestHold(4_000, 30_000), true);
  });

  it("中等预算：最小窗口生效", () => {
    // 100s 预算：阈值 = max(60s, 15s) = 60s
    assert.equal(shouldRequestHold(70_000, 100_000), false);
    assert.equal(shouldRequestHold(60_000, 100_000), true);
  });

  it("预算不限制（非有限 / <=0）时永不触发", () => {
    assert.equal(shouldRequestHold(Number.POSITIVE_INFINITY, 600_000), false);
    assert.equal(shouldRequestHold(Number.NaN, 600_000), false);
    assert.equal(shouldRequestHold(1000, 0), false);
    assert.equal(shouldRequestHold(1000, Number.NaN), false);
  });
});

describe("wanted 标志", () => {
  it("往返一致，缺失字段有兜底", () => {
    const w = buildHoldWanted({ wanted: true, reason: "budget", remainingMs: 12_345 });
    assert.deepEqual(validateHoldWanted(w), w);
    const minimal = validateHoldWanted({ version: 1, wanted: false });
    assert.equal(minimal?.wanted, false);
    assert.equal(minimal?.reason, "budget");
    assert.equal(minimal?.remainingMs, 0);
  });

  it("非法输入返回 undefined（不抛）", () => {
    for (const v of [undefined, null, "x", 42, [], {}, { version: 2, wanted: true }, { version: 1, wanted: "yes" }]) {
      assert.equal(validateHoldWanted(v), undefined);
    }
  });
});

describe("暂存请求", () => {
  it("makeHoldRequest 夹住负数并保留 requestId", () => {
    const r = makeHoldRequest({ reason: "budget", elapsedMs: -5, remainingMs: -1, requestId: "req-1" });
    assert.equal(r.requestId, "req-1");
    assert.equal(r.elapsedMs, 0);
    assert.equal(r.remainingMs, 0);
    assert.equal(validateHoldRequest(r)?.requestId, "req-1");
  });

  it("requestId 必填，reason 非法时回落 budget", () => {
    assert.equal(validateHoldRequest({ version: 1, reason: "budget" }), undefined);
    assert.equal(validateHoldRequest({ version: 1, requestId: "" }), undefined);
    const r = validateHoldRequest({ version: 1, requestId: "a", reason: "乱写", elapsedMs: "x" });
    assert.equal(r?.reason, "budget");
    assert.equal(r?.elapsedMs, 0);
  });
});

describe("暂存决定", () => {
  it("requestId 必须对上（防止读到上一次暂存的陈旧响应）", () => {
    const d = buildHoldDecision({ requestId: "req-1", action: "continue", extraMs: 1000 });
    assert.ok(validateHoldDecision(d, "req-1"));
    assert.equal(validateHoldDecision(d, "req-2"), undefined, "对不上就该忽略");
  });

  it("action 白名单 + extraMs 只接受正数 + comment 去空白", () => {
    assert.equal(validateHoldDecision({ version: 1, requestId: "r", action: "maybe" }, "r"), undefined);
    const stop = validateHoldDecision(
      { version: 1, requestId: "r", action: "stop", extraMs: -3, comment: "  收工吧  " },
      "r",
    );
    assert.equal(stop?.action, "stop");
    assert.equal(stop?.extraMs, undefined);
    assert.equal(stop?.comment, "收工吧");
  });

  it("buildHoldDecision 过滤无效 extraMs", () => {
    assert.equal(buildHoldDecision({ requestId: "r", action: "continue", extraMs: 0 }).extraMs, undefined);
    assert.equal(buildHoldDecision({ requestId: "r", action: "continue", extraMs: 5 }).extraMs, 5);
    assert.equal(DEFAULT_HOLD_EXTRA_MS, 300_000);
  });
});

describe("worker 侧等待", () => {
  /** 假时钟：sleep 只是推进时间，不真等 */
  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it("拿到决定就返回", async () => {
    const clock = fakeClock();
    let calls = 0;
    const decision = await waitForHoldDecision("req-1", {
      ...clock,
      readDecision: () => (++calls >= 3 ? { version: 1, requestId: "req-1", action: "continue", extraMs: 60_000 } : undefined),
      parentAlive: () => true,
    });
    assert.equal(decision.action, "continue");
    assert.equal(decision.extraMs, 60_000);
  });

  it("父进程失联 → 收工（不无限挂着）", async () => {
    const clock = fakeClock();
    let alive = true;
    const decision = await waitForHoldDecision("req-1", {
      ...clock,
      readDecision: () => {
        alive = false; // 第一次轮询后父进程没了
        return undefined;
      },
      parentAlive: () => alive,
      healthMs: 1000,
      pollMs: 100,
    });
    assert.equal(decision.action, "stop");
    assert.match(decision.comment ?? "", /失联/);
  });

  it("等太久 → 收工", async () => {
    const clock = fakeClock();
    const decision = await waitForHoldDecision("req-1", {
      ...clock,
      readDecision: () => undefined,
      parentAlive: () => true,
      timeoutMs: 5000,
      healthMs: 10_000_000,
      pollMs: 100,
    });
    assert.equal(decision.action, "stop");
    assert.match(decision.comment ?? "", /超时/);
  });

  it("陈旧响应（requestId 不符）不会当成自己的决定", async () => {
    const clock = fakeClock();
    const decision = await waitForHoldDecision("req-new", {
      ...clock,
      readDecision: () => ({ version: 1, requestId: "req-old", action: "continue" }),
      parentAlive: () => true,
      timeoutMs: 3000,
      healthMs: 10_000_000,
      pollMs: 100,
    });
    assert.equal(decision.action, "stop", "认不出自己那份就按收工处理");
  });

  it("最小窗口常量是个正数且不超过默认新预算", () => {
    assert.ok(MIN_HOLD_WINDOW_MS > 0);
    assert.ok(DEFAULT_HOLD_EXTRA_MS >= MIN_HOLD_WINDOW_MS);
  });
});
