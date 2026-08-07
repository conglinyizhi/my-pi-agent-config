// batch.ts — 同步并发 batch 调度
//
// Promise.allSettled 语义：所有 worker 并行启动，各自独立跑到终态
// （success/failed/aborted/timeout）。单个 worker 失败或超时不终止兄弟 worker，
// 也不提前返回。结果按输入顺序逐项列出。

import {
  runSubagent,
  getResultOutput,
  isFailedResult,
  type SubagentResult,
  type SubagentUsage,
  type TimelineEvent,
} from "../../lib/subagent-run.ts";
import { updateWorker } from "./status.ts";

export type BatchItemStatus = "success" | "failed" | "aborted" | "timeout";

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
        const msg = String(err);
        const timedOut = /超时/.test(msg);
        const status: BatchItemStatus = timedOut ? "timeout" : "aborted";
        updateWorker(id, {
          status,
          finishedAt: new Date().toISOString(),
          // runSubagent 在超时/中止路径把最终 timeline 挂到错误上，一并保留
          timeline: (err as Error & { timeline?: TimelineEvent[] })?.timeline,
        });
        return { index, status, output: "", stderr: msg };
      }
    }),
  );
}
