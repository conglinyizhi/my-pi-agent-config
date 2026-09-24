// held-report.ts — 暂存回报的纯代码组装
//
// 为什么单独抽出来：worker 停在检查点上时，主 agent 手里只有「谁停了、跑了多久、为什么停」，
// 没有任何产物，于是很容易闭眼续跑或闭眼收工。这里把「暂停瞬间的可见产物」压成有界几行，
// 塞进暂存回报，让续/停的决定至少踩在产物上。
//
// 内容只取 worker 自己产出的可见部分（可见往返、工具步骤、stderr），不碰隐藏 reasoning。

import type { TimelineEvent, VisibleWorkerMessage } from "../../lib/subagent-run.ts";
import { formatDuration } from "./dispatch-view.ts";

/** 最新一段产物的字符预算（超了留尾部：最新动向最有用） */
export const HELD_TEXT_BUDGET = 800;
/** 列出的最后工具步骤条数 */
export const HELD_STEP_COUNT = 3;
/** 单条工具步骤的字符预算 */
export const HELD_STEP_BUDGET = 160;
/** stderr 尾巴预算 */
export const HELD_STDERR_BUDGET = 400;

export interface HeldWorkerArtifact {
  workerId: string;
  elapsedMs: number;
  reason: "budget" | "worker";
  /** worker 写过的可见文本（含任务本身与 assistant 输出） */
  conversation?: VisibleWorkerMessage[];
  /** 有界执行轨迹 */
  timeline?: TimelineEvent[];
  stderr?: string;
  /** 兜底输出（没有可见往返时用） */
  output?: string;
}

function tail(text: string, budget: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= budget) return flat;
  return `…${flat.slice(flat.length - budget)}`;
}

/** 最新一条 assistant 文本；没有就退回 output */
function latestArtifact(a: HeldWorkerArtifact): string | undefined {
  const conv = a.conversation ?? [];
  for (let i = conv.length - 1; i >= 0; i--) {
    const text = conv[i]?.content?.trim();
    if (text) return text;
  }
  const output = a.output?.trim();
  return output ? output : undefined;
}

function stepLine(ev: TimelineEvent): string | undefined {
  if (ev.type === "tool") {
    const status = ev.ok === undefined ? "running" : ev.ok ? "ok" : "err";
    const args = ev.args ? ` · ${ev.args}` : "";
    return `tool:${ev.tool ?? "?"} ${status}${args}`;
  }
  if (ev.type === "lifecycle") return `lifecycle:${ev.state ?? "?"}${ev.message ? ` · ${ev.message}` : ""}`;
  if (ev.type === "assistant") return `assistant · ${ev.text ?? ""}`;
  return undefined;
}

/** 最后几步工具/生命周期步骤（时序保持，去掉与「最新一段产物」重复的 assistant 事件） */
function lastSteps(a: HeldWorkerArtifact): string[] {
  const events = (a.timeline ?? []).filter((ev) => ev.type !== "assistant");
  return events
    .slice(-HELD_STEP_COUNT)
    .map((ev) => stepLine(ev))
    .filter((line): line is string => Boolean(line))
    .map((line) => tail(line, HELD_STEP_BUDGET));
}

/**
 * 一个暂存 worker 的回报块（首行是「谁、跑了多久、为什么停」，后面是产物）。
 * 有产物就列出来，没有就明说没有：留白比一句「无产物」更容易被误读成「不重要」。
 */
export function formatHeldArtifact(a: HeldWorkerArtifact): string[] {
  const why = a.reason === "budget" ? "时间预算快用完了" : "worker 主动请求";
  const lines = [`  ${a.workerId} 已跑 ${formatDuration(a.elapsedMs)} · ${why}`];
  const artifact = latestArtifact(a);
  if (artifact) {
    lines.push(`    最新产物：${tail(artifact, HELD_TEXT_BUDGET)}`);
  } else {
    lines.push("    最新产物：（暂停瞬间还没有可见输出）");
  }
  for (const step of lastSteps(a)) lines.push(`    最后步骤：${step}`);
  const stderr = a.stderr?.trim();
  if (stderr) lines.push(`    stderr 尾：${tail(stderr, HELD_STDERR_BUDGET)}`);
  return lines;
}

export interface HeldReportInput {
  batchId: string;
  held: HeldWorkerArtifact[];
  /** 本批已完成（success）的 worker 数 */
  finishedCount: number;
}

/** 续跑预算下限（秒） */
export const RESUME_MIN_SECONDS = 5;
/**
 * 续跑预算上限（秒）。
 *
 * 上限不是护沙盘，是防手滑：模型顺手写个 86400 就等于「随便跑」，「限时」就名存实亡。
 * 真的需要更长，就把活拆小再续。
 */
export const RESUME_MAX_SECONDS = 3600;

export interface ResumeDecisionInput {
  worker_id?: unknown;
  action?: unknown;
  extra_seconds?: unknown;
}

/**
 * 校验续跑决定（纯函数）。返回给模型看的错误文案；全部合格返回 undefined。
 *
 * continue 必须显式给 extra_seconds：隐式默认值会让「续多久」这个决定滑过去，
 * 而它直接决定这次能跑到哪个交付点。
 */
export function validateResumeDecisions(decisions: unknown): string | undefined {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return "subagent_resume：decisions 不能为空，至少要处理一个 worker。";
  }
  const problems: string[] = [];
  for (const raw of decisions as ResumeDecisionInput[]) {
    const id = typeof raw?.worker_id === "string" && raw.worker_id ? raw.worker_id : "（缺 worker_id）";
    if (raw?.action !== "continue") continue;
    const seconds = raw.extra_seconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
      problems.push(`${id}：action=continue 时必须给 extra_seconds（${RESUME_MIN_SECONDS} 到 ${RESUME_MAX_SECONDS} 秒）`);
      continue;
    }
    if (seconds < RESUME_MIN_SECONDS || seconds > RESUME_MAX_SECONDS) {
      problems.push(`${id}：extra_seconds=${seconds} 超出 ${RESUME_MIN_SECONDS} 到 ${RESUME_MAX_SECONDS} 秒`);
    }
  }
  if (problems.length === 0) return undefined;
  return [
    "subagent_resume：参数不合格，未执行任何决定（这批还停在检查点上）。",
    ...problems.map((p) => `- ${p}`),
    `限时按「这步活能跑到哪个交付点」给（上限 ${RESUME_MAX_SECONDS} 秒）；真要更久，先把活拆小。`,
  ].join("\n");
}

/**
 * 暂存回报正文。除了逐个 worker 的产物，还要说清「检查点不是无限期等」：
 * 没人接管时父侧按收工结算，模型拖过头就白扔一截进度。
 */
export function formatHeldReport(input: HeldReportInput): string {
  const example = input.held
    .map((h) => `{ worker_id: "${h.workerId}", action: "continue", extra_seconds: 300 }`)
    .join(", ");
  return [
    `subagent 暂存：${input.held.length} 个 worker 停在检查点上等你决定（本批已完成 ${input.finishedCount} 个）`,
    ...input.held.flatMap((h) => formatHeldArtifact(h)),
    "",
    "先看上面的产物再决定续/停：续就把 extra_seconds 给足到这步活能告一段落，停就带着现有产物收工",
    `续跑：subagent_resume({ batch_id: "${input.batchId}", decisions: [${example}] })`,
    "extra_seconds 必填（秒，5 到 3600）；检查点不会无限期等，长时间没人接管会按收工结算",
  ].join("\n");
}
