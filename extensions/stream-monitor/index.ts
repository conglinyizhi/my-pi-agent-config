// 流式状态监视器：tok/s 流速 + 工具执行时长（详见 README.md）

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "../../lib/format-utils";
import { estimateTextTokens } from "../../lib/token-utils";

interface ActiveTool {
  name: string;
  start: number;
}

interface SpeedSample {
  time: number;
  tokens: number;
}

const STREAM_KEY = "stream-monitor";
const TOOL_KEY = "stream-monitor-tool";
const TICK_MS = 500;
const SPEED_WINDOW_MS = 3000;
const MIN_WINDOW_SEC = 0.5;

export default function (pi: ExtensionAPI) {
  let streaming = false;
  /** 流结束后保留快照，直到下一次流式 start */
  let holdSnapshot = false;
  let streamStart = 0;
  let tokenCount = 0;
  let speedHistory: SpeedSample[] = [];
  let lastSpeedStr = "…";
  let frozenSpeedStr = "…";
  let frozenTokenCount = 0;
  let frozenElapsedSec = "0.0";

  const activeTools = new Map<string, ActiveTool>();

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let lastCtx: ExtensionContext | null = null;
  let lastUpdate = 0;

  function formatClock(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}m${r.toString().padStart(2, "0")}s` : `${r}s`;
  }

  function computeWindowSpeed(now: number): string {
    const cutoff = now - SPEED_WINDOW_MS;
    speedHistory = speedHistory.filter((h) => h.time > cutoff);

    if (speedHistory.length < 2) return "…";

    const windowTokens = speedHistory.reduce((sum, h) => sum + h.tokens, 0);
    const windowDuration =
      (speedHistory[speedHistory.length - 1].time - speedHistory[0].time) / 1000;

    if (windowDuration < MIN_WINDOW_SEC) return "…";
    return `${Math.round(windowTokens / windowDuration)} tok/s`;
  }

  function computeAverageSpeed(): string {
    const elapsed = (Date.now() - streamStart) / 1000;
    const total = Math.round(tokenCount);
    if (elapsed < MIN_WINDOW_SEC || total <= 0) return lastSpeedStr;
    return `${Math.round(total / elapsed)} tok/s`;
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    lastCtx = ctx;
    const now = Date.now();

    if (streaming) {
      lastSpeedStr = computeWindowSpeed(now);
      const elapsed = ((now - streamStart) / 1000).toFixed(1);
      ctx.ui.setStatus(
        STREAM_KEY,
        `⚡ ${lastSpeedStr}  |  ${formatTokens(Math.round(tokenCount))} tok  |  ${elapsed}s`,
      );
    } else if (holdSnapshot) {
      ctx.ui.setStatus(
        STREAM_KEY,
        `⚡ ${frozenSpeedStr}  |  ${formatTokens(frozenTokenCount)} tok  |  ${frozenElapsedSec}s`,
      );
    } else {
      ctx.ui.setStatus(STREAM_KEY, undefined);
    }

    if (activeTools.size > 0) {
      let oldest = Number.POSITIVE_INFINITY;
      let primaryName = "";
      for (const tool of activeTools.values()) {
        if (tool.start < oldest) {
          oldest = tool.start;
          primaryName = tool.name;
        }
      }
      const elapsed = formatClock((now - oldest) / 1000);
      const extra = activeTools.size - 1;
      const label =
        extra > 0
          ? `🔧 ${primaryName} +${extra} (${elapsed})`
          : `🔧 ${primaryName} (${elapsed})`;
      ctx.ui.setStatus(TOOL_KEY, label);
    } else {
      ctx.ui.setStatus(TOOL_KEY, undefined);
    }
  }

  function throttledUpdate(ctx: ExtensionContext) {
    const now = Date.now();
    if (now - lastUpdate < TICK_MS) return;
    lastUpdate = now;
    updateStatus(ctx);
  }

  function ensureTicker() {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      if (!lastCtx) return;
      if (streaming || activeTools.size > 0) {
        lastUpdate = Date.now();
        updateStatus(lastCtx);
      } else {
        stopTicker();
      }
    }, TICK_MS);
    tickTimer.unref?.();
  }

  function stopTicker() {
    if (!tickTimer) return;
    clearInterval(tickTimer);
    tickTimer = null;
  }

  function recordDelta(delta: string) {
    if (!delta) return;
    const tokens = estimateTextTokens(delta);
    if (tokens <= 0) return;
    tokenCount += tokens;
    speedHistory.push({ time: Date.now(), tokens });
  }

  function freezeSnapshot() {
    frozenSpeedStr = computeAverageSpeed();
    frozenTokenCount = Math.round(tokenCount);
    frozenElapsedSec = ((Date.now() - streamStart) / 1000).toFixed(1);
    holdSnapshot = frozenTokenCount > 0 || Date.now() - streamStart > 200;
  }

  function resetStreamCounters() {
    streaming = true;
    holdSnapshot = false;
    streamStart = Date.now();
    tokenCount = 0;
    speedHistory = [];
    lastSpeedStr = "…";
  }

  function clearAllStatus(ctx?: ExtensionContext) {
    streaming = false;
    holdSnapshot = false;
    activeTools.clear();
    stopTicker();
    const ui = ctx ?? lastCtx;
    if (ui?.hasUI) {
      ui.ui.setStatus(STREAM_KEY, undefined);
      ui.ui.setStatus(TOOL_KEY, undefined);
    }
    lastCtx = null;
  }

  function applyWorkingIndicator(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;
    ctx.ui.setWorkingIndicator({
      frames: [
        theme.fg("dim", "·"),
        theme.fg("muted", "•"),
        theme.fg("accent", "●"),
        theme.fg("muted", "•"),
      ],
      intervalMs: 120,
    });
  }

  // ── 事件 ──

  pi.on("session_start", (_event, ctx) => {
    clearAllStatus(ctx);
    lastUpdate = 0;
    applyWorkingIndicator(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearAllStatus(ctx);
    if (ctx.hasUI) ctx.ui.setWorkingIndicator();
  });

  pi.on("message_update", (event, ctx) => {
    const ev = event.assistantMessageEvent;

    if (ev.type === "start") {
      resetStreamCounters();
      updateStatus(ctx);
      ensureTicker();
      return;
    }

    if (
      ev.type === "text_delta" ||
      ev.type === "thinking_delta" ||
      ev.type === "toolcall_delta"
    ) {
      if (!streaming) {
        resetStreamCounters();
        ensureTicker();
      }
      recordDelta(ev.delta);
      throttledUpdate(ctx);
      return;
    }

    if (ev.type === "done" || ev.type === "error") {
      if (streaming) {
        streaming = false;
        freezeSnapshot();
        updateStatus(ctx);
        if (activeTools.size === 0) stopTicker();
      }
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!streaming) {
      if (holdSnapshot) updateStatus(ctx);
      return;
    }
    streaming = false;
    freezeSnapshot();
    updateStatus(ctx);
    if (activeTools.size === 0) stopTicker();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    activeTools.set(event.toolCallId, {
      name: event.toolName,
      start: Date.now(),
    });
    updateStatus(ctx);
    ensureTicker();
  });

  pi.on("tool_execution_update", (_event, ctx) => {
    if (activeTools.size > 0) throttledUpdate(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    activeTools.delete(event.toolCallId);
    updateStatus(ctx);
    if (!streaming && activeTools.size === 0) stopTicker();
  });

  pi.on("agent_end", (_event, ctx) => {
    if (activeTools.size > 0) {
      activeTools.clear();
      updateStatus(ctx);
    }
    if (!streaming && activeTools.size === 0) stopTicker();
  });
}
