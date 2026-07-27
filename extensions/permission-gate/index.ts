/**
 * 权限闸门扩展
 *
 * 在执行潜在危险的 bash 命令前请求确认。
 * 检查模式：rm -rf、sudo、chmod/chown 777
 * 同时发送桌面通知提醒用户。
 *
 * 安全模式白名单：某些命令组合虽然包含危险关键词，但实际是安全的
 * （例如 cd /tmp && rm -rf foo && mkdir foo 是标准临时目录重建流程），
 * 由 safe-patterns.ts 中的处理器负责识别并放行。
 *
 * 架构见 README.md。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkNotificationSupport, notifyQuestion } from "../../lib/notify-send";
import { isCommandSafe, getDangerousTip, isAutoReject } from "./helpers";

export default async function (pi: ExtensionAPI) {
  const support = await checkNotificationSupport();
  const notificationReady = support.supported;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    // 安全模式白名单放行
    if (isCommandSafe(command)) return undefined;

    // 自动拒绝模式（不弹窗，直接拦）
    if (isAutoReject(command)) {
      const tip = getDangerousTip(command);
      return { block: true, reason: `自动拒绝：${tip}` };
    }

    // 无 UI 则直接阻止
    if (!ctx.hasUI) {
      const tip = getDangerousTip(command);
      const reason = tip
        ? `危险命令已阻止：${tip}`
        : "危险命令已阻止（没有可用于确认的 UI）";
      return { block: true, reason };
    }

    // 桌面通知
    if (notificationReady) {
      notifyQuestion(
        `危险命令请求确认：${command.slice(0, 80)}${command.length > 80 ? "..." : ""}`
      ).catch(() => {});
    }

    // 用户确认
    const choice = await ctx.ui.select(
      `⚠️ 危险命令：\n\n  ${command}\n\n是否允许？`,
      ["Yes", "No"]
    );

    if (choice !== "Yes") {
      return { block: true, reason: "已被用户阻止" };
    }

    return undefined;
  });
}
