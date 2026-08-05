// be-error-recorder — be-* 工具调用失败持久记录
//
// 反馈模式下 worker 只允许 read/bash/be-* 工具（better-edit-tools 反馈收集）。
// be-* 调用失败（模型使用错误）时，本扩展向 ~/.pi/subagent-be-errors.jsonl 追加一行，
// 供用户离线审阅后手动编辑。只追加，绝不自动删除/压缩/去重/改写。
//
// 仅由反馈模式 worker 显式加载（--extension），不注册任何工具。

import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_LOG_PATH = join(homedir(), ".pi", "subagent-be-errors.jsonl");

export interface BeErrorRecord {
  ts: string;
  taskId?: string;
  model?: string;
  tool: string;
  input: string;
  error: string;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c && typeof c === "object" && (c as any).type === "text")
    .map((c) => c.text)
    .join("\n")
    .slice(0, 2000);
}

export function buildRecord(event: ToolResultEvent, taskId?: string): BeErrorRecord | null {
  if (!event.isError) return null;
  if (typeof event.toolName !== "string" || !event.toolName.startsWith("be-")) return null;
  let input = "";
  try { input = JSON.stringify(event.input ?? {}).slice(0, 2000); } catch { input = String(event.input).slice(0, 2000); }
  return {
    ts: new Date().toISOString(),
    taskId,
    model: process.env.PI_MODEL,
    tool: event.toolName,
    input,
    error: textOf(event.content) || String((event as any).errorMessage ?? "").slice(0, 2000),
  };
}

export function appendRecord(logPath: string, rec: BeErrorRecord | null): void {
  if (!rec) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, JSON.stringify(rec) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch { /* 记录失败不打断 worker */ }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event: ToolResultEvent) => {
    appendRecord(DEFAULT_LOG_PATH, buildRecord(event, process.env.PI_TASK_ID));
  });
}
