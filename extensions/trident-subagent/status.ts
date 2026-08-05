// status.ts — 本批 subagent 运行时快照（内存 + 状态文件）
//
// 短生命周期：只在主进程内存中维护，pi 重启不恢复（不是队列）。
// 状态文件 ~/.pi/subagent-status.json 供 Wails GUI 轮询读取（不进 git）。

import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubagentUsage } from "../../lib/subagent-run.ts";

export type WorkerStatus = "starting" | "running" | "success" | "failed" | "aborted" | "timeout";

export interface WorkerRun {
  id: string;
  task: string;
  model: string;
  status: WorkerStatus;
  startedAt: string;
  finishedAt?: string;
  pid?: number;
  usage?: SubagentUsage;
  output?: string;
  stderr?: string;
}

const STATUS_PATH = join(homedir(), ".pi", "subagent-status.json");

let snapshot: WorkerRun[] = [];

export function beginBatch(runs: WorkerRun[]): void {
  snapshot = runs;
  writeStatusFile();
}

export function updateWorker(id: string, patch: Partial<WorkerRun>): void {
  const w = snapshot.find((r) => r.id === id);
  if (!w) return;
  Object.assign(w, patch);
  writeStatusFile();
}

export function getSnapshot(): WorkerRun[] {
  return snapshot;
}

export function writeStatusFile(): void {
  try {
    fs.writeFileSync(
      STATUS_PATH,
      JSON.stringify({ updatedAt: new Date().toISOString(), workers: snapshot }, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch {
    /* GUI 不可用不影响调度 */
  }
}
