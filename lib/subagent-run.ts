// subagent-run.ts — 隔离 pi 进程执行核心
//
// 提取自 extensions/subagent，供 task_new 内部调用。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { getFinalOutput } from "./message-utils";
import { formatTokens } from "./format-utils";

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens?: number;
  turns: number;
}

export interface SubagentResult {
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: SubagentUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export const SUBAGENT_PROMPT = `你是一名具备完整能力的 worker agent。你在隔离的上下文窗口中处理委派任务，避免污染主对话。

请自主完成分配给你的任务，并按需使用所有可用工具。

完成后的输出格式：

## 已完成

做了什么。

## 已修改文件

- \`path/to/file.ts\` - 改了什么

## 备注（如果有）

主 agent 需要知道的事项。`;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

export function getWorkerModel(): string {
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
  } catch { /* ignore */ }
  return "worker";
}

export function formatUsageStats(usage: SubagentUsage, model?: string): string {
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

export function isFailedResult(result: SubagentResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SubagentResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "（无输出）";
  }
  return getFinalOutput(result.messages) || "（无输出）";
}

export interface RunSubagentOptions {
  task: string;
  cwd: string;
  model?: string;
  timeout?: number;
  signal?: AbortSignal;
  taskId?: string; // 用于 permission-gate 关联
  onUpdate?: (result: SubagentResult) => void;
  onSpawn?: (pid: number) => void; // 子进程 PID，用于外部 kill
}

export function runSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
  const task = opts.task;
  const cwd = opts.cwd;
  const timeout = (opts.timeout ?? 600) * 1000;
  const model = opts.model || getWorkerModel();

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(
    () => timeoutController.abort(new Error(`Subagent 超时（${opts.timeout ?? 600}s）`)),
    timeout,
  );
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutController.signal])
    : timeoutController.signal;

  return new Promise(async (resolve, reject) => {
    try {
      const args = [
        "--mode", "json",
        "-p",
        "--no-session",
        "--model", model,
        "--mcp-config", path.join(os.homedir(), ".pi", "agent", "mcp.json"),
      ];

      // 写入系统提示词
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
        opts.onUpdate?.(result);
      };

      let wasAborted = false;

      const exitCode = await new Promise<number>((resolveExit) => {
        const env: Record<string, string> = {
          ...process.env,
          PI_SUBAGENT: "1",
        };
        if (opts.taskId) env.PI_TASK_ID = opts.taskId;

        const proc = spawn(invocation.command, invocation.args, {
          cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });

        opts.onSpawn?.(proc.pid!);

        let buffer = "";

        proc.stdout.on("data", (data: Buffer) => {
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

        proc.stderr.on("data", (data: Buffer) => { result.stderr += data.toString(); });

        proc.on("close", (code: number) => {
          if (buffer.trim()) {
            for (const line of buffer.split("\n")) {
              if (!line.trim()) continue;
              let event: { type?: string; message?: unknown };
              try { event = JSON.parse(line); } catch { continue; }
              if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
                result.messages.push(event.message as Message);
              }
            }
          }
          resolveExit(code ?? 0);
        });

        proc.on("error", () => resolveExit(1));

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

      try { fs.unlinkSync(promptPath); fs.rmdirSync(tmpDir); } catch { /* ignore */ }

      resolve(result);
    } catch (err) {
      clearTimeout(timeoutId);
      reject(err);
    } finally {
      clearTimeout(timeoutId);
    }
  });
}
