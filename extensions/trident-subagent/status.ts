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
import { createHash } from "node:crypto";
import type { SubagentUsage, TimelineEvent, VisibleArchiveEvent, VisibleWorkerMessage, StreamStats } from "../../lib/subagent-run.ts";
import type { CapabilityRequest } from "../../lib/subagent-capability.ts";
import type { HoldRequest } from "../../lib/subagent-hold.ts";
import { archiveDiagnostics } from "./diagnostics.ts";

export type WorkerStatus =
  | "queued"
  | "starting"
  | "running"
  | "success"
  | "failed"
  | "aborted"
  | "timeout"
  | "needs_approval"
  /** 暂存中：预算见底（或 worker 主动请求），停下等主侧决定继续/补充/收工 */
  | "holding";

export interface WorkerRun {
  id: string;
  /** 本批分配的安全 inbox id（补充指令队列用；仅 [A-Za-z0-9_-]，绝不暴露队列文件路径） */
  inboxId: string;
  task: string;
  model: string;
  status: WorkerStatus;
  startedAt: string;
  finishedAt?: string;
  /** 最近一次可观察 worker 事件/状态更新；用于 GUI 无事件时长分级。 */
  lastActivityAt?: string;
  pid?: number;
  usage?: SubagentUsage;
  /** 流式增量累计：展示层据此算字数吞吐与「是否还在推进」（纯思考期也有值） */
  stream?: StreamStats;
  /** 在途 assistant 消息的实时 output token（usage.output 之外的部分） */
  liveOutputTokens?: number;
  output?: string;
  stderr?: string;
  /** 有界 per-worker 执行轨迹（实时更新；终态保留最终 timeline） */
  timeline?: TimelineEvent[];
  /** 任务与 assistant 可见文本的完整来回；隐藏 reasoning 不在此字段。 */
  visibleConversation?: VisibleWorkerMessage[];
  archiveTimeline?: VisibleArchiveEvent[];
  /** worker 等待主进程审批的能力请求 */
  capabilityRequest?: CapabilityRequest;
  /** worker 已暂存，等主侧决定（继续/补充/收工） */
  holdRequest?: HoldRequest;
}

/** 合并写最大延迟：GUI 1s 轮询周期内必定收到新状态 */
export const COALESCE_DELAY_MS = 250;

/** 需要立即落盘的状态：启动 + 并行排队 + 全部终态 */
const IMMEDIATE_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  "queued",
  "starting",
  "success",
  "needs_approval",
  "failed",
  "aborted",
  "timeout",
]);

const STATUS_PATH = join(homedir(), ".pi", "subagent-status.json");

/** 状态快照文件名前缀；带会话哈希时写 `<前缀>-<哈希>.json` */
export const STATUS_FILE_PREFIX = "subagent-status";

/**
 * 会话语义下的状态快照路径。
 *
 * 不带哈希时仍是全局单文件（旧行为，单会话/测试用）；带哈希时每个会话一份，
 * 多开 pi 同时跑 subagent 不再互相覆盖。
 */
export function statusPathFor(sessionHash: string | undefined): string {
  const dir = join(homedir(), ".pi");
  return sessionHash
    ? join(dir, `${STATUS_FILE_PREFIX}-${sessionHash}.json`)
    : join(dir, `${STATUS_FILE_PREFIX}.json`);
}

/**
 * 会话短哈希：8 位十六进制，用作文件名与记录里的会话标识。
 * 走哈希而不是截 id 前缀，免得把会话 id 本身漏到到处可见的文件名里。
 */
export function sessionHashOf(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}

/** 写进快照的会话信息：事后能看出这份状态属于哪条会话 */
export interface StatusSessionInfo {
  /** 会话 id 原文（不写进文件名，只进内容，便于精确对应） */
  id?: string;
  /** 短哈希：文件名与记录里的标识 */
  hash: string;
  /** 会话 jsonl 路径（便于回溯） */
  file?: string;
  /** 工作目录：多个会话常在不同项目下，认人靠它 */
  cwd?: string;
}

let session: StatusSessionInfo | undefined;

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

/**
 * 快照变更订阅者：beginBatch / updateWorker 改写快照后同步通知。
 *
 * 用途：把实时状态直接推给展示层（TUI 行渲染），不必让每个改快照的调用点
 * 都记得自己转发一次——转发漏一处就是一处“界面不动”的隐形 bug。
 */
const snapshotListeners = new Set<(workers: WorkerRun[]) => void>();

/** 订阅快照变更，返回退订函数。监听器必须轻量（投递层自行合并频率）。 */
export function onSnapshotChange(listener: (workers: WorkerRun[]) => void): () => void {
  snapshotListeners.add(listener);
  return () => {
    snapshotListeners.delete(listener);
  };
}

/** 广播快照；单个监听器抛错不得影响调度与其他监听器 */
function notifySnapshot(): void {
  if (snapshotListeners.size === 0) return;
  for (const listener of Array.from(snapshotListeners)) {
    try {
      listener(snapshot);
    } catch {
      /* 展示层异常与调度隔离 */
    }
  }
}

function serialize(): string {
  const doc: Record<string, unknown> = { updatedAt: io.now(), workers: snapshot };
  if (session) doc.session = session;
  return JSON.stringify(doc, null, 2);
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
  archiveDiagnostics(snapshot);
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
  notifySnapshot();
}

export function updateWorker(id: string, patch: Partial<WorkerRun>): void {
  const w = snapshot.find((r) => r.id === id);
  if (!w) return;
  // 任意真实状态/遥测补丁都更新活动时间；UI 据此只提示，不自动终止 worker。
  if (patch.lastActivityAt === undefined) patch.lastActivityAt = io.now();
  Object.assign(w, patch);
  // 启动/终态必须立即落盘；其余实时增量合并写入（有界延迟）
  if (patch.status !== undefined && IMMEDIATE_STATUSES.has(patch.status)) {
    writeNow();
  } else {
    scheduleWrite();
  }
  notifySnapshot();
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
  /** 当前会话信息；不传则不写 session 字段（旧行为） */
  session?: StatusSessionInfo;
  writeFile?: (path: string, data: string) => void;
  now?: () => string;
  schedule?: (fn: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** 测试/宿主注入：替换状态文件 IO 与合并调度器（确定性验证用） */
export function configureStatusFile(cfg: StatusFileConfig): void {
  session = cfg.session;
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
  session = undefined;
  snapshot = [];
  snapshotListeners.clear();
}

/** 当前快照路径：/subagent:gui 与历史浏览用它确认「哪个是当前会话的」 */
export function currentStatusPath(): string {
  return io.path;
}
