// lib/subagent-retry.ts — subagent 重试策略（纯函数）
//
// 供 runSubagent 调用方判定「这次失败要不要重试」以及「重试前等多久」。
// 只含纯函数与常量：不 spawn、不调用 LLM、不碰网络、不读时钟、不读随机数。
//
// 两层结构：
//   classifyFailure(input) → FailureClass        按结构字段 + 文本模式分类
//   planRetry(input, ctx)  → RetryVerdict        按类别查 RETRY_POLICY 给预算与退避
// 旧的 isRetryableFailure / backoffDelayMs 保留但已 deprecated，新代码一律用 planRetry。
import { SubagentError, type SubagentResult } from "./subagent-run.ts";

/**
 * 总轮次硬上界（防御性）；真正的重试预算由 RETRY_POLICY 按类别决定。
 * 最长为 quota 的 5 次（含首次），此值仅作跨类别保险：类别表被调大时仍有上限。
 */
export const SUBAGENT_MAX_ATTEMPTS = 6;
/** @deprecated 旧通用退避基数；新代码用 RETRY_POLICY 的各类 baseDelayMs */
export const SUBAGENT_BACKOFF_BASE_MS = 1000;
/** @deprecated 旧通用退避上限；新代码用 RETRY_POLICY 的各类 maxDelayMs */
export const SUBAGENT_BACKOFF_MAX_MS = 30_000;

/**
 * 指数退避等待时长。
 *
 * @deprecated 旧的通用退避（已不用在 runSubagent 主链）；新代码用 planRetry 的 delayMs。
 * 保留是因为仍有测试与外部引用断言其数值。
 *
 * @param failedAttemptIndex 已完成的失败次数（1-based）：第 1 次失败 → 1s，
 *   第 2 次 → 2s……依次翻倍，封顶 30s。
 */
export function backoffDelayMs(failedAttemptIndex: number): number {
  const exp = Math.max(0, failedAttemptIndex - 1);
  const raw = SUBAGENT_BACKOFF_BASE_MS * 2 ** exp;
  return Math.min(raw, SUBAGENT_BACKOFF_MAX_MS);
}

/**
 * 判定一次 subagent 终态是否值得重试。
 *
 * @deprecated 旧的单一布尔判定（对 timeout/配额都按瞬时抖动处理）；
 * 新代码用 classifyFailure + planRetry。保留是因为仍有测试与外部引用。
 *
 * 可重试：SubagentError("timeout")、exitCode !== 0、stopReason === "error"。
 * 不可重试：SubagentError("aborted")、未知 Error、干净成功、stopReason === "aborted"。
 */
export function isRetryableFailure(input: SubagentResult | unknown): boolean {
  if (input instanceof SubagentError) {
    return input.status === "timeout";
  }
  if (!input || typeof input !== "object") return false;
  const r = input as SubagentResult;
  if (typeof r.exitCode !== "number") return false;
  // 干净成功：exit 0 且无 error/aborted 终止原因
  if (r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted") {
    return false;
  }
  // 外部中止不重试（用户主动取消，重试无意义）
  if (r.stopReason === "aborted") return false;
  // 非零退出 / stopReason error（可能 exit 0）：瞬时故障，值得重试
  return r.exitCode !== 0 || r.stopReason === "error";
}

// ---------------------------------------------------------------------------
// 分类器：失败类别
// ---------------------------------------------------------------------------

export type FailureClass =
  | "quota" // 账号/租户并发或速率配额耗尽（上游限速）
  | "upstream" // 上游流中断、连接被重置（真瞬时）
  | "auth" // 认证/鉴权/模型不存在（配置问题，重试无意义）
  | "context_limit" // 超出上下文/输出上限（要拆任务，不是重试）
  | "crash" // 子进程非零退出且无结构化错误（可能 OOM/被杀）
  | "timeout" // 内部超时控制器触发
  | "aborted" // 外部 signal 中止
  | "unknown"; // 以上都不匹配

export interface FailureSignals {
  /** SubagentError 携带的结构化终态（若有） */
  errorStatus?: "timeout" | "aborted";
  /** 非 SubagentError 时，失败结果的字段 */
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;
  stderr?: string;
}

/** 把任意失败输入规整成判定用的信号（纯函数；非对象一律给空信号）。 */
export function toFailureSignals(input: SubagentResult | SubagentError | unknown): FailureSignals {
  if (input instanceof SubagentError) {
    return { errorStatus: input.status };
  }
  if (!input || typeof input !== "object") return {};
  const r = input as Record<string, unknown>;
  const signals: FailureSignals = {};
  if (typeof r.exitCode === "number") signals.exitCode = r.exitCode;
  if (typeof r.stopReason === "string") signals.stopReason = r.stopReason;
  if (typeof r.errorMessage === "string") signals.errorMessage = r.errorMessage;
  if (typeof r.stderr === "string") signals.stderr = r.stderr;
  return signals;
}

/**
 * 分类用的文本模式表（唯一事实来源）。
 *
 * 顺序敏感：`quota` 必须在 `upstream` 之前。样例来自 ~/.pi/subagent-diagnostics
 * 的真实失败串；新增模式必须同步加真实样本用例。
 */
export const FAILURE_PATTERNS: ReadonlyArray<{ klass: FailureClass; pattern: RegExp }> = [
  { klass: "quota", pattern: /concurrency limit|rate limit|too many requests|\b429\b|quota exceeded/i },
  { klass: "auth", pattern: /unauthorized|invalid api key|\b401\b|\b403\b|model not found|no api key/i },
  { klass: "context_limit", pattern: /context length|too many tokens|prompt is too long|maximum context/i },
  { klass: "upstream", pattern: /stream was interrupted|connection reset|socket hang up|ECONNRESET|ETIMEDOUT|upstream/i },
];

/**
 * 按失败类别分类。结构信号优先，文本模式兜底；永不抛。
 *
 * 优先级：errorStatus(aborted/timeout) → stopReason(aborted) → 文本模式表
 *   → 信号杀死/无解释的非零退出 = crash → 其余 unknown。
 */
export function classifyFailure(input: SubagentResult | SubagentError | unknown): FailureClass {
  try {
    const s = toFailureSignals(input);
    if (s.errorStatus === "aborted") return "aborted";
    if (s.errorStatus === "timeout") return "timeout";
    if (s.stopReason === "aborted") return "aborted";
    const text = `${s.errorMessage ?? ""}\n${s.stderr ?? ""}`;
    for (const { klass, pattern } of FAILURE_PATTERNS) {
      if (pattern.test(text)) return klass;
    }
    if (typeof s.exitCode === "number" && s.exitCode !== 0 && text.trim() === "") {
      // 信号杀死（exitCode >= 128，如 137=SIGKILL）或完全无解释的非零退出 → crash；
      // 带 stopReason 的非零退出是模型/协议层错误，归 unknown 等保守处理。
      return s.exitCode >= 128 || s.stopReason === undefined ? "crash" : "unknown";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// 决策器：重试预算与退避
// ---------------------------------------------------------------------------

export interface RetryPolicyEntry {
  /** 该类的总尝试次数上限（含首次） */
  maxAttempts: number;
  /** 首次退避基数（毫秒） */
  baseDelayMs: number;
  /** 单次退避上限（毫秒） */
  maxDelayMs: number;
}

/**
 * 每类的重试预算与退避（集中一张表，便于调参与核对）。
 *
 * quota 退避尺度按上游账号级配额恢复时间量级取（10→20→40→80→120s）；
 * timeout/aborted/auth/context_limit 不重试：重跑不会改变结果，只会拖时间。
 */
export const RETRY_POLICY: Record<FailureClass, RetryPolicyEntry> = {
  quota: { maxAttempts: 5, baseDelayMs: 10_000, maxDelayMs: 120_000 },
  upstream: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 },
  crash: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 },
  unknown: { maxAttempts: 2, baseDelayMs: 2_000, maxDelayMs: 2_000 },
  auth: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  context_limit: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  timeout: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  aborted: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
};

export interface RetryVerdict {
  klass: FailureClass;
  /** 是否值得再试一次 */
  retry: boolean;
  /** 本次建议退避毫秒（已含 jitter）；retry=false 时为 0 */
  delayMs: number;
  /** 本次已消耗的失败次数（含本次） */
  failureCount: number;
  /** 人类可读判据，写进 timeline 供事后核对 */
  reason: string;
}

export interface PlanRetryContext {
  /** 本次失败后累计的失败次数（1-based） */
  failureCount: number;
  /** 已发过 capability grant → 一律不重试（grant 是否被消费不确定） */
  capabilityGrantIssued?: boolean;
  /** jitter 随机源（0..1），注入以便确定性测试；缺省 Math.random */
  random?: () => number;
  /** jitter 幅度，缺省 0.25（±25%） */
  jitterRatio?: number;
}

/**
 * 决定这次失败要不要重试、等多久。
 *
 * 先 classifyFailure 分类，再查 RETRY_POLICY，再算指数退避 + jitter。
 * capabilityGrantIssued 短路在最前：审批过的 worker 重跑会重放副作用，不赌。
 */
export function planRetry(
  input: SubagentResult | SubagentError | unknown,
  ctx: PlanRetryContext,
): RetryVerdict {
  const klass = classifyFailure(input);
  const failureCount = Math.max(1, Math.floor(ctx.failureCount) || 1);
  const policy = RETRY_POLICY[klass];
  const noRetry = (reason: string): RetryVerdict => ({ klass, retry: false, delayMs: 0, failureCount, reason });

  if (ctx.capabilityGrantIssued) {
    return noRetry(`${klass}：已发放 capability grant，不重试（grant 是否被消费不确定）`);
  }
  if (policy.maxAttempts <= 1) {
    return noRetry(`${klass}：该类不重试（重跑不改变结果，或需拆任务/改配置）`);
  }
  if (failureCount >= policy.maxAttempts) {
    return noRetry(`${klass}：已达最大尝试次数 ${policy.maxAttempts}，不再重试`);
  }

  const exp = Math.max(0, failureCount - 1);
  const raw = Math.min(policy.baseDelayMs * 2 ** exp, policy.maxDelayMs);
  const jitterRatio = ctx.jitterRatio ?? 0.25;
  const rand = ctx.random ?? Math.random;
  const factor = 1 + (rand() * 2 - 1) * jitterRatio;
  const delayMs = Math.max(0, Math.round(raw * factor));
  return {
    klass,
    retry: true,
    delayMs,
    failureCount,
    reason: `${klass}：第 ${failureCount} 次失败，退避 ${delayMs}ms 后重试`,
  };
}
