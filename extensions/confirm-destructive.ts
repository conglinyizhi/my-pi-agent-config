/**
 * 破坏性操作确认扩展
 *
 * 在执行破坏性会话操作（清空、切换、分叉）前请求确认。
 * 演示如何使用 before_* 事件取消会话事件。
 */

import type { ExtensionAPI, SessionBeforeSwitchEvent, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
    if (!ctx.hasUI) return;

    if (event.reason === "new") {
      const confirmed = await ctx.ui.confirm("清空会话？", "这会删除当前会话中的所有消息。");

      if (!confirmed) {
        ctx.ui.notify("已取消清空", "info");
        return { cancel: true };
      }
      return;
    }

    // reason === "resume"：检查是否存在未保存的工作（自上次 assistant 回复后的消息）
    const entries = ctx.sessionManager.getEntries();
    const hasUnsavedWork = entries.some((e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user");

    if (hasUnsavedWork) {
      const confirmed = await ctx.ui.confirm("切换会话？", "当前会话中还有消息。仍然要切换吗？");

      if (!confirmed) {
        ctx.ui.notify("已取消切换", "info");
        return { cancel: true };
      }
    }
  });

  pi.on("session_before_fork", async (event, ctx) => {
    if (!ctx.hasUI) return;

    const choice = await ctx.ui.select(`从条目 ${event.entryId.slice(0, 8)} 分叉？`, ["是，创建分叉", "否，留在当前会话"]);

    if (choice !== "是，创建分叉") {
      ctx.ui.notify("已取消分叉", "info");
      return { cancel: true };
    }
  });
}
