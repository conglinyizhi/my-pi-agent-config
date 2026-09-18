// extensions/subagent-supplement-bridge/index.ts — Task 2: worker 补充指令桥接
//
// 由 worker 子进程显式加载（--extension）。每个 tool_execution_end（无论成功/失败）
// 从 PI_SUBAGENT_INBOX 指定的补充队列 claim 最早一条 pending 补充指令，编码成
// wire 标记 + JSON 载荷后经 pi.sendUserMessage(encoded, { deliverAs: "steer" })
// 塞回当前 worker——steer 会在本轮工具执行完后、下一次 LLM 调用前投递。
//
// 职责边界：
//   - 只做 claim + 投递，不手动改 timeline（那是 TimelineBuilder 的事），
//     也不对队列 "handoff" 宣称模型已经阅读。
//   - 只在 process.env.PI_SUBAGENT_INBOX 是有效 inbox id 时注册 handler；
//     无值 / 非法值一律不注册、不抛（静默禁用）。
//   - claim 到 null（无 pending）不投递。
//
// 可测性：createSupplementToolEndHandler(deps) 工厂可注入 claim 与 send；
// registerSupplementBridge 可注入 inboxId / claim / send，默认接线用真实
// claimNextSupplement 与 pi.sendUserMessage。default export 只读 env。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  claimNextSupplement,
  encodeSupplementMessage,
  isValidInboxId,
  releaseSupplement,
} from "../../lib/subagent-supplement.ts";
import {
  makeHoldRequest,
  validateHoldWanted,
  waitForHoldDecision,
  type HoldAction,
  type HoldWanted,
} from "../../lib/subagent-hold.ts";

/**
 * tool_execution_end 事件的最小结构形状（本地定义，避免依赖包的导出面；
 * 与 pi.on 推断出的 ToolExecutionEndEvent 结构一致）。
 */
export interface ToolEndEventShape {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

/** claim 边界的最小契约（真实 claimNextSupplement 的返回值是它的超集）。 */
export interface SupplementClaimResult {
  claimed: { id: string; text: string } | null;
}

/** 工厂依赖：inboxId + claim + release + send 全部可注入。 */
export interface SupplementBridgeDeps {
  inboxId: string;
  claim: (inboxId: string) => Promise<SupplementClaimResult>;
  release: (inboxId: string, entryId: string) => Promise<{ released: boolean }>;
  send: (encoded: string, options: { deliverAs: "steer" }) => void;
}

/**
 * 返回 tool_execution_end handler：不看 isError，成功/失败完成都 claim 一条；
 * claimed null 不发；claimed 存在则编码后以 steer 投递。
 * send 同步抛错（Pi 未接受入队）时：尽力原位 release 回滚该条为 pending，
 * 然后 rethrow 原始错误让 Pi 能报告 bridge 故障——绝不宣布 delivery。
 * send 正常返回即代表 Pi 接受入队，条目保持 handoff，不调用 release。
 */
export function createSupplementToolEndHandler(
  deps: SupplementBridgeDeps,
): (event: ToolEndEventShape) => Promise<void> {
  return async (_event: ToolEndEventShape): Promise<void> => deliverOneSupplement(deps);
}

/** 领一条 pending 补充并 steer 投递；有一条就拿一条，没有就什么都不做。 */
async function deliverOneSupplement(deps: SupplementBridgeDeps): Promise<void> {
  const { claimed } = await deps.claim(deps.inboxId);
  if (!claimed) return;
  try {
    deps.send(encodeSupplementMessage(claimed.id, claimed.text), { deliverAs: "steer" });
  } catch (err) {
    // send 是同步 void：只有同步抛错才进这里。回滚为 best-effort——
    // release 自身失败也不吞掉原始错误，仍抛 err。
    try {
      await deps.release(deps.inboxId, claimed.id);
    } catch {
      // 尽力回滚失败：保留原始 send 错误
    }
    throw err;
  }
}

/** 注册选项：可覆盖 inboxId / claim / release / send（测试注入；默认用真实实现）。 */
export interface SupplementBridgeOptions {
  inboxId?: string;
  claim?: (inboxId: string) => Promise<SupplementClaimResult>;
  release?: (inboxId: string, entryId: string) => Promise<{ released: boolean }>;
  send?: (encoded: string, options: { deliverAs: "steer" }) => void;
  /** 暂存三文件路径；缺省从 env 读（与 runner 的 PI_SUBAGENT_HOLD_* 对应） */
  holdPaths?: HoldPaths;
  /** 测试注入：等决定时的时钟与等待上限 */
  holdWait?: HoldWaitOverrides;
}

/** 暂存通道的三个文件（父进程建在 worker 的 tmpDir 里） */
export interface HoldPaths {
  wanted: string;
  request: string;
  response: string;
}

export interface HoldWaitOverrides {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  healthMs?: number;
  pollMs?: number;
}

/** 从环境变量取暂存路径；三个都齐且为绝对路径才启用 */
export function holdPathsFromEnv(env: NodeJS.ProcessEnv = process.env): HoldPaths | undefined {
  const wanted = env.PI_SUBAGENT_HOLD_WANTED;
  const request = env.PI_SUBAGENT_HOLD_REQUEST;
  const response = env.PI_SUBAGENT_HOLD_RESPONSE;
  if (!wanted || !request || !response) return undefined;
  if (![wanted, request, response].every((p) => isAbsolute(p))) return undefined;
  return { wanted, request, response };
}

export interface HoldCycleDeps {
  paths: HoldPaths;
  /** 继续后立刻拉一条补充投递（让人给的补充赶在下一次 LLM 调用前到位） */
  deliverSupplement: () => Promise<void>;
  parentAlive?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  healthMs?: number;
  pollMs?: number;
}

export interface HoldOutcome {
  held: boolean;
  action?: HoldAction;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, payload: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * 造一个「检查点暂存」动作：工具调用结束时调一次。
 *
 * 父进程只在预算见底时写下 wanted 标志；worker 拿到后**自己挑时机**（就是现在这个
 * 工具结束点）写请求并阻塞等决定——模型流没法暂停，只能在安静点停，所以这个顺序不能反。
 *
 * 拿到 continue：拉一条补充投递（若有），继续干；拿到 stop：往 stderr 留一行，
 * 剩下交给父进程（它会 abort 本进程）。
 */
export function createHoldCycle(deps: HoldCycleDeps): () => Promise<HoldOutcome> {
  return async (): Promise<HoldOutcome> => {
    const wanted: HoldWanted | undefined = validateHoldWanted(readJson(deps.paths.wanted));
    if (!wanted?.wanted) return { held: false };
    const request = makeHoldRequest({
      reason: wanted.reason,
      elapsedMs: Math.round(process.uptime() * 1000),
      remainingMs: wanted.remainingMs,
    });
    try {
      writeJsonAtomic(deps.paths.request, request);
    } catch {
      return { held: false }; // 写不进去（tmpDir 没了等）：当作没发生
    }
    const decision = await waitForHoldDecision(request.requestId, {
      readDecision: () => readJson(deps.paths.response),
      parentAlive: deps.parentAlive ?? (() => true),
      now: deps.now,
      sleep: deps.sleep,
      timeoutMs: deps.timeoutMs,
      healthMs: deps.healthMs,
      pollMs: deps.pollMs,
    });
    try {
      unlinkSync(deps.paths.response);
    } catch {
      // 下次暂存靠 requestId 比对防陈旧，不依赖删干净
    }
    if (decision.action === "continue") {
      try {
        await deps.deliverSupplement();
      } catch {
        // 补充投递失败不能把 worker 拖挂：下一轮工具结束还会再试
      }
    }
    // 「收工」不在这里出声：停下是父侧的决定，它已经把 hold_stop 生命周期
    // （含理由）记进 timeline 和诊断档案，worker 再留一行只是重复
    return { held: true, action: decision.action };
  };
}

/**
 * 向 ExtensionAPI 注册 supplement 桥接 handler。inboxId 无效时返回 false
 * 且不注册 handler、不抛。返回是否已注册。
 */
/**
 * 父进程还活着吗。
 *
 * 只看 `kill(ppid, 0)` 挡不住：父进程死后子进程会被 init 收养，ppid 变成 1，
 * 而 `kill(1, 0)` 是成功的 —— 于是孤儿 worker 以为自己还有爹，把活干完，
 * 而等结果的人早就不在了。所以额外认 ppid 的变化。
 */
export function parentProcessAlive(opts: {
  initialPpid: number;
  currentPpid: number;
  /** 向 currentPpid 发信号是否成功 */
  signalable: boolean;
}): boolean {
  if (opts.currentPpid === 1) return false;
  if (opts.currentPpid !== opts.initialPpid) return false;
  return opts.signalable;
}

export function registerSupplementBridge(
  pi: ExtensionAPI,
  opts: SupplementBridgeOptions = {},
): boolean {
  const inboxId = opts.inboxId ?? process.env.PI_SUBAGENT_INBOX ?? "";
  const hasInbox = isValidInboxId(inboxId);
  if (!hasInbox) {
    // 以前这里是默默返回 false，连暂存也一起废掉：两条通道本无关，inbox 有问题
    // 不该拖累暂存。留一行 stderr，它会进父侧的诊断尾部。
    //
    // 但本扩展住在 ~/.pi/agent/extensions/（全局自动发现），主会话、`pi --help`
    // 这类非 worker 进程也会加载它，而它们永远没有 PI_SUBAGENT_INBOX——不加
    // 门槛就等于每次启动都报一次。诊断是给父侧看的，只在 worker 上下文出声。
    if (process.env.PI_SUBAGENT === "1") {
      process.stderr.write("subagent-supplement-bridge: 无有效 inbox id，补充通道未启用\n");
    }
  }
  const holdPathsProbe = opts.holdPaths ?? holdPathsFromEnv();
  if (!hasInbox && !holdPathsProbe) return false; // 两条都没得做才彻底退出
  const claim = opts.claim ?? ((id: string) => claimNextSupplement(id));
  const release =
    opts.release ?? ((id: string, entryId: string) => releaseSupplement(id, entryId));
  const send = opts.send ?? ((encoded: string) => pi.sendUserMessage(encoded, { deliverAs: "steer" }));
  const supplementDeps: SupplementBridgeDeps = { inboxId, claim, release, send };
  // 父进程存活判断：只看 kill(ppid,0) 挡不住这件事——父死了子进程会被 init 收养，
  // ppid 变成 1，而 kill(1,0) 是成功的。所以额外认 ppid 的变化。
  const initialParentPid = process.ppid;
  const partnerAlive = () => {
    let signalable = true;
    try {
      process.kill(process.ppid, 0);
    } catch {
      signalable = false;
    }
    return parentProcessAlive({
      initialPpid: initialParentPid,
      currentPpid: process.ppid,
      signalable,
    });
  };
  const holdCycle = holdPathsProbe
    ? createHoldCycle({
        paths: holdPathsProbe,
        deliverSupplement: () => deliverOneSupplement(supplementDeps),
        parentAlive: partnerAlive,
        ...opts.holdWait,
      })
    : undefined;

  pi.on("tool_execution_end", async (event: ToolEndEventShape, ctx) => {
    // 父进程没了就别接着跑：孤儿 worker 会把活干完，而等结果的人早就不在了，
    // 白烧时间和额度。检查点只有工具结束这一个，够用。
    if (!partnerAlive()) {
      ctx.shutdown();
      return;
    }
    // 先处理暂存：预算见底时在这个检查点停下问一次，拿到补充再继续
    if (holdCycle) await holdCycle();
    if (hasInbox) await createSupplementToolEndHandler(supplementDeps)(event);
  });
  return true;
}

export default function (pi: ExtensionAPI): boolean {
  return registerSupplementBridge(pi);
}
