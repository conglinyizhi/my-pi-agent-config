/**
 * 流式状态监视器
 *
 * - 显示当前 token 流入速度（tok/s）
 * - 工具执行时显示运行时长
 * - 自定义工作指示器，直观判断是否卡死
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 状态
  let sessionCtx: any = null;
  let streaming = false;
  let toolRunning = false;
  let toolName = "";
  let toolStart = 0;

  // 流速计算
  let streamStart = 0;
  let charCount = 0;
  // 滚动窗口：每秒的快照，用于平滑速度计算
  let speedHistory: { time: number; chars: number }[] = [];

  // 定时器
  let statusTimer: ReturnType<typeof setInterval> | null = null;

  const STATUS_KEY = "stream-monitor";
  const TOOL_STATUS_KEY = "stream-monitor-tool";

  /** 估算 token 数（中英文混合粗略估算：4 字符 ≈ 1 token） */
  function estimateTokens(chars: number): number {
    return Math.round(chars / 4);
  }

  /** 更新状态栏 */
  function updateStatus() {
    if (!sessionCtx) return;

    const now = Date.now();

    if (streaming) {
      // 清理 3 秒前的历史
      const cutoff = now - 3000;
      speedHistory = speedHistory.filter((h) => h.time > cutoff);

      // 计算滑动窗口内的速度
      const windowChars = speedHistory.reduce((sum, h) => sum + h.chars, 0);
      const windowDuration = speedHistory.length > 1
        ? (speedHistory[speedHistory.length - 1].time - speedHistory[0].time) / 1000
        : 0;

      let speedStr: string;
      if (windowDuration > 0.5) {
        const tokPerSec = estimateTokens(windowChars / windowDuration);
        speedStr = `${tokPerSec} tok/s`;
      } else {
        speedStr = "…";
      }

      const totalTok = estimateTokens(charCount);
      const elapsed = ((now - streamStart) / 1000).toFixed(1);

      sessionCtx.ui.setStatus(STATUS_KEY, `⚡ ${speedStr}  |  ${totalTok.toLocaleString()} tok  |  ${elapsed}s`);
    } else {
      sessionCtx.ui.setStatus(STATUS_KEY, undefined);
    }

    if (toolRunning) {
      const elapsed = Math.round((now - toolStart) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      const timeStr = minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
      sessionCtx.ui.setStatus(TOOL_STATUS_KEY, `🔧 ${toolName} (${timeStr})`);
    } else {
      sessionCtx.ui.setStatus(TOOL_STATUS_KEY, undefined);
    }
  }

  /** 记录字符增量 */
  function recordChars(delta: string) {
    if (!delta) return;
    const now = Date.now();
    const len = delta.length;
    charCount += len;
    speedHistory.push({ time: now, chars: len });
  }

  // ── 事件监听 ──

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;

    // 自定义工作指示器：动画脉冲，直观显示"在动"
    ctx.ui.setWorkingIndicator({
      frames: [
        ctx.ui.theme.fg("dim", "○  "),
        ctx.ui.theme.fg("muted", "◔  "),
        ctx.ui.theme.fg("accent", "● "),
        ctx.ui.theme.fg("muted", "◕  "),
      ],
      intervalMs: 150,
    });

    // 每秒刷新一次状态栏
    statusTimer = setInterval(() => updateStatus(), 1000);
  });

  pi.on("message_update", (event) => {
    const ev = event.assistantMessageEvent;

    if (ev.type === "start") {
      // 新一轮流式开始
      streaming = true;
      streamStart = Date.now();
      charCount = 0;
      speedHistory = [];
      toolRunning = false; // 工具执行结束，进入流式
      updateStatus();
    }

    if (ev.type === "text_delta") {
      recordChars(ev.delta);
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") {
      streaming = false;
      updateStatus();
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    toolRunning = true;
    toolName = event.toolName;
    toolStart = Date.now();
    updateStatus();
  });

  pi.on("tool_execution_end", () => {
    toolRunning = false;
    updateStatus();
  });
}
