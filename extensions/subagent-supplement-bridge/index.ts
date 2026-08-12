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
import {
  claimNextSupplement,
  encodeSupplementMessage,
  isValidInboxId,
} from "../../lib/subagent-supplement.ts";

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

/** 工厂依赖：inboxId + claim + send 全部可注入。 */
export interface SupplementBridgeDeps {
  inboxId: string;
  claim: (inboxId: string) => Promise<SupplementClaimResult>;
  send: (encoded: string, options: { deliverAs: "steer" }) => void;
}

/**
 * 返回 tool_execution_end handler：不看 isError，成功/失败完成都 claim 一条；
 * claimed null 不发；claimed 存在则编码后以 steer 投递。
 */
export function createSupplementToolEndHandler(
  deps: SupplementBridgeDeps,
): (event: ToolEndEventShape) => Promise<void> {
  return async (_event: ToolEndEventShape): Promise<void> => {
    const { claimed } = await deps.claim(deps.inboxId);
    if (!claimed) return;
    deps.send(encodeSupplementMessage(claimed.id, claimed.text), { deliverAs: "steer" });
  };
}

/** 注册选项：可覆盖 inboxId / claim / send（测试注入；默认用真实实现）。 */
export interface SupplementBridgeOptions {
  inboxId?: string;
  claim?: (inboxId: string) => Promise<SupplementClaimResult>;
  send?: (encoded: string, options: { deliverAs: "steer" }) => void;
}

/**
 * 向 ExtensionAPI 注册 supplement 桥接 handler。inboxId 无效时返回 false
 * 且不注册 handler、不抛。返回是否已注册。
 */
export function registerSupplementBridge(
  pi: ExtensionAPI,
  opts: SupplementBridgeOptions = {},
): boolean {
  const inboxId = opts.inboxId ?? process.env.PI_SUBAGENT_INBOX ?? "";
  if (!isValidInboxId(inboxId)) return false; // 无有效 inbox：静默禁用
  const claim = opts.claim ?? ((id: string) => claimNextSupplement(id));
  const send = opts.send ?? ((encoded: string) => pi.sendUserMessage(encoded, { deliverAs: "steer" }));
  pi.on("tool_execution_end", createSupplementToolEndHandler({ inboxId, claim, send }));
  return true;
}

export default function (pi: ExtensionAPI): boolean {
  return registerSupplementBridge(pi);
}
