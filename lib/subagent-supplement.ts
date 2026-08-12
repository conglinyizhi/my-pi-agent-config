// lib/subagent-supplement.ts — subagent 补充指令队列存储（Task 1）
//
// 每个 worker 一条 FIFO 队列，存于 ~/.pi/subagent-supplements/<inboxId>.json。
// 队列操作对并发的 worker Node 进程 / Go bridge 安全：
//   - 队列文件旁的同名 .lock 目录做互斥，有限超时 + stale mtime 恢复；
//   - 写操作走同目录临时文件 + rename 原子落盘，读方永远看到完整文件；
//   - 队列文件 owner-only（0o600）。
// 本模块只负责存储与纯队列语义（enqueue/claim/withdraw/merge），
// 不做 worker 生命周期判断（那是 bridge / Go 层的事）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** 单条补充消息原文上限（字符）。 */
export const MAX_SUPPLEMENT_TEXT = 4000;
/** 单 inbox 容量上限：pending + handoff 合计。 */
export const MAX_SUPPLEMENT_ENTRIES = 30;
/** 锁等待超时（ms）：超过即抛错，不让写者无限阻塞。 */
export const SUPPLEMENT_LOCK_TIMEOUT_MS = 5000;
/** 锁目录 mtime 超过该阈值视为 stale，可被回收。 */
export const SUPPLEMENT_LOCK_STALE_MS = 10_000;

// ── supplement wire 标记（Task 2）──
//
// bridge 把 claim 到的 entry 编码成 user 消息塞回 worker（pi.sendUserMessage +
// deliverAs: "steer"），TimelineBuilder 需要从 worker JSON 的 user message_start 里
// 判别出这条补充指令并留下 supplement 轨迹，同时保证普通 worker user 输入
// （初始任务提示词等）绝不被误判。标记放在 lib 层（Task 1 的底层协议）以便
// bridge（extension）与 timeline（lib）共享，timeline 不反向依赖 extension 路径。

/** wire 前缀：普通 worker user 输入几乎不可能以它开头。 */
export const SUPPLEMENT_MESSAGE_PREFIX = "⟦pi-supplement:v1⟧";

/** decode 成功后的载荷：entry id + 补充正文。 */
export interface DecodedSupplementMessage {
  id: string;
  text: string;
}

/** 编码一条补充消息（前缀 + JSON 载荷）。 */
export function encodeSupplementMessage(id: string, text: string): string {
  return SUPPLEMENT_MESSAGE_PREFIX + JSON.stringify({ id, text });
}

/**
 * 解码补充消息。tolerate malformed：无前缀 / 载荷非 JSON / 字段缺失或类型不对
 * 一律返回 null，绝不抛出，也绝不把残缺内容暴露给调用方。
 */
export function decodeSupplementMessage(text: string): DecodedSupplementMessage | null {
  if (typeof text !== "string" || !text.startsWith(SUPPLEMENT_MESSAGE_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(SUPPLEMENT_MESSAGE_PREFIX.length));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as { id?: unknown; text?: unknown };
  if (typeof p.id !== "string" || !p.id) return null;
  if (typeof p.text !== "string") return null;
  return { id: p.id, text: p.text };
}

/** 默认队列根目录：~/.pi/subagent-supplements */
export const INBOX_ROOT = path.join(os.homedir(), ".pi", "subagent-supplements");

export interface SupplementEntry {
  id: string;
  text: string;
  state: "pending" | "handoff";
  createdAt: string;
  handedOffAt?: string;
}

export interface SupplementInbox {
  inboxId: string;
  createdAt: string;
  updatedAt: string;
  /** 数组顺序即 FIFO 顺序：handoff 不可撤回，pending 按序被 claim/merge。 */
  entries: SupplementEntry[];
}

export interface SupplementInboxOptions {
  /** 队列根目录；默认 INBOX_ROOT。测试注入临时目录。 */
  root?: string;
  /** 时钟注入；默认 new Date().toISOString()。 */
  now?: () => string;
  /** 条目 id 生成器；默认 randomUUID。 */
  id?: () => string;
  /** 锁等待超时（ms）；默认 SUPPLEMENT_LOCK_TIMEOUT_MS。 */
  lockTimeoutMs?: number;
  /** 锁视为 stale 的 mtime 阈值（ms）；默认 SUPPLEMENT_LOCK_STALE_MS。 */
  lockStaleMs?: number;
}

export interface ClaimResult {
  inbox: SupplementInbox;
  claimed: SupplementEntry | null;
}

export interface WithdrawResult {
  inbox: SupplementInbox;
  withdrawn: boolean;
}

export interface ReleaseResult {
  inbox: SupplementInbox;
  released: boolean;
}

export interface MergeResult {
  inbox: SupplementInbox;
  merged: boolean;
}

interface ResolvedOptions {
  root: string;
  now: () => string;
  id: () => string;
  lockTimeoutMs: number;
  lockStaleMs: number;
}

/** inboxId 仅允许安全 ASCII 标识符字符，1-128 位，杜绝路径穿越。 */
export function isValidInboxId(inboxId: string): boolean {
  return typeof inboxId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(inboxId);
}

function assertInboxId(inboxId: string): void {
  if (!isValidInboxId(inboxId)) {
    throw new Error(
      `invalid inboxId ${JSON.stringify(inboxId)}: must be 1-128 chars of [A-Za-z0-9_-]`,
    );
  }
}

function resolveOptions(options?: SupplementInboxOptions): ResolvedOptions {
  return {
    root: options?.root ?? INBOX_ROOT,
    now: options?.now ?? (() => new Date().toISOString()),
    id: options?.id ?? randomUUID,
    lockTimeoutMs: options?.lockTimeoutMs ?? SUPPLEMENT_LOCK_TIMEOUT_MS,
    lockStaleMs: options?.lockStaleMs ?? SUPPLEMENT_LOCK_STALE_MS,
  };
}

function queueFilePath(root: string, inboxId: string): string {
  return path.join(root, `${inboxId}.json`);
}

/**
 * 确保根目录存在且 owner 权限不宽于 0o700：
 *   - 自建时 mkdir mode 受 umask 放宽，创建后显式 chmod 收紧到 0o700；
 *   - 已存在时只清除 0o700 之外的多余位，绝不放宽已有更严权限
 *     （0o700 是可用目录的最严权限，`existing & 0o700` 恒不增加位）。
 * 平台不支持 chmod 时静默忽略（Windows 等），由调用方按需跳过断言。
 */
function ensureRootDir(root: string): void {
  let existingMode: number | null = null;
  try {
    existingMode = fs.statSync(root).mode & 0o777;
  } catch {
    // 不存在，稍后创建
  }
  if (existingMode === null) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(root, 0o700);
    } catch {
      // 平台不支持时忽略
    }
    return;
  }
  const tightened = existingMode & 0o700;
  if (tightened !== existingMode) {
    try {
      fs.chmodSync(root, tightened);
    } catch {
      // 平台不支持时忽略
    }
  }
}

function lockDirPath(queueFile: string): string {
  return `${queueFile}.lock`;
}

/** 深冻结返回给调用方的 snapshot，保证「API 不变异已给出 snapshot」。 */
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      freezeSnapshot((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

let tmpSeq = 0;

/** 同目录临时文件 + fsync + rename 原子落盘；文件 owner-only。 */
function atomicWriteJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${tmpSeq++}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 锁目录 mtime 过旧即视为 stale（写者已崩溃），可回收。 */
function isStaleLock(lockDir: string, staleMs: number): boolean {
  try {
    const st = fs.statSync(lockDir);
    return Date.now() - st.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * 以锁目录方式互斥执行 fn：mkdir 成功即持锁，finally 必释放。
 * 锁被占时轮询等待至 lockTimeoutMs；超过超时抛错且不删除别人的锁。
 * 仅当锁 stale 时才强制回收。锁只守护短促的本地文件操作。
 */
async function withLock<T>(
  lockDir: string,
  opts: ResolvedOptions,
  fn: () => T,
): Promise<T> {
  const deadline = Date.now() + opts.lockTimeoutMs;
  let acquired = false;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      acquired = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isStaleLock(lockDir, opts.lockStaleMs)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${opts.lockTimeoutMs}ms waiting for queue lock ${lockDir}`,
        );
      }
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    try {
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch {
      // owner 文件仅供调试，写失败不阻断操作
    }
    return await fn();
  } finally {
    if (acquired) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // 释放失败留待 stale recovery 兜底
      }
    }
  }
}

/** 读取并校验队列文件；缺失或损坏抛错。 */
function readQueueFile(file: string): SupplementInbox {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`inbox file not found: ${file}`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt inbox file (invalid JSON): ${file}`);
  }
  const inbox = parsed as SupplementInbox;
  if (
    typeof inbox !== "object" ||
    inbox === null ||
    typeof inbox.inboxId !== "string" ||
    typeof inbox.createdAt !== "string" ||
    typeof inbox.updatedAt !== "string" ||
    !Array.isArray(inbox.entries)
  ) {
    throw new Error(`corrupt inbox file (bad shape): ${file}`);
  }
  for (const entry of inbox.entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.id !== "string" ||
      typeof entry.text !== "string" ||
      (entry.state !== "pending" && entry.state !== "handoff") ||
      typeof entry.createdAt !== "string"
    ) {
      throw new Error(`corrupt inbox file (bad entry): ${file}`);
    }
  }
  return inbox;
}

/** 创建新 inbox；已存在则抛错（幂等创建由调用方负责）。 */
export async function createInbox(
  inboxId: string,
  options?: SupplementInboxOptions,
): Promise<SupplementInbox> {
  assertInboxId(inboxId);
  const o = resolveOptions(options);
  ensureRootDir(o.root);
  const file = queueFilePath(o.root, inboxId);
  const now = o.now();
  return withLock(lockDirPath(file), o, () => {
    if (fs.existsSync(file)) {
      throw new Error(`inbox already exists: ${inboxId}`);
    }
    const inbox: SupplementInbox = {
      inboxId,
      createdAt: now,
      updatedAt: now,
      entries: [],
    };
    atomicWriteJson(file, inbox);
    return freezeSnapshot(inbox);
  });
}

/** 读取 inbox 快照；不存在抛错。 */
export async function readInbox(
  inboxId: string,
  options?: SupplementInboxOptions,
): Promise<SupplementInbox> {
  assertInboxId(inboxId);
  const o = resolveOptions(options);
  const file = queueFilePath(o.root, inboxId);
  return withLock(lockDirPath(file), o, () =>
    freezeSnapshot(readQueueFile(file)),
  );
}

/** 队尾追加一条 pending 消息。空白拒绝、超 4000 字符拒绝、总量超 30 拒绝。 */
export async function enqueueSupplement(
  inboxId: string,
  text: string,
  options?: SupplementInboxOptions,
): Promise<SupplementInbox> {
  assertInboxId(inboxId);
  if (typeof text !== "string") {
    throw new Error(`supplement text must be a string, got ${typeof text}`);
  }
  if (text.trim().length === 0) {
    throw new Error("supplement text must not be blank");
  }
  if (text.length > MAX_SUPPLEMENT_TEXT) {
    throw new Error(
      `supplement text too long: ${text.length} chars (max ${MAX_SUPPLEMENT_TEXT})`,
    );
  }
  const o = resolveOptions(options);
  const file = queueFilePath(o.root, inboxId);
  return withLock(lockDirPath(file), o, () => {
    const inbox = readQueueFile(file);
    if (inbox.entries.length >= MAX_SUPPLEMENT_ENTRIES) {
      throw new Error(
        `inbox ${inboxId} is full: ${MAX_SUPPLEMENT_ENTRIES} entries`,
      );
    }
    const entry: SupplementEntry = {
      id: o.id(),
      text,
      state: "pending",
      createdAt: o.now(),
    };
    inbox.entries.push(entry);
    inbox.updatedAt = o.now();
    atomicWriteJson(file, inbox);
    return freezeSnapshot(inbox);
  });
}

/**
 * 把最早的 pending 置为 handoff 并记 handedOffAt。一次只 claim 一条，
 * 不接受任何工具结果参数（成功/失败工具完成后的行为由 bridge 决定，与队列无关）。
 */
export async function claimNextSupplement(
  inboxId: string,
  options?: SupplementInboxOptions,
): Promise<ClaimResult> {
  assertInboxId(inboxId);
  const o = resolveOptions(options);
  const file = queueFilePath(o.root, inboxId);
  return withLock(lockDirPath(file), o, () => {
    const inbox = readQueueFile(file);
    const index = inbox.entries.findIndex((e) => e.state === "pending");
    if (index === -1) {
      return { inbox: freezeSnapshot(inbox), claimed: null };
    }
    const claimed = inbox.entries[index];
    claimed.state = "handoff";
    claimed.handedOffAt = o.now();
    inbox.updatedAt = o.now();
    atomicWriteJson(file, inbox);
    return {
      inbox: freezeSnapshot(inbox),
      claimed: freezeSnapshot(claimed),
    };
  });
}

/** 撤回一条 pending；handoff 条目不可撤回，未知 id 返回 withdrawn false。 */
export async function withdrawSupplement(
  inboxId: string,
  entryId: string,
  options?: SupplementInboxOptions,
): Promise<WithdrawResult> {
  assertInboxId(inboxId);
  const o = resolveOptions(options);
  const file = queueFilePath(o.root, inboxId);
  return withLock(lockDirPath(file), o, () => {
    const inbox = readQueueFile(file);
    const index = inbox.entries.findIndex((e) => e.id === entryId);
    if (index === -1 || inbox.entries[index].state !== "pending") {
      return { inbox: freezeSnapshot(inbox), withdrawn: false };
    }
    inbox.entries.splice(index, 1);
    inbox.updatedAt = o.now();
    atomicWriteJson(file, inbox);
    return { inbox: freezeSnapshot(inbox), withdrawn: true };
  });
}

/**
 * 把一条 handoff 原位恢复为 pending（bridge 投递失败时回滚用）。
 * 只允许 handoff：pending 条目本就未投递、未知 id 一律返回 released false 且不写盘。
 * 恢复是「原位」的——条目在 entries 中的位置不变，删除 handedOffAt，更新 updatedAt。
 */
export async function releaseSupplement(
  inboxId: string,
  entryId: string,
  options?: SupplementInboxOptions,
): Promise<ReleaseResult> {
  assertInboxId(inboxId);
  const o = resolveOptions(options);
  const file = queueFilePath(o.root, inboxId);
  return withLock(lockDirPath(file), o, () => {
    const inbox = readQueueFile(file);
    const index = inbox.entries.findIndex((e) => e.id === entryId);
    if (index === -1 || inbox.entries[index].state !== "handoff") {
      return { inbox: freezeSnapshot(inbox), released: false };
    }
    const entry = inbox.entries[index];
    entry.state = "pending";
    delete entry.handedOffAt;
    inbox.updatedAt = o.now();
    atomicWriteJson(file, inbox);
    return { inbox: freezeSnapshot(inbox), released: true };
  });
}

/**
 * 把所有 pending 按原顺序合并为一条，新条目位于第一个 pending 的**原全局位置**；
 * 所有 handoff（前/中/后）原样保留相对顺序。少于 2 条 pending 返回 merged false 且不写盘。
 * 正文按 `--- Supplement N ---`（N 从 2 起，作为独立段落以空行分隔）连接。
 */
export async function mergePendingSupplements(
  inboxId: string,
  options?: SupplementInboxOptions,
): Promise<MergeResult> {
  assertInboxId(inboxId);
  const o = resolveOptions(options);
  const file = queueFilePath(o.root, inboxId);
  return withLock(lockDirPath(file), o, () => {
    const inbox = readQueueFile(file);
    const pending = inbox.entries.filter((e) => e.state === "pending");
    if (pending.length < 2) {
      return { inbox: freezeSnapshot(inbox), merged: false };
    }
    const firstPendingIndex = inbox.entries.findIndex(
      (e) => e.state === "pending",
    );
    const parts: string[] = [];
    pending.forEach((entry, i) => {
      if (i > 0) parts.push(`--- Supplement ${i + 1} ---`);
      parts.push(entry.text);
    });
    const merged: SupplementEntry = {
      id: o.id(),
      text: parts.join("\n\n"),
      state: "pending",
      createdAt: o.now(),
    };
    // 按原全局顺序重建：merged 占据最早 pending 的原位置（该处插入一次），
    // 所有 handoff（包括位于最早 pending 之前/中间/之后的）原样保留相对顺序，
    // 其余 pending 被 merged 取代（跳过）。
    const next: SupplementEntry[] = [];
    for (let i = 0; i < inbox.entries.length; i++) {
      const entry = inbox.entries[i];
      if (i === firstPendingIndex) {
        next.push(merged);
      } else if (entry.state === "handoff") {
        next.push(entry);
      }
      // 其余 pending：已并入 merged，不保留
    }
    inbox.entries = next;
    inbox.updatedAt = o.now();
    atomicWriteJson(file, inbox);
    return { inbox: freezeSnapshot(inbox), merged: true };
  });
}
