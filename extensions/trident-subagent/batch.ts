// batch.ts — 同步并发 batch 调度
//
// Promise.allSettled 语义：所有 worker 并行启动，各自独立跑到终态
// （success/failed/aborted/timeout）。单个 worker 失败或超时不终止兄弟 worker，
// 也不提前返回。结果按输入顺序逐项列出。

import {
  runSubagent,
  getResultOutput,
  isFailedResult,
  SubagentError,
  type SubagentResult,
  type SubagentUsage,
  type TimelineEvent,
} from "../../lib/subagent-run.ts";
import { createInbox, isValidInboxId } from "../../lib/subagent-supplement.ts";
import { updateWorker } from "./status.ts";

export type BatchItemStatus = "success" | "failed" | "aborted" | "timeout";

/**
 * 把 runSubagent 抛出的错误分类为可识别终态（timeout | aborted）。
 *
 * 依赖 SubagentError.status（结构化字段）而非错误消息文本：超时（内部超时控制器）
 * 映射为 timeout，外部 signal 中止映射为 aborted，其余未知错误兜底为 aborted
 * （保持原有 catch 语义：只有明确超时才标 timeout）。
 */
export function classifyTerminalError(err: unknown): {
  status: "timeout" | "aborted";
  timeline?: TimelineEvent[];
} {
  if (err instanceof SubagentError) {
    return { status: err.status, timeline: err.timeline };
  }
  return { status: "aborted" };
}

export interface TerminalPatch {
  status: BatchItemStatus;
  finishedAt: string;
  timeline?: TimelineEvent[];
}

/**
 * 构造终态 updateWorker 补丁。timeline 只在错误明确携带时写入：
 * undefined 绝不覆盖已有实时 timeline（catch 里保留最终轨迹，不抹掉实时快照）。
 */
export function buildTerminalPatch(err: unknown, finishedAt: string): TerminalPatch {
  const { status, timeline } = classifyTerminalError(err);
  const patch: TerminalPatch = { status, finishedAt };
  if (timeline) patch.timeline = timeline;
  return patch;
}

/**
 * catch 路径的失败输出：SubagentError 携带 investigationPath 时，输出中附调查文件
 * 路径与读档指引（供主 agent 直接 read 调查文件恢复现场）；否则返回空字符串，
 * 由调用方回退为 String(err)。
 */
export function formatCatchOutput(err: unknown, status: BatchItemStatus): string {
  const investigationPath = err instanceof SubagentError ? err.investigationPath : undefined;
  if (!investigationPath) return "";
  return `FAILED final=${status}\n  investigation: ${investigationPath}\n  读档：先看该文件「读档指引」与「最终结论」\n  ${String(err)}`;
}

export interface BatchItemResult {
  index: number;
  status: BatchItemStatus;
  exitCode?: number;
  output: string;
  stderr: string;
  errorMessage?: string;
  usage?: SubagentUsage;
  /** 重试彻底失败后写出的调查文件绝对路径（timeout/aborted/failed 时可能携带） */
  investigationPath?: string;
  /** 实际尝试次数（含首次；仅成功/失败结果携带，超时/中止时调查文件内有计数） */
  attempts?: number;
}

export interface RunBatchOptions {
  cwd: string;
  model: string;
  signal?: AbortSignal;
  tools?: string[];
  extraExtensions?: string[];
  taskId?: string;
  timeout?: number;
  /**
   * 与 tasks 一一对应的 batch-scoped inbox ids（每个 worker 一个）。
   * 在 spawn 之前统一校验并预创建 inbox；同一 batch 内每个 worker 只 create 一次。
   */
  workerInboxIds: string[];
}

/**
 * 前置校验：workerInboxIds 必须与 tasks 长度一致且每个都是合法 inbox id。
 * 校验失败在 create/spawn 之前抛错——绝不产生半启动的 batch。
 */
export function validateWorkerInboxIds(tasks: string[], inboxIds: string[]): void {
  if (!Array.isArray(inboxIds) || inboxIds.length !== tasks.length) {
    throw new Error(
      `workerInboxIds length ${Array.isArray(inboxIds) ? inboxIds.length : "missing"} does not match tasks length ${tasks.length}`,
    );
  }
  for (const id of inboxIds) {
    if (!isValidInboxId(id)) {
      throw new Error(
        `invalid worker inboxId ${JSON.stringify(id)}: must be 1-128 chars of [A-Za-z0-9_-]`,
      );
    }
  }
}

/** inbox 预创建函数（测试注入；默认真实 createInbox）。 */
export type CreateInboxFn = (inboxId: string) => Promise<unknown>;

/**
 * 在 spawn 之前按序为每个 worker 预创建 inbox（每 id 恰好一次）。
 * 任一 create 失败立即整体拒绝：runBatch 不会带着半批 inbox 继续 spawn。
 */
export async function prepareInboxes(
  inboxIds: string[],
  create: CreateInboxFn = (id) => createInbox(id),
): Promise<void> {
  for (const id of inboxIds) {
    await create(id);
  }
}

export async function runBatch(tasks: string[], opts: RunBatchOptions): Promise<BatchItemResult[]> {
  // 前置：校验 + 全部 inbox 预创建完成，之后才进入 Promise.all 并行 spawn。
  // 任一 create 失败都在子进程启动前整体拒绝（不留半批）；
  // 调用方（index submit tool）据此把整批标记为失败并给出可观测 UI 响应。
  validateWorkerInboxIds(tasks, opts.workerInboxIds);
  await prepareInboxes(opts.workerInboxIds);

  return Promise.all(
    tasks.map(async (task, index) => {
      const id = `w${index + 1}`;
      const inboxId = opts.workerInboxIds[index];
      updateWorker(id, { status: "starting" });

      try {
        const result: SubagentResult = await runSubagent({
          task,
          cwd: opts.cwd,
          model: opts.model,
          signal: opts.signal,
          tools: opts.tools,
          extraExtensions: opts.extraExtensions,
          taskId: opts.taskId ? `${opts.taskId}-${id}` : id,
          inboxId, // 重试循环内由 runSubagent 原样复用，不在 attempt 内重建
          timeout: opts.timeout ?? 600,
          onSpawn: (pid) => updateWorker(id, { pid, status: "running" }),
          onUpdate: (r) => updateWorker(id, {
            usage: r.usage,
            stderr: r.stderr.slice(-4000),
            // 每次实时解析更新都传 timeline 快照（复制，避免共享同一数组引用）
            timeline: [...r.timeline],
          }),
        });

        const failed = isFailedResult(result);
        const status: BatchItemStatus = failed ? "failed" : "success";
        updateWorker(id, {
          status,
          finishedAt: new Date().toISOString(),
          usage: result.usage,
          stderr: result.stderr.slice(-4000),
          output: getResultOutput(result).slice(-8000),
          // 终态更新保留最终 timeline
          timeline: [...result.timeline],
        });
        return {
          index,
          status,
          exitCode: result.exitCode,
          output: result.inlineSummary ?? getResultOutput(result),
          stderr: result.stderr,
          errorMessage: result.errorMessage,
          usage: result.usage,
          investigationPath: result.investigationPath,
          attempts: result.attempts,
        };
      } catch (err) {
        // 结构化终态：timeout/aborted 由 SubagentError.status 决定，不再用 /超时/ 正则误判
        const patch = buildTerminalPatch(err, new Date().toISOString());
        updateWorker(id, patch);
        const investigationPath = err instanceof SubagentError ? err.investigationPath : undefined;
        return {
          index,
          status: patch.status,
          output: formatCatchOutput(err, patch.status) || String(err),
          stderr: String(err),
          investigationPath,
        };
      }
    }),
  );
}
