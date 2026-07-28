// todo-scan.ts — TODO 扫描纯数据层
// 供 trident-routing/index.ts 调用，不直接操作 UI

import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";

const TODO_PATTERN = "TO" + "DO:"; // 拆开避免扫到自己
const SEARCH_TIMEOUT_MS = 5000;

export interface TodoItem {
  file: string;
  line: number;
  text: string;
  done: boolean;
}

export type ScanState =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "done"; items: TodoItem[]; total: number; doneCount: number; expanded: boolean }
  | { status: "timeout" }
  | { status: "error"; message: string };

function parseSearchOutput(stdout: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const match = line.match(/^(.+):(\d+):(.*)$/);
    if (!match) continue;
    const text = match[3]!.trim();
    items.push({
      file: match[1]!,
      line: parseInt(match[2]!, 10),
      text,
      done: text.includes("TO" + "DO:DONE"),
    });
  }
  return items;
}

export async function scanTodos(
  pi: ExtensionAPI,
  cwd: string,
): Promise<{ items: TodoItem[]; total: number; doneCount: number } | null> {
  let result: ExecResult;

  try {
    result = await pi.exec("rg", [
      "-n", "--no-heading",
      "-g", "!node_modules", "-g", "!.git", "-g", "!dist", "-g", "!build", "-g", "!target",
      "-g", "!extensions/todo-scanner.ts",
      "-g", "!extensions/trident-routing/*",
      "-g", "!extensions/trident-queue/*",
      TODO_PATTERN, ".",
    ], { timeout: SEARCH_TIMEOUT_MS, cwd });
  } catch {
    try {
      result = await pi.exec("grep", [
        "-rn",
        "--exclude-dir=node_modules", "--exclude-dir=.git",
        "--exclude-dir=dist", "--exclude-dir=build", "--exclude-dir=target",
        "--exclude=todo-scanner.ts",
        "--exclude-dir=trident-routing",
        "--exclude-dir=trident-queue",
        TODO_PATTERN, ".",
      ], { timeout: SEARCH_TIMEOUT_MS, cwd });
    } catch {
      return null;
    }
  }

  if (result.killed) return null;
  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return { items: [], total: 0, doneCount: 0 };

  const items = parseSearchOutput(stdout);
  return { items, total: items.length, doneCount: items.filter((i) => i.done).length };
}

/** 计算字符串终端可见宽度（CJK 2，其他 1） */
export function visibleWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1b000 && cp <= 0x1b2ff) ||
      (cp >= 0x1f004 && cp <= 0x1f251) || (cp >= 0x20000 && cp <= 0x2ffff)
    ) w += 2;
    else w += 1;
  }
  return w;
}

export function truncateToWidth(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let w = 0;
  const chars = [...str];
  for (let i = 0; i < chars.length; i++) {
    w += visibleWidth(chars[i]!);
    if (w > maxWidth) return chars.slice(0, i).join("") + "…";
  }
  return str;
}
