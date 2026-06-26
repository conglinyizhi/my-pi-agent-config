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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRetryableError } from "../lib/error-utils";
import { findLastAssistant, summarizeLastAssistantMessage } from "../lib/message-utils";
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


