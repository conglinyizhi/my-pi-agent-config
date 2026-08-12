// status.ts — 本批 subagent 运行时快照（内存 + 状态文件）
//
// 短生命周期：只在主进程内存中维护，pi 重启不恢复（不是队列）。
// 状态文件 ~/.pi/subagent-status.json 供 Wails GUI 轮询读取（不进 git）。
//
// 写入策略（I-2 热路径 I/O，有界合并写入）：
//   - beginBatch / 启动（starting）/ 终态（success/failed/aborted/timeout）/ 显式
//     flushStatusFile 立即同步写入（终态必须立即落盘）；
//   - 其余实时更新（running、usage/stderr/timeline 增量）合并写入：最多延迟
//     COALESCE_DELAY_MS（250ms）——GUI 1s 轮询周期内必定可见；期间连发更新只写
//     最新 snapshot，不丢最终状态；终态立即写会取消挂起合并定时器（已含最新快照）。
//   - 任何挂起合并写可在会话/进程结束前用 flushStatusFile() 显式落盘。
//   - 默认写入器走同目录临时文件 + rename 原子落盘：GUI 轮询读方永远看到
//     完整 JSON，不会撞上截断后未写完的半截文件。
//   - 写失败静默（GUI 不可用不影响调度）。
//
// 测试注入：configureStatusFile / resetStatusFile 替换写入器与合并调度器，使
// 连发合并 / 终态立即落盘等行为可用确定性方式（内存写入器 + 手动推进定时器）验证。

import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubagentUsage, TimelineEvent } from "../../lib/subagent-run.ts";

export type WorkerStatus = "starting" | "running" | "success" | "failed" | "aborted" | "timeout";

export interface WorkerRun {
  id: string;
  /** 本批分配的安全 inbox id（补充指令队列用；仅 [A-Za-z0-9_-]，绝不暴露队列文件路径） */
  inboxId: string;
  task: string;
  model: string;
  status: WorkerStatus;
  startedAt: string;
  finishedAt?: string;
  pid?: number;
  usage?: SubagentUsage;
  output?: string;
  stderr?: string;
  /** 有界 per-worker 执行轨迹（实时更新；终态保留最终 timeline） */
  timeline?: TimelineEvent[];
}

/** 合并写最大延迟：GUI 1s 轮询周期内必定收到新状态 */
export const COALESCE_DELAY_MS = 250;

/** 需要立即落盘的状态：启动 + 全部终态 */
const IMMEDIATE_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  "starting",
  "success",
  "failed",
  "aborted",
  "timeout",
]);

const STATUS_PATH = join(homedir(), ".pi", "subagent-status.json");

let tmpSeq = 0;

/**
 * 同目录临时文件 + fsync + rename 原子写（owner-only）：替代直接 writeFileSync
 * 的“截断再写”，避免 GUI 轮询读到半截 JSON。rename 失败时清理临时文件再抛出
 * （由调用方的静默 catch 处理）。
 */
function atomicWriteFileSync(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${tmpSeq++}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, path);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** 状态文件 IO 与合并调度器（默认真实实现；测试可注入） */
interface StatusFileIO {
  path: string;
  writeFile: (path: string, data: string) => void;
  now: () => string;
  schedule: (fn: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

function defaultIO(): StatusFileIO {
  return {
    path: STATUS_PATH,
    writeFile: atomicWriteFileSync,
    now: () => new Date().toISOString(),
    // unref：挂起合并写不阻止进程退出；会话结束前由 flushStatusFile 显式落盘
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    cancel: (h) => clearTimeout(h as NodeJS.Timeout),
  };
}

let io: StatusFileIO = defaultIO();
let snapshot: WorkerRun[] = [];
let pendingTimer: unknown;

function serialize(): string {
  return JSON.stringify({ updatedAt: io.now(), workers: snapshot }, null, 2);
}

/** 立即写入：取消任何挂起的合并定时器（本次写入已含最新 snapshot，避免冗余落盘） */
function writeNow(): void {
  if (pendingTimer !== undefined) {
    io.cancel(pendingTimer);
    pendingTimer = undefined;
  }
  try {
    io.writeFile(io.path, serialize());
  } catch {
    /* GUI 不可用不影响调度 */
  }
}

/** 合并写：已有挂起定时器则复用，否则排一个（延迟上限 COALESCE_DELAY_MS） */
function scheduleWrite(): void {
  if (pendingTimer !== undefined) return;
  pendingTimer = io.schedule(() => {
    pendingTimer = undefined;
    writeNow();
  }, COALESCE_DELAY_MS);
}

export function beginBatch(runs: WorkerRun[]): void {
  snapshot = runs;
  writeNow();
}

export function updateWorker(id: string, patch: Partial<WorkerRun>): void {
  const w = snapshot.find((r) => r.id === id);
  if (!w) return;
  Object.assign(w, patch);
  // 启动/终态必须立即落盘；其余实时增量合并写入（有界延迟）
  if (patch.status !== undefined && IMMEDIATE_STATUSES.has(patch.status)) {
    writeNow();
  } else {
    scheduleWrite();
  }
}

export function getSnapshot(): WorkerRun[] {
  return snapshot;
}

/** 显式 flush：立即落盘当前快照（含任何挂起的合并写）；会话/进程结束前调用 */
export function flushStatusFile(): void {
  writeNow();
}

/** 立即写入当前快照（保持原 API 名；beginBatch/终态路径内部使用） */
export function writeStatusFile(): void {
  writeNow();
}

export interface StatusFileConfig {
  path?: string;
  writeFile?: (path: string, data: string) => void;
  now?: () => string;
  schedule?: (fn: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** 测试/宿主注入：替换状态文件 IO 与合并调度器（确定性验证用） */
export function configureStatusFile(cfg: StatusFileConfig): void {
  io = {
    path: cfg.path ?? STATUS_PATH,
    writeFile: cfg.writeFile ?? atomicWriteFileSync,
    now: cfg.now ?? (() => new Date().toISOString()),
    schedule: cfg.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
    cancel: cfg.cancel ?? ((h) => clearTimeout(h as NodeJS.Timeout)),
  };
  // 配置切换后旧调度器句柄不可靠：丢弃（调用方应先 reset/flush 清掉挂起写）
  pendingTimer = undefined;
}

/** 恢复默认 IO 并取消任何挂起写（测试 after 钩子用） */
export function resetStatusFile(): void {
  if (pendingTimer !== undefined) {
    io.cancel(pendingTimer);
    pendingTimer = undefined;
  }
  io = defaultIO();
  snapshot = [];
}
