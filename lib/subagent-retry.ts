// lib/subagent-retry.ts — subagent 重试策略（纯函数）
//
// 供 runSubagent 调用方判定「这次失败要不要重试」以及「重试前等多久」。
// 只含纯函数与常量：不 spawn、不调用 LLM、不碰网络。重试循环与调查文件属于后续任务。
import { SubagentError, type SubagentResult } from "./subagent-run.ts";

/** 总尝试次数：首次 + 最多 5 次重试 */
export const SUBAGENT_MAX_ATTEMPTS = 6;
/** 退避基数：第一次失败后等 1s */
export const SUBAGENT_BACKOFF_BASE_MS = 1000;
/** 退避上限：单次等待最长 30s */
export const SUBAGENT_BACKOFF_MAX_MS = 30_000;

/**
 * 指数退避等待时长。
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
