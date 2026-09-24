// batch.ts — 同步并发 batch 调度
//
// Promise.allSettled 语义：所有 worker 并行启动，各自独立跑到终态
// （success/failed/aborted/timeout）。单个 worker 失败或超时不终止兄弟 worker，
// 也不提前返回。结果按输入顺序逐项列出。

import { join } from "node:path";
import {
  runSubagent,
  externalStopReason,
  getResultOutput,
  isFailedResult,
  SubagentError,
  type SubagentResult,
  type SubagentUsage,
  type TimelineEvent,
} from "../../lib/subagent-run.ts";
import type { CapabilityApproval, CapabilityRequest, CapabilityReview } from "../../lib/subagent-capability.ts";
import { buildHoldDecision, type HoldDecision, type HoldDeferHandle, type HoldRequest } from "../../lib/subagent-hold.ts";
import { createInbox, isValidInboxId } from "../../lib/subagent-supplement.ts";
import { diagnosticsRoot } from "./diagnostics.ts";
import { updateWorker } from "./status.ts";
import { registerWorkerAbort, unregisterWorkerAbort, type WorkerKey } from "./active-workers.ts";

export type BatchItemStatus = "success" | "failed" | "aborted" | "timeout" | "needs_approval";

/**
 * 单批同时运行的 worker 数安全阀（不是节流额度）。
 *
 * 正常批次应当齐射：上游的并发配额由 provider 自己管，撞到
 * `Concurrency limit exceeded for account` 时由重试链按 quota 类别退避再试
 * （见 lib/subagent-retry.ts 的 RETRY_POLICY），不靠静态额度预算先掉。
 * 这个上限只挡极端大批次（一次派十几个 worker），避免把账号配额打到难以恢复。
 * （不做模型降级：手上没有可用作降级的其他模型资源。）
 */
export const MAX_PARALLEL_WORKERS_SAFETY_CAP = 8;

/**
 * 把 runSubagent 抛出的错误分类为可识别终态（timeout | aborted）。
 *
 * 依赖 SubagentError.status（结构化字段）而非错误消息文本：超时（内部超时控制器）
 * 映射为 timeout，外部 signal 中止映射为 aborted，其余未知错误兜底为 aborted
 * （保持原有 catch 语义：只有明确超时才标 timeout）。
 */
export function classifyTerminalError(err: unknown): {
  status: "timeout" | "aborted";
  timeline?: TimelineEvent[];
} {
  if (err instanceof SubagentError) {
    return { status: err.status, timeline: err.timeline };
  }
  return { status: "aborted" };
}

export interface TerminalPatch {
  status: BatchItemStatus;
  finishedAt: string;
  timeline?: TimelineEvent[];
}

/**
 * 构造终态 updateWorker 补丁。timeline 只在错误明确携带时写入：
 * undefined 绝不覆盖已有实时 timeline（catch 里保留最终轨迹，不抹掉实时快照）。
 */
export function buildTerminalPatch(err: unknown, finishedAt: string): TerminalPatch {
  const { status, timeline } = classifyTerminalError(err);
  const patch: TerminalPatch = { status, finishedAt };
  if (timeline) patch.timeline = timeline;
  return patch;
}

/**
 * catch 路径的失败输出：SubagentError 携带 investigationPath 时，输出中附调查文件
 * 路径与读档指引（供主 agent 直接 read 调查文件恢复现场）；否则返回空字符串，
 * 由调用方回退为 String(err)。
 *
 * 用户强停（/subagent:stop）另有措辞：这不是 worker 的故障，是人在会话里叫停的，
 * 而且现场还在，不该当超时/失败那样自动重试或原样重派。
 */
export function formatCatchOutput(
  err: unknown,
  status: BatchItemStatus,
  opts: { archivePath?: string } = {},
): string {
  const investigationPath = err instanceof SubagentError ? err.investigationPath : undefined;
  const userStop = err instanceof SubagentError && err.stopKind === "user";
  if (userStop) {
    const lines = [
      `${String(err)}`,
      "  这是用户在会话里下的令（/subagent:stop），不是 worker 失败、也不是超时：不要自动重试，也不要原样重派同一个任务，先看用户的理由。",
    ];
    if (investigationPath) {
      lines.push(`  现场摘要（最后步骤 + 路径线索）：${investigationPath}`);
      lines.push("  读档：先看该文件「读档指引」与「最终结论」；要复用已做的侦察，按「线索」里的路径去 read/diff 磁盘现状");
    }
    if (opts.archivePath) {
      lines.push(`  完整可见轨迹（任务输入 / timeline / worker 可见输出）：${opts.archivePath}`);
    }
    lines.push("  接着干：worker 进程已退出，subagent_resume 续不上（那只对停在检查点上的 worker 有效）；要接着做就把上面的文件当背景重新派一个 worker，或先跟用户对齐还做不做。");
    return lines.join("\n");
  }
  if (!investigationPath) return "";
  return `FAILED final=${status}\n  investigation: ${investigationPath}\n  读档：先看该文件「读档指引」与「最终结论」\n  ${String(err)}`;
}

export interface BatchItemResult {
  index: number;
  status: BatchItemStatus;
  exitCode?: number;
  output: string;
  stderr: string;
  errorMessage?: string;
  usage?: SubagentUsage;
  /** 重试彻底失败后写出的调查文件绝对路径（timeout/aborted/failed 时可能携带） */
  investigationPath?: string;
  /** 实际尝试次数（含首次；仅成功/失败结果携带，超时/中止时调查文件内有计数） */
  attempts?: number;
  /** worker 请求的额外能力；拒绝或 GUI 不可用时作为终态返回 */
  capabilityRequest?: CapabilityRequest;
  /** 该 capability 请求的审核模型意见（供主 agent 回报简报） */
  capabilityReview?: CapabilityReview;
}

export interface RunBatchOptions {
  cwd: string;
  model: string;
  signal?: AbortSignal;
  tools?: string[];
  extraExtensions?: string[];
  /** 所有 worker 共用的 skill 绝对路径（兼容旧调用） */
  skills?: string[];
  /** 每个 worker 独立的 skill 绝对路径；缺省回退到 skills */
  workerSkills?: string[][];
  taskId?: string;
  timeout?: number;
  /**
   * 与 tasks 一一对应的 batch-scoped inbox ids（每个 worker 一个）。
   * 在 spawn 之前统一校验并预创建 inbox；同一 batch 内每个 worker 只 create 一次。
   */
  workerInboxIds: string[];
  /** 沙箱可写根（限制 worker 只写该目录，工程其余只读） */
  sandboxDir?: string;
  /** 沙箱只读模式（不写 workspace） */
  readonly?: boolean;
  /** 主进程审批 worker 的能力请求；返回精确 grant 才会重启当前 worker，review 作为审核简报透传 */
  onCapabilityRequest?: (request: CapabilityRequest, workerId: string) => Promise<CapabilityApproval | undefined>;
  /**
   * worker 预算见底时的暂存决策（继续/补充/收工）。
   * 不传 = 不启用暂存，行为与以前一致（到点即超时终止）。
   */
  onHold?: (request: HoldRequest, workerId: string) => Promise<HoldDecision | "defer" | undefined>;
  /** 同时运行的 worker 数上限；缺省 MAX_PARALLEL_WORKERS_SAFETY_CAP */
  maxParallel?: number;
  /**
   * worker 交出暂存控制权（onHold 返回 defer）时按 worker 回调。
   * 拿到句柄的一方负责写回决定，否则 worker 会一直守着检查点。
   */
  onDefer?: (handle: HoldDeferHandle, workerId: string) => void;
}

/**
 * 前置校验：workerInboxIds 必须与 tasks 长度一致且每个都是合法 inbox id。
 * 校验失败在 create/spawn 之前抛错——绝不产生半启动的 batch。
 */
export function validateWorkerInboxIds(tasks: string[], inboxIds: string[]): void {
  if (!Array.isArray(inboxIds) || inboxIds.length !== tasks.length) {
    throw new Error(
      `workerInboxIds length ${Array.isArray(inboxIds) ? inboxIds.length : "missing"} does not match tasks length ${tasks.length}`,
    );
  }
  for (const id of inboxIds) {
    if (!isValidInboxId(id)) {
      throw new Error(
        `invalid worker inboxId ${JSON.stringify(id)}: must be 1-128 chars of [A-Za-z0-9_-]`,
      );
    }
  }
}

/** inbox 预创建函数（测试注入；默认真实 createInbox）。 */
export type CreateInboxFn = (inboxId: string) => Promise<unknown>;

/**
 * 在 spawn 之前按序为每个 worker 预创建 inbox（每 id 恰好一次）。
 * 任一 create 失败立即整体拒绝：runBatch 不会带着半批 inbox 继续 spawn。
 */
export async function prepareInboxes(
  inboxIds: string[],
  create: CreateInboxFn = (id) => createInbox(id),
): Promise<void> {
  for (const id of inboxIds) {
    await create(id);
  }
}

/**
 * 固定并发度的任务池：最多 limit 个 fn 同时在飞，其余按输入顺序排队。
 * 结果数组与输入同序（与批次汇报「按输入顺序逐项列出」的语义一致）。
 * 单个 fn 抛错会向上冒泡——调用方（runWorker）自己消化成终态，不在这里吞。
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const effective = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  const lanes = Array.from({ length: effective }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

export async function runBatch(tasks: string[], opts: RunBatchOptions): Promise<BatchItemResult[]> {
  // 前置：校验 + 全部 inbox 预创建完成，之后才进入并行 spawn。
  // 任一 create 失败都在子进程启动前整体拒绝（不留半批）；
  // 调用方（index submit tool）据此把整批标记为失败并给出可观测 UI 响应。
  validateWorkerInboxIds(tasks, opts.workerInboxIds);
  await prepareInboxes(opts.workerInboxIds);

  // 并发安全阀：正常批次齐射；只有超过安全阀的极端大批次才排队（上游限速由重试链退避吸收）。
  const limit = Math.max(1, Math.min(opts.maxParallel ?? MAX_PARALLEL_WORKERS_SAFETY_CAP, tasks.length));
  // 超出额度的 worker 标 queued：如实告诉操作者在排队，不拿「启动中」假装已开始
  for (let i = limit; i < tasks.length; i++) updateWorker(`w${i + 1}`, { status: "queued" });

  // 取消句柄在排队阶段就建好并登记：排队的 worker 也要停得掉。
  // 登记在这里、注销在 finally，因为排队中的 worker 可能压根不会进 runWorker。
  const controllers = new Map<string, AbortController>();
  for (let i = 0; i < tasks.length; i++) {
    const id = `w${i + 1}`;
    const controller = new AbortController();
    controllers.set(id, controller);
    if (opts.taskId) registerWorkerAbort({ batchId: opts.taskId, workerId: id }, controller);
  }
  try {
    return await runWithConcurrency(tasks, limit, (task, index) =>
      runWorker(task, index, opts, controllers.get(`w${index + 1}`)!),
    );
  } finally {
    if (opts.taskId) {
      for (const id of controllers.keys()) {
        unregisterWorkerAbort({ batchId: opts.taskId, workerId: id });
      }
    }
  }
}

/** 一个停在检查点上等决定的 worker */
export interface BatchDefer {
  workerId: string;
  handle: HoldDeferHandle;
  at: number;
}

/**
 * 批次运行时：跑到暂存点先把控制权交回来，worker 继续守着检查点。
 *
 * 为什么需要这层：runBatch 要等所有 worker 收尾，而暂存中的 worker 就是在等决定，
 * 两边互等就死在那里。所以把「批次结束」和「又有 worker 暂存了」拆成两个信号，
 * 调用方 race 它们：前者到 = 收工；后者到 = 把球踢出去做决策，批次在后台挂着。
 */
export interface BatchRuntime {
  batchId: string | undefined;
  /** 全部 worker 收尾才 resolve；暂存期间继续挂着 */
  done: Promise<BatchItemResult[]>;
  /** 取走当前待决的暂存。取走即不再返回，避免同一个请求被决策两次 */
  takePendingDefers(): BatchDefer[];
  /** 等下一个暂存；已有待决的立即返回。批次结束由 done 那边收场，这里不等它 */
  waitForDefer(): Promise<void>;
  /** 写回某个 worker 的决定；没有句柄则 false（它可能已收尾或已被决策） */
  resume(workerId: string, choice: ResumeChoice): boolean;
}

export function createDeferQueue(): DeferQueue {
  const pending: BatchDefer[] = [];
  const handles = new Map<string, HoldDeferHandle>();
  let wake: (() => void) | undefined;
  return {
    push(workerId, handle) {
      handles.set(workerId, handle);
      pending.push({ workerId, handle, at: Date.now() });
      const notify = wake;
      wake = undefined;
      notify?.();
    },
    takePending: () => pending.splice(0, pending.length),
    wait: () =>
      new Promise<void>((resolve) => {
        if (pending.length > 0) {
          resolve();
          return;
        }
        wake = resolve;
      }),
    resume: (workerId, choice) => {
      const handle = handles.get(workerId);
      if (!handle) return false;
      handles.delete(workerId);
      handle.resume(buildHoldDecision({
        requestId: handle.request.requestId,
        action: choice.action,
        extraMs: choice.extraMs,
        comment: choice.comment,
      }));
      return true;
    },
  };
}

/** 续跑选择：requestId 由句柄自己带上，调用方不必（也不该）操心配对 */
export interface ResumeChoice {
  action: "continue" | "stop";
  /** continue 时的新预算；缺省用 DEFAULT_HOLD_EXTRA_MS */
  extraMs?: number;
  comment?: string;
}

/**
 * 暂存句柄队列：攒待决请求、唤醒等待者、写回决定。
 * 单独抽出来是为了能测——这层出错的表现是「决策丢了」或「同一次请求被决策两次」，
 * 现场都很难看出来。
 */
export interface DeferQueue {
  push(workerId: string, handle: HoldDeferHandle): void;
  takePending(): BatchDefer[];
  wait(): Promise<void>;
  /** 写回决定；没有句柄则 false。requestId 从句柄取，避免调用方配错对 */
  resume(workerId: string, choice: ResumeChoice): boolean;
}

export function startBatch(tasks: string[], opts: RunBatchOptions): BatchRuntime {
  const queue = createDeferQueue();
  const done = runBatch(tasks, {
    ...opts,
    onDefer: (handle, workerId) => queue.push(workerId, handle),
  });
  // 批次的拒绝由调用方 await done 接收；这里先搽一层，避免没人接时进程报 unhandled rejection
  done.catch(() => {});

  return {
    batchId: opts.taskId,
    done,
    takePendingDefers: () => queue.takePending(),
    waitForDefer: () => queue.wait(),
    resume: (workerId, choice) => queue.resume(workerId, choice),
  };
}

/**
 * 用调用方建好的取消句柄跑一轮（句柄的生命周期比单次 runSubagent 长：
 * 排队中的 worker 也得停得掉，所以 controller 由 runBatch 统一创建并登记）。
 */
async function withWorkerAbort<T>(
  controller: AbortController,
  run: (signal: AbortSignal) => Promise<T>,
  batchSignal?: AbortSignal,
): Promise<T> {
  const signal = batchSignal ? AbortSignal.any([batchSignal, controller.signal]) : controller.signal;
  try {
    return await run(signal);
  } catch (err) {
    // 命令层停下来的理由挂在 abort reason 上；别让它随 signal 一起消失
    const reason = controller.signal.reason;
    if (controller.signal.aborted && reason instanceof Error && err instanceof Error) {
      (err as Error & { stopReason?: string }).stopReason = reason.message;
    }
    throw err;
  }
}

/** 单个 worker 的完整生命周期（原 runBatch 的 per-task 主体，拆出以便并发池复用） */
async function runWorker(
  task: string,
  index: number,
  opts: RunBatchOptions,
  controller: AbortController,
): Promise<BatchItemResult> {
  const id = `w${index + 1}`;
  const inboxId = opts.workerInboxIds[index];

  // 排队期间被停：不启动进程。不检查的话，stop 会在队列里排队等着启动，
  // 面板上它一直是 queued，提督以为停干净了
  if (controller.signal.aborted) {
    const finishedAt = new Date().toISOString();
    // 同样是用户下的令：说清「一步都没跑」，别让主 agent 去猜有没有留下现场
    const reason = externalStopReason(controller.signal);
    const note = `用户强停（/subagent:stop）于启动前：${reason ?? "未写理由"}。这个 worker 一步都没跑，没有现场可回溯，也不用重派。`;
    updateWorker(id, { status: "aborted", finishedAt, output: note });
    return { index, status: "aborted", output: note, stderr: note };
  }

  // 真启动才计耗时：创建批次时写入的 startedAt 是批次起点，排队中的 worker 一直沿用它，
  // 会让后启动的 worker 报出与先启动兄弟相同的耗时。这里重置为实际启动时刻。
  updateWorker(id, { status: "starting", startedAt: new Date().toISOString() });

  try {
    const result: SubagentResult = await withWorkerAbort(controller, (signal) => runSubagent({
      task,
      cwd: opts.cwd,
      model: opts.model,
      signal,
      tools: opts.tools,
      extraExtensions: opts.extraExtensions,
      skills: opts.workerSkills?.[index] ?? opts.skills,
      taskId: opts.taskId ? `${opts.taskId}-${id}` : id,
      sandboxDir: opts.sandboxDir,
      readonly: opts.readonly,
      onCapabilityRequest: opts.onCapabilityRequest
        ? async (request) => {
            updateWorker(id, {
              status: "needs_approval",
              capabilityRequest: request,
              output: `等待主 agent 审批：${request.capability}（${request.scope}）`,
            });
            try {
              return await opts.onCapabilityRequest!(request, id);
            } finally {
              // 审批结束后 worker 继续执行（不再 kill/重启），状态回到运行中
              updateWorker(id, { status: "running", capabilityRequest: undefined });
            }
          }
        : undefined,
      // 预算见底：worker 在检查点停下，状态转 holding，等主侧决定后再跑
      onHold: opts.onHold
        ? async (request) => {
            updateWorker(id, {
              status: "holding",
              holdRequest: request,
              output: `暂存中（${request.reason === "budget" ? "时间预算快用完了" : "worker 主动请求"}）：等主侧决定`,
            });
            let outcome: HoldDecision | "defer" | undefined;
            try {
              outcome = await opts.onHold!(request, id);
            } finally {
              // defer 不能当「答完了」：worker 还停在检查点，状态得留着 holding，
              // 否则面板会显示运行中，实际它一步没动
              if (outcome !== "defer") updateWorker(id, { status: "running", holdRequest: undefined });
            }
            return outcome;
          }
        : undefined,
      // 交出控制权：不在这里写决定，由拿到句柄的一方决定何时续跑；resume 时才翻回运行中
      onDefer: opts.onDefer
        ? (handle) => opts.onDefer!(
            {
              request: handle.request,
              resume: (decision) => {
                updateWorker(id, { status: "running", holdRequest: undefined });
                handle.resume(decision);
              },
            },
            id,
          )
        : undefined,
      inboxId, // 重试循环内由 runSubagent 原样复用，不在 attempt 内重建
      timeout: opts.timeout ?? 600,
      onSpawn: (pid) => updateWorker(id, { pid, status: "running" }),
      onUpdate: (r) => updateWorker(id, {
        usage: r.usage,
        stream: r.stream,
        liveOutputTokens: r.liveOutputTokens ?? 0,
        stderr: r.stderr.slice(-4000),
        // 每次实时解析更新都传 timeline 快照（复制，避免共享同一数组引用）
        timeline: [...r.timeline],
        visibleConversation: [...r.visibleConversation],
        archiveTimeline: [...r.archiveTimeline],
      }),
    }), opts.signal);

    const failed = isFailedResult(result);
    const status: BatchItemStatus = result.capabilityRequest
      ? result.capabilityDenied ? "failed" : "needs_approval"
      : failed ? "failed" : "success";
    updateWorker(id, {
      status,
      finishedAt: new Date().toISOString(),
      usage: result.usage,
      stream: result.stream,
      liveOutputTokens: 0, // 终态：在途计数已并入 usage.output
      stderr: result.stderr.slice(-4000),
      output: result.capabilityRequest
        ? result.capabilityDenied
          ? `主 agent 未批准：${result.capabilityRequest.capability}（${result.capabilityRequest.scope}）`
          : `等待主 agent 审批：${result.capabilityRequest.capability}（${result.capabilityRequest.scope}）`
        : getResultOutput(result).slice(-8000),
      // 终态更新保留最终 timeline
      timeline: [...result.timeline],
      visibleConversation: [...result.visibleConversation],
      archiveTimeline: [...result.archiveTimeline],
      capabilityRequest: result.capabilityRequest,
    });
    return {
      index,
      status,
      exitCode: result.exitCode,
      output: result.capabilityRequest
        ? result.capabilityDenied
          ? `主 agent 未批准：${result.capabilityRequest.capability}（${result.capabilityRequest.scope}）`
          : `等待主 agent 审批：${result.capabilityRequest.capability}（${result.capabilityRequest.scope}）`
        : result.inlineSummary ?? getResultOutput(result),
      stderr: result.stderr,
      errorMessage: result.errorMessage,
      usage: result.usage,
      investigationPath: result.investigationPath,
      attempts: result.attempts,
      capabilityRequest: result.capabilityRequest,
      capabilityReview: result.capabilityReview,
    };
  } catch (err) {
    // 结构化终态：timeout/aborted 由 SubagentError.status 决定，不再用 /超时/ 正则误判
    const patch = buildTerminalPatch(err, new Date().toISOString());
    updateWorker(id, patch);
    const investigationPath = err instanceof SubagentError ? err.investigationPath : undefined;
    // 诊断档案按批次落盘（batchId）：worker 被强停时这是唯一留下完整可见轨迹的地方
    const archivePath = opts.taskId ? join(diagnosticsRoot(), `${opts.taskId}.json`) : undefined;
    return {
      index,
      status: patch.status,
      output: formatCatchOutput(err, patch.status, { archivePath }) || String(err),
      stderr: String(err),
      investigationPath,
    };
  }
}

