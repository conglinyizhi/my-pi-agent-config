// 流式状态监视器：tok/s 流速 + 工具执行时长 + /stream-stats 详细统计面板

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "../../lib/format-utils";
import { estimateTextTokens } from "../../lib/token-utils";

// ── 类型 ──

interface ActiveTool {
  name: string;
  start: number;
}

interface SpeedSample {
  time: number;
  tokens: number;
}

interface ResponseStats {
  index: number;
  totalTokens: number;
  durationSec: number;
  firstTokenMs: number;
  avgSpeed: number;
  maxSpeed: number;
  minSpeed: number;
  p1LowSpeed: number;
  /** 每秒采样的窗口速度，用于折线图 */
  speedSamples: number[];
}

// ── 常量 ──

const STREAM_KEY = "stream-monitor";
const TOOL_KEY = "stream-monitor-tool";
const TICK_MS = 500;
const SPEED_WINDOW_MS = 3000;
const MIN_WINDOW_SEC = 0.5;

/** 统计保留条数上限 */
const MAX_STATS = 5;

// ── 工具函数 ──

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m${r.toString().padStart(2, "0")}s` : `${r}s`;
}

function formatDuration(sec: number): string {
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return formatClock(sec);
}



// ── 扩展主体 ──

export default function (pi: ExtensionAPI) {
  // ── 状态栏相关状态 ──
  let streaming = false;
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

  // ── 统计收集相关状态 ──
  let responseStats: ResponseStats[] = [];
  let responseIndex = 0;
  /** 当前响应过程中每隔 TICK_MS 采样的窗口速度 */
  let currentSpeedSamples: number[] = [];
  /** 首个 token 到达的时机 */
  let firstTokenTime = 0;
  let firstTokenRecorded = false;

  // ── 状态栏方法 ──

  function getWindowSpeedNumeric(now: number): number | null {
    const cutoff = now - SPEED_WINDOW_MS;
    speedHistory = speedHistory.filter((h) => h.time > cutoff);

    if (speedHistory.length < 2) return null;

    const windowTokens = speedHistory.reduce((sum, h) => sum + h.tokens, 0);
    const windowDuration =
      (speedHistory[speedHistory.length - 1].time - speedHistory[0].time) / 1000;

    if (windowDuration < MIN_WINDOW_SEC) return null;
    return Math.round(windowTokens / windowDuration);
  }

  function computeWindowSpeed(now: number): string {
    const speed = getWindowSpeedNumeric(now);
    return speed !== null ? `${speed} tok/s` : "…";
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
      const numericSpeed = getWindowSpeedNumeric(now);
      lastSpeedStr = numericSpeed !== null ? `${numericSpeed} tok/s` : "…";
      // 采样速度数据
      if (numericSpeed !== null) {
        currentSpeedSamples.push(numericSpeed);
      }

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
    if (!firstTokenRecorded) {
      firstTokenTime = Date.now();
      firstTokenRecorded = true;
    }
    const tokens = estimateTextTokens(delta);
    if (tokens <= 0) return;
    tokenCount += tokens;
    speedHistory.push({ time: Date.now(), tokens });
  }

  function computeAndStoreStats() {
    if (currentSpeedSamples.length === 0) return;
    const sorted = [...currentSpeedSamples].sort((a, b) => a - b);
    const p1LowIndex = Math.max(0, Math.floor(sorted.length * 0.01));
    const duration = (Date.now() - streamStart) / 1000;

    responseIndex++;
    responseStats.push({
      index: responseIndex,
      totalTokens: Math.round(tokenCount),
      durationSec: parseFloat(duration.toFixed(1)),
      firstTokenMs: firstTokenRecorded ? Math.max(0, firstTokenTime - streamStart) : 0,
      avgSpeed: duration > 0 ? Math.round(tokenCount / duration) : 0,
      maxSpeed: sorted[sorted.length - 1],
      minSpeed: sorted[0],
      p1LowSpeed: sorted[p1LowIndex],
      speedSamples: [],
    });
    // 只保留最后 N 条
    while (responseStats.length > MAX_STATS) responseStats.shift();
  }

  function freezeSnapshot() {
    frozenSpeedStr = computeAverageSpeed();
    frozenTokenCount = Math.round(tokenCount);
    frozenElapsedSec = ((Date.now() - streamStart) / 1000).toFixed(1);
    holdSnapshot = frozenTokenCount > 0 || Date.now() - streamStart > 200;
    computeAndStoreStats();
    currentSpeedSamples = [];
  }

  function resetStreamCounters() {
    streaming = true;
    holdSnapshot = false;
    streamStart = Date.now();
    tokenCount = 0;
    speedHistory = [];
    lastSpeedStr = "…";
    currentSpeedSamples = [];
    firstTokenRecorded = false;
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

  // ── /stream-stats 统计面板 ──

  pi.registerCommand("token-stream-stats", {
    description: "打开 Token 流速详细统计面板（max/min/1% low/折线图）",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("仅在 TUI 模式下可用", "warning");
        return;
      }

      if (responseStats.length === 0) {
        ctx.ui.notify("暂无统计数据，等待一次流式响应完成后即可查看", "info");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          let scrollOffset = 0;

          function renderLines(width: number): string[] {
            const lines: string[] = [];
            const borderFg = (s: string) => theme.fg("accent", s);
            const muted = (s: string) => theme.fg("muted", s);
            const accent = (s: string) => theme.fg("accent", s);
            const success = (s: string) => theme.fg("success", s);
            const warning = (s: string) => theme.fg("warning", s);
            const dim = (s: string) => theme.fg("dim", s);

            const pad = 2;
            const innerW = width - pad * 2;
            if (innerW <= 0) return ["…"];

            const hLine = "─".repeat(innerW);

            // 标题栏
            lines.push(`${" ".repeat(pad)}${borderFg("┌" + hLine + "┐")}`);
            const title = " Token 流速统计面板  "; // 副标题显示总览
            const totalResponses = responseStats.length;
            const totalTokens = responseStats.reduce((s, r) => s + r.totalTokens, 0);
            const totalTime = responseStats.reduce((s, r) => s + r.durationSec, 0);
            const overallAvg = totalTime > 0 ? Math.round(totalTokens / totalTime) : 0;
            const titleFull = `${title}${dim(`共 ${totalResponses} 次响应 · ${formatTokens(totalTokens)} tok · 均 ${overallAvg} tok/s`)}`;
            lines.push(
              `${" ".repeat(pad)}${borderFg("│")}${trunc(titleFull, innerW)}${borderFg("│")}`,
            );
            lines.push(`${" ".repeat(pad)}${borderFg("├" + hLine + "┤")}`);

            // 计算可见范围
            const visibleStats = responseStats.slice(scrollOffset);

            // 内容行
            for (let i = 0; i < visibleStats.length; i++) {
              const r = visibleStats[i];
              const tag = `#${r.index}`;

              // 响应概要行
              const ftStr = r.firstTokenMs > 0 ? `  ft ${formatDuration(r.firstTokenMs / 1000)}` : "";
              const summary =
                `${accent(tag)} ${formatTokens(r.totalTokens)} tok  /  ${formatDuration(r.durationSec)}${dim(ftStr)}`;
              lines.push(
                `${" ".repeat(pad)}${borderFg("│")}${trunc(" " + summary, innerW)}${borderFg("│")}`,
              );

              // 统计行
              const statsLine = `  ${muted("avg")}${success(`${r.avgSpeed} tok/s`)}  ${muted("max")}${accent(`${r.maxSpeed}`)}  ${muted("min")}${dim(`${r.minSpeed}`)}  ${muted("1%L")}${warning(`${r.p1LowSpeed}`)}`;
              lines.push(
                `${" ".repeat(pad)}${borderFg("│")}${trunc(statsLine, innerW)}${borderFg("│")}`,
              );

              // 分隔线（非最后一条）
              if (i < visibleStats.length - 1) {
                lines.push(
                  `${" ".repeat(pad)}${borderFg("│")}${dim("  " + "·".repeat(Math.min(innerW - 2, 40)))}${borderFg("│")}`,
                );
              }
            }

            // 底栏
            lines.push(`${" ".repeat(pad)}${borderFg("├" + hLine + "┤")}`);

            // 翻页提示
            const totalItems = responseStats.length;
            const navHint =
              scrollOffset > 0 || totalItems > 3
                ? `  ↑↓/jk 滚动  ·  r 重置  ·  esc/q 关闭  [${scrollOffset + 1}-${Math.min(scrollOffset + 3, totalItems)}/${totalItems}]`
                : `  r 重置统计  ·  esc/q 关闭`;
            lines.push(
              `${" ".repeat(pad)}${borderFg("│")}${trunc(dim(navHint), innerW)}${borderFg("│")}`,
            );
            lines.push(`${" ".repeat(pad)}${borderFg("└" + hLine + "┘")}`);

            return lines;
          }

          function handleInput(data: string) {
            if (data === "j" || data === "\x1b[B") {
              // 下翻
              if (scrollOffset + 1 < responseStats.length) {
                scrollOffset++;
                tui.requestRender();
              }
            } else if (data === "k" || data === "\x1b[A") {
              // 上翻
              if (scrollOffset > 0) {
                scrollOffset--;
                tui.requestRender();
              }
            } else if (data === "r") {
              // 重置
              responseStats = [];
              responseIndex = 0;
              scrollOffset = 0;
              tui.requestRender();
            } else if (
              data === "q" ||
              data === "\x1b" || // escape
              data === "\x03" // ctrl+c
            ) {
              done();
            }
          }

          return {
            render: (width: number) => renderLines(width),
            handleInput,
            invalidate: () => {},
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            maxHeight: "80%",
            minWidth: 50,
            width: "70%",
          },
        },
      );
    },
  });

  // ── 事件 ──

  pi.on("session_start", (_event, ctx) => {
    clearAllStatus(ctx);
    lastUpdate = 0;
    // 重置统计
    responseStats = [];
    responseIndex = 0;
    currentSpeedSamples = [];
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

// ── 小工具：ANSI 安全的截断 ──

function trunc(str: string, width: number): string {
  // 去掉 ANSI 转义序列后计算实际宽度
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripped.length <= width) return str.padEnd(width - stripped.length + str.length, " ");
  // 简单粗暴：超宽就裁（保留 ANSI）
  let visible = 0;
  let result = "";
  let inEscape = false;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\x1b") {
      inEscape = true;
      result += str[i];
    } else if (inEscape) {
      result += str[i];
      if (str[i] === "m") inEscape = false;
    } else {
      if (visible < width) {
        result += str[i];
        visible++;
      }
    }
  }
  return result;
}
