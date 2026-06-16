/**
 * 任务通知扩展
 *
 * 当用户的任务完全处理完成时发送桌面通知。
 * 监听 agent_end 事件，在整个 agent 会话/任务循环结束时通知用户一次。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkNotificationSupport, notifyTaskComplete } from "../lib/notify-send";

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

  // 监听 agent_end 事件：当整个 agent 任务循环结束时触发，只发送一次通知
  pi.on("agent_end", async (event, ctx) => {
    // 通知不可用时直接跳过，避免无谓的失败重试
    if (!notificationReady) return;
    // 仅在有 UI 的情况下发送通知（避免在非交互模式下干扰）
    if (!ctx.hasUI) return;

    try {
      const summary = summarizeLastAssistantMessage(event.messages);
      await notifyTaskComplete(summary);
    } catch (error) {
      console.warn("发送任务完成通知失败:", error);
    }
  });
}

/**
 * 从消息列表中提取最后一条 assistant 文本消息作为任务摘要
 */
function summarizeLastAssistantMessage(messages: AgentMessage[]): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");

  if (!lastAssistant) {
    return "任务处理完成";
  }

  const textParts = lastAssistant.content.filter((content) => content.type === "text");
  if (textParts.length === 0) {
    return "任务处理完成";
  }

  const fullText = textParts.map((content) => content.text).join(" ");
  // 截取前 100 个字符作为摘要
  return fullText.length > 100 ? `${fullText.slice(0, 100)}...` : fullText;
}
