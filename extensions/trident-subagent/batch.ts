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

export interface BatchItemResult {
  index: number;
  status: BatchItemStatus;
  exitCode?: number;
  output: string;
  stderr: string;
  errorMessage?: string;
  usage?: SubagentUsage;
}

export interface RunBatchOptions {
  cwd: string;
  model: string;
  signal?: AbortSignal;
  tools?: string[];
  extraExtensions?: string[];
  taskId?: string;
  timeout?: number;
}

export async function runBatch(tasks: string[], opts: RunBatchOptions): Promise<BatchItemResult[]> {
  return Promise.all(
    tasks.map(async (task, index) => {
      const id = `w${index + 1}`;
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
          output: getResultOutput(result),
          stderr: result.stderr,
          errorMessage: result.errorMessage,
          usage: result.usage,
        };
      } catch (err) {
        // 结构化终态：timeout/aborted 由 SubagentError.status 决定，不再用 /超时/ 正则误判
        const patch = buildTerminalPatch(err, new Date().toISOString());
        updateWorker(id, patch);
        return { index, status: patch.status, output: "", stderr: String(err) };
      }
    }),
  );
}
