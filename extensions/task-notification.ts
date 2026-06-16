/**
 * 任务通知扩展
 *
 * 当用户的任务完全处理完成时发送桌面通知。
 * 监听 turn_end 事件，在每个 agent 回复轮次结束时通知用户。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkNotificationSupport, notify, notifyTaskComplete } from "../lib/notify-send";

export default async function taskNotification(pi: ExtensionAPI) {
  // 初始化时检查通知指令是否可用，不满足时提示用户如何安装
  const support = await checkNotificationSupport();
  let notificationReady = support.supported;

  if (!support.supported) {
    const missingDesc = support.missing.length > 0 ? support.missing.join(", ") : "无可用通知工具";
    console.warn(
      `[task-notification] 桌面通知不可用（${support.os}，缺失: ${missingDesc}）。\n${support.installHint}`,
    );
  }

  // 监听 session_start：在 TUI 中提示用户（若不可用）
  pi.on("session_start", async (_event, ctx) => {
    if (notificationReady) return;
    if (!ctx.hasUI) return;
    const missingDesc = support.missing.length > 0 ? support.missing.join(", ") : "无可用通知工具";
    ctx.ui.notify(
      `桌面通知不可用（${support.os}，缺失: ${missingDesc}）。请在终端查看安装提示。`,
      "warning",
    );
  });

  // 监听 turn_end 事件：当 agent 完成一轮回复时触发
  pi.on("turn_end", async (event, ctx) => {
    // 通知不可用时直接跳过，避免无谓的失败重试
    if (!notificationReady) return;
    // 仅在有 UI 的情况下发送通知（避免在非交互模式下干扰）
    if (!ctx.hasUI) return;

    try {
      const message = event.message;

      // 从消息中提取摘要信息
      let summary = "任务处理完成";

      if (message.type === "assistant" && message.content) {
        // 尝试从 assistant 消息中提取文本摘要
        const textParts = message.content.filter((c: { type: string }) => c.type === "text");
        if (textParts.length > 0) {
          const fullText = textParts.map((c: { text: string }) => c.text).join(" ");
          // 截取前 100 个字符作为摘要
          summary = fullText.length > 100 ? `${fullText.slice(0, 100)}...` : fullText;
        }
      }

      // 检查是否有工具调用结果
      const toolResults = event.toolResults || [];
      if (toolResults.length > 0) {
        const toolNames = toolResults
          .map((r: { toolName?: string }) => r.toolName || "unknown")
          .filter((name: string, index: number, arr: string[]) => arr.indexOf(name) === index);
        summary += ` (使用了工具: ${toolNames.join(", ")})`;
      }

      await notifyTaskComplete(summary);
    } catch (error) {
      console.warn("发送任务完成通知失败:", error);
    }
  });

  // 监听 agent_end 事件：当整个 agent 会话结束时触发
  pi.on("agent_end", async (event, ctx) => {
    if (!notificationReady) return;
    if (!ctx.hasUI) return;

    try {
      const messageCount = event.messages.length;
      await notify("Pi Agent", `会话结束，共处理 ${messageCount} 条消息`, {
        urgency: "low",
      });
    } catch (error) {
      console.warn("发送会话结束通知失败:", error);
    }
  });
}
