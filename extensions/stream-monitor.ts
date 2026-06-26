/**
 * 流式状态监视器
 *
 * - 显示当前 token 流入速度（tok/s）
 * - 工具执行时显示运行时长
 * - 自定义工作指示器，直观判断是否卡死
 * - 不缓存 ctx，避免 session 替换后使用过期引用
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "../lib/token-utils";

export default function (pi: ExtensionAPI) {
  // 状态
  let streaming = false;
  let toolRunning = false;
  let toolName = "";
  let toolStart = 0;

  // 流速计算
  let streamStart = 0;
  let charCount = 0;
  let speedHistory: { time: number; chars: number }[] = [];

  // 节流
  let lastUpdate = 0;

  const STREAM_KEY = "stream-monitor";
  const TOOL_KEY = "stream-monitor-tool";

  function updateStatus(ctx: ExtensionContext) {
    const now = Date.now();

    if (streaming) {
      const cutoff = now - 3000;
      speedHistory = speedHistory.filter((h) => h.time > cutoff);

      const windowChars = speedHistory.reduce((sum, h) => sum + h.chars, 0);
      const windowDuration = speedHistory.length > 1 ? (speedHistory[speedHistory.length - 1].time - speedHistory[0].time) / 1000 : 0;

      let speedStr: string;
      if (windowDuration > 0.5) {
        const tokPerSec = estimateTokens(windowChars / windowDuration);
        speedStr = `${tokPerSec} tok/s`;
      } else {
        speedStr = "…";
      }

      const totalTok = estimateTokens(charCount).toLocaleString();
      const elapsed = ((now - streamStart) / 1000).toFixed(1);
      ctx.ui.setStatus(STREAM_KEY, `⚡ ${speedStr}  |  ${totalTok} tok  |  ${elapsed}s`);
    } else {
      ctx.ui.setStatus(STREAM_KEY, undefined);
    }

    if (toolRunning) {
      const elapsed = Math.round((now - toolStart) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      ctx.ui.setStatus(TOOL_KEY, `🔧 ${toolName} (${m > 0 ? `${m}m${s}s` : `${s}s`})`);
    } else {
      ctx.ui.setStatus(TOOL_KEY, undefined);
    }
  }

  /** 带节流更新（text_delta 可能很频繁） */
  function throttledUpdate(ctx: ExtensionContext) {
    const now = Date.now();
    if (now - lastUpdate < 500) return;
    lastUpdate = now;
    updateStatus(ctx);
  }

  function recordChars(delta: string) {
    if (!delta) return;
    charCount += delta.length;
    speedHistory.push({ time: Date.now(), chars: delta.length });
  }

  // ── 事件监听 ──

  pi.on("session_start", (_event, ctx) => {
    streaming = false;
    toolRunning = false;
    lastUpdate = 0;

    // 自定义工作指示器
    ctx.ui.setWorkingIndicator({
      frames: [ctx.ui.theme.fg("dim", "W-"), ctx.ui.theme.fg("muted", "O-"), ctx.ui.theme.fg("accent", "R-"), ctx.ui.theme.fg("muted", "K-")],
      intervalMs: 150,
    });
  });

  pi.on("message_update", (event, ctx) => {
    const ev = event.assistantMessageEvent;

    if (ev.type === "start") {
      streaming = true;
      streamStart = Date.now();
      charCount = 0;
      speedHistory = [];
      toolRunning = false;
      updateStatus(ctx);
    }

    if (ev.type === "text_delta") {
      recordChars(ev.delta);
      throttledUpdate(ctx);
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") {
      streaming = false;
      updateStatus(ctx);
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    toolRunning = true;
    toolName = event.toolName;
    toolStart = Date.now();
    updateStatus(ctx);
  });

  pi.on("tool_execution_update", (_event, ctx) => {
    if (toolRunning) updateStatus(ctx);
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    toolRunning = false;
    updateStatus(ctx);
  });
}
