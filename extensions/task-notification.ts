/**
 * 任务通知扩展
 *
 * 当用户的任务完全处理完成时发送桌面通知。
 * 监听 agent_end 事件，在整个 agent 会话/任务循环结束时通知用户一次。
 *
 * - 用户手动取消（stopReason === "aborted"）→ 不通知
 * - 网络错误但 agent 会重试 → 延迟通知，如果 agent 恢复则取消
 * - 网络错误导致对话终止 → 发通知
 * - 正常完成 → 发通知
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkNotificationSupport, notifyTaskComplete } from "../lib/notify-send";

// 匹配可重试的网络/连接错误
const RETRYABLE_ERROR_RE = /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

export default async function taskNotification(pi: ExtensionAPI) {
  // 初始化时检查通知指令是否可用，不满足时提示用户如何安装
  const support = await checkNotificationSupport();
  const notificationReady = support.supported;

  if (!support.supported) {
    const missingDesc = support.missing.length > 0 ? support.missing.join(", ") : "无可用通知工具";
    const unavailableHint = `桌面通知不可用（${support.os}，缺失: ${missingDesc}）。请在终端查看安装提示。`;
    console.warn(`[task-notification] ${unavailableHint}\n${support.installHint}`);

    // 在 TUI 中也提示一次（终端已有详细安装指引）
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(unavailableHint, "warning");
    });
  }

  let deferredTimer: ReturnType<typeof setTimeout> | undefined;
  let deferredSummary = "";

  /** 取消延迟通知 */
  function cancelDeferred() {
    if (deferredTimer !== undefined) {
      clearTimeout(deferredTimer);
      deferredTimer = undefined;
      deferredSummary = "";
    }
  }

  /** 发送通知（摘要） */
  async function sendNotification(messages: AgentMessage[]) {
    if (!notificationReady) return;
    try {
      const summary = summarizeLastAssistantMessage(messages);
      await notifyTaskComplete(summary);
    } catch (error) {
      console.warn("发送任务完成通知失败:", error);
    }
  }

  /** 判断是否为可重试的网络错误（agent 可能自动恢复） */
  function isRetryableError(msg: AgentMessage): boolean {
    if (msg.role !== "assistant") return false;
    const assistant = msg as AgentMessage & { stopReason?: string; errorMessage?: string };
    return assistant.stopReason === "error" &&
      typeof assistant.errorMessage === "string" &&
      RETRYABLE_ERROR_RE.test(assistant.errorMessage);
  }

  // 监听 agent_start：agent 开始新一轮（包括重试）→ 取消延迟通知
  pi.on("agent_start", () => {
    cancelDeferred();
  });

  // 监听 agent_end
  pi.on("agent_end", async (event, ctx) => {
    // 通知不可用时直接跳过
    if (!notificationReady) return;
    // 仅在有 UI 的情况下发送通知
    if (!ctx.hasUI) return;

    const lastAssistant = findLastAssistant(event.messages);

    // 没有 assistant 消息 → 正常通知
    if (!lastAssistant) {
      await sendNotification(event.messages);
      return;
    }

    const assistant = lastAssistant as AgentMessage & { stopReason?: string };
    const reason = assistant.stopReason;

    // 用户手动取消 → 不通知
    if (reason === "aborted") {
      cancelDeferred();
      return;
    }

    // 可重试的网络错误 → 延迟通知（agent 可能正在重试）
    if (isRetryableError(lastAssistant)) {
      deferredSummary = summarizeLastAssistantMessage(event.messages);
      // 3 秒后如果 agent 没有恢复（未触发 agent_start），说明对话终止
      deferredTimer = setTimeout(async () => {
        if (deferredSummary) {
          try {
            await notifyTaskComplete(deferredSummary);
          } catch (error) {
            console.warn("发送任务完成通知失败:", error);
          }
        }
        deferredTimer = undefined;
        deferredSummary = "";
      }, 3000);
      return;
    }

    // 其他情况（正常完成、不可重试错误等）→ 发通知
    cancelDeferred();
    await sendNotification(event.messages);
  });
}

/** 查找最后一条 assistant 消息 */
function findLastAssistant(messages: AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return undefined;
}

/**
 * 从消息列表中提取最后一条 assistant 文本消息作为任务摘要
 */
function summarizeLastAssistantMessage(messages: AgentMessage[]): string {
  type ContentPart = { type: string; text?: string };

  const lastAssistant = findLastAssistant(messages);
  if (!lastAssistant) {
    return "任务处理完成";
  }

  const assistant = lastAssistant as AgentMessage & { content?: ContentPart[] };
  if (!assistant.content) {
    return "任务处理完成";
  }

  const textParts = assistant.content.filter((part: ContentPart) => part.type === "text");
  if (textParts.length === 0) {
    return "任务处理完成";
  }

  const fullText = textParts.map((part: ContentPart) => part.text ?? "").join(" ");
  // 截取前 100 个字符作为摘要
  return fullText.length > 100 ? `${fullText.slice(0, 100)}...` : fullText;
}
