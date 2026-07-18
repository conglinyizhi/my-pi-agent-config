// 思维链异常截断输出自动续跑：仅 thinking、无可见正文时自动发送续写提示并警告通知
//
// 判定（最后一条 assistant）：
//   - 去掉空白后 type=text 正文长度为 0
//   - 无 toolCall
//   - 有非空 thinking，或 stopReason 为 length（截断）
//   - stopReason 不是 aborted；可重试 error 交给 pi 内置重试
//   - thinking 未表达「已完成 / 无需再追问」（见 isThinkingDoneIntention）
//
// 动作：
//   1. 标记 continuation-guard，让 task-notification 跳过「任务完成」
//   2. 桌面 + TUI 警告：大模型 API 出现了异常截断输出，自动进行重试
//   3. sendUserMessage(..., { deliverAs: "followUp" }) 排队续写
//      agent_end 监听器结算前 isStreaming 仍为 true，必须带 deliverAs，
//      否则会抛 Agent is already processing
//
// 连续异常截断输出最多续 MAX_CONTINUES 次，防止死循环。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clearSuppressTaskComplete,
  getContinueAttempts,
  markSuppressTaskComplete,
  recordContinueAttempt,
  resetContinuationGuard,
  resetContinueAttempts,
} from "../../lib/continuation-guard";
import { isRetryableError } from "../../lib/error-utils";
import { notify } from "../../lib/notify-send";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MAX_CONTINUES = 3;
const CONTINUE_PROMPT = "你似乎没有说完，我没有看到你的发言就终止了任务，请在content区域输出一些文本让我知道这个任务完成详情";
const WARNING_TITLE = "Pi Agent";
const WARNING_BODY = "大模型 API 出现了异常截断输出，自动进行重试";

// ---------------------------------------------------------------------------
// 消息判定
// ---------------------------------------------------------------------------

interface ContentPart {
  type: string;
  text?: string;
  thinking?: string;
}

interface AssistantLike {
  role: string;
  content?: ContentPart[] | string;
  stopReason?: string;
  errorMessage?: string;
}

function extractParts(msg: AssistantLike): ContentPart[] {
  if (!msg.content) return [];
  if (typeof msg.content === "string") {
    return msg.content ? [{ type: "text", text: msg.content }] : [];
  }
  return msg.content;
}

/** 正文去掉空白后是否一个字都没有 */
function bodyIsBlank(parts: ContentPart[]): boolean {
  let body = "";
  for (const p of parts) {
    if (p.type === "text" && typeof p.text === "string") {
      body += p.text;
    }
  }
  return body.replace(/\s+/g, "").length === 0;
}

function hasNonEmptyThinking(parts: ContentPart[]): boolean {
  return parts.some((p) => p.type === "thinking" && typeof p.thinking === "string" && p.thinking.replace(/\s+/g, "").length > 0);
}

function hasToolCall(parts: ContentPart[]): boolean {
  return parts.some((p) => p.type === "toolCall");
}

/** 拼接全部 thinking 文本 */
function getThinkingText(parts: ContentPart[]): string {
  let text = "";
  for (const p of parts) {
    if (p.type === "thinking" && typeof p.thinking === "string") {
      text += p.thinking;
    }
  }
  return text;
}

/**
 * thinking 是否已表达「任务完成、无需再追问」
 * - 同时包含「完成」与「简单回复」（与逻辑）
 * - 或包含「不要再调用工具」
 */
export function isThinkingDoneIntention(thinking: string): boolean {
  if (!thinking) return false;
  if (thinking.includes("不要再调用工具")) return true;
  return thinking.includes("完成") && thinking.includes("简单回复");
}

/**
 * 是否「仅思维链 / 截断导致无正文」需要自动续跑
 */
export function isThinkingOnlyEmptyBody(msg: AssistantLike | undefined | null): boolean {
  if (msg?.role !== "assistant") return false;

  const reason = msg.stopReason;
  if (reason === "aborted") return false;
  if (isRetryableError(msg)) return false;

  const parts = extractParts(msg);
  if (hasToolCall(parts)) return false;
  if (!bodyIsBlank(parts)) return false;

  // 思维链已表明「做完了 / 不要再追问」→ 视为正常收工，不自动续跑
  if (isThinkingDoneIntention(getThinkingText(parts))) return false;

  if (hasNonEmptyThinking(parts)) return true;
  if (reason === "length") return true;

  return false;
}

function findLastAssistant(messages: unknown[]): AssistantLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AssistantLike | undefined;
    if (m?.role === "assistant") return m;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 扩展
// ---------------------------------------------------------------------------

export default function thinkingOnlyContinue(pi: ExtensionAPI) {
  /** message_end 已判定需要续跑 */
  let pendingContinue = false;
  /** 同一 agent_end 周期内只 dispatch 一次 */
  let continueDispatched = false;

  function clearPendingUi(ctx: ExtensionContext) {
    if (ctx.hasUI) {
      ctx.ui.setStatus("thinking-only-continue", undefined);
    }
  }

  function armContinue(ctx: ExtensionContext) {
    pendingContinue = true;
    // message_end 早于 agent_end：先于 task-notification 压制「任务完成」
    markSuppressTaskComplete();
    if (ctx.hasUI) {
      ctx.ui.setStatus("thinking-only-continue", "⚠ 异常截断输出，准备自动续跑…");
    }
  }

  async function fireWarning(ctx: ExtensionContext, attempt: number) {
    const detail = `${WARNING_BODY}（第 ${attempt}/${MAX_CONTINUES} 次）`;
    if (ctx.hasUI) {
      ctx.ui.notify(detail, "warning");
    }
    try {
      await notify(WARNING_TITLE, detail, {
        urgency: "critical",
        timeout: 15_000,
        sound: true,
      });
    } catch {
      // 桌面通知失败不影响续跑
    }
  }

  function dispatchContinue(ctx: ExtensionContext) {
    if (continueDispatched) return;
    continueDispatched = true;

    const attempt = recordContinueAttempt();
    if (attempt > MAX_CONTINUES) {
      clearSuppressTaskComplete();
      pendingContinue = false;
      clearPendingUi(ctx);
      resetContinueAttempts();
      if (ctx.hasUI) {
        ctx.ui.notify(`异常截断输出自动续跑已达上限（${MAX_CONTINUES} 次），请手动处理`, "error");
      }
      void notify(WARNING_TITLE, `异常截断输出自动续跑已达上限（${MAX_CONTINUES} 次）`, {
        urgency: "critical",
        timeout: 20_000,
      });
      return;
    }

    void fireWarning(ctx, attempt);
    clearPendingUi(ctx);

    // agent_end 监听器仍在运行时 isStreaming===true（核心约定：
    // agent 要等 awaited agent_end 监听器全部 settle 后才 idle）。
    // 无 deliverAs 会同步/异步抛：
    //   Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')
    // 续写应在本轮结束后再开新 turn → followUp，而不是 steer 打断当前收尾。
    // 注意：pi.sendUserMessage 实际返回 Promise，必须按异步处理，
    // 不能靠同步 try/catch 兜底（否则变成 unhandled rejection → Extension "<runtime>"）。
    void Promise.resolve(pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" })).catch((err: unknown) => {
      clearSuppressTaskComplete();
      pendingContinue = false;
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx.hasUI) {
        ctx.ui.notify(`自动续跑失败: ${msg}`, "error");
      }
    });

    pendingContinue = false;
  }

  // ── 会话生命周期 ──

  pi.on("session_start", () => {
    pendingContinue = false;
    continueDispatched = false;
    resetContinuationGuard();
  });

  pi.on("input", (event) => {
    // 用户真实输入：重置连续计数（extension 注入的续跑提示不重置）
    if (event.source !== "extension") {
      resetContinueAttempts();
    }
    return { action: "continue" as const };
  });

  // ── 比 agent_end 更早 mark，保证 task-notification 能读到 suppress ──

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const msg = event.message as AssistantLike;
    if (isThinkingOnlyEmptyBody(msg)) {
      armContinue(ctx);
      return;
    }

    // 有正文或工具调用 → 正常/续跑成功
    const parts = extractParts(msg);
    if (!bodyIsBlank(parts) || hasToolCall(parts)) {
      if (getContinueAttempts() > 0) {
        resetContinueAttempts();
      }
      pendingContinue = false;
      continueDispatched = false;
      clearSuppressTaskComplete();
      clearPendingUi(ctx);
    }
  });

  // ── 回合结束：执行续跑 ──

  pi.on("agent_end", (event, ctx) => {
    continueDispatched = false;

    // 主路径：message_end 已 arm
    if (pendingContinue) {
      dispatchContinue(ctx);
      return;
    }

    // 兜底：用本 run 最后一条 assistant 再判一次
    const last = findLastAssistant(event.messages ?? []);
    if (isThinkingOnlyEmptyBody(last)) {
      armContinue(ctx);
      dispatchContinue(ctx);
    }
  });
}
