// lib/subagent-retry.test.ts — 重试策略纯函数测试
import assert from "node:assert";
import { describe, it } from "node:test";
import { SubagentError, type SubagentResult } from "./subagent-run.ts";
import {
  SUBAGENT_MAX_ATTEMPTS,
  SUBAGENT_BACKOFF_MAX_MS,
  backoffDelayMs,
  isRetryableFailure,
} from "./subagent-retry.ts";

function baseResult(over: Partial<SubagentResult> = {}): SubagentResult {
  return {
    task: "t",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
    ...over,
  };
}

describe("constants", () => {
  it("max attempts is 6", () => {
    assert.strictEqual(SUBAGENT_MAX_ATTEMPTS, 6);
  });
});

describe("backoffDelayMs", () => {
  it("exponential 1s,2s,4s,8s,16s capped at 30s", () => {
    assert.strictEqual(backoffDelayMs(1), 1000);
    assert.strictEqual(backoffDelayMs(2), 2000);
    assert.strictEqual(backoffDelayMs(3), 4000);
    assert.strictEqual(backoffDelayMs(4), 8000);
    assert.strictEqual(backoffDelayMs(5), 16000);
    assert.strictEqual(backoffDelayMs(6), SUBAGENT_BACKOFF_MAX_MS); // 32000 -> 30000
    assert.strictEqual(backoffDelayMs(10), SUBAGENT_BACKOFF_MAX_MS);
  });
});

describe("isRetryableFailure", () => {
  it("timeout SubagentError is retryable", () => {
    assert.strictEqual(isRetryableFailure(new SubagentError("timeout", "t")), true);
  });
  it("aborted SubagentError is not retryable", () => {
    assert.strictEqual(isRetryableFailure(new SubagentError("aborted", "a")), false);
  });
  it("unknown Error is not retryable", () => {
    assert.strictEqual(isRetryableFailure(new Error("boom")), false);
  });
  it("nonzero exit is retryable", () => {
    assert.strictEqual(isRetryableFailure(baseResult({ exitCode: 1 })), true);
  });
  it("stopReason error is retryable", () => {
    assert.strictEqual(isRetryableFailure(baseResult({ stopReason: "error", errorMessage: "sse" })), true);
  });
  it("success result is not retryable", () => {
    assert.strictEqual(isRetryableFailure(baseResult({ exitCode: 0 })), false);
  });
  it("stopReason aborted result is not retryable", () => {
    assert.strictEqual(isRetryableFailure(baseResult({ stopReason: "aborted" })), false);
  });
});
