// tool-args.test.ts — subagent 参数兼容折叠单测
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/tool-args.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertStructuredTaskArray,
  normalizeSubagentArgs,
  prepareSubagentArgs,
  taskHeadline,
} from "./tool-args.ts";

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

describe("assertStructuredTaskArray（数组元素形状）", () => {
  it("单个字符串 task 的兼容路径不受影响", () => {
    assert.doesNotThrow(() => assertStructuredTaskArray("一条纯文本任务说明"));
  });

  it("全对象数组通过（只填 objective 也算结构化）", () => {
    assert.doesNotThrow(() => assertStructuredTaskArray([brief, { objective: "查 Y" }]));
  });

  it("裸字符串报错并指出是第几个元素", () => {
    assert.throws(
      () => assertStructuredTaskArray([brief, "timeout"]),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /第 2 个元素/);
        assert.match(msg, /timeout/);
        assert.match(msg, /顶层键/);
        return true;
      },
    );
  });

  it("裸字符串是 sandbox_dir 时同样拒绝", () => {
    assert.throws(() => assertStructuredTaskArray(["sandbox_dir"]), /第 1 个元素/);
  });

  it("缺 objective / objective 为空 / 元素不是对象都报错", () => {
    assert.throws(() => assertStructuredTaskArray([{ context: "只有背景" }]), /缺少非空的 objective/);
    assert.throws(() => assertStructuredTaskArray([{ objective: "   " }]), /缺少非空的 objective/);
    assert.throws(() => assertStructuredTaskArray([{ objective: 42 }]), /缺少非空的 objective/);
    assert.throws(() => assertStructuredTaskArray([42]), /不是对象/);
    assert.throws(() => assertStructuredTaskArray([null]), /不是对象/);
    assert.throws(() => assertStructuredTaskArray([[brief]]), /不是对象/);
  });

  it("非数组（含 undefined）不动手", () => {
    for (const v of [undefined, null, "文本", brief, 42]) {
      assert.doesNotThrow(() => assertStructuredTaskArray(v));
    }
  });
});

describe("prepareSubagentArgs", () => {
  it("折叠 tasks 后继续校验元素形状", () => {
    assert.deepEqual(prepareSubagentArgs({ tasks: [brief] }), { task: [brief] });
    assert.throws(() => prepareSubagentArgs({ tasks: [brief, "timeout"] }), /第 2 个元素/);
  });

  it("task 优先时不去校验被忽略的 tasks", () => {
    const input = { task: [brief], tasks: ["误写的"] };
    assert.equal(prepareSubagentArgs(input), input);
  });

  it("单个字符串 task 仍然可用", () => {
    assert.deepEqual(prepareSubagentArgs({ task: "单条任务说明" }), { task: "单条任务说明" });
  });
});

describe("taskHeadline", () => {
  it("对象取 objective、字符串原样、缺 objective 有提示", () => {
    assert.equal(taskHeadline({ objective: "调研 X" }), "调研 X");
    assert.equal(taskHeadline("裸字符串"), "裸字符串");
    assert.equal(taskHeadline({ context: "x" }), "（缺 objective：undefined）");
    assert.equal(taskHeadline(undefined), "（缺 objective：undefined）");
    assert.equal(taskHeadline({ objective: 42 }), "（缺 objective：number）");
    assert.equal(taskHeadline(42), "（不是简报：number 42）");
  });

  it("压成单行并截断到 40 字", () => {
    assert.equal(taskHeadline({ objective: "第一行\n第二行" }), "第一行 第二行");
    const long = "很".repeat(60);
    const head = taskHeadline({ objective: long });
    assert.equal(head.length, 41);
    assert.ok(head.endsWith("…"));
  });

  it("objective 只有空白时给明确提示", () => {
    assert.equal(taskHeadline({ objective: "  " }), "（objective 为空）");
  });
});
