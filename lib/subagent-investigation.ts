// lib/subagent-investigation.ts — 失败调查包纯代码组装
//
// 两个文件，分两级详细度，都落在 os.tmpdir()（本机是 tmpfs 内存盘），模型只拿路径：
//   - 调查摘要（writeInvestigationFile / writeIncidentFiles）：压缩摘要，给「快速读档」
//   - 全量档（writeIncidentFiles）：任务原文 + 可见往返 + 每一步工具输出 + stderr，
//     给「回溯现场」；不截断单条字段，靠分节预算封顶
//
// 纯代码约束：只用字符串模板、截断与路径正则启发式；不调 LLM、不 spawn、不碰网络。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SubagentUsage, TimelineEvent, VisibleWorkerMessage } from "./subagent-run.ts";

export interface AttemptSnapshot {
  /** 1-based 尝试序号 */
  attempt: number;
  status: "success" | "failed" | "aborted" | "timeout";
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
  timeline: TimelineEvent[];
  /**
   * 本轮可安全展示的来回文本（任务 + assistant 可见输出）。
   * 中止/超时时也要带着：全量档要的就是它，而不是只有压缩后的 timeline。
   */
  visibleConversation?: VisibleWorkerMessage[];
  usage?: SubagentUsage;
  startedAt: string;
  finishedAt: string;
}

export interface InvestigationInput {
  task: string;
  taskId?: string;
  model?: string;
  cwd?: string;
  attempts: AttemptSnapshot[];
  finalStatus: "failed" | "aborted" | "timeout";
  maxAttempts: number;
  startedAt: string;
  finishedAt: string;
}

// ── 常量 ──

/** 内联摘要硬上限 */
export const INLINE_ERROR_MAX = 300;
export const INLINE_STEPS_MAX = 8;
export const INLINE_STEP_MAX = 120;
/** 文件内上限 */
export const FILE_TASK_MAX = 4000;
export const FILE_STEPS_MAX = 30;
export const FILE_STDERR_TAIL_MAX = 2000;
export const FILE_PATH_CLUES_MAX = 20;

/** 疑似产生文件副作用的工具名（启发式白名单；非 LLM 判定） */
const WRITE_TOOL_HINTS = new Set([
  "edit", "write", "be-write", "be-replace", "be-insert", "be-delete",
  "apply_patch", "patch", "cp", "mv", "rm", "mkdir", "rmdir", "touch", "install",
]);

// ── 小工具 ──

/** 单行化 + 截断：折叠空白、去首尾空白，超长加省略号 */
function truncateLine(s: string, max: number): string {
  const flat = String(s).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + "…";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/** tool args 预览：若 args 是 JSON 且含 command/path 字符串字段则取之，否则原样 */
function toolArgsPreview(args?: string): string {
  if (!args) return "";
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      for (const key of ["command", "path", "file", "tool"]) {
        const v = rec[key];
        if (typeof v === "string" && v) return v;
      }
    }
  } catch {
    // 非 JSON → 原样返回
  }
  return args;
}

/** 最后一个非空 errorMessage，否则 fallback 到 status */
function lastErrorText(input: InvestigationInput): string {
  for (let i = input.attempts.length - 1; i >= 0; i--) {
    const m = input.attempts[i].errorMessage;
    if (m && m.trim()) return truncate(m.trim(), INLINE_ERROR_MAX);
  }
  return input.finalStatus;
}

/** 跨 attempt 合并的 timeline（chronological） */
function concatTimelines(attempts: AttemptSnapshot[]): TimelineEvent[] {
  return attempts.flatMap((a) => a.timeline);
}

/**
 * 选取内联 last_steps：优先 tool 事件 + 终态 lifecycle + 最后一条 assistant，
 * 按原始时序排序，封顶 cap 条。每条由 formatTimelineStep 单行化并截断。
 */
function pickInlineSteps(attempts: AttemptSnapshot[], cap: number): string[] {
  const all = concatTimelines(attempts);
  const tools = all.filter((e) => e.type === "tool").slice(-Math.max(1, cap - 2));
  let termLife: TimelineEvent | undefined;
  let lastAsst: TimelineEvent | undefined;
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.type === "lifecycle" && !termLife) termLife = e;
    if (e.type === "assistant" && !lastAsst) lastAsst = e;
    if (termLife && lastAsst) break;
  }
  const picked = [...tools];
  if (termLife) picked.push(termLife);
  if (lastAsst) picked.push(lastAsst);
  return picked
    .map((e) => ({ e, idx: all.indexOf(e) }))
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.e)
    .slice(-cap)
    .map((e) => formatTimelineStep(e, INLINE_STEP_MAX));
}

/** 疑似文件副作用（仅按工具名启发式，不做 LLM 判断） */
function detectSideEffects(attempts: AttemptSnapshot[]): string {
  const touched = new Set<string>();
  for (const ev of concatTimelines(attempts)) {
    if (ev.type === "tool" && ev.tool && WRITE_TOOL_HINTS.has(ev.tool)) {
      touched.add(ev.tool);
    }
  }
  if (touched.size === 0) {
    return "否（timeline 中未见写类工具；仅工具名启发式，非 LLM 判定）";
  }
  return `是（触及工具：${[...touched].join(", ")}；仅工具名启发式，非 LLM 判定）`;
}

/** 文件名片段清洗：仅保留 [A-Za-z0-9_-]，其余折叠为 - */
function sanitizeFragment(id: string): string {
  const frag = id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return frag || "w";
}

// ── 公开 API ──

/**
 * 单条 timeline 事件 → 一行摘要。
 * - tool: `tool:<name> <ok|err> · <args preview>`
 * - assistant: `assistant · <text>`
 * - lifecycle: `lifecycle · <state> <message?>`
 * 单行化并截断到 maxLen（默认 120）。
 */
export function formatTimelineStep(ev: TimelineEvent, maxLen: number = INLINE_STEP_MAX): string {
  let line: string;
  switch (ev.type) {
    case "tool":
      line = `tool:${ev.tool ?? "unknown"} ${ev.ok ? "ok" : "err"} · ${toolArgsPreview(ev.args)}`;
      break;
    case "assistant":
      line = `assistant · ${ev.text ?? ""}`;
      break;
    case "lifecycle": {
      const msg = ev.message && ev.message !== ev.state ? ` ${ev.message}` : "";
      line = `lifecycle · ${ev.state ?? ""}${msg}`;
      break;
    }
    default:
      line = `? · ${String((ev as { state?: string }).state ?? "")}`;
  }
  return truncateLine(line, maxLen);
}

/**
 * 从 tool 事件的 args/result/preview 中启发式抽取路径线索。
 * 保守正则 + 去重 + 有界（默认 20 条）。best-effort，允许为空。
 */
export function extractPathClues(timelines: TimelineEvent[][], limit: number = FILE_PATH_CLUES_MAX): string[] {
  const TOKEN_RE = /[A-Za-z0-9_./~-]*\/[A-Za-z0-9_./~-]+|[A-Za-z0-9_./~-]+\.[A-Za-z0-9]{1,6}/g;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tl of timelines) {
    for (const ev of tl) {
      if (ev.type !== "tool") continue;
      for (const field of [ev.args, ev.preview, ev.result]) {
        if (!field) continue;
        for (const m of field.matchAll(TOKEN_RE)) {
          let token = m[0];
          if (/^(?:https?|file|ftp|ws):\/\//i.test(token)) continue; // 排除 URL
          token = token.replace(/[)\]}"',;:]+$/, "");
          if (token.length < 2) continue;
          if (/^[\d.]+$/.test(token)) continue; // 排除纯数字/版本号
          if (!token.includes("/") && !/\.[A-Za-z0-9]{1,6}$/.test(token)) continue;
          if (seen.has(token)) continue;
          seen.add(token);
          out.push(token);
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

/**
 * 内联短摘要。硬上限：error ≤300、last_steps ≤8 且每条 ≤120。
 * 不写文件、不调 LLM；investigationPath 存在时附路径与读档提示。
 */
export function buildInlineSummary(input: InvestigationInput, investigationPath?: string, transcriptPath?: string): string {
  const lines: string[] = [];
  lines.push(`FAILED attempts=${input.attempts.length}/${input.maxAttempts} final=${input.finalStatus}`);
  lines.push(`  error: ${lastErrorText(input)}`);
  lines.push(`  last_steps:`);
  for (const step of pickInlineSteps(input.attempts, INLINE_STEPS_MAX)) {
    lines.push(`  - ${step}`);
  }
  if (investigationPath) lines.push(`  investigation: ${investigationPath}`);
  if (transcriptPath) lines.push(`  transcript: ${transcriptPath}`);
  lines.push(`  读档：摘要看 investigation，复用已做侦察看 transcript；两者都是本地文件，不要整文件灌回上下文`);
  return lines.join("\n");
}

export interface IncidentFileOptions {
  /** 同目录的全量档路径；有就写进读档指引 */
  transcriptPath?: string;
}

/** 组装调查文件正文（固定 md 章节模板） */
function buildFileBody(input: InvestigationInput, opts: IncidentFileOptions = {}): string {
  const lastErr = lastErrorText(input);
  const lastAttempt = input.attempts[input.attempts.length - 1];
  const stderrTail = lastAttempt && lastAttempt.stderr.length > FILE_STDERR_TAIL_MAX
    ? "…" + lastAttempt.stderr.slice(-FILE_STDERR_TAIL_MAX)
    : (lastAttempt?.stderr ?? "");
  const all = concatTimelines(input.attempts);
  const lastSteps = all.slice(-FILE_STEPS_MAX).map((e) => `- ${formatTimelineStep(e)}`).join("\n");
  const clues = extractPathClues(input.attempts.map((a) => a.timeline));
  const cluesLines = clues.length > 0
    ? clues.map((c) => `- ${c}`).join("\n")
    : "- （timeline 中未抽取到路径线索）";

  const attemptLines = input.attempts.map((a) => {
    const exit = a.exitCode !== undefined ? String(a.exitCode) : "-";
    const stop = a.stopReason ?? "-";
    const msg = a.errorMessage ?? "-";
    return `- #${a.attempt} ${a.status}: exit=${exit} stopReason=${stop} msg=${msg}`;
  }).join("\n");

  return [
    "# Subagent 调查摘要",
    "",
    "## 读档指引（主 agent）",
    "1. 先看「最终结论」与「最后步骤」",
    `2. 需要看完整可见往返/每一步工具输出时，读同目录的全量档${opts.transcriptPath ? `（${opts.transcriptPath}）` : "（transcript）"}`,
    "3. 需要复用已做侦察时，按「线索」里的路径去 read/diff 磁盘现状",
    "4. 不要整文件灌回上下文；本文件已是压缩摘要，全量档也只分段读",
    "",
    "## 元信息",
    `- taskId: ${input.taskId ?? "-"}`,
    `- model: ${input.model ?? "-"}`,
    `- cwd: ${input.cwd ?? "-"}`,
    `- attempts: ${input.attempts.length}/${input.maxAttempts}`,
    `- maxAttempts: ${input.maxAttempts}`,
    `- finalStatus: ${input.finalStatus}`,
    `- lastError: ${lastErr}`,
    `- startedAt: ${input.startedAt}`,
    `- finishedAt: ${input.finishedAt}`,
    "",
    "## 任务",
    truncate(input.task, FILE_TASK_MAX),
    "",
    "## 最终结论",
    `失败原因：${lastErr}`,
    `疑似已产生文件副作用：${detectSideEffects(input.attempts)}`,
    "",
    "## Attempt 摘要",
    attemptLines,
    "",
    `## 最后步骤（跨 attempt 合并，最多 ~${FILE_STEPS_MAX} 条 timeline）`,
    lastSteps,
    "",
    "## 线索",
    cluesLines,
    "",
    "stderr 尾部（最后一次 attempt，≤2k）:",
    "```",
    stderrTail || "（无 stderr）",
    "```",
    "",
  ].join("\n");
}

/**
 * 写出轻量调查文件并返回绝对路径。
 * 目录：os.tmpdir()/pi-subagent-inv-XXXXXX；文件：<taskId 清洗>|<w>-<ts>.md；
 * mode 0o600（平台允许处生效）。写失败直接抛出，由调用方决定是否吞掉
 * （Task 3 应在 catch 中原失败优先，写文件错误不掩盖原始终态）。
 */
export function writeInvestigationFile(input: InvestigationInput): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-inv-"));
  const frag = sanitizeFragment(input.taskId ?? "w");
  const file = path.join(dir, `${frag}-${Date.now()}.md`);
  fs.writeFileSync(file, buildFileBody(input), { encoding: "utf-8", mode: 0o600 });
  return file;
}
// ── 全量档（内存盘） ──

/**
 * 全量档总量上限（字节）。
 *
 * 写的是 os.tmpdir()，本机是 tmpfs（内存盘），所以不能敞开写：一个疯跑的 worker
 * 的可见往返没有条数上限，不封顶就能把内存吃掉一块。超限按分节预算裁，裁了要说。
 */
export const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;
/** 可见往返分节预算 */
export const TRANSCRIPT_CONVERSATION_BYTES = 1_500_000;
/** 时间线分节预算（此处不逐条截断，靠分节总量兜） */
export const TRANSCRIPT_TIMELINE_BYTES = 1_500_000;
/** stderr 分节预算 */
export const TRANSCRIPT_STDERR_BYTES = 200_000;

/** 保留首尾、中间折叠：两端都是有用信息（开头有任务，结尾有最新动向） */
function capMiddle(text: string, maxBytes: number): { text: string; dropped: number } {
  const size = Buffer.byteLength(text, "utf8");
  if (size <= maxBytes) return { text, dropped: 0 };
  const keep = Math.max(1, Math.floor(maxBytes / 2));
  const buf = Buffer.from(text, "utf8");
  const head = buf.subarray(0, keep).toString("utf8");
  const tail = buf.subarray(buf.length - keep).toString("utf8");
  return {
    text: `${head}\n\n…（此处省略 ${size - keep * 2} 字节，超出该分节预算）…\n\n${tail}`,
    dropped: size - keep * 2,
  };
}

/** 事件 → 全量档用的一行/一块（不做 INLINE_STEP_MAX 那种 120 字截断） */
function transcriptEventBlock(ev: TimelineEvent): string {
  switch (ev.type) {
    case "tool":
      return [
        `- tool: ${ev.tool ?? "unknown"} ${ev.ok === undefined ? "(running)" : ev.ok ? "ok" : "err"}`,
        ev.args ? `  args: ${ev.args}` : "",
        ev.preview ? `  preview: ${ev.preview}` : "",
        ev.result ? `  result: ${ev.result}` : "",
      ].filter(Boolean).join("\n");
    case "assistant":
      return `- assistant: ${ev.text ?? ""}`;
    case "lifecycle": {
      const msg = ev.message && ev.message !== ev.state ? ` ${ev.message}` : "";
      return `- lifecycle: ${ev.state ?? ""}${msg}`;
    }
    default:
      return `- ? ${JSON.stringify(ev)}`;
  }
}

/** 拼全量档正文（可单测；写盘由 writeIncidentFiles 负责） */
export function buildTranscriptBody(input: InvestigationInput): string {
  const head = [
    "# Subagent 全量档（内存盘）",
    "",
    "这份是给「回溯现场」用的原始可见轨迹：任务原文、可见往返、每一步工具调用与输出、stderr。",
    "它不进入主 agent 的上下文，主 agent 只会拿到这个文件路径（需要时自己分段 read）。",
    "隐藏 reasoning 与原始消息对象不在其中（本模块从不保存它们）。",
    "",
    "## 元信息",
    `- taskId: ${input.taskId ?? "-"}`,
    `- model: ${input.model ?? "-"}`,
    `- cwd: ${input.cwd ?? "-"}`,
    `- finalStatus: ${input.finalStatus}`,
    `- attempts: ${input.attempts.length}/${input.maxAttempts}`,
    `- startedAt: ${input.startedAt}`,
    `- finishedAt: ${input.finishedAt}`,
    "",
    "## 任务原文",
    input.task,
    "",
  ].join("\n");

  const meta = input.attempts.map((a) => {
    const exit = a.exitCode !== undefined ? String(a.exitCode) : "-";
    return `- #${a.attempt} ${a.status}: exit=${exit} stopReason=${a.stopReason ?? "-"} msg=${a.errorMessage ?? "-"} ${a.startedAt} → ${a.finishedAt}`;
  }).join("\n");

  const conversation = input.attempts.flatMap((a) =>
    (a.visibleConversation ?? []).map((m) => `### [attempt ${a.attempt}] ${m.role} · ${m.ts}\n\n${m.content}`),
  ).join("\n\n");
  const conversationCapped = capMiddle(conversation, TRANSCRIPT_CONVERSATION_BYTES);

  const timeline = input.attempts.flatMap((a) =>
    a.timeline.map((ev) => `### [attempt ${a.attempt}]\n${transcriptEventBlock(ev)}`),
  ).join("\n");
  const timelineCapped = capMiddle(timeline, TRANSCRIPT_TIMELINE_BYTES);

  const stderr = input.attempts
    .map((a) => (a.stderr.trim() ? `### [attempt ${a.attempt}]\n${a.stderr}` : ""))
    .filter(Boolean)
    .join("\n\n");
  const stderrCapped = capMiddle(stderr, TRANSCRIPT_STDERR_BYTES);

  const notes: string[] = [];
  if (conversationCapped.dropped > 0) notes.push(`可见往返裁掉 ${conversationCapped.dropped} 字节`);
  if (timelineCapped.dropped > 0) notes.push(`时间线裁掉 ${timelineCapped.dropped} 字节`);
  if (stderrCapped.dropped > 0) notes.push(`stderr 裁掉 ${stderrCapped.dropped} 字节`);

  return [
    head,
    "## Attempt 摘要",
    meta || "（无）",
    "",
    `## 可见往返（attempt 内按发生顺序；总量上限 ${TRANSCRIPT_CONVERSATION_BYTES} 字节）`,
    conversationCapped.text || "（无可见往返）",
    "",
    `## 执行轨迹（完全不截断单条字段；总量上限 ${TRANSCRIPT_TIMELINE_BYTES} 字节）`,
    timelineCapped.text || "（无轨迹）",
    "",
    `## stderr（上限 ${TRANSCRIPT_STDERR_BYTES} 字节）`,
    "```",
    stderrCapped.text || "（无 stderr）",
    "```",
    "",
    "## 裁剪说明",
    notes.length > 0 ? notes.map((n) => `- ${n}`).join("\n") : "- 未裁剪",
    "",
  ].join("\n");
}

/**
 * 一次写出调查摘要与全量档（同一个内存盘目录，两个文件互相引用）。
 * 写失败直接抛，调用方决定是否吞掉（原始失败优先）。
 */
export function writeIncidentFiles(input: InvestigationInput): { dir: string; investigationPath: string; transcriptPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-inv-"));
  const frag = sanitizeFragment(input.taskId ?? "w");
  const stamp = Date.now();
  const investigationPath = path.join(dir, `${frag}-${stamp}.md`);
  const transcriptPath = path.join(dir, `${frag}-${stamp}-transcript.md`);
  fs.writeFileSync(investigationPath, buildFileBody(input, { transcriptPath }), { encoding: "utf-8", mode: 0o600 });
  fs.writeFileSync(transcriptPath, buildTranscriptBody(input), { encoding: "utf-8", mode: 0o600 });
  return { dir, investigationPath, transcriptPath };
}
