// subagent-hold.ts — worker「暂存」通道
//
// 背景：worker 的时间预算是硬上限，到点直接终止，做到一半的活儿白扔。
// 这里把「到点」改成一个可决策的检查点：worker 在安全位置（工具调用结束）主动请求
// 暂存 → 父进程暂停预算计时 → 主侧（人，或将来主 agent）决定继续/补充/收工 →
// 决定写回，worker 接着干。
//
// 与 capability 通道同构（同一套「请求文件 + 决定文件 + 活体检查」握手），但语义相反：
//   - capability 是权限，兜底按 **拒绝**（fail-closed，绝不静默放行）
//   - hold 是工时，兜底按 **收工**（不让人不在时无限挂着一个活进程占额度）
//
// worker 不得在任意时刻被挂起：模型流没法暂停，只能在「工具调用结束」这种安静点停。
// 所以父进程只能表达「下次检查点时请暂存」（wanted 标志），由 worker 自己挑时机。
//
// 文件布局（父进程建在 worker 的 tmpDir 里，路径经 env 传给 worker）：
//   hold-wanted.json    父进程写：{wanted, reason, remainingMs}
//   hold-request.json   worker 写：HoldRequest
//   hold-response.json  父进程写：HoldDecision

import { randomUUID } from "node:crypto";

/** 暂存原因：预算见底 / worker 自己要求 */
export type HoldReason = "budget" | "worker";

export interface HoldRequest {
  version: 1;
  requestId: string;
  reason: HoldReason;
  /** 已经跑了多久（毫秒） */
  elapsedMs: number;
  /** 请求暂存时的剩余预算（毫秒，可为 0） */
  remainingMs: number;
  createdAt: string;
}

export type HoldAction = "continue" | "stop";

export interface HoldDecision {
  version: 1;
  requestId: string;
  action: HoldAction;
  /** continue 时给的新预算（毫秒）；缺省由调用方取默认窗口 */
  extraMs?: number;
  /** 决策说明（人写的理由；补充正文走 inbox 队列，不进这里） */
  comment?: string;
  createdAt: string;
}

/** 父进程侧「下次检查点请暂存」的标志 */
export interface HoldWanted {
  version: 1;
  wanted: boolean;
  reason: HoldReason;
  remainingMs: number;
  updatedAt: string;
}

/** 剩余预算低于这个比例就请求暂存 */
export const DEFAULT_HOLD_RATIO = 0.15;
/** 无论预算多大，剩余低于这个窗口也请求暂存（短预算任务不至于永不触发） */
export const MIN_HOLD_WINDOW_MS = 60_000;
/** 继续时给的默认新预算 */
export const DEFAULT_HOLD_EXTRA_MS = 300_000;
/** 父进程侧兜底：等这么久还没人决定，就按收工处理（进程不无限挂着） */
export const DEFAULT_HOLD_CAP_MS = 300_000;
/** worker 侧等待上限（父进程一般先到 cap 并写回；这里只防父进程彻底失联） */
export const WORKER_HOLD_WAIT_MS = 900_000;
/**
 * 宽限窗口：父进程写下「下次检查点请暂存」后暂停计时，等 worker 跑到检查点。
 * 不宽限的话会自相矛盾：一边请它暂存，一边几秒后就把它杬了。
 * 超过这个窗口还没到检查点 → 恢复计时（于是仍按普通超时收尾，不比以前差）。
 */
export const HOLD_GRACE_MS = 60_000;

/**
 * 该不该请求暂存：剩余预算比例低于阈值，或低于最小窗口。
 * 预算是 0/负数/非有限（不限制）时永不触发。
 */
export function shouldRequestHold(
  remainingMs: number,
  totalMs: number,
  ratio: number = DEFAULT_HOLD_RATIO,
): boolean {
  if (!Number.isFinite(remainingMs) || !Number.isFinite(totalMs) || totalMs <= 0) return false;
  if (remainingMs <= 0) return true;
  const threshold = Math.max(MIN_HOLD_WINDOW_MS, totalMs * ratio);
  // 预算本身就比阈值小的时候，别一开局就请求（那样等于每步都暂存）
  if (totalMs <= threshold) return remainingMs <= totalMs * ratio;
  return remainingMs <= threshold;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验父进程写下的 wanted 标志 */
export function validateHoldWanted(value: unknown): HoldWanted | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (typeof value.wanted !== "boolean") return undefined;
  const reason = value.reason === "worker" ? "worker" : "budget";
  const remainingMs = typeof value.remainingMs === "number" && Number.isFinite(value.remainingMs)
    ? value.remainingMs
    : 0;
  return {
    version: 1,
    wanted: value.wanted,
    reason,
    remainingMs,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

export function buildHoldWanted(
  input: { wanted: boolean; reason?: HoldReason; remainingMs?: number },
): HoldWanted {
  return {
    version: 1,
    wanted: input.wanted,
    reason: input.reason ?? "budget",
    remainingMs: input.remainingMs ?? 0,
    updatedAt: new Date().toISOString(),
  };
}

/** 校验 worker 写下的暂存请求 */
export function validateHoldRequest(value: unknown): HoldRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (typeof value.requestId !== "string" || value.requestId.length === 0) return undefined;
  const reason: HoldReason = value.reason === "worker" ? "worker" : "budget";
  const elapsedMs = typeof value.elapsedMs === "number" && Number.isFinite(value.elapsedMs) ? value.elapsedMs : 0;
  const remainingMs =
    typeof value.remainingMs === "number" && Number.isFinite(value.remainingMs) ? value.remainingMs : 0;
  return {
    version: 1,
    requestId: value.requestId,
    reason,
    elapsedMs,
    remainingMs,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
  };
}

export function makeHoldRequest(input: {
  reason: HoldReason;
  elapsedMs: number;
  remainingMs: number;
  requestId?: string;
}): HoldRequest {
  return {
    version: 1,
    requestId: input.requestId ?? randomUUID(),
    reason: input.reason,
    elapsedMs: Math.max(0, Math.floor(input.elapsedMs)),
    remainingMs: Math.max(0, Math.floor(input.remainingMs)),
    createdAt: new Date().toISOString(),
  };
}

/** 校验父进程写回的决定；requestId 必须对上（防止读到上一次暂存的陈旧响应） */
export function validateHoldDecision(value: unknown, requestId: string): HoldDecision | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (value.requestId !== requestId) return undefined;
  const action = value.action;
  if (action !== "continue" && action !== "stop") return undefined;
  const extraMs =
    typeof value.extraMs === "number" && Number.isFinite(value.extraMs) && value.extraMs > 0
      ? Math.floor(value.extraMs)
      : undefined;
  return {
    version: 1,
    requestId,
    action,
    extraMs,
    comment: typeof value.comment === "string" && value.comment.trim() ? value.comment.trim() : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
  };
}

export function buildHoldDecision(input: {
  requestId: string;
  action: HoldAction;
  extraMs?: number;
  comment?: string;
}): HoldDecision {
  const extraMs =
    typeof input.extraMs === "number" && Number.isFinite(input.extraMs) && input.extraMs > 0
      ? Math.floor(input.extraMs)
      : undefined;
  return {
    version: 1,
    requestId: input.requestId,
    action: input.action,
    extraMs,
    comment: input.comment?.trim() ? input.comment.trim() : undefined,
    createdAt: new Date().toISOString(),
  };
}

export interface HoldWaitOptions {
  /** 读一次响应文件内容（不存在/半截返回 undefined） */
  readDecision: () => unknown;
  /** 父进程是否还活着 */
  parentAlive: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 等待上限，默认 WORKER_HOLD_WAIT_MS */
  timeoutMs?: number;
  healthMs?: number;
  pollMs?: number;
}

/**
 * worker 侧阻塞等决定。超时/失联一律按 **stop** 返回——不让人不在时无限挂着一个进程，
 * 也不会因为等不到就自己往前跑。
 */
export async function waitForHoldDecision(
  requestId: string,
  opts: HoldWaitOptions,
): Promise<HoldDecision> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs ?? WORKER_HOLD_WAIT_MS;
  const healthMs = opts.healthMs ?? 100_000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = now() + timeoutMs;
  let lastHealth = now();
  while (now() < deadline) {
    const decision = validateHoldDecision(opts.readDecision(), requestId);
    if (decision) return decision;
    if (now() - lastHealth >= healthMs) {
      lastHealth = now();
      if (!opts.parentAlive()) {
        return buildHoldDecision({ requestId, action: "stop", comment: "暂存通道失联（父进程已退出）" });
      }
    }
    await sleep(pollMs);
  }
  return buildHoldDecision({ requestId, action: "stop", comment: "暂存等待超时" });
}
