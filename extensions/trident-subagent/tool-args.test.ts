// tool-args.test.ts — subagent 参数兼容折叠单测
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/tool-args.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSubagentArgs } from "./tool-args.ts";

const brief = { objective: "调研 X", context: "背景" };

describe("normalizeSubagentArgs", () => {
  it("把复数的 tasks 折成 task", () => {
    assert.deepEqual(normalizeSubagentArgs({ tasks: [brief] }), { task: [brief] });
    assert.deepEqual(normalizeSubagentArgs({ tasks: brief }), { task: brief });
    assert.deepEqual(normalizeSubagentArgs({ tasks: "单条任务说明" }), { task: "单条任务说明" });
  });

  it("保留同级参数（sandbox_profile / model / skills）", () => {
    assert.deepEqual(
      normalizeSubagentArgs({ tasks: [brief], sandbox_profile: "readonly", model: "p/m", skills: ["s"] }),
      { task: [brief], sandbox_profile: "readonly", model: "p/m", skills: ["s"] },
    );
  });

  it("已经正确的形状原样返回（同一个引用，不白造对象）", () => {
    const input = { task: [brief], model: "p/m" };
    assert.equal(normalizeSubagentArgs(input), input);
  });

  it("两个都在时不动手，task 优先（不覆盖正确参数）", () => {
    const input = { task: "正确的那份", tasks: ["误写的"] };
    assert.equal(normalizeSubagentArgs(input), input);
  });

  it("非对象 / 数组 / 空值原样返回", () => {
    for (const v of [undefined, null, "字符串", 42, [brief], true]) {
      assert.equal(normalizeSubagentArgs(v), v);
    }
    const empty = {};
    assert.equal(normalizeSubagentArgs(empty), empty);
    const other = { foo: 1 };
    assert.equal(normalizeSubagentArgs(other), other);
  });

  it("不改调用方的输入对象", () => {
    const input: Record<string, unknown> = { tasks: [brief], sandbox_profile: "readonly" };
    const out = normalizeSubagentArgs(input) as Record<string, unknown>;
    assert.ok("tasks" in input, "原对象不该被删字段");
    assert.equal("task" in input, false, "原对象不该被塞字段");
    assert.deepEqual(out.task, [brief]);
    assert.equal("tasks" in out, false);
  });
});
