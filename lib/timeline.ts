// timeline.ts — worker JSON 事件 → 有界 per-worker 执行轨迹（TimelineEvent）归一化
//
// 输入是 pi --mode json 的 stdout 事件行（每行一个 JSON 对象），事件形状来自
// @earendil-works/pi-agent-core 的 AgentEvent + modes/json-event.ts（JSON 协议会
// 剥掉 message_update 的累积快照，只留 assistantMessageEvent 增量）：
//   message_start / message_update / message_end / tool_execution_start /
//   tool_execution_update / tool_execution_end
//
// 归一化为三类 TimelineEvent：
//   - assistant：一次流式回复合并为一条记录；text_delta 增量累积为预览，
//     message_end 以消息权威全文终结（final=true）。只保留 assistant 可见文本，
//     thinking/toolcall 增量不进轨迹（不捕获隐藏推理）。
//   - tool：一次工具调用按 toolCallId 合并为一条记录；start 记录工具名与序列化
//     参数，update 追加预览，end 记录最终结果与成功/失败状态。
//   - lifecycle：worker 启动 / 终止（success/failed/aborted/timeout）/ 截断标记。
//
// 容错约束：
//   - malformed / unknown 行直接忽略；遥测归一化错误与结果采集隔离，永不抛出。
//   - 任意 args/result 用安全序列化兜底（深度嵌套等非序列化数据给占位符）。
//   - 每 worker 至多 TIMELINE_MAX_ENTRIES 条（含截断标记）；超限丢弃最旧记录并
//     在最前位置维护唯一的 truncated lifecycle 标记，操作者可感知历史被丢弃。
//
// 角色过滤：message_start / message_end 仅对 role === "assistant" 的消息建/完成
// assistant 轨迹；worker 的用户输入与 toolResult 消息（role user/tool）绝不写入
// 轨迹（GUI 不暴露原始提示词与工具输出）。
//
// 变化报告：handleLine 返回是否有可观察的轨迹变化——不只看条数（原地修改如 tool
// update/end、assistant delta/finalize 不改变条数），由各处理函数置 dirty 标记。
// runSubagent 据此决定是否触发 onUpdate 实时刷新。

export type TimelineEventType = "assistant" | "tool" | "lifecycle";

export interface TimelineEvent {
  /** 稳定 id：assistant=消息 id（缺失则合成），tool=toolCallId，lifecycle=合成 */
  id: string;
  type: TimelineEventType;
  /** ISO 时间戳 */
  ts: string;
  /** assistant：累积的可见文本（有界；message_end 后为权威全文） */
  text?: string;
  /** assistant：message_end 已终结 */
  final?: boolean;
  /** tool：工具名 */
  tool?: string;
  /** tool：序列化参数预览（有界） */
  args?: string;
  /** tool：最新 partialResult 预览（有界） */
  preview?: string;
  /** tool：最终 result 预览（有界） */
  result?: string;
  /** tool：成功标记（tool_execution_end.isError 取反） */
  ok?: boolean;
  /** lifecycle：状态名（starting/success/failed/aborted/timeout/truncated 等） */
  state?: string;
  /** lifecycle：细节说明（有界） */
  message?: string;
  /** lifecycle：truncated 标记（丢弃最旧记录时置位） */
  truncated?: boolean;
}

/** 每 worker 轨迹条数上限（含截断标记，超限丢弃最旧并置 truncated） */
export const TIMELINE_MAX_ENTRIES = 500;
/** assistant 累积文本上限（字符） */
export const TIMELINE_MAX_TEXT = 8000;
/** 单个字段（args/preview/result/message）上限（字符） */
export const TIMELINE_MAX_FIELD = 2000;

export interface TimelineBuilderOptions {
  /** 时间源（测试注入；默认 new Date().toISOString()） */
  now?: () => string;
  /** 条数上限（测试注入；默认 TIMELINE_MAX_ENTRIES） */
  maxEntries?: number;
}

export class TimelineBuilder {
  /** 有界轨迹（含可能的 truncated 标记）；对外暴露同一数组引用，供实时快照 */
  readonly events: TimelineEvent[] = [];
  /** 本行是否产生可观察变化（原地修改也置位；handleLine 消费后重置） */
  private dirty = false;
  /** toolCallId → 进行中的 tool 记录 */
  private activeTools = new Map<string, TimelineEvent>();
  /** 当前进行中的 assistant 记录（流式回复按顺序合并） */
  private activeAssistant: TimelineEvent | undefined;
  private seq = 0;
  private readonly now: () => string;
  private readonly maxEntries: number;

  constructor(opts: TimelineBuilderOptions = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.maxEntries = opts.maxEntries ?? TIMELINE_MAX_ENTRIES;
  }

  private nextSeq(): number {
    return ++this.seq;
  }

  /**
   * 解析一行 JSON 事件并归一化。malformed / unknown / 遥测错误一律隔离，不抛出。
   * 返回是否产生了可观察的轨迹变化（供调用方决定是否触发实时更新）。
   */
  handleLine(line: string): boolean {
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return false; // malformed → 忽略
    }
    if (!ev || typeof ev !== "object" || typeof (ev as { type?: unknown }).type !== "string") {
      return false;
    }
    this.dirty = false;
    try {
      this.dispatch(ev as Record<string, unknown>);
    } catch {
      // 遥测归一化错误隔离：不影响结果采集
    }
    return this.dirty;
  }

  /** 添加 lifecycle 记录（worker 启动/终止/截断等） */
  addLifecycle(state: string, message?: string): void {
    this.push({
      id: `lifecycle-${this.nextSeq()}`,
      type: "lifecycle",
      ts: this.now(),
      state,
      message: message ? truncate(message, TIMELINE_MAX_FIELD) : undefined,
    });
  }

  private dispatch(ev: Record<string, unknown>): void {
    switch (ev.type) {
      case "message_start": this.onMessageStart(ev); break;
      case "message_update": this.onMessageUpdate(ev); break;
      case "message_end": this.onMessageEnd(ev); break;
      case "tool_execution_start": this.onToolStart(ev); break;
      case "tool_execution_update": this.onToolUpdate(ev); break;
      case "tool_execution_end": this.onToolEnd(ev); break;
      default: break; // 未知事件 → 忽略
    }
  }

  // ── assistant ──

  private onMessageStart(ev: Record<string, unknown>): void {
    const msg = (ev.message ?? {}) as Record<string, unknown>;
    if (msg.role !== "assistant") return; // 只建 assistant 轨迹；user/toolResult 消息不进轨迹
    const id = typeof msg.id === "string" && msg.id ? msg.id : `assistant-${this.nextSeq()}`;
    const rec: TimelineEvent = {
      id,
      type: "assistant",
      ts: this.now(),
      text: truncate(extractVisibleText(msg.content), TIMELINE_MAX_TEXT),
      final: false,
    };
    this.activeAssistant = rec;
    this.push(rec);
  }

  private onMessageUpdate(ev: Record<string, unknown>): void {
    const ame = ev.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!ame || typeof ame !== "object") return;
    // 只取 text_delta（可见文本）；thinking_delta（隐藏推理）/ toolcall_delta /
    // start / end 等不进轨迹
    if (ame.type !== "text_delta" || typeof ame.delta !== "string") return;
    let rec = this.currentAssistant();
    if (!rec) {
      rec = { id: `assistant-${this.nextSeq()}`, type: "assistant", ts: this.now(), text: "", final: false };
      this.activeAssistant = rec;
      this.push(rec);
    }
    this.dirty = this.appendText(rec, ame.delta) || this.dirty;
  }

  private onMessageEnd(ev: Record<string, unknown>): void {
    const msg = (ev.message ?? {}) as Record<string, unknown>;
    if (msg.role !== "assistant") return; // 只完成 assistant 轨迹；user/toolResult 消息不终结、不补建
    let rec = this.currentAssistant();
    if (!rec) {
      // end 先于 start 到达（防御）：补建记录
      rec = { id: `assistant-${this.nextSeq()}`, type: "assistant", ts: this.now(), text: "", final: false };
      this.activeAssistant = rec;
      this.push(rec);
    }
    const full = extractVisibleText(msg.content);
    if (full) rec.text = truncate(full, TIMELINE_MAX_TEXT);
    rec.final = true;
    this.activeAssistant = undefined;
    this.dirty = true;
  }

  /** 当前活动 assistant 记录；若已被截断丢弃则视为不存在 */
  private currentAssistant(): TimelineEvent | undefined {
    return this.activeAssistant && this.events.includes(this.activeAssistant)
      ? this.activeAssistant
      : undefined;
  }

  /** 追加可见文本增量；返回是否有可见变化（已达上限 / 空增量 → false） */
  private appendText(rec: TimelineEvent, delta: string): boolean {
    if (!delta) return false;
    const cur = rec.text ?? "";
    if (cur.length >= TIMELINE_MAX_TEXT) return false; // 已达上限，停止累积
    rec.text = truncate(cur + delta, TIMELINE_MAX_TEXT);
    return true;
  }

  // ── tool ──

  private onToolStart(ev: Record<string, unknown>): void {
    const callId = typeof ev.toolCallId === "string" && ev.toolCallId
      ? ev.toolCallId
      : `tool-${this.nextSeq()}`;
    const rec: TimelineEvent = {
      id: callId,
      type: "tool",
      ts: this.now(),
      tool: typeof ev.toolName === "string" ? ev.toolName : "unknown",
      args: safeSerialize(ev.args, TIMELINE_MAX_FIELD),
    };
    this.activeTools.set(callId, rec);
    this.push(rec);
  }

  private onToolUpdate(ev: Record<string, unknown>): void {
    if (typeof ev.toolCallId !== "string" || !ev.toolCallId) return;
    const rec = this.activeTools.get(ev.toolCallId);
    if (!rec) return;
    rec.preview = safeSerialize(ev.partialResult ?? ev.args, TIMELINE_MAX_FIELD);
    this.dirty = true; // 原地更新预览 → 报告变化
  }

  private onToolEnd(ev: Record<string, unknown>): void {
    if (typeof ev.toolCallId !== "string" || !ev.toolCallId) return;
    let rec = this.activeTools.get(ev.toolCallId);
    if (!rec) {
      // end 先于 start 到达（防御）：补建记录
      rec = {
        id: ev.toolCallId,
        type: "tool",
        ts: this.now(),
        tool: typeof ev.toolName === "string" ? ev.toolName : "unknown",
      };
      this.activeTools.set(ev.toolCallId, rec);
      this.push(rec);
    }
    rec.result = safeSerialize(ev.result, TIMELINE_MAX_FIELD);
    rec.ok = ev.isError !== true;
    this.activeTools.delete(ev.toolCallId);
    this.dirty = true; // 原地写结果/状态 → 报告变化
  }

  // ── 有界保留 ──

  private push(ev: TimelineEvent): void {
    this.events.push(ev);
    this.dirty = true; // 新增记录 → 报告变化
    this.trim();
  }

  /** 超限时丢弃最旧记录并维护唯一的 truncated 标记（始终位于最前） */
  private trim(): void {
    if (this.events.length <= this.maxEntries) return;
    const overflow = this.events.length - this.maxEntries;
    const markerIdx = this.events.findIndex((e) => e.type === "lifecycle" && e.truncated === true);
    if (markerIdx === -1) {
      // 无标记：多丢一条腾出标记位
      const dropped = this.events.splice(0, overflow + 1).length;
      this.events.unshift(this.makeTruncMarker(dropped));
    } else {
      // 已有标记：先把它移到最前（丢弃其前的旧记录），再按需丢弃 overflow 条
      if (markerIdx > 0) this.events.splice(0, markerIdx);
      const drop = Math.max(0, overflow - markerIdx);
      if (drop > 0) this.events.splice(1, drop);
    }
  }

  private makeTruncMarker(dropped: number): TimelineEvent {
    return {
      id: `lifecycle-truncated-${this.nextSeq()}`,
      type: "lifecycle",
      ts: this.now(),
      state: "truncated",
      message: `已截断：丢弃 ${dropped} 条最旧记录`,
      truncated: true,
    };
  }
}

/** 由运行终态推导 terminal lifecycle 状态：success/failed/aborted/timeout */
export function resolveTerminalState(opts: {
  aborted: boolean;
  timedOut: boolean;
  exitCode: number;
  stopReason?: string;
}): "success" | "failed" | "aborted" | "timeout" {
  if (opts.aborted) return opts.timedOut ? "timeout" : "aborted";
  if (opts.exitCode !== 0 || opts.stopReason === "error") return "failed";
  if (opts.stopReason === "aborted") return "aborted";
  return "success";
}

// ── 小工具 ──

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/** 安全序列化任意工具参数/结果；永不抛出，非序列化数据给占位符 */
function safeSerialize(value: unknown, cap: number): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return truncate(value, cap);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const s = JSON.stringify(value);
    if (typeof s === "string") return truncate(s, cap);
  } catch {
    // 深度嵌套 / 循环引用 → fallthrough
  }
  try {
    return truncate(String(value), cap);
  } catch {
    return "[unserializable]";
  }
}

/** 提取 assistant 可见文本：string content 与 type=text 的 content part（跳过 thinking/toolCall/image） */
function extractVisibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") out += p.text;
  }
  return out;
}
