// 任务完成桌面通知（详见 README.md）

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shouldSuppressTaskComplete } from "../../lib/continuation-guard";
import { isRetryableError } from "../../lib/error-utils";
import { findLastAssistant, summarizeLastAssistantMessage } from "../../lib/message-utils";
import { checkNotificationSupport, notifyBrief, notifyTaskComplete, testNotificationSound } from "../../lib/notify-send";

export default async function taskNotification(pi: ExtensionAPI) {
  // 初始化时检查通知指令是否可用，不满足时提示用户如何安装
  const support = await checkNotificationSupport();
  const notificationReady = support.supported;

  if (!support.supported) {
    const missingDesc = support.missing.length > 0 ? support.missing.join(", ") : "无可用通知工具";
    const unavailableHint = `桌面通知不可用（${support.os}，缺失: ${missingDesc}）。请在终端查看安装提示。`;

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
    } catch {
      // 通知发送失败不影响主流程
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

    // 异常截断输出自动续跑中：不发「任务完成」，改由 for-grok-4-5 发警告
    if (shouldSuppressTaskComplete()) {
      cancelDeferred();
      return;
    }

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
        // 延迟窗口内若已进入异常截断输出续跑，同样抑制
        if (shouldSuppressTaskComplete()) {
          deferredTimer = undefined;
          deferredSummary = "";
          return;
        }
        if (deferredSummary) {
          try {
            await notifyBrief(deferredSummary);
          } catch {
            // 通知发送失败不影响主流程
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

  // ============================================================
  // /notify-sound-test —— 测试通知音效播放
  // ============================================================
  pi.registerCommand("notify-sound-test", {
    description: "测试通知音效播放是否正常",
    handler: async (_args, ctx) => {
      if (!notificationReady) {
        ctx.ui.notify("通知系统不可用，无法测试音效", "warning");
        return;
      }
      ctx.ui.notify("正在测试通知音效…", "info");
      const result = await testNotificationSound();
      if (result.success) {
        ctx.ui.notify(`✅ 通知音效测试成功 (${result.method})`, "info");
      } else {
        ctx.ui.notify(`❌ 通知音效测试失败: ${result.error || "未知原因"}`, "error");
      }
    },
  });
}


