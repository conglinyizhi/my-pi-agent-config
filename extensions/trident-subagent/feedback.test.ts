// feedback.test.ts — 反馈模式工具白名单构造行为测试
//
// 背景：反馈模式下 worker 只允许 read/bash/be-* 工具。--tools 是精确名单，
// 不支持通配，因此从活跃工具名中过滤 be- 前缀得到实际名单。
// 未检测到任何 be-* 工具时拒绝开启（避免表面开启实际放行全部工具）。
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/feedback.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { buildToolsFromNames, readFeedbackState, writeFeedbackState } from "./feedback.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";

describe("feedback mode", () => {
  it("从活跃工具名构造白名单（read + bash + be-*）", () => {
    const r = buildToolsFromNames(["read", "bash", "be-read", "be-replace", "edit", "write", "be-insert"]);
    assert.deepStrictEqual(r.tools, ["read", "bash", "be-insert", "be-read", "be-replace"]);
    assert.strictEqual(r.reason, undefined);
  });

  it("无 be-* 工具时拒绝并给原因", () => {
    const r = buildToolsFromNames(["read", "bash", "edit", "write"]);
    assert.strictEqual(r.tools, undefined);
    assert(r.reason!.includes("be-"));
  });

  it("空工具集拒绝", () => {
    const r = buildToolsFromNames([]);
    assert.strictEqual(r.tools, undefined);
  });
});

describe("feedback state persistence", () => {
  const statePath = join(homedir(), ".pi", "subagent-feedback.json");
  let orig = "";
  try { orig = readFileSync(statePath, "utf-8"); } catch { /* 文件可能不存在 */ }

  it("写入后能读回", () => {
    writeFeedbackState(true);
    assert.strictEqual(readFeedbackState(), true);
    writeFeedbackState(false);
    assert.strictEqual(readFeedbackState(), false);
  });

  it("默认关闭", () => {
    // 文件不存在/解析失败 → false
    rmSync(statePath, { force: true });
    assert.strictEqual(readFeedbackState(), false);
  });

  try { writeFeedbackState(JSON.parse(orig).enabled ?? false); } catch { /* ignore */ }
});
