// memory-gate.test.ts — 派工前内存闸的纯函数与读值
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/memory-gate.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import {
  DEFAULT_PLAN_MB,
  DEFAULT_RESERVE_MB,
  MIN_PLAN_MB,
  planMemoryGate,
  readAvailableMb,
  readMemoryGateConfig,
} from "./memory-gate.ts";

/** 缺省配置下的输入 */
function gate(over: Partial<Parameters<typeof planMemoryGate>[0]> = {}) {
  return planMemoryGate({
    availableMb: 4_051,
    reserveMb: DEFAULT_RESERVE_MB,
    planMb: DEFAULT_PLAN_MB,
    safetyCap: 8,
    taskCount: 5,
    ...over,
  });
}

describe("planMemoryGate", () => {
  it("按（可用 − 保留）÷ 计划值算，并夹到安全阀", () => {
    // (4051 − 2048) / 512 = 3.9 → 3
    const r = gate();
    assert.equal(r.memoryLimit, 3);
    assert.equal(r.limit, 3);
    assert.match(r.reason, /可用 4051MB − 保留 2048MB = 2003MB/);
    assert.match(r.reason, /计划 512MB/);
    assert.match(r.reason, /安全阀 8/);
  });

  it("内存宽裕时顶到安全阀，不随内存无限开", () => {
    const r = gate({ availableMb: 64_000, taskCount: 10 });
    assert.ok(r.memoryLimit > 8);
    assert.equal(r.limit, 8);
  });

  it("不想派的比能开的多：上限不超过本批数量", () => {
    assert.equal(gate({ taskCount: 2 }).limit, 2);
  });

  it("预算不够一个 worker 时仍开 1 个，并在依据里说明", () => {
    const r = gate({ availableMb: 2_100 });
    assert.equal(r.memoryLimit, 0);
    assert.equal(r.limit, 1);
    assert.match(r.reason, /仍先开 1 个/);
    assert.match(r.reason, /其余排队/);
  });

  it("计划值有下限：不让人靠调小计划值假装 worker 不占内存", () => {
    const r = gate({ planMb: 8 });
    assert.match(r.reason, new RegExp(`计划 ${MIN_PLAN_MB}MB`));
  });

  it("畸形输入不炸：负数/NaN/零走安全分支", () => {
    assert.equal(gate({ availableMb: Number.NaN }).limit >= 1, true);
    assert.equal(gate({ reserveMb: -100, availableMb: 1_000 }).limit, 1);
    assert.equal(gate({ planMb: Number.NaN }).limit >= 1, true);
    assert.equal(gate({ taskCount: 0 }).limit >= 1, true);
  });

  it("墙与计划值的分工写在依据里（避免读成人把墙也调小了）", () => {
    assert.match(gate().reason, /命令墙仍是 1GiB/);
  });
});

describe("readAvailableMb / readMemoryGateConfig", () => {
  it("Linux 上读到正数（本机路径）", () => {
    const mb = readAvailableMb();
    assert.ok(Number.isFinite(mb) && mb > 0, `可用内存应 > 0，实际 ${mb}`);
  });

  it("配置缺失/损坏时退回保守缺省", () => {
    const cfg = readMemoryGateConfig("/nonexistent/extensions.toml");
    assert.deepEqual(cfg, { reserveMb: DEFAULT_RESERVE_MB, planMb: DEFAULT_PLAN_MB });
  });

  it("读到本仓的真实配置：reserve 与 plan 都是正整数", () => {
    const cfg = readMemoryGateConfig();
    assert.ok(cfg.reserveMb >= 0 && cfg.planMb >= MIN_PLAN_MB, JSON.stringify(cfg));
  });
});
