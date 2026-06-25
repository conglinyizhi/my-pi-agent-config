/**
 * 权限闸门扩展
 *
 * 在执行潜在危险的 bash 命令前请求确认。
 * 检查模式：rm -rf、sudo、chmod/chown 777
 * 同时发送桌面通知提醒用户
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkNotificationSupport, notifyQuestion } from "../lib/notify-send";

export default async function (pi: ExtensionAPI) {
  const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

  // 初始化时检查通知是否可用
  const support = await checkNotificationSupport();
  const notificationReady = support.supported;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;
    const isDangerous = dangerousPatterns.some((p) => p.test(command));

    if (isDangerous) {
      if (!ctx.hasUI) {
        // 在非交互模式下默认阻止
        return { block: true, reason: "危险命令已阻止（没有可用于确认的 UI）" };
      }

      // 发送桌面通知提醒用户
      if (notificationReady) {
        notifyQuestion(`危险命令请求确认：${command.slice(0, 80)}${command.length > 80 ? "..." : ""}`).catch(() => {});
      }

      const choice = await ctx.ui.select(`⚠️ 危险命令：\n\n  ${command}\n\n是否允许？`, ["Yes", "No"]);

      if (choice !== "Yes") {
        return { block: true, reason: "已被用户阻止" };
      }
    }

    return undefined;
  });
}
