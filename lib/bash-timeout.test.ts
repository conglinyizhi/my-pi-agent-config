// bash-timeout.test.ts — bash 默认超时单测
//
// 跑法：node --experimental-strip-types lib/bash-timeout.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BASH_TIMEOUT_SECONDS, withDefaultTimeout } from "./bash-timeout.ts";

describe("withDefaultTimeout", () => {
  it("缺 timeout 时补默认值", () => {
    assert.deepEqual(withDefaultTimeout({ command: "ls" }), {
      command: "ls",
      timeout: DEFAULT_BASH_TIMEOUT_SECONDS,
    });
    assert.equal(DEFAULT_BASH_TIMEOUT_SECONDS, 30);
  });

  it("模型显式给的正整数一律尊重（放宽长命令）", () => {
    for (const t of [1, 60, 400, 3600]) {
      const input = { command: "moon test", timeout: t };
      assert.equal(withDefaultTimeout(input), input, `${t} 不该被改写`);
    }
  });

  it("无效 timeout 视为缺省（0 / 负数 / NaN / 非数字 / null）", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60", null, undefined]) {
      const out = withDefaultTimeout({ command: "ls", timeout: bad }) as Record<string, unknown>;
      assert.equal(out.timeout, DEFAULT_BASH_TIMEOUT_SECONDS, `${String(bad)} 该被兜住`);
    }
  });

  it("保留同级参数（不丢 command / 其它字段）", () => {
    assert.deepEqual(withDefaultTimeout({ command: "ls -la", foo: 1 }), {
      command: "ls -la",
      foo: 1,
      timeout: DEFAULT_BASH_TIMEOUT_SECONDS,
    });
  });

  it("不改调用方的输入对象", () => {
    const input: Record<string, unknown> = { command: "ls" };
    withDefaultTimeout(input);
    assert.equal("timeout" in input, false, "原对象不该被塞字段");
  });

  it("非对象输入原样返回", () => {
    for (const v of [undefined, null, "ls", 42, ["ls"], true]) {
      assert.equal(withDefaultTimeout(v), v);
    }
  });

  it("自定义默认值可用（便于调用方按场景收紧）", () => {
    const out = withDefaultTimeout({ command: "curl x" }, 10) as Record<string, unknown>;
    assert.equal(out.timeout, 10);
  });
});
