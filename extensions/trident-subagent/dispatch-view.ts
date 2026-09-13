// dispatch-view.ts — subagent 派发面的展示层（实时投影 / TUI 仪表盘 / 回报文本预算）
//
// 三块都是纯计算，不 spawn、不碰网络、不写盘，可单测：
//   1. projectFleet(workers, nowMs)     快照 → 展示投影（吞吐、活性、当前动向）
//   2. FleetView                        投影 → 多行 TUI 组件（含瞬时吞吐 sparkline）
//   3. formatWorkerOutput(output, 预算)  worker 回报文本按整批预算分配与截断
//
// 吞吐口径（别把折算当权威）：
//   - 字符数是**实测**：来自 worker 流式增量计数（text/thinking/toolcall 三类 delta）。
//   - token 是**折算**：以「同期累计字符 ÷ 已终结消息的权威 usage.output」自校准每
//     token 字符数；样本不足时退回 DEFAULT_CHARS_PER_TOKEN。provider 只在完成时
//     报 usage 时折算值仍能反映实时速率，但绝对值有误差，故一律带「≈」。
//   - 活性：最近一次增量距今 < IDLE_AFTER_MS 即视为正在推进。纯思考期也算推进——
//     这正是本模块存在的原因：让「在思考」与「卡死」可区分，不再盯着死屏发呆。

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StreamStats, TimelineEvent } from "../../lib/subagent-run.ts";
import type { WorkerRun, WorkerStatus } from "./status.ts";

/** 自校准缺省值：中英混排 + 代码的粗略每 token 字符数 */
export const DEFAULT_CHARS_PER_TOKEN = 3.2;
/** 自校准系数（每 token 字符数）的合理区间（防小样本把比值放大成荒谬值） */
export const MIN_CHARS_PER_TOKEN = 1.2;
export const MAX_CHARS_PER_TOKEN = 8;
/** 最近一次增量距今超过此值即视为静默（不判定卡死，只如实显示） */
export const IDLE_AFTER_MS = 2000;
/** 瞬时速率保留的样本数（sparkline 宽度） */
export const RATE_HISTORY = 24;
/** 两次采样之间的最小间隔（防止同帧多次 render 造出噪声速率） */
export const MIN_SAMPLE_INTERVAL_MS = 200;
/** worker 回报文本的最小字节预算（再多 worker 也留这么多，避免全被砍成一行） */
export const WORKER_OUTPUT_MIN_BUDGET = 4 * 1024;

const SPARK_CHARS = "▁▂▃▄▅▆▇█";

// ── 类型 ──

export interface FleetThroughput {
  /** 累计流式字符（text + thinking + toolcall） */
  chars: number;
  textChars: number;
  thinkingChars: number;
  toolcallChars: number;
  /** 收到的增量事件数 */
  deltas: number;
  /** 已终结的 assistant 消息数 */
  messages: number;
  /** 已产出 output token：已终结消息权威累计 + 在途实时值 */
  outputTokens: number;
  /** 自校准的每字符 token 系数 */
  charsPerToken: number;
  /** 平均吞吐（自 worker 起算，含工具等待与退避，故偏保守） */
  avgCharsPerSec: number;
  estTokensPerSec: number;
}

export type FleetActivityKind =
  | "queued"
  | "starting"
  | "thinking"
  | "output"
  | "tool"
  | "waiting"
  | "idle"
  | "done"
  | "failed";

export interface FleetActivity {
  kind: FleetActivityKind;
  /** 一行摘要（含工具名/参数头，或静默时长） */
  label: string;
}

export interface FleetWorkerView {
  index: number;
  id: string;
  status: WorkerStatus;
  model: string;
  pid?: number;
  /** worker 起算至今（已终态则到 finishedAt） */
  elapsedMs: number;
  /** 距最近一次快照更新的静默时长；已终态为 0 */
  silentMs: number;
  /** 已发生的重试轮次（timeline 里的「第 N 次尝试」最大值；0 = 未重试） */
  retries: number;
  throughput: FleetThroughput;
  activity: FleetActivity;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    contextTokens: number;
    turns: number;
  };
  cost: number;
  /** 失败/审批类 lifecycle 的说明（有则显示） */
  note?: string;
  capability?: { capability: string; scope?: string; command: string };
  /** 实时 timeline 是否已发生截断（历史被丢弃，操作者可感知） */
  timelineTruncated: boolean;
  finished: boolean;
}

// ── 格式化小工具 ──

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatRate(perSec: number): string {
  if (!Number.isFinite(perSec) || perSec <= 0) return "0";
  if (perSec < 1000) return String(Math.round(perSec));
  return `${(perSec / 1000).toFixed(perSec < 10_000 ? 1 : 0)}k`;
}

export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, Number.EPSILON);
  return values
    .map((v) => {
      const ratio = max > 0 ? v / max : 0;
      const idx = Math.min(SPARK_CHARS.length - 1, Math.max(0, Math.round(ratio * (SPARK_CHARS.length - 1))));
      return SPARK_CHARS[idx];
    })
    .join("");
}

/** 单行化：折叠空白，用于把工具参数塞进一行 */
function oneLine(s: string, cap: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : flat.slice(0, cap) + "…";
}

/**
 * 工具参数预览：把 timeline 里序列化好的 JSON 压成可读短串。
 * 单键对象（绝大多数工具，如 {command} / {path}）只给值，多键才带 key=。
 * 非 JSON / 已被截断的串退回原样单行化，保证永不抛。
 */
export function formatToolArgs(raw: string, cap: number): string {
  if (!raw) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return oneLine(raw, cap);
  }
  if (typeof parsed === "string") return oneLine(parsed, cap);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return oneLine(raw, cap);
    const parts = entries.map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
      return entries.length === 1 ? text : `${key}=${text}`;
    });
    return oneLine(parts.join(" "), cap);
  }
  return oneLine(raw, cap);
}

// ── 投影 ──

const ZERO_STREAM: StreamStats = { textChars: 0, thinkingChars: 0, toolcallChars: 0, deltas: 0, messages: 0 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function lastNonLifecycle(events: TimelineEvent[]): TimelineEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== "lifecycle") return events[i];
  }
  return undefined;
}

function countRetries(events: TimelineEvent[]): number {
  let max = 0;
  for (const e of events) {
    const m = /第 (\d+) 次尝试/.exec(e.message ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function terminalNote(events: TimelineEvent[]): string | undefined {
  const interesting = new Set(["failed", "aborted", "timeout", "needs_approval", "truncated"]);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "lifecycle" && e.state && interesting.has(e.state)) {
      return e.message ?? e.state;
    }
  }
  return undefined;
}

function deriveActivity(
  w: WorkerRun,
  stream: StreamStats,
  silentMs: number,
  finished: boolean,
): FleetActivity {
  if (finished) {
    if (w.status === "success") return { kind: "done", label: "已完成" };
    return { kind: "failed", label: w.status === "timeout" ? "超时" : w.status === "aborted" ? "已中止" : "失败" };
  }
  if (w.status === "queued") {
    return { kind: "queued", label: "排队中（等并行额度）" };
  }
  if (w.status === "needs_approval" && w.capabilityRequest) {
    return { kind: "waiting", label: `等待审批 ${w.capabilityRequest.capability}` };
  }
  if (w.status === "starting" && stream.deltas === 0) {
    return { kind: "starting", label: "启动中" };
  }
  const tail = lastNonLifecycle(w.timeline ?? []);
  if (tail?.type === "tool" && tail.ok === undefined) {
    const args = tail.args ? formatToolArgs(tail.args, 70) : "";
    return { kind: "tool", label: `${tail.tool ?? "tool"} ${args}`.trim() };
  }
  // 静默优先于「上次在做什么」：如实显示停顿时长，而不是拿旧状态冒充当前
  if (silentMs >= IDLE_AFTER_MS) {
    return { kind: "idle", label: `静默 ${formatDuration(silentMs)}` };
  }
  switch (stream.lastDeltaKind) {
    case "thinking": return { kind: "thinking", label: "思考中" };
    case "text": return { kind: "output", label: "输出中" };
    case "toolcall": return { kind: "thinking", label: "组工具参数" };
    default: return { kind: "idle", label: "等待响应" };
  }
}

export function projectWorker(w: WorkerRun, index: number, nowMs: number): FleetWorkerView {
  const startedMs = Date.parse(w.startedAt);
  const finished = w.finishedAt !== undefined;
  const endMs = finished ? Date.parse(w.finishedAt as string) : nowMs;
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, endMs - startedMs) : 0;
  const lastActivityMs = w.lastActivityAt ? Date.parse(w.lastActivityAt) : startedMs;
  const silentMs = finished || !Number.isFinite(lastActivityMs) ? 0 : Math.max(0, nowMs - lastActivityMs);

  const stream: StreamStats = w.stream ?? ZERO_STREAM;
  const usage = w.usage;
  const chars = stream.textChars + stream.thinkingChars + stream.toolcallChars;
  const outputTokens = (usage?.output ?? 0) + (w.liveOutputTokens ?? 0);

  // 自校准：每 token 字符数 = 实测字符 ÷ 已终结 token。只在「有已终结消息 + 有字符
  // 样本 + 有权威 token」时用实测比值，否则退回缺省。
  const committedTokens = usage?.output ?? 0;
  const calibrated = stream.messages > 0 && chars > 0 && committedTokens > 0
    ? clamp(chars / committedTokens, MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN)
    : DEFAULT_CHARS_PER_TOKEN;

  const elapsedSec = elapsedMs / 1000;
  const avgCharsPerSec = elapsedSec > 0 ? chars / elapsedSec : 0;

  return {
    index,
    id: w.id,
    status: w.status,
    model: w.model,
    pid: w.pid,
    elapsedMs,
    silentMs,
    retries: countRetries(w.timeline ?? []),
    throughput: {
      chars,
      textChars: stream.textChars,
      thinkingChars: stream.thinkingChars,
      toolcallChars: stream.toolcallChars,
      deltas: stream.deltas,
      messages: stream.messages,
      outputTokens,
      charsPerToken: calibrated,
      avgCharsPerSec,
      estTokensPerSec: avgCharsPerSec / calibrated,
    },
    activity: deriveActivity(w, stream, silentMs, finished),
    usage: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      contextTokens: usage?.contextTokens ?? 0,
      turns: usage?.turns ?? 0,
    },
    cost: usage?.cost ?? 0,
    note: terminalNote(w.timeline ?? []),
    capability: w.capabilityRequest
      ? {
          capability: w.capabilityRequest.capability,
          scope: w.capabilityRequest.scope,
          command: w.capabilityRequest.command,
        }
      : undefined,
    timelineTruncated: (w.timeline ?? []).some((e) => e.truncated === true),
    finished,
  };
}

export function projectFleet(workers: WorkerRun[], nowMs: number): FleetWorkerView[] {
  return workers.map((w, i) => projectWorker(w, i, nowMs));
}

// ── TUI 组件 ──

export interface FleetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** 展开提示（折叠态显示）；由调用方注入，避免本模块依赖 pi 的 keybinding 层 */
export type ExpandHint = () => string;

const STATUS_LABEL: Record<WorkerStatus, string> = {
  queued: "排队",
  starting: "启动",
  running: "运行",
  needs_approval: "等审批",
  success: "完成",
  failed: "失败",
  aborted: "中止",
  timeout: "超时",
};

const STATUS_COLOR: Record<WorkerStatus, string> = {
  queued: "dim",
  starting: "dim",
  running: "accent",
  needs_approval: "warning",
  success: "success",
  failed: "error",
  aborted: "warning",
  timeout: "warning",
};

const ACTIVITY_MARK: Record<FleetActivityKind, string> = {
  queued: "·",
  starting: "○",
  thinking: "…",
  output: "→",
  tool: "$",
  waiting: "?",
  idle: "·",
  done: "✓",
  failed: "✗",
};

/**
 * 多行 fleet 仪表盘。
 *
 * 折叠态每个 worker 三行（身份/吞吐/动向），展开态追加字符细分、sparkline、
 * 上下文与权限明细。渲染按 (width, 数据签名) 缓存，避免每帧重算。
 * 瞬时速率在 render 时采样（带最小间隔），因此 sparkline 反映真实流速而非装饰。
 */
export class FleetView {
  private workers: FleetWorkerView[] = [];
  private theme: FleetTheme;
  private expanded: boolean;
  private sig = "";
  private cachedWidth = -1;
  private cached: string[] = [];
  /** worker id → 瞬时字符/秒 历史（sparkline 数据源） */
  private readonly rates = new Map<string, number[]>();
  private readonly samples = new Map<string, { chars: number; at: number }>();
  private readonly now: () => number;
  private readonly expandHint: ExpandHint | undefined;

  constructor(theme: FleetTheme, expanded: boolean, now: () => number = () => Date.now(), expandHint?: ExpandHint) {
    this.theme = theme;
    this.expanded = expanded;
    this.now = now;
    this.expandHint = expandHint;
  }

  /** 注入新投影。数据签名变化时作废渲染缓存，避免宽度未变就吃旧行。 */
  update(workers: FleetWorkerView[], theme: FleetTheme, expanded: boolean): void {
    const sig = workers
      .map((w) => `${w.id}|${w.status}|${w.throughput.deltas}|${w.throughput.outputTokens}|${w.activity.kind}|${w.capability?.command ?? ""}`)
      .join("~");
    if (sig !== this.sig) {
      this.sig = sig;
      this.cachedWidth = -1;
    }
    this.workers = workers;
    this.theme = theme;
    this.expanded = expanded;
  }

  /** 瞬时速率历史（测试与调试用） */
  rateHistory(id: string): number[] {
    return [...(this.rates.get(id) ?? [])];
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }

  private sampleRates(nowMs: number): void {
    for (const w of this.workers) {
      const chars = w.throughput.chars;
      const prev = this.samples.get(w.id);
      if (!prev) {
        this.samples.set(w.id, { chars, at: nowMs });
        continue;
      }
      const dt = nowMs - prev.at;
      if (dt < MIN_SAMPLE_INTERVAL_MS) continue;
      const rate = Math.max(0, chars - prev.chars) / (dt / 1000);
      const arr = this.rates.get(w.id) ?? [];
      arr.push(rate);
      if (arr.length > RATE_HISTORY) arr.shift();
      this.rates.set(w.id, arr);
      this.samples.set(w.id, { chars, at: nowMs });
    }
  }

  /** 当前瞬时 token/秒（全 worker 合计），用于表头 */
  private liveTokensPerSec(): number {
    let total = 0;
    for (const w of this.workers) {
      const arr = this.rates.get(w.id);
      const last = arr && arr.length > 0 ? arr[arr.length - 1] : w.throughput.avgCharsPerSec;
      total += last / w.throughput.charsPerToken;
    }
    return total;
  }

  render(width: number): string[] {
    const sampleAt = this.now();
    this.sampleRates(sampleAt);
    if (this.cachedWidth === width && this.cached.length > 0) return this.cached;
    const lines = this.build(width);
    this.cachedWidth = width;
    this.cached = lines;
    return lines;
  }

  private build(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const ready = this.workers.filter(
      (w) => !w.finished && w.status !== "queued" && w.status !== "needs_approval" && w.status !== "success",
    ).length;
    const queued = this.workers.filter((w) => w.status === "queued").length;
    const done = this.workers.filter((w) => w.status === "success").length;
    const bad = this.workers.filter((w) => w.finished && w.status !== "success").length;
    const wait = this.workers.filter((w) => w.status === "needs_approval").length;

    // 表头：左身份，右总量（按可见宽度对齐，ANSI 不影响）
    const chips: string[] = [];
    if (this.workers.length === 0) {
      chips.push(t.fg("dim", "无进行中的 worker"));
    } else {
      if (ready > 0) chips.push(t.fg("accent", `${ready} 运行`));
      if (queued > 0) chips.push(t.fg("dim", `${queued} 排队`));
      if (wait > 0) chips.push(t.fg("warning", `${wait} 等审批`));
      if (done > 0) chips.push(t.fg("success", `${done} 完成`));
      if (bad > 0) chips.push(t.fg("error", `${bad} 异常`));
    }
    const left = t.bold("⚓ subagent") + "  " + chips.join(t.fg("dim", " · "));
    const maxElapsed = this.workers.reduce((m, w) => Math.max(m, w.elapsedMs), 0);
    const totalCost = this.workers.reduce((s, w) => s + w.cost, 0);
    const live = this.liveTokensPerSec();
    let right = "";
    if (this.workers.length > 0) {
      right = t.fg("muted", formatDuration(maxElapsed));
      if (totalCost > 0) right += t.fg("dim", " · ") + t.fg("muted", `¥${totalCost.toFixed(3)}`);
      if (live > 0) right += t.fg("dim", " · ") + t.fg("accent", `${formatRate(live)} tok/s`);
    }
    lines.push(padBetween(t, left, right, width));
    lines.push(t.fg("dim", "─".repeat(Math.max(8, width))));

    for (const w of this.workers) lines.push(...this.workerLines(w, width));

    if (this.expanded && this.workers.length > 0) {
      const trunc = this.workers.some((w) => w.timelineTruncated);
      if (trunc) lines.push(t.fg("warning", "  ⚠ 部分 worker 的实时轨迹已截断（最旧记录被丢弃）"));
      lines.push(t.fg("dim", `  速率按流式增量实测；token 为折算值（每 token ≈${DEFAULT_CHARS_PER_TOKEN} 字起自校准）`));
    } else if (!this.expanded && this.workers.length > 0 && this.expandHint) {
      lines.push("  " + t.fg("dim", this.expandHint()));
    }
    return lines.map((l) => truncateToWidth(l, Math.max(4, width), "…"));
  }

  private workerLines(w: FleetWorkerView, width: number): string[] {
    const t = this.theme;
    const out: string[] = [];
    const head = `${w.id.padEnd(3)}${ACTIVITY_MARK[w.activity.kind]} ${t.fg(STATUS_COLOR[w.status], STATUS_LABEL[w.status])}`;
    let l1 = ` ${head}`;
    l1 += t.fg("dim", " · ") + t.fg("muted", w.model || "?");
    l1 += t.fg("dim", " · ") + t.fg("muted", formatDuration(w.elapsedMs));
    if (w.cost > 0) l1 += t.fg("dim", " · ") + t.fg("muted", `¥${w.cost.toFixed(3)}`);
    if (w.retries > 0) l1 += t.fg("dim", " · ") + t.fg("warning", `第${w.retries}次尝试`);
    out.push(l1);

    const tp = w.throughput;
    const hist = this.rates.get(w.id) ?? [];
    const instChars = hist.length > 0 ? hist[hist.length - 1] : tp.avgCharsPerSec;
    const instTokens = instChars / tp.charsPerToken;
    let l2 = "    " + t.fg("accent", `≈${formatRate(instTokens)} tok/s`);
    l2 += t.fg("dim", " · ") + t.fg("muted", `${formatCount(tp.chars)} 字`);
    l2 += t.fg("dim", " · ") + `out ${formatCount(tp.outputTokens)}`;
    l2 += t.fg("dim", " ") + t.fg("dim", `(均 ≈${formatRate(tp.estTokensPerSec)} tok/s)`);
    if (hist.length > 1) l2 += " " + t.fg("accent", sparkline(hist));
    out.push(l2);

    let l3 = "    " + w.activity.label;
    if (!w.finished && w.silentMs >= IDLE_AFTER_MS) {
      // 等审批不是「静默」——换成「已等待」，否则读起来像 worker 卡了
      if (w.activity.kind === "waiting") l3 += t.fg("dim", ` · 已等待 ${formatDuration(w.silentMs)}`);
      else if (w.activity.kind !== "idle") l3 += t.fg("dim", ` · 静默 ${formatDuration(w.silentMs)}`);
    }
    // 终态且有 note 时不再重复「失败」二字（note 行紧跟在后）
    if (!(w.activity.kind === "failed" && w.note)) out.push(l3);

    if (this.expanded) {
      let l4 = "    " + t.fg("dim", "字符 ") + `text ${formatCount(tp.textChars)} / 思考 ${formatCount(tp.thinkingChars)} / 参数 ${formatCount(tp.toolcallChars)}`;
      l4 += t.fg("dim", ` · 增量 ${formatCount(tp.deltas)} · 消息 ${tp.messages}`);
      out.push(l4);

      let l5 = "    " + t.fg("dim", "token ") + `in ${formatCount(w.usage.input)} / out ${formatCount(tp.outputTokens)}`;
      if (w.usage.cacheRead > 0) l5 += ` / 缓存读 ${formatCount(w.usage.cacheRead)}`;
      if (w.usage.cacheWrite > 0) l5 += ` / 缓存写 ${formatCount(w.usage.cacheWrite)}`;
      l5 += t.fg("dim", ` · 轮 ${w.usage.turns}`);
      if (w.usage.contextTokens > 0) l5 += t.fg("dim", ` · 上下文 ${formatCount(w.usage.contextTokens)}`);
      if (w.pid) l5 += t.fg("dim", ` · pid ${w.pid}`);
      out.push(l5);
    }

    if (w.capability) {
      let lc = "    " + t.fg("warning", `权限请求 ${w.capability.capability}`) + t.fg("dim", ` (${w.capability.scope ?? "-"})`);
      out.push(lc);
      if (this.expanded) out.push("      " + t.fg("dim", oneLine(w.capability.command, Math.max(20, width - 8))));
    }
    if (w.note) out.push("    " + t.fg(w.finished && w.status !== "success" ? "error" : "dim", oneLine(w.note, Math.max(20, width - 8))));
    return out;
  }
}

/** 左右对齐成一行（按可见宽度补空格；ANSI 与宽字符交给 pi-tui 计算） */
function padBetween(theme: FleetTheme, left: string, right: string, width: number): string {
  if (!right) return left;
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 2) return left + theme.fg("dim", " ") + right;
  return left + " ".repeat(gap) + right;
}

// ── 回报文本预算 ──

/**
 * 每个 worker 分到的输出字节预算：整批共享 pi 的输出上限（默认 50KB），
 * 按 worker 数均分但保底 WORKER_OUTPUT_MIN_BUDGET。
 */
export function workerOutputBudget(workerCount: number): number {
  const n = Math.max(1, workerCount);
  return Math.max(WORKER_OUTPUT_MIN_BUDGET, Math.floor(DEFAULT_MAX_BYTES / n));
}

/** 按预算截断单个 worker 的回报文本；截断时附上可读提示与完整内容所在 */
export function formatWorkerOutput(output: string, budget: number): string {
  const r = truncateHead(output, { maxBytes: budget, maxLines: DEFAULT_MAX_LINES });
  if (!r.truncated) return r.content;
  return (
    `${r.content}\n… [输出被截断：${formatSize(r.outputBytes)}/${formatSize(r.totalBytes)}` +
    `，按 ${formatSize(r.maxBytes)} 预算保留开头；完整输出见 ~/.pi/subagent-diagnostics/ 下本批档案]`
  );
}

// ── 投递合并 ──

export interface CoalescerScheduler {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => { unref?: () => void };
  cancel?: (handle: unknown) => void;
}

/**
 * 投递合并器：把高频 push 合并为「最多每 minIntervalMs 一次」，且**最后一次必然送达**。
 *
 * 用途：N 个 worker 各自按增量节流投递实时快照，直接转发会把 TUI 行重绘次数乘上 N；
 * 展示只需要「够新」。时间源和调度器可注入，便于确定性测试。
 */
export function createCoalescer<T>(
  minIntervalMs: number,
  deliver: (value: T) => void,
  opts: CoalescerScheduler = {},
): { push: (value: T) => void; flush: () => void; hasPending: () => boolean } {
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  let lastDeliveredAt: number | undefined;
  let pending: T | undefined;
  let handle: unknown;
  let live = false;

  const deliverNow = () => {
    if (handle !== undefined) {
      cancel(handle);
      handle = undefined;
    }
    if (!live) return;
    const value = pending as T;
    pending = undefined;
    lastDeliveredAt = now();
    deliver(value);
  };

  return {
    push(value: T) {
      live = true;
      pending = value;
      // 首帧必须立即送达：不依赖时钟绝对值（注入时钟可能从 0 起算）
      const elapsed = lastDeliveredAt === undefined ? Number.POSITIVE_INFINITY : now() - lastDeliveredAt;
      if (elapsed >= minIntervalMs) {
        deliverNow();
        return;
      }
      if (handle !== undefined) return; // 已有挂起投递，它会带上最新值
      handle = schedule(() => {
        handle = undefined;
        deliverNow();
      }, minIntervalMs - elapsed);
      (handle as { unref?: () => void } | undefined)?.unref?.();
    },
    /** 立即送达挂起值（终态/收尾路径用，保证不丢最后一帧） */
    flush() {
      if (pending !== undefined) deliverNow();
    },
    hasPending() {
      return pending !== undefined;
    },
  };
}
