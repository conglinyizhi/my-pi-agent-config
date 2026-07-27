// tool-param-normalizer —— 工具参数修正 + 错误日志
//
// 两个功能：
// 1. tool_call 阶段：修正模型生成的非标准参数名（如 old_str → oldText）
// 2. tool_result 阶段：捕获工具调用错误，写入日志文件供离线审阅

import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- 日志 ----

const LOG_DIR = join(homedir(), ".pi", "agent");
const ERROR_LOG = join(LOG_DIR, "tool-errors.log");

function ensureLogDir() {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

function logError(line: string) {
  try {
    ensureLogDir();
    appendFileSync(ERROR_LOG, line + "\n");
  } catch { /* 日志写入失败不应影响主流程 */ }
}

function formatTime(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ---- edit 工具 edits[] 参数别名归一化 ----

const EDIT_KEY_ALIASES: Record<string, string> = {
  old_str: "oldText",
  old_text: "oldText",
  new_str: "newText",
  new_text: "newText",
};

function normalizeEditInput(input: Record<string, unknown>): string[] {
  const fixes: string[] = [];
  if (!Array.isArray(input.edits)) return fixes;

  for (const edit of input.edits as Record<string, unknown>[]) {
    for (const [bad, good] of Object.entries(EDIT_KEY_ALIASES)) {
      if (bad in edit && !(good in edit)) {
        edit[good] = edit[bad];
        delete edit[bad];
        fixes.push(`edits[].${bad} → ${good}`);
      }
    }
  }
  return fixes;
}

// ---- 从 tool call input 中提取 path 字段 ----

function extractPath(input: Record<string, unknown>): string {
  return String(input?.path ?? input?.file ?? "?");
}

// ----

export default function (pi: ExtensionAPI) {
  // ---- 阶段 1：执行前修正参数 ----
  pi.on("tool_call", (event: ToolCallEvent, _ctx) => {
    if (event.toolName !== "edit") return;
    if (!event.input) return;

    const fixes = normalizeEditInput(event.input as Record<string, unknown>);
    if (fixes.length > 0) {
      logError(`[${formatTime()}] FIX edit ${extractPath(event.input as Record<string, unknown>)} | ${fixes.join(", ")}`);
    }
  });

  // ---- 阶段 2：执行后记录错误 ----
  pi.on("tool_result", (event: ToolResultEvent, _ctx) => {
    if (!event.isError) return;

    const input = event.input as Record<string, unknown>;
    const contentText = (event.content ?? [])
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(" ")
      .slice(0, 500);

    const lines = [
      `[${formatTime()}] ERROR ${event.toolName} ${extractPath(input)}`,
      `  input: ${JSON.stringify(input).slice(0, 300)}`,
      `  output: ${contentText}`,
    ];

    // edit 工具特有：打印 edits 结构帮助诊断
    if (event.toolName === "edit" && input?.edits) {
      const editKeys = (input.edits as Record<string, unknown>[]).map((e) => Object.keys(e).join(",")).join(" | ");
      lines.push(`  edits keys: ${editKeys}`);
    }

    logError(lines.join("\n"));
  });
}
