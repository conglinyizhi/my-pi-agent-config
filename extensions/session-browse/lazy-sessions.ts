// session 懒加载源
//
// 背景：SessionManager.listAll() 会把 sessions 目录下每个 .jsonl 整个读出来解析，
// 用来算名称 / 首条消息 / 消息数。几百个 session（本项目实测 326 个文件、385MB）
// 全量解析要一两秒，而用户通常只看最近几条。
//
// 这里的做法：
//   1. 先只 readdir + stat 拿文件名和修改时间（几百个也就十几毫秒），按最后活动倒序
//   2. 按需解析：先解析最近 N 个，用户往后翻时再解析下一批
//   3. 带过滤时一直扫描到凑够一批匹配项，或扫完所有文件
//
// 解析出的 SessionInfo 与 SessionManager.listAll() 同形（名称 / 首条消息 / 消息数 /
// 最后活动时间 / 全文本），所以上层格式化逻辑不用改。

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSessionEntries,
  type FileEntry,
  type SessionInfo,
  type SessionMessageEntry,
  type SessionInfoEntry,
} from "@earendil-works/pi-coding-agent";

export interface SessionFileRef {
  path: string;
  mtimeMs: number;
}

/** 列出 sessions 目录下的所有 session 文件，按最后修改时间倒序 */
export async function listSessionFiles(sessionsDir: string): Promise<SessionFileRef[]> {
  let dirs: string[];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    dirs = entries.filter(entry => entry.isDirectory()).map(entry => join(sessionsDir, entry.name));
  } catch {
    return [];
  }

  const refs: SessionFileRef[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        refs.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      } catch {
        // 文件在扫描间隙被删掉了，跳过
      }
    }
  }

  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && "type" in block && block.type === "text" &&
      "text" in block && typeof (block as { text?: unknown }).text === "string",
    )
    .map(block => block.text)
    .join(" ");
}

/**
 * 从已解析的条目里重建 SessionInfo。
 * 字段口径与 SessionManager 内部一致：名称取最后一条 session_info，
 * firstMessage 取首条 user 消息，modified 取最后一条消息的活动时间。
 */
export function buildSessionInfo(
  path: string,
  mtimeMs: number,
  entries: FileEntry[],
): SessionInfo | null {
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") return null;

  let messageCount = 0;
  let firstMessage = "";
  let name: string | undefined;
  let lastActivityTime: number | undefined;
  const allMessages: string[] = [];

  for (const entry of entries.slice(1)) {
    if (entry.type === "session_info") {
      name = (entry as SessionInfoEntry).name?.trim() || undefined;
      continue;
    }
    if (entry.type !== "message") continue;
    messageCount++;

    const message = (entry as SessionMessageEntry).message as {
      role?: unknown;
      content?: unknown;
      timestamp?: unknown;
    };
    if (typeof message?.role !== "string" || !("content" in message)) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;

    const text = messageText(message.content);
    if (!text) continue;

    allMessages.push(text);
    if (!firstMessage && message.role === "user") firstMessage = text;

    const timestamp = typeof message.timestamp === "number"
      ? message.timestamp
      : new Date(entry.timestamp).getTime();
    if (!Number.isNaN(timestamp)) lastActivityTime = Math.max(lastActivityTime ?? 0, timestamp);
  }

  const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
  const modified = lastActivityTime && lastActivityTime > 0
    ? new Date(lastActivityTime)
    : !Number.isNaN(headerTime)
      ? new Date(headerTime)
      : new Date(mtimeMs);

  return {
    path,
    id: header.id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    parentSessionPath: (header as { parentSession?: string }).parentSession,
    created: new Date(header.timestamp),
    modified,
    messageCount,
    firstMessage: firstMessage || "(no messages)",
    allMessagesText: allMessages.join(" "),
  };
}

export interface LazySessionOptions {
  /** 过滤谓词；返回 false 的 session 不进入结果 */
  match?: (info: SessionInfo) => boolean;
  /** 最多加载多少条（对应 /session-switch N） */
  limit?: number;
}

/** 按需解析的 session 源 */
export class LazySessionSource {
  private readonly files: SessionFileRef[];
  private readonly options: LazySessionOptions;
  private cursor = 0;
  private scanned = 0;
  private readonly items: SessionInfo[] = [];

  // 不用 TS 参数属性：Node 的剥类型模式不支持，扩展要能直接跑 .ts
  constructor(files: SessionFileRef[], options: LazySessionOptions = {}) {
    this.files = files;
    this.options = options;
  }

  static async create(sessionsDir: string, options: LazySessionOptions = {}): Promise<LazySessionSource> {
    return new LazySessionSource(await listSessionFiles(sessionsDir), options);
  }

  /** 已解析出来的 session（按最后活动倒序） */
  get sessions(): SessionInfo[] {
    return this.items;
  }

  /** 磁盘上的 session 文件总数 */
  get totalFiles(): number {
    return this.files.length;
  }

  /** 已扫描过的文件数（带过滤时用来显示进度） */
  get scannedFiles(): number {
    return this.scanned;
  }

  get hasMore(): boolean {
    if (this.cursor >= this.files.length) return false;
    const limit = this.options.limit;
    return limit === undefined || this.items.length < limit;
  }

  /**
   * 再加载一批，返回本次新增条数。
   * 带过滤时会一直扫描到凑够 batch 条匹配，或扫完所有文件。
   * 每个文件之间让出事件循环，TUI 能刷新「正在加载更多」。
   */
  async loadMore(batch: number): Promise<number> {
    let added = 0;
    while (added < batch && this.cursor < this.files.length) {
      if (this.options.limit !== undefined && this.items.length >= this.options.limit) break;

      const file = this.files[this.cursor++];
      this.scanned++;

      let info: SessionInfo | null = null;
      try {
        info = buildSessionInfo(file.path, file.mtimeMs, parseSessionEntries(await readFile(file.path, "utf8")));
      } catch {
        info = null; // 损坏或读不了的文件直接跳过
      }
      if (info && (!this.options.match || this.options.match(info))) {
        this.items.push(info);
        added++;
      }

      await new Promise(resolve => setImmediate(resolve));
    }
    return added;
  }
}
