/**
 * 状态快照的历史浏览：列出 ~/.pi/subagent-status*.json，供 /subagent:gui-history 选择。
 *
 * 快照按会话分区后（每个 pi 会话一份），旧会话的文件会留下来，能回看当时在跑什么。
 * 这里只做列举与描述，不解释内容——快照结构由 status.ts 决定。
 */

import * as fs from "node:fs";
import { join } from "node:path";
import { STATUS_FILE_PREFIX } from "./status.ts";

export interface StatusSnapshotFile {
  path: string;
  /** 快照写入时刻（文件内容里的 updatedAt，缺失回退文件 mtime） */
  updatedAt?: string;
  /** 该文件属于哪个会话 */
  sessionHash?: string;
  sessionCwd?: string;
  sessionFile?: string;
  workerCount: number;
  /** 当前会话正在写的那个 */
  current: boolean;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // 半截文件 / 权限问题：当没这份，不让一个坏文件挡住列表
  }
}

/** 扫描快照目录。坏文件跳过，按 updatedAt 从新到旧排，当前会话置顶。 */
export function listStatusSnapshots(dir: string, opts: { currentPath?: string } = {}): StatusSnapshotFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: StatusSnapshotFile[] = [];
  for (const name of names) {
    if (!name.startsWith(STATUS_FILE_PREFIX) || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    const doc = readJson(path);
    if (!doc) continue;
    const session = (doc.session ?? {}) as Record<string, unknown>;
    const workers = Array.isArray(doc.workers) ? doc.workers : [];
    let updatedAt = typeof doc.updatedAt === "string" ? doc.updatedAt : undefined;
    if (!updatedAt) {
      try {
        updatedAt = fs.statSync(path).mtime.toISOString();
      } catch {
        /* 读不到就当没有 */
      }
    }
    out.push({
      path,
      updatedAt,
      sessionHash: typeof session.hash === "string" ? session.hash : undefined,
      sessionCwd: typeof session.cwd === "string" ? session.cwd : undefined,
      sessionFile: typeof session.file === "string" ? session.file : undefined,
      workerCount: workers.length,
      current: opts.currentPath !== undefined && path === opts.currentPath,
    });
  }
  out.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
  });
  return out;
}

function shortTime(iso: string | undefined): string {
  if (!iso) return "时间未知";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "时间未知";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 目录尾段：多个会话常在不同项目下，一眼认出是哪个 */
function tailName(p: string | undefined): string {
  if (!p) return "?";
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length === 0 ? p : parts.slice(-2).join("/");
}

/** 选择列表里的一行 */
export function describeSnapshot(f: StatusSnapshotFile): string {
  const bits = [
    f.current ? "当前会话" : f.sessionHash ? `会话 ${f.sessionHash}` : "旧格式快照",
    tailName(f.sessionCwd),
    shortTime(f.updatedAt),
    `${f.workerCount} 个 worker`,
  ];
  return bits.join(" · ");
}
