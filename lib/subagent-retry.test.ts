// lib/subagent-retry.test.ts — 重试策略纯函数测试
import assert from "node:assert";
import { describe, it } from "node:test";
import { SubagentError, type SubagentResult } from "./subagent-run.ts";
import {
  SUBAGENT_MAX_ATTEMPTS,
  SUBAGENT_BACKOFF_MAX_MS,
  backoffDelayMs,
  isRetryableFailure,
  classifyFailure,
  planRetry,
  FAILURE_PATTERNS,
  RETRY_POLICY,
  type FailureClass,
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

// ── 分类器（Task 1） ──

describe("classifyFailure", () => {
  it("结构信号优先：SubagentError timeout / aborted", () => {
    assert.strictEqual(classifyFailure(new SubagentError("timeout", "t")), "timeout");
    assert.strictEqual(classifyFailure(new SubagentError("aborted", "a")), "aborted");
  });

  it("stopReason aborted 归 aborted", () => {
    assert.strictEqual(classifyFailure(baseResult({ stopReason: "aborted" })), "aborted");
  });

  it("真实串：账号并发限速 → quota", () => {
    assert.strictEqual(
      classifyFailure(
        baseResult({
          exitCode: 1,
          stopReason: "error",
          errorMessage: "Concurrency limit exceeded for account, please retry later",
        }),
      ),
      "quota",
    );
  });

  it("真实串：上游流中断 → upstream", () => {
    assert.strictEqual(
      classifyFailure(
        baseResult({ exitCode: 1, stopReason: "error", errorMessage: "Upstream response stream was interrupted" }),
      ),
      "upstream",
    );
  });

  it("errorMessage 为空时从 stderr 分类", () => {
    assert.strictEqual(
      classifyFailure(
        baseResult({ exitCode: 1, stopReason: "error", stderr: "Error: Concurrency limit exceeded for account" }),
      ),
      "quota",
    );
  });

  it("exitCode 137 无文本 → crash", () => {
    assert.strictEqual(classifyFailure(baseResult({ exitCode: 137 })), "crash");
  });

  it("完全无线索的非零退出 → unknown", () => {
    assert.strictEqual(classifyFailure(baseResult({ exitCode: 1, stopReason: "error" })), "unknown");
  });

  it("怪异输入不抛，返回合法类别", () => {
    const legal: FailureClass[] = [
      "quota", "upstream", "auth", "context_limit", "crash", "timeout", "aborted", "unknown",
    ];
    for (const v of [null, undefined, "boom", 42, new Error("boom")]) {
      assert.ok(legal.includes(classifyFailure(v)));
    }
  });

  it("模式表顺序：quota 先于 upstream（防回归）", () => {
    const classes = FAILURE_PATTERNS.map((p) => p.klass);
    assert.ok(classes.indexOf("quota") < classes.indexOf("upstream"));
  });
});

// ── 决策器（Task 2） ──

describe("planRetry", () => {
  const quota = baseResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Concurrency limit exceeded for account, please retry later",
  });
  const upstream = baseResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Upstream response stream was interrupted",
  });

  it("不重试类：timeout / aborted / auth / context_limit", () => {
    for (const input of [
      new SubagentError("timeout", "t"),
      new SubagentError("aborted", "a"),
      baseResult({ exitCode: 1, stopReason: "error", errorMessage: "invalid api key" }),
      baseResult({ exitCode: 1, stopReason: "error", errorMessage: "prompt is too long" }),
    ]) {
      const v = planRetry(input, { failureCount: 1, random: () => 0.5 });
      assert.strictEqual(v.retry, false, v.reason);
      assert.strictEqual(v.delayMs, 0);
      assert.ok(v.reason.length > 0);
    }
  });

  it("timeout 回归：超时不重试（本次修复核心）", () => {
    const v = planRetry(new SubagentError("timeout", "t"), { failureCount: 1 });
    assert.strictEqual(v.klass, "timeout");
    assert.strictEqual(v.retry, false);
    assert.match(v.reason, /timeout/);
  });

  it("quota：第 1 次退避落在 10s ±25%", () => {
    const lo = planRetry(quota, { failureCount: 1, random: () => 0 });
    const hi = planRetry(quota, { failureCount: 1, random: () => 1 });
    assert.strictEqual(lo.retry, true);
    assert.strictEqual(lo.delayMs, 7500);
    assert.strictEqual(hi.delayMs, 12500);
  });

  it("quota：退避指数增长（10/20/40/80s）", () => {
    const d = (n: number) => planRetry(quota, { failureCount: n, random: () => 0.5 }).delayMs;
    assert.strictEqual(d(1), 10_000);
    assert.strictEqual(d(2), 20_000);
    assert.strictEqual(d(3), 40_000);
    assert.strictEqual(d(4), 80_000);
  });

  it("quota：第 5 次失败后不再重试", () => {
    const v = planRetry(quota, { failureCount: 5 });
    assert.strictEqual(v.retry, false);
    assert.match(v.reason, /最大尝试次数/);
  });

  it("upstream / crash：第 1 次重试，到 maxAttempts 停", () => {
    assert.strictEqual(planRetry(upstream, { failureCount: 1 }).retry, true);
    assert.strictEqual(planRetry(upstream, { failureCount: 2 }).retry, true);
    assert.strictEqual(planRetry(upstream, { failureCount: 3 }).retry, false);
    const crash = baseResult({ exitCode: 137 });
    assert.strictEqual(planRetry(crash, { failureCount: 1 }).retry, true);
    assert.strictEqual(planRetry(crash, { failureCount: 3 }).retry, false);
  });

  it("unknown：只给一次机会（保守）", () => {
    const unknown = baseResult({ exitCode: 1, stopReason: "error" });
    assert.strictEqual(planRetry(unknown, { failureCount: 1 }).retry, true);
    assert.strictEqual(planRetry(unknown, { failureCount: 2 }).retry, false);
  });

  it("capabilityGrantIssued 时任何类别都不重试", () => {
    for (const input of [quota, upstream, baseResult({ exitCode: 137 })]) {
      const v = planRetry(input, { failureCount: 1, capabilityGrantIssued: true });
      assert.strictEqual(v.retry, false);
      assert.match(v.reason, /grant/);
    }
  });

  it("退避上限不超过 maxDelay 的 1.25 倍", () => {
    const v = planRetry(quota, { failureCount: 4, random: () => 1 });
    assert.ok(v.delayMs <= 120_000 * 1.25);
  });

  it("reason 含类别名（供 timeline 核对）", () => {
    assert.match(planRetry(quota, { failureCount: 1 }).reason, /quota/);
  });

  it("RETRY_POLICY 覆盖全部类别且预算合法", () => {
    assert.strictEqual(Object.keys(RETRY_POLICY).length, 8);
    for (const [klass, p] of Object.entries(RETRY_POLICY)) {
      assert.ok(p.maxAttempts >= 1, klass);
      assert.ok(p.baseDelayMs >= 0, klass);
      assert.ok(p.maxDelayMs >= p.baseDelayMs, klass);
    }
  });
});
