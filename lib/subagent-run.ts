// subagent-run.ts — 隔离 pi 进程执行核心
//
// 供 subagent 工具内部调用。worker 显式加载 custom-providers（providers.toml 动态模型），
// 其余扩展发现关闭以保持隔离。支持 --tools 白名单（反馈模式）与额外显式扩展。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { getFinalOutput } from "./message-utils.ts";
import { formatTokens } from "./format-utils.ts";
import { TimelineBuilder, resolveTerminalState } from "./timeline.ts";
import type { TimelineEvent } from "./timeline.ts";
import { SUBAGENT_MAX_ATTEMPTS, backoffDelayMs, isRetryableFailure } from "./subagent-retry.ts";
import { buildInlineSummary, writeInvestigationFile, type AttemptSnapshot } from "./subagent-investigation.ts";
import { isValidInboxId } from "./subagent-supplement.ts";
// timeline 公共面（类型/常量/归一化器）从本模块再导出，供调用方与测试统一引用
export {
  TimelineBuilder,
  resolveTerminalState,
  TIMELINE_MAX_ENTRIES,
  TIMELINE_MAX_TEXT,
  TIMELINE_MAX_FIELD,
} from "./timeline.ts";
export type {
  TimelineEvent,
  TimelineEventType,
  TimelineBuilderOptions,
} from "./timeline.ts";

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
  /** 有界 per-worker 执行轨迹（实时变化；终态保留最终 timeline） */
  timeline: TimelineEvent[];
  /** 重试彻底失败后写出的调查文件绝对路径（成功/未重试时为 undefined） */
  investigationPath?: string;
  /** 实际尝试次数（含首次） */
  attempts?: number;
  /** 最终失败的内联摘要（成功时为 undefined） */
  inlineSummary?: string;
}

/**
 * runSubagent 中止/超时路径抛出的结构化终态错误。
 *
 * 携带可识别终态 status（timeout | aborted）与最终 timeline，供 batch 等调用方
 * 按类型而非错误消息文本（如 /超时/ 正则）分类，保证 timeout 与外部 abort 在
 * WorkerStatus / BatchItemResult.status / lifecycle 三处状态一致。
 */
export class SubagentError extends Error {
  /** 终态：timeout（内部超时控制器触发）或 aborted（外部 signal 中止） */
  readonly status: "timeout" | "aborted";
  /** 最终 timeline：超时/中止时也把最终轨迹带给调用方（catch 保留） */
  readonly timeline?: TimelineEvent[];
  /** 重试彻底失败后写出的调查文件绝对路径（可选） */
  readonly investigationPath?: string;

  constructor(status: "timeout" | "aborted", message: string, timeline?: TimelineEvent[], investigationPath?: string) {
    super(message);
    this.name = "SubagentError";
    this.status = status;
    this.timeline = timeline;
    this.investigationPath = investigationPath;
  }
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

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const CUSTOM_PROVIDERS_EXT = path.join(AGENT_DIR, "extensions", "custom-providers", "index.ts");
const MCP_ADAPTER_EXT = path.join(AGENT_DIR, "npm", "node_modules", "pi-mcp-adapter", "index.ts");
const SUPPLEMENT_BRIDGE_EXT = path.join(AGENT_DIR, "extensions", "subagent-supplement-bridge", "index.ts");
const SANDBOX_GUARD_EXT = path.join(AGENT_DIR, "extensions", "sandbox-guard", "index.ts");

/**
 * 构造 worker 子进程 env（纯函数，不改 process.env）：
 * 仅当 inboxId 合法时才注入 PI_SUBAGENT_INBOX；taskId 存在时注入 PI_TASK_ID。
 * PI_SUBAGENT 恒为 "1"（子进程内禁用递归派发）。
 */
export function buildSubagentEnv(
  base: NodeJS.ProcessEnv,
  opts: {
    inboxId?: string;
    taskId?: string;
    /** 沙箱可写根（限制 worker 只能写指定目录，工程其余只读；透传 PI_SANDBOX_RW） */
    sandboxDir?: string;
    /** 沙箱只读模式（不写 workspace；透传 PI_SANDBOX_READONLY） */
    readonly?: boolean;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PI_SUBAGENT: "1" };
  if (opts.taskId) env.PI_TASK_ID = opts.taskId;
  if (opts.inboxId && isValidInboxId(opts.inboxId)) {
    env.PI_SUBAGENT_INBOX = opts.inboxId;
  }
  // 沙箱细粒度限制（wrapper sandbox-shell.mjs 消费；仅 Linux/darwin 沙箱平台生效）
  if (opts.sandboxDir) env.PI_SANDBOX_RW = opts.sandboxDir;
  if (opts.readonly) env.PI_SANDBOX_READONLY = "1";
  return env;
}

/**
 * 合并 worker 额外显式扩展（纯函数）：保留既有 extras（反馈模式等），
 * 仅当 inboxId 合法时追加 supplement bridge 扩展绝对路径（AGENT_DIR 派生，
 * 非硬编码 cwd），且去重——绝不在同一 worker 上重复加载 bridge。
 */
export function buildWorkerExtraExtensions(
  extras: string[] | undefined,
  inboxId: string | undefined,
): string[] {
  const list = [...(extras ?? [])];
  if (inboxId && isValidInboxId(inboxId)) {
    if (!list.includes(SUPPLEMENT_BRIDGE_EXT)) list.push(SUPPLEMENT_BRIDGE_EXT);
  }
  return list;
}

/** 构造 worker 子进程参数：隔离 + custom-providers 显式加载 + 可选工具白名单 */
export function buildSubagentArgs(opts: {
  task: string;
  cwd: string;
  model: string;
  promptPath?: string;
  tools?: string[];
  extraExtensions?: string[];
}): string[] {
  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--model", opts.model,
    "--extension", CUSTOM_PROVIDERS_EXT,
    "--extension", MCP_ADAPTER_EXT,
    "--extension", SANDBOX_GUARD_EXT,
  ];
  for (const ext of opts.extraExtensions ?? []) args.push("--extension", ext);
  if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
  if (opts.promptPath) args.push("--append-system-prompt", opts.promptPath);
  args.push(`任务：${opts.task}`);
  return args;
}

/** 从 agent_end 事件的 messages 数组提取最终文本（兜底；失败返回空串） */
export function extractAgentEndOutput(line: string): string {
  try {
    const event = JSON.parse(line) as { type?: string; messages?: Array<{ role: string; content: unknown }> };
    if (event.type !== "agent_end" || !Array.isArray(event.messages)) return "";
    return getFinalOutput(event.messages as Array<{ role: string; content: string | ContentPartLike[] }>) || "";
  } catch {
    return "";
  }
}

interface ContentPartLike {
  type: string;
  text?: string;
}

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

/** 单次执行函数（默认 defaultRunOnce；重试循环测试注入用） */
export type RunOnceFn = (opts: RunSubagentOptions) => Promise<SubagentResult>;

export interface RunSubagentOptions {
  task: string;
  cwd: string;
  model?: string;
  timeout?: number;
  signal?: AbortSignal;
  taskId?: string; // 用于 permission-gate 关联
  tools?: string[]; // 工具白名单（反馈模式：read/bash/be-*）
  extraExtensions?: string[]; // 额外显式加载的扩展绝对路径
  /** 本 worker 的补充指令 inbox id（batch 分配；重试循环内复用同一个） */
  inboxId?: string;
  /** 沙箱可写根（限制本 worker 只写该目录，其余只读） */
  sandboxDir?: string;
  /** 沙箱只读模式 */
  readonly?: boolean;
  onUpdate?: (result: SubagentResult) => void;
  onSpawn?: (pid: number) => void; // 子进程 PID，用于外部 kill
  /** 测试注入：替换单次执行实现（仅重试循环内部使用） */
  runOnce?: RunOnceFn;
  /** 测试注入：替换退避等待实现 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 重试循环注入：上一轮累积的最终轨迹，作为本轮 timeline 的种子（续接而非重置） */
  seedTimeline?: TimelineEvent[];
  /** 重试循环注入：本次 attempt 编号（1-based），用于 timeline 合成 id 命名空间去撞号 */
  attempt?: number;
}

/**
 * 默认单次执行：spawn 隔离 pi 进程并收集结果（原 runSubagent 本体）。
 * 重试循环的每次 attempt 调用它；每次调用自带全新 timeline 与超时控制器。
 */
export function defaultRunOnce(opts: RunSubagentOptions): Promise<SubagentResult> {
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
      // 写入系统提示词（buildSubagentArgs 会追加 --append-system-prompt 与任务注入）
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
      const promptPath = path.join(tmpDir, "prompt.md");
      await fs.promises.writeFile(promptPath, SUBAGENT_PROMPT, { encoding: "utf-8", mode: 0o600 });
      const args = buildSubagentArgs({
        task,
        cwd,
        model,
        promptPath,
        tools: opts.tools,
        // 既有反馈扩展 + 有效 inbox 才追加的 supplement bridge（去重合并）
        extraExtensions: buildWorkerExtraExtensions(opts.extraExtensions, opts.inboxId),
      });

      const invocation = getPiInvocation(args);

      // worker 启动 lifecycle；timeline 数组引用直接挂到 result，实时快照随事件推进。
      // 重试时以上轮累积轨迹为 seed，并用 attempt 命名空间隔离合成 id，避免 GUI 轨迹塌缩/撞号。
      const attempt = opts.attempt ?? 1;
      const timeline = new TimelineBuilder({ seedEvents: opts.seedTimeline, attempt });
      timeline.addLifecycle(
        "starting",
        attempt > 1 ? `worker 重试（第 ${attempt} 次尝试）` : "worker 启动",
      );

      const result: SubagentResult = {
        task,
        exitCode: 0,
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        model,
        timeline: timeline.events,
      };

      const emitUpdate = () => {
        opts.onUpdate?.(result);
      };

      let wasAborted = false;
      let agentEndOutput = "";

      const exitCode = await new Promise<number>((resolveExit) => {
        // 子进程 env 独立构造：不污染 process.env；有效 inbox 才注入 PI_SUBAGENT_INBOX
        const env = buildSubagentEnv(process.env, {
          inboxId: opts.inboxId,
          taskId: opts.taskId,
          sandboxDir: opts.sandboxDir,
          readonly: opts.readonly,
        });

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
            if (timeline.handleLine(line)) emitUpdate();
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
              timeline.handleLine(line);
              let event: { type?: string; message?: unknown };
              try { event = JSON.parse(line); } catch { continue; }
              if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
                result.messages.push(event.message as Message);
              } else if (event.type === "agent_end") {
                const text = extractAgentEndOutput(line);
                if (text) agentEndOutput = text;
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
      // 终态 lifecycle：success/failed/aborted/timeout（timeout 依据内部超时控制器判断）
      const terminal = resolveTerminalState({
        aborted: wasAborted,
        timedOut: timeoutController.signal.aborted,
        exitCode: result.exitCode,
        stopReason: result.stopReason,
      });
      timeline.addLifecycle(terminal);
      // 终态同步一次：尾缓冲里的 telemetry 已并入 timeline，随终态 lifecycle 一起
      // 通过 onUpdate 送达调用方（与下方 resolve/throw 路径的 result.timeline 一致）
      emitUpdate();
      // agent_end 兜底：若 messages 里没有最终输出（如非标准退出路径），用 agent_end 的完整 messages
      if (agentEndOutput && !getFinalOutput(result.messages)) {
        result.messages.push({ role: "assistant", content: agentEndOutput } as unknown as Message);
      }

      try { fs.unlinkSync(promptPath); fs.rmdirSync(tmpDir); } catch { /* ignore */ }

      if (wasAborted) {
        // 结构化终态错误：batch 依赖 status（timeout/aborted）而非消息文本识别；
        // 最终 timeline 随错误带给调用方（catch 保留，undefined 不覆盖实时轨迹）
        const status: "timeout" | "aborted" = terminal === "timeout" ? "timeout" : "aborted";
        throw new SubagentError(
          status,
          status === "timeout" ? `Subagent 超时（${opts.timeout ?? 600}s）` : "Subagent 已中止",
          result.timeline,
        );
      }

      resolve(result);
    } catch (err) {
      clearTimeout(timeoutId);
      reject(err);
    } finally {
      clearTimeout(timeoutId);
    }
  });
}

/** 可中止退避等待：signal 中止时以 SubagentError("aborted") 拒绝（默认 sleep 实现） */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new SubagentError("aborted", "Subagent 已中止"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new SubagentError("aborted", "Subagent 已中止"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 从失败结果构造 attempt 快照（timeline 复制，避免与实时轨迹共享引用） */
function snapshotFromResult(
  attempt: number,
  result: SubagentResult,
  status: AttemptSnapshot["status"],
  startedAt: string,
): AttemptSnapshot {
  return {
    attempt,
    status,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    stderr: result.stderr,
    timeline: [...result.timeline],
    usage: result.usage,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/** 从抛出的错误（SubagentError 超时/中止、未知异常）构造 attempt 快照 */
function snapshotFromError(
  attempt: number,
  err: unknown,
  status: AttemptSnapshot["status"],
  timeline: TimelineEvent[] | undefined,
  startedAt: string,
): AttemptSnapshot {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    attempt,
    status,
    errorMessage: msg,
    stderr: "",
    timeline: timeline ? [...timeline] : [],
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/** 依据最终错误/结果推导调查 finalStatus */
function deriveFinalStatus(
  lastError: unknown,
  lastResult: SubagentResult | undefined,
  attempts: AttemptSnapshot[],
): "failed" | "aborted" | "timeout" {
  if (lastError instanceof SubagentError) return lastError.status;
  if (attempts.length > 0) {
    const last = attempts[attempts.length - 1];
    if (last.status === "aborted" || last.status === "timeout") return last.status;
  }
  if (lastResult?.stopReason === "aborted") return "aborted";
  return "failed";
}

/**
 * 公共入口：单次执行 + 最多 SUBAGENT_MAX_ATTEMPTS 次基础设施重试。
 *
 * - 成功：直接返回（带 attempts 计数），不写调查文件。
 * - 最终失败（exit/error）：返回 failed SubagentResult，附 investigationPath / attempts / inlineSummary。
 * - 超时/中止：写调查文件后抛 SubagentError（携带 investigationPath）。
 *
 * 每次 attempt 调用 defaultRunOnce（或注入的 runOnce），各自带全新 timeline 与超时控制器。
 */
export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
  const max = SUBAGENT_MAX_ATTEMPTS;
  const runOnce = opts.runOnce ?? defaultRunOnce;
  const sleep = opts.sleep ?? abortableSleep;
  const attempts: AttemptSnapshot[] = [];
  const batchStarted = new Date().toISOString();
  let lastResult: SubagentResult | undefined;
  let lastError: unknown;
  // 跨 attempt 累积的轨迹：上轮结果作为下轮种子，让 GUI 实时轨迹重试时续接而非塌缩回 1 条。
  let accumulated: TimelineEvent[] | undefined;

  for (let i = 1; i <= max; i++) {
    if (opts.signal?.aborted) {
      lastError = new SubagentError("aborted", "Subagent 已中止");
      break;
    }
    const startedAt = new Date().toISOString();
    try {
      const result = await runOnce({ ...opts, runOnce: undefined, sleep: undefined, seedTimeline: accumulated, attempt: i });
      lastResult = result;
      accumulated = result.timeline; // 本轮结束后的完整累积，供下轮重试续接
      if (!isFailedResult(result) && result.stopReason !== "error") {
        // 干净成功：返回（带 attempts 供观测），不写调查文件
        result.attempts = i;
        return result;
      }
      // 失败结果（可重试或不可重试）
      const status: AttemptSnapshot["status"] = result.stopReason === "aborted" ? "aborted" : "failed";
      attempts.push(snapshotFromResult(i, result, status, startedAt));
      lastError = null;
      if (!isRetryableFailure(result) || i === max) break;
      await sleep(backoffDelayMs(i), opts.signal);
    } catch (err) {
      lastError = err;
      const status: AttemptSnapshot["status"] = err instanceof SubagentError ? err.status : "aborted";
      const timeline = err instanceof SubagentError ? err.timeline : undefined;
      if (timeline) accumulated = timeline; // 超时/中止也携最终轨迹，重试前续接
      attempts.push(snapshotFromError(i, err, status, timeline, startedAt));
      if (!isRetryableFailure(err) || i === max) break;
      try {
        await sleep(backoffDelayMs(i), opts.signal);
      } catch (sleepErr) {
        // 退避期间被外部中止
        lastError = sleepErr;
        break;
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const finalStatus = deriveFinalStatus(lastError, lastResult, attempts);
  const invInput = {
    task: opts.task,
    taskId: opts.taskId,
    model: opts.model,
    cwd: opts.cwd,
    attempts,
    finalStatus,
    maxAttempts: max,
    startedAt: batchStarted,
    finishedAt,
  };

  let investigationPath: string | undefined;
  try {
    investigationPath = writeInvestigationFile(invInput);
  } catch {
    investigationPath = undefined; // 写文件失败不掩盖原始失败
  }
  const inlineSummary = buildInlineSummary(invInput, investigationPath);

  if (lastError instanceof SubagentError) {
    throw new SubagentError(lastError.status, lastError.message, lastError.timeline, investigationPath);
  }
  if (lastError) {
    throw new SubagentError("aborted", String(lastError), undefined, investigationPath);
  }
  // 最终失败（exit/error）路径：返回 failed 结果并附调查信息
  const failed: SubagentResult = lastResult ?? {
    task: opts.task,
    exitCode: 1,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
  };
  failed.investigationPath = investigationPath;
  failed.attempts = attempts.length || 1;
  failed.inlineSummary = inlineSummary;
  return failed;
}
