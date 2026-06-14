/**
 * Subagent 工具：把任务委派给专门的 agents
 *
 * 每次调用 subagent 时都会启动一个独立的 `pi` 进程，
 * 从而获得隔离的上下文窗口。
 *
 * 支持三种模式：
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * 使用 JSON 模式捕获 subagent 的结构化输出。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getMarkdownTheme,
  type ThemeColor,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/**
 * 将 token 数量格式化为易读的字符串（如 1.5k、2M）。
 *
 * @param count - token 数量
 * @returns 格式化后的字符串
 */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * 将用量统计格式化为可读的汇总字符串。
 *
 * @param usage - 用量统计对象
 * @param model - 可选的模型名称
 * @returns 格式化后的用量字符串
 */
function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} 轮`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

/**
 * 格式化工具调用为可读的简短文本。
 *
 * @param toolName - 工具名称
 * @param args - 工具参数
 * @param themeFg - 主题前景色函数
 * @returns 格式化后的工具调用文本
 */
function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
): string {
  /**
   * 将用户主目录前缀替换为 ~，缩短路径显示。
   *
   * @param p - 原始路径
   * @returns 缩短后的路径
   */
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview =
        command.length > 60 ? `${command.slice(0, 60)}...` : command;
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
        text += themeFg(
          "warning",
          `:${startLine}${endLine ? `-${endLine}` : ""}`,
        );
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
      return (
        themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
      );
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "find ") +
        themeFg("accent", pattern) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview =
        argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

/**
 * 从消息列表中提取最后一条 assistant 文本消息。
 *
 * @param messages - 消息数组
 * @returns 最后一条 assistant 文本内容；不存在则返回空字符串
 */
function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

/**
 * 判断单个 agent 执行结果是否失败。
 *
 * @param result - 单个 agent 执行结果
 * @returns 失败时返回 true，否则返回 false
 */
function isFailedResult(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted"
  );
}

/**
 * 获取单个 agent 执行结果的输出文本。
 *
 * @param result - 单个 agent 执行结果
 * @returns 输出文本；失败时优先返回错误信息
 */
function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return (
      result.errorMessage ||
      result.stderr ||
      getFinalOutput(result.messages) ||
      "（无输出）"
    );
  }
  return getFinalOutput(result.messages) || "（无输出）";
}

/**
 * 截断并行任务的输出，使其不超过单任务输出上限。
 *
 * @param output - 原始输出文本
 * @returns 截断后的输出文本
 */
function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[输出已截断：省略了 ${byteLength - Buffer.byteLength(truncated, "utf8")} 字节。完整输出保留在工具详情中。]`;
}

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

/**
 * 将消息列表转换为可展示的文本/工具调用项。
 *
 * @param messages - 消息数组
 * @returns 展示项数组
 */
function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({
            type: "toolCall",
            name: part.name,
            args: part.arguments,
          });
      }
    }
  }
  return items;
}

/**
 * 创建并发工作线程，循环领取并处理任务。
 *
 * @param nextIndex - 共享的下一个任务索引
 * @param items - 待处理数组
 * @param results - 结果数组
 * @param fn - 处理函数
 * @returns 工作线程函数
 */
function createConcurrencyWorker<TIn, TOut>(
  nextIndex: { value: number },
  items: TIn[],
  results: TOut[],
  fn: (item: TIn, index: number) => Promise<TOut>,
): () => Promise<void> {
  return async () => {
    while (true) {
      const current = nextIndex.value++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  };
}

/**
 * 对数组元素并发执行异步操作，并限制最大并发数。
 *
 * @param items - 待处理的数组
 * @param concurrency - 最大并发数
 * @param fn - 对每个元素执行的异步函数
 * @returns 处理结果数组
 */
async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  const nextIndex = { value: 0 };
  const workers = new Array(limit)
    .fill(null)
    .map(() => createConcurrencyWorker(nextIndex, items, results, fn));
  await Promise.all(workers);
  return results;
}

/**
 * 将 agent 的系统提示写入临时文件。
 *
 * @param agentName - agent 名称
 * @param prompt - 系统提示内容
 * @returns 临时目录路径和临时文件路径
 */
async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-"),
  );
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
  return { dir: tmpDir, filePath };
}

/**
 * 获取启动 pi 子进程的命令和参数。
 *
 * @param args - 传递给 pi 的参数
 * @returns 包含 command 和 args 的对象
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

/**
 * 根据 agent 配置构建启动 pi 进程所需的参数数组。
 *
 * @param agent - agent 配置
 * @returns pi 参数数组
 */
function buildPiArgs(agent: AgentConfig): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0)
    args.push("--tools", agent.tools.join(","));
  return args;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * 创建发送当前执行进度更新的回调函数。
 *
 * @param onUpdate - 可选的进度更新回调
 * @param currentResult - 当前执行结果对象
 * @param makeDetails - 构造工具详情对象的函数
 * @returns 发送更新的函数
 */
function createEmitUpdate(
  onUpdate: OnUpdateCallback | undefined,
  currentResult: SingleResult,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): () => void {
  return () => {
    if (onUpdate) {
      onUpdate({
        content: [
          {
            type: "text",
            text: getFinalOutput(currentResult.messages) || "（运行中...）",
          },
        ],
        details: makeDetails([currentResult]),
      });
    }
  };
}

/**
 * 子进程输出的一行 JSON 事件。
 */
interface SubagentEvent {
	type?: string;
	message?: unknown;
}

/**
 * 创建解析并处理子进程输出 JSON 事件的回调函数。
 *
 * @param currentResult - 当前执行结果对象
 * @param emitUpdate - 进度更新函数
 * @returns 处理单行输出的函数
 */
function createProcessLine(
  currentResult: SingleResult,
  emitUpdate: () => void,
): (line: string) => void {
  return (line: string) => {
    if (!line.trim()) return;
    let event: SubagentEvent;
    try {
      event = JSON.parse(line) as SubagentEvent;
    } catch {
      return;
    }

    if (event.type === "message_end" && event.message) {
      const msg = event.message as Message;
      currentResult.messages.push(msg);

      if (msg.role === "assistant") {
        currentResult.usage.turns++;
        const usage = msg.usage;
        if (usage) {
          currentResult.usage.input += usage.input || 0;
          currentResult.usage.output += usage.output || 0;
          currentResult.usage.cacheRead += usage.cacheRead || 0;
          currentResult.usage.cacheWrite += usage.cacheWrite || 0;
          currentResult.usage.cost += usage.cost?.total || 0;
          currentResult.usage.contextTokens = usage.totalTokens || 0;
        }
        if (!currentResult.model && msg.model) currentResult.model = msg.model;
        if (msg.stopReason) currentResult.stopReason = msg.stopReason;
        if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
      }
      emitUpdate();
    }

    if (event.type === "tool_result_end" && event.message) {
      currentResult.messages.push(event.message as Message);
      emitUpdate();
    }
  };
}

/**
 * 启动 pi 子进程并收集其输出。
 *
 * @param invocation - 命令与参数
 * @param cwd - 工作目录
 * @param signal - 可选的中止信号
 * @param onLine - 处理每行 stdout 的回调
 * @param onStderr - 处理 stderr 数据的回调
 * @returns 包含退出码和中止标志的对象
 */
async function spawnPiProcess(
  invocation: { command: string; args: string[] },
  cwd: string,
  signal: AbortSignal | undefined,
  onLine: (line: string) => void,
  onStderr: (data: string) => void,
): Promise<{ exitCode: number; wasAborted: boolean }> {
  let wasAborted = false;
  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) onLine(line);
    });

    proc.stderr.on("data", (data) => {
      onStderr(data.toString());
    });

    proc.on("close", (code) => {
      if (buffer.trim()) onLine(buffer);
      resolve(code ?? 0);
    });

    proc.on("error", () => {
      resolve(1);
    });

    if (signal) {
      const killProc = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }
  });

  return { exitCode, wasAborted };
}

/**
 * 清理临时提示文件与目录。
 *
 * @param tmpPromptPath - 临时提示文件路径
 * @param tmpPromptDir - 临时目录路径
 */
function cleanupTempPrompt(
  tmpPromptPath: string | null,
  tmpPromptDir: string | null,
): void {
  if (tmpPromptPath) {
    try {
      fs.unlinkSync(tmpPromptPath);
    } catch {
      /* 忽略 */
    }
  }
  if (tmpPromptDir) {
    try {
      fs.rmdirSync(tmpPromptDir);
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 运行单个 subagent 任务。
 *
 * @param defaultCwd - 默认工作目录
 * @param agents - 可用 agent 配置列表
 * @param agentName - 要调用的 agent 名称
 * @param task - 任务内容
 * @param cwd - 可选的 agent 进程工作目录
 * @param step - 可选的链式执行步骤编号
 * @param signal - 可选的中止信号
 * @param onUpdate - 可选的进度更新回调
 * @param makeDetails - 构造工具详情对象的函数
 * @returns 单个 agent 执行结果
 */
async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "无";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `未知 agent："${agentName}"。可用 agents：${available}。`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }

  const args = buildPiArgs(agent);

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: agent.model,
    step,
  };

  const emitUpdate = createEmitUpdate(onUpdate, currentResult, makeDetails);
  const processLine = createProcessLine(currentResult, emitUpdate);

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`任务：${task}`);

    const invocation = getPiInvocation(args);
    const { exitCode, wasAborted } = await spawnPiProcess(
      invocation,
      cwd ?? defaultCwd,
      signal,
      processLine,
      (data) => {
        currentResult.stderr += data;
      },
    );

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent 已中止");
    return currentResult;
  } finally {
    cleanupTempPrompt(tmpPromptPath, tmpPromptDir);
  }
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "要调用的 agent 名称" }),
  task: Type.String({ description: "委派给 agent 的任务" }),
  cwd: Type.Optional(Type.String({ description: "agent 进程的工作目录" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "要调用的 agent 名称" }),
  task: Type.String({
    description: "任务，可用可选的 {previous} 占位符引用上一步输出",
  }),
  cwd: Type.Optional(Type.String({ description: "agent 进程的工作目录" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    '使用哪些 agent 目录。默认是 "user"。使用 "both" 可包含项目本地 agents。',
  default: "user",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "要调用的 agent 名称（单任务模式）" }),
  ),
  task: Type.Optional(
    Type.String({ description: "要委派的任务（单任务模式）" }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: "用于并行执行的 {agent, task} 数组" }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, { description: "用于串行执行的 {agent, task} 数组" }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: "运行项目本地 agents 前先确认。默认：true。",
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "agent 进程的工作目录（单任务模式）" }),
  ),
});

/**
 * 创建根据当前模式构造 SubagentDetails 对象的工厂函数。
 *
 * @param agentScope - agent 搜索范围
 * @param projectAgentsDir - 项目本地 agents 目录
 * @returns details 构造工厂
 */
function createDetailsMaker(
  agentScope: AgentScope,
  projectAgentsDir: string | null,
): (
  mode: "single" | "parallel" | "chain",
) => (results: SingleResult[]) => SubagentDetails {
  return (mode) => (results) => ({
    mode,
    agentScope,
    projectAgentsDir,
    results,
  });
}

/**
 * 创建串行链的进度更新回调。
 *
 * @param results - 已完成的步骤结果
 * @param onUpdate - 外部更新回调
 * @param makeDetails - 构造工具详情对象的函数
 * @returns 链式更新回调或 undefined
 */
function createChainUpdate(
  results: SingleResult[],
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): OnUpdateCallback | undefined {
  if (!onUpdate) return undefined;
  return (partial) => {
    const currentResult = partial.details?.results[0];
    if (currentResult) {
      const allResults = [...results, currentResult];
      onUpdate({
        content: partial.content,
        details: makeDetails(allResults),
      });
    }
  };
}

/**
 * 创建并行任务的整体进度更新函数。
 *
 * @param onUpdate - 外部更新回调
 * @param allResults - 所有并行任务结果数组
 * @param makeDetails - 构造工具详情对象的函数
 * @returns 发送整体进度更新的函数
 */
function createEmitParallelUpdate(
  onUpdate: OnUpdateCallback | undefined,
  allResults: SingleResult[],
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): () => void {
  return () => {
    if (!onUpdate) return;
    const running = allResults.filter((r) => r.exitCode === -1).length;
    const done = allResults.filter((r) => r.exitCode !== -1).length;
    onUpdate({
      content: [
        {
          type: "text",
          text: `并行执行：${done}/${allResults.length} 已完成，${running} 个仍在运行...`,
        },
      ],
      details: makeDetails([...allResults]),
    });
  };
}

/**
 * 运行单个并行任务并同步更新总体进度。
 *
 * @param cwd - 工作目录
 * @param agents - 可用 agent 配置列表
 * @param task - 任务项
 * @param index - 在并行结果数组中的索引
 * @param allResults - 所有并行任务结果数组
 * @param signal - 中止信号
 * @param emitParallelUpdate - 并行整体进度更新函数
 * @param makeDetails - 构造工具详情对象的函数
 * @returns 单个 agent 执行结果
 */
async function runParallelTask(
  cwd: string,
  agents: AgentConfig[],
  task: { agent: string; task: string; cwd?: string },
  index: number,
  allResults: SingleResult[],
  signal: AbortSignal | undefined,
  emitParallelUpdate: () => void,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const result = await runSingleAgent(
    cwd,
    agents,
    task.agent,
    task.task,
    task.cwd,
    undefined,
    signal,
    (partial) => {
      if (partial.details?.results[0]) {
        allResults[index] = partial.details.results[0];
        emitParallelUpdate();
      }
    },
    makeDetails,
  );
  allResults[index] = result;
  emitParallelUpdate();
  return result;
}

/**
 * 将并行执行结果格式化为汇总文本。
 *
 * @param results - 并行执行结果数组
 * @returns 汇总文本
 */
function formatParallelSummary(results: SingleResult[]): string {
  const successCount = results.filter((r) => !isFailedResult(r)).length;
  const summaries = results.map((r) => {
    const output = truncateParallelOutput(getResultOutput(r));
    const status = isFailedResult(r)
      ? `失败${r.stopReason && r.stopReason !== "end" ? `（${r.stopReason}）` : ""}`
      : "已完成";
    return `### [${r.agent}] ${status}\n\n${output}`;
  });
  return `并行执行：${successCount}/${results.length} 成功\n\n${summaries.join("\n\n---\n\n")}`;
}

/**
 * 注册 subagent 工具到扩展 API。
 *
 * @param pi - 扩展 API 实例
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "将任务委派给具备隔离上下文的专门 subagents。",
      "模式：single（agent + task）、parallel（tasks 数组）、chain（使用 {previous} 占位符串行执行）。",
      '默认 agent scope 是 "user"（来自 ~/.pi/agent/agents）。',
      '如需启用 .pi/agents 中的项目本地 agents，请将 agentScope 设为 "both"（或 "project"）。',
    ].join(" "),
    parameters: SubagentParams,

    /**
     * 执行 subagent 工具调用。
     *
     * @param _toolCallId - 工具调用 ID
     * @param params - 工具参数
     * @param signal - 中止信号
     * @param onUpdate - 进度更新回调
     * @param ctx - 扩展上下文
     * @returns 工具执行结果
     */
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? true;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails = createDetailsMaker(
        agentScope,
        discovery.projectAgentsDir,
      );

      if (modeCount !== 1) {
        const available =
          agents.map((a) => `${a.name} (${a.source})`).join(", ") || "无";
        return {
          content: [
            {
              type: "text",
              text: `参数无效。必须且只能提供一种模式。\n可用 agents：${available}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      if (
        (agentScope === "project" || agentScope === "both") &&
        confirmProjectAgents &&
        ctx.hasUI
      ) {
        const requestedAgentNames = new Set<string>();
        if (params.chain)
          for (const step of params.chain) requestedAgentNames.add(step.agent);
        if (params.tasks)
          for (const t of params.tasks) requestedAgentNames.add(t.agent);
        if (params.agent) requestedAgentNames.add(params.agent);

        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is AgentConfig => a?.source === "project");

        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((a) => a.name).join(", ");
          const dir = discovery.projectAgentsDir ?? "（未知）";
          const ok = await ctx.ui.confirm(
            "运行项目本地 agents？",
            `Agents：${names}\n来源：${dir}\n\n项目 agents 受仓库控制。仅在仓库可信时继续。`,
          );
          if (!ok)
            return {
              content: [
                { type: "text", text: "已取消：项目本地 agents 未获批准。" },
              ],
              details: makeDetails(
                hasChain ? "chain" : hasTasks ? "parallel" : "single",
              )([]),
            };
        }
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(
            /\{previous\}/g,
            previousOutput,
          );

          const chainUpdate = createChainUpdate(
            results,
            onUpdate,
            makeDetails("chain"),
          );

          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
          );
          results.push(result);

          const isError = isFailedResult(result);
          if (isError) {
            const errorMsg = getResultOutput(result);
            return {
              content: [
                {
                  type: "text",
                  text: `串行链在第 ${i + 1} 步（${step.agent}）停止：${errorMsg}`,
                },
              ],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [
            {
              type: "text",
              text:
                getFinalOutput(results[results.length - 1].messages) ||
                "（无输出）",
            },
          ],
          details: makeDetails("chain")(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
          return {
            content: [
              {
                type: "text",
                text: `并行任务过多（${params.tasks.length} 个）。最大值是 ${MAX_PARALLEL_TASKS}。`,
              },
            ],
            details: makeDetails("parallel")([]),
          };

        const allResults: SingleResult[] = new Array(params.tasks.length);

        for (let i = 0; i < params.tasks.length; i++) {
          allResults[i] = {
            agent: params.tasks[i].agent,
            agentSource: "unknown",
            task: params.tasks[i].task,
            exitCode: -1, // -1 = 仍在运行中
            messages: [],
            stderr: "",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          };
        }

        const emitParallelUpdate = createEmitParallelUpdate(
          onUpdate,
          allResults,
          makeDetails("parallel"),
        );

        const results = await mapWithConcurrencyLimit(
          params.tasks,
          MAX_CONCURRENCY,
          (t, index) =>
            runParallelTask(
              ctx.cwd,
              agents,
              t,
              index,
              allResults,
              signal,
              emitParallelUpdate,
              makeDetails("parallel"),
            ),
        );

        return {
          content: [{ type: "text", text: formatParallelSummary(results) }],
          details: makeDetails("parallel")(results),
        };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
        );
        const isError = isFailedResult(result);
        if (isError) {
          const errorMsg = getResultOutput(result);
          return {
            content: [
              {
                type: "text",
                text: `Agent ${result.stopReason || "失败"}：${errorMsg}`,
              },
            ],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: getFinalOutput(result.messages) || "（无输出）",
            },
          ],
          details: makeDetails("single")([result]),
        };
      }

      const available =
        agents.map((a) => `${a.name} (${a.source})`).join(", ") || "无";
      return {
        content: [
          { type: "text", text: `参数无效。可用 agents：${available}` },
        ],
        details: makeDetails("single")([]),
      };
    },

    /**
     * 渲染 subagent 工具调用的简要展示。
     *
     * @param args - 工具参数
     * @param theme - 主题对象
     * @param _context - 渲染上下文
     * @returns 渲染后的文本组件
     */
    renderCall(args, theme, _context) {
      const scope: AgentScope = args.agentScope ?? "user";
      if (args.chain && args.chain.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`) +
          theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          // 为展示清理掉 {previous} 占位符
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview =
            cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text +=
            "\n  " +
            theme.fg("muted", `${i + 1}.`) +
            " " +
            theme.fg("accent", step.agent) +
            theme.fg("dim", ` ${preview}`);
        }
        if (args.chain.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
          theme.fg("muted", ` [${scope}]`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview =
            t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const agentName = args.agent || "...";
      const preview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", agentName) +
        theme.fg("muted", ` [${scope}]`);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    /**
     * 渲染 subagent 工具执行结果。
     *
     * @param result - 工具结果
     * @param options - 渲染选项，包含 expanded 标志
     * @param theme - 主题对象
     * @param _context - 渲染上下文
     * @returns 渲染后的 UI 组件
     */
    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "（无输出）", 0, 0);
      }

      const mdTheme = getMarkdownTheme();

      /**
       * 将展示项渲染为文本。
       *
       * @param items - 展示项数组
       * @param limit - 可选的显示数量限制
       * @returns 渲染后的文本
       */
      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped =
          limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0)
          text += theme.fg("muted", `... 还有更早的 ${skipped} 项\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded
              ? item.text
              : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const isError = isFailedResult(r);
        const icon = isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);

        if (expanded) {
          const container = new Container();
          let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
          if (isError && r.stopReason)
            header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && r.errorMessage)
            container.addChild(
              new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
            );
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── 任务 ───"), 0, 0));
          container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── 输出 ───"), 0, 0));
          if (displayItems.length === 0 && !finalOutput) {
            container.addChild(new Text(theme.fg("muted", "（无输出）"), 0, 0));
          } else {
            // 显示工具调用
            for (const item of displayItems) {
              if (item.type === "toolCall")
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(
                        item.name,
                        item.args,
                        theme.fg.bind(theme),
                      ),
                    0,
                    0,
                  ),
                );
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(
                new Markdown(finalOutput.trim(), 0, 0, mdTheme),
              );
            }
          }
          const usageStr = formatUsageStats(r.usage, r.model);
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
          }
          return container;
        }

        let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (isError && r.stopReason)
          text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        if (isError && r.errorMessage)
          text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
        else if (displayItems.length === 0)
          text += `\n${theme.fg("muted", "（无输出）")}`;
        else {
          text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT)
            text += `\n${theme.fg("muted", "（按 Ctrl+O 展开）")}`;
        }
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        return new Text(text, 0, 0);
      }

      /**
       * 汇总多个 agent 执行结果的用量统计。
       *
       * @param results - agent 执行结果数组
       * @returns 汇总后的用量统计
       */
      const aggregateUsage = (results: SingleResult[]) => {
        const total = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
        };
        for (const r of results) {
          total.input += r.usage.input;
          total.output += r.usage.output;
          total.cacheRead += r.usage.cacheRead;
          total.cacheWrite += r.usage.cacheWrite;
          total.cost += r.usage.cost;
          total.turns += r.usage.turns;
        }
        return total;
      };

      if (details.mode === "chain") {
        const successCount = details.results.filter(
          (r) => r.exitCode === 0,
        ).length;
        const icon =
          successCount === details.results.length
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");

        if (expanded) {
          const container = new Container();
          container.addChild(
            new Text(
              icon +
                " " +
                theme.fg("toolTitle", theme.bold("chain ")) +
                theme.fg(
                  "accent",
                  `${successCount}/${details.results.length} steps`,
                ),
              0,
              0,
            ),
          );

          for (const r of details.results) {
            const rIcon =
              r.exitCode === 0
                ? theme.fg("success", "✓")
                : theme.fg("error", "✗");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(
                `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
                0,
                0,
              ),
            );
            container.addChild(
              new Text(
                theme.fg("muted", "任务：") + theme.fg("dim", r.task),
                0,
                0,
              ),
            );

            // 显示工具调用
            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(
                        item.name,
                        item.args,
                        theme.fg.bind(theme),
                      ),
                    0,
                    0,
                  ),
                );
              }
            }

            // 以 Markdown 显示最终输出
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(
                new Markdown(finalOutput.trim(), 0, 0, mdTheme),
              );
            }

            const stepUsage = formatUsageStats(r.usage, r.model);
            if (stepUsage)
              container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
          }

          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(
              new Text(theme.fg("dim", `总计：${usageStr}`), 0, 0),
            );
          }
          return container;
        }

        // 折叠视图
        let text =
          icon +
          " " +
          theme.fg("toolTitle", theme.bold("chain ")) +
          theme.fg("accent", `${successCount}/${details.results.length} steps`);
        for (const r of details.results) {
          const rIcon =
            r.exitCode === 0
              ? theme.fg("success", "✓")
              : theme.fg("error", "✗");
          const displayItems = getDisplayItems(r.messages);
          text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
          if (displayItems.length === 0)
            text += `\n${theme.fg("muted", "（无输出）")}`;
          else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) text += `\n\n${theme.fg("dim", `总计：${usageStr}`)}`;
        text += `\n${theme.fg("muted", "（按 Ctrl+O 展开）")}`;
        return new Text(text, 0, 0);
      }

      if (details.mode === "parallel") {
        const running = details.results.filter((r) => r.exitCode === -1).length;
        const successCount = details.results.filter(
          (r) => r.exitCode !== -1 && !isFailedResult(r),
        ).length;
        const failCount = details.results.filter(
          (r) => r.exitCode !== -1 && isFailedResult(r),
        ).length;
        const isRunning = running > 0;
        const icon = isRunning
          ? theme.fg("warning", "⏳")
          : failCount > 0
            ? theme.fg("warning", "◐")
            : theme.fg("success", "✓");
        const status = isRunning
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} 个任务`;

        if (expanded && !isRunning) {
          const container = new Container();
          container.addChild(
            new Text(
              `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
              0,
              0,
            ),
          );

          for (const r of details.results) {
            const rIcon = isFailedResult(r)
              ? theme.fg("error", "✗")
              : theme.fg("success", "✓");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(
                `${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`,
                0,
                0,
              ),
            );
            container.addChild(
              new Text(
                theme.fg("muted", "任务：") + theme.fg("dim", r.task),
                0,
                0,
              ),
            );

            // 显示工具调用
            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(
                        item.name,
                        item.args,
                        theme.fg.bind(theme),
                      ),
                    0,
                    0,
                  ),
                );
              }
            }

            // 以 Markdown 显示最终输出
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(
                new Markdown(finalOutput.trim(), 0, 0, mdTheme),
              );
            }

            const taskUsage = formatUsageStats(r.usage, r.model);
            if (taskUsage)
              container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
          }

          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(
              new Text(theme.fg("dim", `总计：${usageStr}`), 0, 0),
            );
          }
          return container;
        }

        // 折叠视图（或仍在运行）
        let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
        for (const r of details.results) {
          const rIcon =
            r.exitCode === -1
              ? theme.fg("warning", "⏳")
              : isFailedResult(r)
                ? theme.fg("error", "✗")
                : theme.fg("success", "✓");
          const displayItems = getDisplayItems(r.messages);
          text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
          if (displayItems.length === 0)
            text += `\n${theme.fg("muted", r.exitCode === -1 ? "（运行中...）" : "（无输出）")}`;
          else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        if (!isRunning) {
          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) text += `\n\n${theme.fg("dim", `总计：${usageStr}`)}`;
        }
        if (!expanded) text += `\n${theme.fg("muted", "（按 Ctrl+O 展开）")}`;
        return new Text(text, 0, 0);
      }

      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "（无输出）", 0, 0);
    },
  });
}
