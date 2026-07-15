// grok-4.5 完成信号：连续两次「仅」bash true 且无其他指令 → 视为任务正常完成
//
// 背景：grok-4.5 收工时常反复 toolCall bash command=true，既不给正文也不停。
// 这是模型侧行为，应用侧开发者无法改模型，只能识别并当作正常完成。
//
// 规则：
//   - bash 且 command 去空白后严格等于 "true" → 连续计数 +1
//   - 任何其他工具 / 非 pure-true 的 bash → 计数清零
//   - 计数达到 2：视为正常完成（非错误）
//       · 第二次 true 照常执行（exit 0，不 block，避免 UI 像报错）
//       · tool_result 成功后发「任务完成」通知
//       · 再 abort，打断后续 true 空转（无可奈何的适配，不是判定出错）
//
// 标注：grok-4.5 特性

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { notifyTaskComplete } from "../../lib/notify-send";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 连续几次 pure true 视为完成 */
const DONE_THRESHOLD = 2;

/** 正常完成文案：强调是模型完成信号，不是环节出错 */
const DONE_SUMMARY = "任务处理完成（grok-4.5：连续 bash true 正常收工）";

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** command 去空白后是否严格为 true（无其它指令） */
export function isPureTrueCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return command.trim() === "true";
}

// ---------------------------------------------------------------------------
// 扩展
// ---------------------------------------------------------------------------

export default function bashTrueDone(pi: ExtensionAPI) {
  /** 连续 pure true 次数（跨 turn 累计，遇其它工具清零） */
  let consecutivePureTrue = 0;
  /** 已达阈值、等待本次 true 的 tool_result 后收工 */
  let pendingDoneToolCallId: string | undefined;
  /** 本轮已发过完成通知，避免重复 */
  let doneNotified = false;

  function resetStreak() {
    consecutivePureTrue = 0;
    pendingDoneToolCallId = undefined;
  }

  function resetAll() {
    consecutivePureTrue = 0;
    pendingDoneToolCallId = undefined;
    doneNotified = false;
  }

  async function signalNormalComplete(ctx: ExtensionContext) {
    if (doneNotified) return;
    doneNotified = true;

    if (ctx.hasUI) {
      ctx.ui.notify(DONE_SUMMARY, "info");
      ctx.ui.setStatus("bash-true-done", "✓ 正常完成（grok true×2）");
      setTimeout(() => {
        try {
          ctx.ui.setStatus("bash-true-done", undefined);
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

    // 模型还会继续 true 空转：只能 abort 打断。
    // stopReason 会变成 aborted，但语义上是我们主动正常收工，不是用户取消/出错。
    // task-notification 对 aborted 不发「任务完成」，因此上面已自行 notifyTaskComplete。
    setTimeout(() => {
      try {
        ctx.abort();
      } catch {
        // ignore
      }
    }, 0);
  }

  pi.on("session_start", () => {
    resetAll();
  });

  // 用户新输入：新任务
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      resetAll();
    }
    return { action: "continue" as const };
  });

  // 不在 agent_end 清零：true → agent_end → 又 true 是正常轨迹

  pi.on("tool_call", (event, ctx) => {
    // 非 bash → 打断连续 true
    if (!isToolCallEventType("bash", event)) {
      if (consecutivePureTrue > 0) resetStreak();
      return;
    }

    if (!isPureTrueCommand(event.input.command)) {
      if (consecutivePureTrue > 0) resetStreak();
      return;
    }

    // pure true：放行执行（包括第 2 次），不 block —— 这是正常收工路径
    consecutivePureTrue += 1;

    if (ctx.hasUI && consecutivePureTrue === 1) {
      ctx.ui.setStatus("bash-true-done", "grok 收工信号 1/2…");
    }

    if (consecutivePureTrue >= DONE_THRESHOLD) {
      // 等本条 true 跑完再通知 + abort
      pendingDoneToolCallId = event.toolCallId;
      if (ctx.hasUI) {
        ctx.ui.setStatus("bash-true-done", "grok 收工信号 2/2…");
      }
    }

    // 明确不 return block
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!pendingDoneToolCallId || event.toolCallId !== pendingDoneToolCallId) {
      return;
    }

    // 本次 true 已结束（无论 isError；pure true 几乎不会失败）
    pendingDoneToolCallId = undefined;
    await signalNormalComplete(ctx);
  });

  // 兜底：若 tool_result 未对上 id（少见），agent_end 时计数已满也收工
  pi.on("agent_end", async (_event, ctx) => {
    if (doneNotified) return;
    if (consecutivePureTrue >= DONE_THRESHOLD) {
      await signalNormalComplete(ctx);
    }
  });
}
