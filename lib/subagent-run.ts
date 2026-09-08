// subagent-run.ts — 隔离 pi 进程执行核心
//
// 供 subagent 工具内部调用。worker 显式加载 custom-providers（providers.toml 动态模型），
// 其余扩展发现关闭以保持隔离。支持安全工具白名单、无 UI capability 请求与额外显式扩展。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getFinalOutput } from "./message-utils.ts";
import { formatTokens } from "./format-utils.ts";
import { TimelineBuilder, resolveTerminalState } from "./timeline.ts";
import type { TimelineEvent } from "./timeline.ts";
import { SUBAGENT_MAX_ATTEMPTS, backoffDelayMs, isRetryableFailure } from "./subagent-retry.ts";
import { buildInlineSummary, writeInvestigationFile, type AttemptSnapshot } from "./subagent-investigation.ts";
import { isValidInboxId } from "./subagent-supplement.ts";
import { commandDigest, buildCapabilityDecision, validateCapabilityRequest, type CapabilityApproval, type CapabilityGrant, type CapabilityRequest, type CapabilityReview } from "./subagent-capability.ts";
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

export interface VisibleWorkerMessage {
  /** 显式任务文本或 assistant 可见文本；不含 thinking/CoT 与 tool result 原始 payload。 */
  role: "user" | "assistant";
  content: string;
  ts: string;
}

export interface VisibleArchiveEvent {
  id: string;
  type: "assistant" | "tool" | "lifecycle";
  ts: string;
  tool?: string;
  args?: string;
  preview?: string;
  result?: string;
  ok?: boolean;
  text?: string;
  state?: string;
  message?: string;
}

export interface SubagentResult {
  task: string;
  exitCode: number;
  messages: Message[];
  /** 本次运行可安全展示的来回文本；供本地诊断档案永久保存。 */
  visibleConversation: VisibleWorkerMessage[];
  /** 不受实时 timeline 条数上限影响的可见工具/assistant 事件档案。 */
  archiveTimeline: VisibleArchiveEvent[];
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
  /** worker bash guard 产生的结构化权限请求；存在时不会自动重试 */
  capabilityRequest?: CapabilityRequest;
  /** 主进程明确拒绝了 capability request */
  capabilityDenied?: boolean;
  /** 本次 capability 请求的审核模型意见（供主 agent 回报；无审核/未请求时 undefined） */
  capabilityReview?: CapabilityReview;
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

安全边界：worker 的 bash 运行在低权限沙箱中。敏感路径与明确危险操作会直接拒绝；需要网络或其他额外能力时，当前 worker 会停止并把结构化权限请求交给主 agent。不要把“需要权限”写成普通完成结论，也不要尝试读取凭据、绕过沙箱或伪造权限请求。

完成后的输出格式：

## 已完成

做了什么。

## 已修改文件

- \`path/to/file.ts\` - 改了什么

## 备注（如果有）

主 agent 需要知道的事项。`;

// 与 pi 自身的 agent dir 保持一致（PI_CODING_AGENT_DIR 可覆盖）；worker 子进程据此加载扩展
const AGENT_DIR = getAgentDir();
const CUSTOM_PROVIDERS_EXT = path.join(AGENT_DIR, "extensions", "custom-providers", "index.ts");
const MCP_ADAPTER_EXT = path.join(AGENT_DIR, "npm", "node_modules", "pi-mcp-adapter", "index.ts");
const SUPPLEMENT_BRIDGE_EXT = path.join(AGENT_DIR, "extensions", "subagent-supplement-bridge", "index.ts");
const SANDBOX_GUARD_EXT = path.join(AGENT_DIR, "extensions", "sandbox-permissions", "guard.ts");
const SUBAGENT_BASH_GUARD_EXT = path.join(AGENT_DIR, "extensions", "sandbox-permissions", "subagent-bash-guard.ts");

/**
 * 构造 worker 子进程 env（纯函数，不改 process.env）：
 * 仅当 inboxId 合法时才注入 PI_SUBAGENT_INBOX；taskId 存在时注入 PI_TASK_ID。
 * PI_SUBAGENT 恒为 "1"（子进程内禁用递归派发）。
 */
const WORKER_ENV_ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM",
  "LANG", "TZ", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "XDG_DATA_HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR",
]);

/** 只继承运行 worker 所需的非秘密环境；API key/token/password 等一律不下传。 */
export function sanitizeWorkerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (WORKER_ENV_ALLOW.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  return env;
}

export function buildSubagentEnv(
  base: NodeJS.ProcessEnv,
  opts: {
    inboxId?: string;
    taskId?: string;
    /** 沙箱可写根（限制 worker 只能写指定目录，工程其余只读；透传 PI_SANDBOX_RW） */
    sandboxDir?: string;
    /** 沙箱只读模式（不写 workspace；透传 PI_SANDBOX_READONLY） */
    readonly?: boolean;
    /** 权限请求文件（仅父子进程间使用） */
    capabilityRequestPath?: string;
    /** 权限响应文件：worker 阻塞等待父进程写回决策 */
    capabilityResponsePath?: string;
    /** 已由主进程批准的、按 commandDigest 绑定的一次性 capability */
    capabilityGrants?: CapabilityGrant[];
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sanitizeWorkerEnv(base), PI_SUBAGENT: "1" };
  if (opts.taskId) env.PI_TASK_ID = opts.taskId;
  if (opts.inboxId && isValidInboxId(opts.inboxId)) {
    env.PI_SUBAGENT_INBOX = opts.inboxId;
  }
  // 沙箱细粒度限制（wrapper sandbox-shell.mjs 消费；仅 Linux/darwin 沙箱平台生效）
  if (opts.sandboxDir) env.PI_SANDBOX_RW = opts.sandboxDir;
  if (opts.readonly) env.PI_SANDBOX_READONLY = "1";
  if (opts.capabilityRequestPath) env.PI_SUBAGENT_CAPABILITY_REQUEST = opts.capabilityRequestPath;
  if (opts.capabilityResponsePath) env.PI_SUBAGENT_CAPABILITY_RESPONSE = opts.capabilityResponsePath;
  if (opts.capabilityGrants && opts.capabilityGrants.length > 0) {
    env.PI_SUBAGENT_CAPABILITY_GRANTS = JSON.stringify(opts.capabilityGrants);
  }
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
  /** 要提供给 worker 的 skill 绝对路径（目录/文件，加载对应 SKILL.md） */
  skills?: string[];
}): string[] {
  const skills = (opts.skills ?? []).filter(Boolean);
  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--no-extensions",
    // 默认禁用 skills 保持隔离；显式提供 skills 时改为逐个加载
    ...(skills.length > 0 ? [] : ["--no-skills"]),
    ...(skills.length > 0 ? skills.flatMap((s) => ["--skill", s]) : []),
    "--no-prompt-templates",
    "--no-context-files",
    "--model", opts.model,
    "--extension", CUSTOM_PROVIDERS_EXT,
    "--extension", MCP_ADAPTER_EXT,
    "--extension", SANDBOX_GUARD_EXT,
    "--extension", SUBAGENT_BASH_GUARD_EXT,
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
  /** 要提供给 worker 的 skill 绝对路径（目录/文件） */
  skills?: string[];
  /** 已审批的精确 capability grant；只对匹配 commandDigest 的命令生效 */
  capabilityGrants?: CapabilityGrant[];
  /** 主进程审批 worker 请求；返回 grant 才会重启当前 worker，review 作为审核意见透传 */
  onCapabilityRequest?: (request: CapabilityRequest) => Promise<CapabilityApproval | undefined>;
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

/** 原子写审批决策：tmp + rename，worker 读到的永远是完整 JSON */
function writeCapabilityDecision(
  path: string,
  request: CapabilityRequest,
  approval: CapabilityApproval | undefined,
): void {
  const decision = buildCapabilityDecision(request, approval);
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(decision), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, path);
}

/**
 * 默认单次执行：spawn 隔离 pi 进程并收集结果（原 runSubagent 本体）。
 * 重试循环的每次 attempt 调用它；每次调用自带全新 timeline 与超时控制器。
 */
export function defaultRunOnce(opts: RunSubagentOptions): Promise<SubagentResult> {
  const task = opts.task;
  const cwd = opts.cwd;
  const timeoutSeconds = opts.timeout ?? 600;
  // 模型不再从配置文件决定，统一由调用方传入（默认当前会话模型）
  const model = opts.model || "";

  const timeoutController = new AbortController();
  const timeoutError = () => new Error(`Subagent 超时（${timeoutSeconds}s）`);
  let remainingTimeoutMs = timeoutSeconds * 1000;
  let timeoutId: NodeJS.Timeout | undefined = setTimeout(
    () => timeoutController.abort(timeoutError()),
    remainingTimeoutMs,
  );
  // 审批等待不计入 worker 总超时：发现请求时暂停计时，审批结束后接着算剩余时间
  let timeoutPausedAt: number | undefined;
  const pauseTimeout = () => {
    if (timeoutPausedAt !== undefined) return;
    timeoutPausedAt = Date.now();
    if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
  };
  const resumeTimeout = () => {
    if (timeoutPausedAt === undefined) return;
    remainingTimeoutMs -= Date.now() - timeoutPausedAt;
    timeoutPausedAt = undefined;
    if (remainingTimeoutMs <= 0) {
      timeoutController.abort(timeoutError());
      return;
    }
    timeoutId = setTimeout(() => timeoutController.abort(timeoutError()), remainingTimeoutMs);
  };
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutController.signal])
    : timeoutController.signal;

  return new Promise(async (resolve, reject) => {
    try {
      // 写入系统提示词（buildSubagentArgs 会追加 --append-system-prompt 与任务注入）
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
      const promptPath = path.join(tmpDir, "prompt.md");
      const capabilityRequestPath = path.join(tmpDir, "capability-request.json");
      const capabilityResponsePath = path.join(tmpDir, "capability-response.json");
      await fs.promises.writeFile(promptPath, SUBAGENT_PROMPT, { encoding: "utf-8", mode: 0o600 });
      const args = buildSubagentArgs({
        task,
        cwd,
        model,
        promptPath,
        tools: opts.tools,
        skills: opts.skills,
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
      const archiveTimeline = new TimelineBuilder({
        seedEvents: [],
        attempt,
        maxEntries: Number.MAX_SAFE_INTEGER,
        maxText: Number.MAX_SAFE_INTEGER,
        maxField: Number.MAX_SAFE_INTEGER,
      });
      archiveTimeline.addLifecycle("starting", attempt > 1 ? `worker 重试（第 ${attempt} 次尝试）` : "worker 启动");

      const result: SubagentResult = {
        task,
        exitCode: 0,
        messages: [],
        visibleConversation: [{ role: "user", content: task, ts: new Date().toISOString() }],
        archiveTimeline: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        model,
        timeline: timeline.events,
      };

      // 独立的无限（相对当前进程寿命）可见归档轨迹；实时 timeline 仍有 500 条保护。
      const syncArchiveTimeline = () => {
        result.archiveTimeline = archiveTimeline.events
          .filter((event) => event.type !== "supplement")
          .map((event) => ({ ...event } as VisibleArchiveEvent));
      };
      const emitUpdate = () => {
        syncArchiveTimeline();
        opts.onUpdate?.(result);
      };

      let wasAborted = false;
      let capabilityRequest: CapabilityRequest | undefined;
      // 审批进行中：防止 capabilityPoll 重复处理同一请求
      let approvalInFlight = false;
      // 最近一次审核意见：随终态结果带回主 agent（供回报简报）
      let lastCapabilityReview: CapabilityReview | undefined;
      let agentEndOutput = "";

      const exitCode = await new Promise<number>((resolveExit) => {
        // 子进程 env 独立构造：不污染 process.env；有效 inbox 才注入 PI_SUBAGENT_INBOX
        const env = buildSubagentEnv(process.env, {
          inboxId: opts.inboxId,
          taskId: opts.taskId,
          sandboxDir: opts.sandboxDir,
          readonly: opts.readonly,
          capabilityRequestPath,
          capabilityResponsePath,
          capabilityGrants: opts.capabilityGrants,
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
            const archiveChanged = archiveTimeline.handleLine(line);
            if (timeline.handleLine(line) || archiveChanged) emitUpdate();
            let event: { type?: string; message?: unknown };
            try { event = JSON.parse(line); } catch { continue; }

            if (event.type === "message_end" && event.message) {
              const msg = event.message as Message;
              result.messages.push(msg);
              if (msg.role === "assistant") {
                const visible = getFinalOutput([msg as unknown as { role: string; content: string | ContentPartLike[] }]);
                if (visible) {
                  const ts = new Date().toISOString();
                  result.visibleConversation.push({ role: "assistant", content: visible, ts });
                }
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

        const readCapabilityRequest = (): CapabilityRequest | undefined => {
          try {
            return validateCapabilityRequest(JSON.parse(fs.readFileSync(capabilityRequestPath, "utf8")));
          } catch {
            return undefined;
          }
        };

        // worker guard 写请求后阻塞等待响应；父进程审批后原子写回决策，不 kill worker。
        // 审批期间暂停 worker 总超时（权限申请不该吃掉执行预算）。
        const capabilityPoll = setInterval(() => {
          if (approvalInFlight) return;
          const parsed = readCapabilityRequest();
          if (!parsed) return;
          approvalInFlight = true;
          capabilityRequest = parsed;
          pauseTimeout();
          void (async () => {
            let approval: CapabilityApproval | undefined;
            try {
              approval = await opts.onCapabilityRequest?.(parsed);
            } catch {
              approval = undefined;
            }
            try {
              writeCapabilityDecision(capabilityResponsePath, parsed, approval);
            } catch {
              // 写失败：worker 侧靠健康检查/超时按拒绝处理，不放行
            }
            try { fs.unlinkSync(capabilityRequestPath); } catch { /* ignore */ }
            if (approval?.review) lastCapabilityReview = approval.review;
            capabilityRequest = undefined;
            approvalInFlight = false;
            resumeTimeout();
          })();
        }, 50);
        capabilityPoll.unref?.();

        proc.on("close", (code: number) => {
          clearInterval(capabilityPoll);
          // 短命 worker 可能在首个 50ms 轮询前退出；close 时再读一次，避免丢请求。
          capabilityRequest ??= readCapabilityRequest();
          if (buffer.trim()) {
            for (const line of buffer.split("\n")) {
              if (!line.trim()) continue;
              timeline.handleLine(line);
              archiveTimeline.handleLine(line);
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
      if (capabilityRequest) result.capabilityRequest = capabilityRequest;
      if (lastCapabilityReview) result.capabilityReview = lastCapabilityReview;
      // 终态 lifecycle：success/failed/aborted/timeout（timeout 依据内部超时控制器判断）
      const terminal = resolveTerminalState({
        aborted: wasAborted,
        timedOut: timeoutController.signal.aborted,
        exitCode: result.exitCode,
        stopReason: result.stopReason,
      });
      timeline.addLifecycle(capabilityRequest ? "needs_approval" : terminal, capabilityRequest?.reason);
      archiveTimeline.addLifecycle(capabilityRequest ? "needs_approval" : terminal, capabilityRequest?.reason);
      // 终态同步一次：尾缓冲里的 telemetry 已并入 timeline，随终态 lifecycle 一起
      // 通过 onUpdate 送达调用方（与下方 resolve/throw 路径的 result.timeline 一致）
      emitUpdate();
      // agent_end 兜底：若 messages 里没有最终输出（如非标准退出路径），用 agent_end 的完整 messages
      if (agentEndOutput && !getFinalOutput(result.messages)) {
        result.messages.push({ role: "assistant", content: agentEndOutput } as unknown as Message);
      }

      try { fs.unlinkSync(promptPath); } catch { /* ignore */ }
      try { fs.unlinkSync(capabilityRequestPath); } catch { /* ignore */ }
      try { fs.unlinkSync(capabilityResponsePath); } catch { /* ignore */ }
      try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }

      if (wasAborted && !capabilityRequest) {
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
      if (timeoutId) clearTimeout(timeoutId);
      reject(err);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
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
  let capabilityGrants = [...(opts.capabilityGrants ?? [])];
  let capabilityGrantIssued = capabilityGrants.length > 0;
  // 最后一次审核意见：进入最终失败终态时（批准后基础设施失败 / 超时 / 中止）随结果带回；
  // 被拒绝时已在下方单独写入 capabilityReview，不依赖这个兜底。
  let lastApprovalReview: CapabilityReview | undefined;
  // 失败预算（failureCount）只被可重试的基础设施失败消耗：capability 审批与随之而来的
  // worker 重启不占次数（审批是正交路径，不该吃掉网络抖动的重试额度）。
  // round 是总轮次，用于 timeline 命名空间与 attempt 记录，capability 重启也递增。
  let failureCount = 0;
  let round = 0;

  while (true) {
    if (opts.signal?.aborted) {
      lastError = new SubagentError("aborted", "Subagent 已中止");
      break;
    }
    round++;
    const startedAt = new Date().toISOString();
    try {
      // 精确 grant 可跨多轮请求累积（例如同一条 curl | sh 需要 network+command 两把钥匙）。
      // 它们只绑定精确 commandDigest；一旦已发过 capability grant，后续基础设施失败不再自动重试，
      // 避免不清楚 grant 是否已被消费时重复执行获批命令。
      const result = await runOnce({
        ...opts,
        capabilityGrants,
        runOnce: undefined,
        sleep: undefined,
        seedTimeline: accumulated,
        attempt: round,
      });
      lastResult = result;
      accumulated = result.timeline; // 本轮结束后的完整累积，供下轮重试续接
      if (result.capabilityRequest) {
        // 权限请求不属于基础设施失败；只有主进程明确返回匹配 grant 才重启。
        const approval = await opts.onCapabilityRequest?.(result.capabilityRequest);
        if (approval?.review) lastApprovalReview = approval.review;
        const grant = approval?.grant;
        if (!grant) {
          result.capabilityDenied = true;
          result.capabilityReview = approval?.review;
          result.errorMessage = "capability request 未获主进程批准，worker 未继续执行。";
          result.attempts = round;
          return result;
        }
        if (
          grant.capability !== result.capabilityRequest.capability ||
          grant.commandDigest !== result.capabilityRequest.commandDigest ||
          grant.commandDigest !== commandDigest(result.capabilityRequest.command)
        ) {
          result.capabilityDenied = true;
          result.errorMessage = "主进程返回了不匹配的 capability grant，已拒绝继续执行。";
          result.attempts = round;
          return result;
        }
        capabilityGrants = [...capabilityGrants, grant];
        capabilityGrantIssued = true;
        continue;
      }
      if (!isFailedResult(result) && result.stopReason !== "error") {
        // 干净成功：返回（带 attempts 供观测），不写调查文件
        result.attempts = round;
        return result;
      }
      // 失败结果（可重试或不可重试）：只有这里消耗失败预算
      failureCount++;
      const status: AttemptSnapshot["status"] = result.stopReason === "aborted" ? "aborted" : "failed";
      attempts.push(snapshotFromResult(round, result, status, startedAt));
      lastError = null;
      if (capabilityGrantIssued || !isRetryableFailure(result) || failureCount >= max) break;
      await sleep(backoffDelayMs(failureCount), opts.signal);
    } catch (err) {
      lastError = err;
      const status: AttemptSnapshot["status"] = err instanceof SubagentError ? err.status : "aborted";
      const timeline = err instanceof SubagentError ? err.timeline : undefined;
      if (timeline) accumulated = timeline; // 超时/中止也携最终轨迹，重试前续接
      failureCount++;
      attempts.push(snapshotFromError(round, err, status, timeline, startedAt));
      if (!isRetryableFailure(err) || failureCount >= max) break;
      try {
        await sleep(backoffDelayMs(failureCount), opts.signal);
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
    visibleConversation: [{ role: "user", content: opts.task, ts: new Date().toISOString() }],
    archiveTimeline: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
  };
  failed.investigationPath = investigationPath;
  failed.attempts = attempts.length || 1;
  failed.inlineSummary = inlineSummary;
  // 重试耗尽（每轮都获批并重启）时，把最后一次审核意见带回终态结果
  if (!failed.capabilityReview) failed.capabilityReview = lastApprovalReview;
  return failed;
}
