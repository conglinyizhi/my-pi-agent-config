// Subagent 工具：将任务委派给隔离上下文的子进程执行
//
// 单一 worker 子进程，不暴露 agent 名称选择，避免主 Agent 产生幻觉。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatTokens } from "../../lib/format-utils";
import { getFinalOutput } from "../../lib/message-utils";

const SUBAGENT_PROMPT = `你是一名具备完整能力的 worker agent。你在隔离的上下文窗口中处理委派任务，避免污染主对话。

请自主完成分配给你的任务，并按需使用所有可用工具。

完成后的输出格式：

## 已完成

做了什么。

## 已修改文件

- \`path/to/file.ts\` - 改了什么

## 备注（如果有）

主 agent 需要知道的事项。`;

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens?: number;
  turns: number;
}

interface SubagentResult {
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

type PiInvocation = { command: string; args: string[] };

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

// ═══════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════

function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} 轮`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: (color: ThemeColor, text: string) => string): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

function isFailedResult(result: SubagentResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SubagentResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "（无输出）";
  }
  return getFinalOutput(result.messages) || "（无输出）";
}

function getPiInvocation(args: string[]): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

function resolveModelName(): string {
  const rolesPath = path.join(os.homedir(), ".pi", "agent", "providers.roles.toml");
  try {
    const content = fs.readFileSync(rolesPath, "utf-8");
    let inRoles = false;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "[roles]") { inRoles = true; continue; }
      if (inRoles && trimmed.startsWith("[")) break;
      if (!inRoles) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "worker" && value) return value;
    }
  } catch { /* 忽略 */ }
  return "worker";
}

// ═══════════════════════════════════════════════════
// 参数定义
// ═══════════════════════════════════════════════════

const SubagentParams = Type.Object({
  task: Type.String({ description: "要委派给子进程的任务描述" }),
  cwd: Type.Optional(Type.String({ description: "工作目录，默认使用当前项目目录" })),
  timeout: Type.Optional(Type.Number({ description: "超时秒数，默认 600（10分钟）", default: 600 })),
});

// ═══════════════════════════════════════════════════
// 注册
// ═══════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT) return;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "将任务委派给隔离上下文的子进程执行。子进程拥有完整工具权限，在独立上下文中工作，完成后返回结果。适合需要多步操作且不应污染主对话上下文的场景。",
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const task: string = params.task;
      const cwd: string = params.cwd ?? ctx.cwd;
      const timeout = (params.timeout ?? 600) * 1000;

      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(new Error(`Subagent 超时（${params.timeout ?? 600}s）`)), timeout);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      try {
        const model = resolveModelName();
        const args = ["--mode", "json", "-p", "--no-session", "--model", model];

        // 写入 subagent 系统提示词
        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
        const promptPath = path.join(tmpDir, "prompt.md");
        await fs.promises.writeFile(promptPath, SUBAGENT_PROMPT, { encoding: "utf-8", mode: 0o600 });
        args.push("--append-system-prompt", promptPath);
        args.push(`任务：${task}`);

        const invocation = getPiInvocation(args);

        const result: SubagentResult = {
          task,
          exitCode: 0,
          messages: [],
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          model,
        };

        const emitUpdate = () => {
          if (onUpdate) {
            onUpdate({
              content: [{ type: "text", text: getFinalOutput(result.messages) || "（运行中...）" }],
              details: { result },
            });
          }
        };

        let wasAborted = false;
        const exitCode = await new Promise<number>((resolve) => {
          const proc = spawn(invocation.command, invocation.args, {
            cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PI_SUBAGENT: "1" },
          });
          let buffer = "";

          proc.stdout.on("data", (data) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              let event: { type?: string; message?: unknown };
              try { event = JSON.parse(line); } catch { continue; }

              if (event.type === "message_end" && event.message) {
                const msg = event.message as Message;
                result.messages.push(msg);
                if (msg.role === "assistant") {
                  result.usage.turns++;
                  const usage = msg.usage;
                  if (usage) {
                    result.usage.input += usage.input || 0;
                    result.usage.output += usage.output || 0;
                    result.usage.cacheRead += usage.cacheRead || 0;
                    result.usage.cacheWrite += usage.cacheWrite || 0;
                    result.usage.cost += usage.cost?.total || 0;
                    result.usage.contextTokens = usage.totalTokens || 0;
                  }
                  if (!result.model && msg.model) result.model = msg.model;
                  if (msg.stopReason) result.stopReason = msg.stopReason;
                  if (msg.errorMessage) result.errorMessage = msg.errorMessage;
                }
                emitUpdate();
              }
              if (event.type === "tool_result_end" && event.message) {
                result.messages.push(event.message as Message);
                emitUpdate();
              }
            }
          });

          proc.stderr.on("data", (data) => { result.stderr += data.toString(); });

          proc.on("close", (code) => {
            if (buffer.trim()) {
              const lines = buffer.split("\n");
              for (const line of lines) {
                if (!line.trim()) continue;
                let event: { type?: string; message?: unknown };
                try { event = JSON.parse(line); } catch { continue; }
                if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
                  result.messages.push(event.message as Message);
                }
              }
            }
            resolve(code ?? 0);
          });

          proc.on("error", () => resolve(1));

          if (combinedSignal) {
            const killProc = () => {
              wasAborted = true;
              proc.kill("SIGTERM");
              setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
            };
            if (combinedSignal.aborted) killProc();
            else combinedSignal.addEventListener("abort", killProc, { once: true });
          }
        });

        result.exitCode = exitCode;
        if (wasAborted) throw new Error("Subagent 已中止");

        // 清理临时文件
        try { fs.unlinkSync(promptPath); fs.rmdirSync(tmpDir); } catch { /* 忽略 */ }

        if (isFailedResult(result)) {
          return {
            content: [{ type: "text", text: `执行失败：${getResultOutput(result)}` }],
            details: { result },
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "（无输出）" }],
          details: { result },
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },

    renderCall(args, theme, _context) {
      const preview = args.task
        ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task)
        : "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("subagent")) + "\n  " + theme.fg("dim", preview),
        0, 0,
      );
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as { result: SubagentResult } | undefined;
      if (!details) {
        const text = result.content?.[0];
        return new Text(text?.type === "text" ? text.text : "（无输出）", 0, 0);
      }

      const r = details.result;
      const isError = isFailedResult(r);
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const displayItems = getDisplayItems(r.messages);
      const finalOutput = getFinalOutput(r.messages);
      const mdTheme = getMarkdownTheme();

      const renderItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... 还有更早的 ${skipped} 项\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      if (expanded) {
        const container = new Container();
        let header = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
        if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        container.addChild(new Text(header, 0, 0));
        if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── 任务 ───"), 0, 0));
        container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── 输出 ───"), 0, 0));
        if (displayItems.length === 0 && !finalOutput) {
          container.addChild(new Text(theme.fg("muted", "（无输出）"), 0, 0));
        } else {
          for (const item of displayItems) {
            if (item.type === "toolCall")
              container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
          }
          if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
          }
        }
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }
        return container;
      }

      let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
      if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
      if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
      else if (displayItems.length === 0) text += `\n${theme.fg("muted", "（无输出）")}`;
      else {
        text += `\n${renderItems(displayItems, 10)}`;
        if (displayItems.length > 10) text += `\n${theme.fg("muted", "（按 Ctrl+O 展开）")}`;
      }
      const usageStr = formatUsageStats(r.usage, r.model);
      if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
      return new Text(text, 0, 0);
    },
  });
}
