// for-grok-4-5：强大、实惠、但疯跑的孩子
//
// grok-4.5 两大顽疾的自动化处理：
//
//   习性一 · 只 thinking、不吐正文就停
//     判定：最后一条 assistant 无正文、无 toolCall、有非空 thinking（或 stopReason === "length"），
//     且 thinking 未表达「已完成 / 无需再追问」
//     动作：续写提示 + 警告通知，最多续 3 次
//
//   习性二 · 反复 true 空转不停
//     判定：连续两次 bash 且 command 去空白后严格等于 "true"
//     动作：第二次 true 正常执行后发「任务完成」通知，随后 abort 打断空转
//
// 两个习性独立判定、独立处理，互不干扰。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
  clearSuppressTaskComplete,
  getContinueAttempts,
  markSuppressTaskComplete,
  recordContinueAttempt,
  resetContinuationGuard,
  resetContinueAttempts,
} from "../../lib/continuation-guard";
import { isRetryableError } from "../../lib/error-utils";
import { notify, notifyTaskComplete } from "../../lib/notify-send";

// ===========================================================================
// 常量
// ===========================================================================

// ── 习性一：异常截断输出 ──

const MAX_CONTINUES = 3;
const CONTINUE_PROMPT =
  "你似乎没有说完，我没有看到你的发言就终止了任务，请在content区域输出一些文本让我知道这个任务完成详情；如果你重复看到了这条消息，请调用 bash 工具：";
const BASH_HIT = "echo job done already";
const WARNING_TITLE = "Pi Agent";
const WARNING_BODY = "大模型 API 出现了异常截断输出，自动进行重试";

// ── 习性二：bash true 空转 ──

const DONE_THRESHOLD = 2;
const DONE_SUMMARY = "任务处理完成（grok-4.5：连续 bash true 正常收工）";

// ===========================================================================
// 习性一：消息判定
// ===========================================================================

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
  if (!msg || msg.role !== "assistant") return false;

  const reason = msg.stopReason;
  if (reason === "aborted") return false;
  if (isRetryableError(msg)) return false;

  const parts = extractParts(msg);
  if (hasToolCall(parts)) return false;
  if (!bodyIsBlank(parts)) return false;

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

// ===========================================================================
// 习性二：bash true 判定
// ===========================================================================

export function isPureTrueCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return command.trim() === "true";
}

// ===========================================================================
// 扩展入口
// ===========================================================================

export default function forGrok45(pi: ExtensionAPI) {
  // ── 习性一 状态 ──
  let pendingContinue = false;
  let continueDispatched = false;

  function clearPendingUi(ctx: ExtensionContext) {
    if (ctx.hasUI) {
      ctx.ui.setStatus("for-grok-4-5", undefined);
    }
  }

  function armContinue(ctx: ExtensionContext) {
    pendingContinue = true;
    markSuppressTaskComplete();
    if (ctx.hasUI) {
      ctx.ui.setStatus("for-grok-4-5", "⚠ 异常截断输出，准备自动续跑…");
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

    void Promise.resolve(pi.sendUserMessage(CONTINUE_PROMPT + BASH_HIT, { deliverAs: "followUp" })).catch((err: unknown) => {
      clearSuppressTaskComplete();
      pendingContinue = false;
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx.hasUI) {
        ctx.ui.notify(`自动续跑失败: ${msg}`, "error");
      }
    });

    pendingContinue = false;
  }

  // ── 习性二 状态 ──
  let consecutivePureTrue = 0;
  let pendingDoneToolCallId: string | undefined;
  let doneNotified = false;

  function resetTrueStreak() {
    consecutivePureTrue = 0;
    pendingDoneToolCallId = undefined;
  }

  function resetTrueAll() {
    consecutivePureTrue = 0;
    pendingDoneToolCallId = undefined;
    doneNotified = false;
  }

  async function signalNormalComplete(ctx: ExtensionContext) {
    if (doneNotified) return;
    doneNotified = true;

    if (ctx.hasUI) {
      ctx.ui.notify(DONE_SUMMARY, "info");
      ctx.ui.setStatus("for-grok-4-5", "✓ 正常完成（grok true×2）");
      setTimeout(() => {
        try {
          ctx.ui.setStatus("for-grok-4-5", undefined);
        } catch {
          // session 可能已切换
        }
      }, 4000);
    }

    try {
      await notifyTaskComplete(DONE_SUMMARY);
    } catch {
      // 桌面通知失败不影响收工
    }

    setTimeout(() => {
      try {
        ctx.abort();
      } catch {
        // ignore
      }
    }, 0);
  }

  // =========================================================================
  // 生命周期（两个习性共享）
  // =========================================================================

  pi.on("session_start", () => {
    pendingContinue = false;
    continueDispatched = false;
    resetContinuationGuard();
    resetTrueAll();
  });

  pi.on("input", (event) => {
    if (event.source !== "extension") {
      resetContinueAttempts();
      resetTrueAll();
    }
    return { action: "continue" as const };
  });

  // =========================================================================
  // 习性一：message_end / agent_end
  // =========================================================================

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const msg = event.message as AssistantLike;
    if (isThinkingOnlyEmptyBody(msg)) {
      armContinue(ctx);
      return;
    }

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

  pi.on("agent_end", (event, ctx) => {
    // ── 习性一：续跑 dispatch ──
    continueDispatched = false;

    if (pendingContinue) {
      dispatchContinue(ctx);
    } else {
      const last = findLastAssistant(event.messages ?? []);
      if (isThinkingOnlyEmptyBody(last)) {
        armContinue(ctx);
        dispatchContinue(ctx);
      }
    }

    // ── 习性二：兜底收工（true 计数已满但 tool_result 未对上） ──
    if (!doneNotified && consecutivePureTrue >= DONE_THRESHOLD) {
      void signalNormalComplete(ctx);
    }
  });

  // =========================================================================
  // 习性二：tool_call / tool_result
  // =========================================================================

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("bash", event)) {
      if (consecutivePureTrue > 0) resetTrueStreak();
      return;
    }

    const cmd = event.input.command as string;

    // 习性二 · 快速通道：bash 输出包含 BASH_HIT → 即刻收工
    if (typeof cmd === "string" && cmd.includes(BASH_HIT)) {
      pendingDoneToolCallId = event.toolCallId;
      if (ctx.hasUI) {
        ctx.ui.setStatus("for-grok-4-5", "grok 主动报告完成…");
      }
      return;
    }

    if (!isPureTrueCommand(cmd)) {
      if (consecutivePureTrue > 0) resetTrueStreak();
      return;
    }

    consecutivePureTrue += 1;

    if (ctx.hasUI && consecutivePureTrue === 1) {
      ctx.ui.setStatus("for-grok-4-5", "grok 收工信号 1/2…");
    }

    if (consecutivePureTrue >= DONE_THRESHOLD) {
      pendingDoneToolCallId = event.toolCallId;
      if (ctx.hasUI) {
        ctx.ui.setStatus("for-grok-4-5", "grok 收工信号 2/2…");
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!pendingDoneToolCallId || event.toolCallId !== pendingDoneToolCallId) {
      return;
    }

    pendingDoneToolCallId = undefined;
    await signalNormalComplete(ctx);
  });
}
