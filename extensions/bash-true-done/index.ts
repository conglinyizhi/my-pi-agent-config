// grok-4.5 完成信号：连续两次「仅」bash true 且无其他指令 → 视为任务正常完成
//
// 背景：grok-4.5 经常在干完活后反复 toolCall bash command=true 空转，
// 既不给正文也不停。连续两次 pure `true` 可当作「我做完了」。
//
// 规则：
//   - bash 且 command 去空白后严格等于 "true" → 连续计数 +1
//   - 任何其他工具 / 非 pure-true 的 bash → 计数清零
//   - 计数达到 2：发任务完成通知、TUI 提示，block 本次 true 并 abort agent
//
// 标注：grok-4.5 特性（逻辑不限模型，文案标明来源）

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { notifyTaskComplete } from "../../lib/notify-send";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 连续几次 pure true 视为完成 */
const DONE_THRESHOLD = 2;

const DONE_SUMMARY = "任务处理完成（grok-4.5 完成信号：连续 bash true）";
const BLOCK_REASON =
  "已连续两次仅调用 bash true，判定任务完成（grok-4.5 特性），已中止后续空转";

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
  /** 本会话是否已因完成信号中止过一轮（避免重复刷通知） */
  let justSignaledDone = false;

  function resetStreak() {
    consecutivePureTrue = 0;
  }

  function resetAll() {
    consecutivePureTrue = 0;
    justSignaledDone = false;
  }

  async function signalDone(ctx: ExtensionContext) {
    justSignaledDone = true;

    if (ctx.hasUI) {
      ctx.ui.notify(DONE_SUMMARY, "info");
      ctx.ui.setStatus("bash-true-done", "✓ grok 完成信号");
      // 状态栏短暂展示后清掉
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
      // 桌面通知失败不影响中止
    }

    // 中止当前 agent，避免再开下一轮 true
    // 延迟到 tool_call 处理返回后，让 block 结果先落盘
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

  // 用户新输入：新任务，清计数（extension 注入的续跑提示也清——完成信号与续跑无关）
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      resetAll();
    }
    return { action: "continue" as const };
  });

  // agent 正常结束（非我们 abort）时，若没有再 true，可保留计数或清零：
  // 清零更安全，避免跨任务误判；但 grok 的 true 往往跨多个 agent_end。
  // 真实轨迹是：true → agent_end → 又 true… 所以不能在 agent_end 清零。
  // 仅在用户输入 / 非 true 工具时清零。

  pi.on("tool_call", async (event, ctx) => {
    // 非 bash → 打断连续 true
    if (!isToolCallEventType("bash", event)) {
      if (consecutivePureTrue > 0) {
        resetStreak();
      }
      justSignaledDone = false;
      return;
    }

    const command = event.input.command;

    if (!isPureTrueCommand(command)) {
      if (consecutivePureTrue > 0) {
        resetStreak();
      }
      justSignaledDone = false;
      return;
    }

    // pure true
    consecutivePureTrue += 1;

    if (ctx.hasUI && consecutivePureTrue === 1) {
      ctx.ui.setStatus("bash-true-done", "grok 完成信号 1/2…");
    }

    if (consecutivePureTrue < DONE_THRESHOLD) {
      return; // 放行第一次 true
    }

    // ── 达到阈值：完成 ──
    if (!justSignaledDone) {
      await signalDone(ctx);
    } else {
      // 已 signal 过仍又来 true（abort 竞态）→ 直接 block + 再 abort
      setTimeout(() => {
        try {
          ctx.abort();
        } catch {
          // ignore
        }
      }, 0);
    }

    return {
      block: true,
      reason: BLOCK_REASON,
    };
  });
}
