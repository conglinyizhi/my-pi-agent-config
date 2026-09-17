/**
 * /subagent:stop 与 /subagent:stop-all 的交互流程。
 *
 * 三屏：选 worker（stop-all 跳过）→ 选确认方式 → 选填理由。取消在任何一屏都能退出，
 * 且取消之后绝不停任何东西：这个命令是强停，误触的代价比多点一次大得多。
 *
 * UI 与「怎么停」都从参数进来，流程本身不碰 pi API，便于按屏断言。
 */

import type { WorkerRun } from "./status.ts";
import { STATUS_LABEL } from "./dispatch-view.ts";
import { formatWorkerKey, type WorkerKey } from "./active-workers.ts";

export const CONFIRM_WITH_REASON = "额外填写理由后确认";
export const CONFIRM_WITHOUT_REASON = "不书写理由直接确认";
export const CANCEL = "取消";

export interface StopUi {
  select: (title: string, options: string[]) => Promise<string | undefined>;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
  notify: (message: string, level: "info" | "warning" | "error") => void;
}

export interface StopCommandDeps {
  /** 当前还在跑的 worker（未收尾的都算，含暂存中） */
  listActive: () => WorkerKey[];
  /** 状态快照，用于把 key 翻成你认得出的那一行 */
  snapshot: () => WorkerRun[];
  stopOne: (key: WorkerKey, reason: string) => boolean;
  stopAll: (reason: string) => number;
}

/** 理由为空时也要能在诊断里区分「没写」和「写了空串」 */
export type ReasonOutcome = { confirmed: false } | { confirmed: true; reason?: string };

function firstLine(text: string, limit = 48): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

function elapsedText(startedAt: string, now = Date.now()): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "耗时未知";
  const secs = Math.max(0, Math.round((now - started) / 1000));
  if (secs < 60) return `已跑 ${secs}s`;
  return `已跑 ${Math.floor(secs / 60)}m${secs % 60}s`;
}

/** 第二屏的选项文本：先认出是哪个 worker，再决定停不停 */
export function describeWorker(key: WorkerKey, run: WorkerRun | undefined): string {
  if (!run) return `${key.workerId} · 状态未知`;
  const parts = [key.workerId, STATUS_LABEL[run.status], elapsedText(run.startedAt)];
  const task = firstLine(run.task);
  if (task) parts.push(task);
  return parts.join(" · ");
}

/**
 * 三选一确认屏。返回 confirmed:false 表示取消（含直接关掉对话框）。
 * 选「填写理由」但输入为空，按「不写理由」处理：理由本来就是可选的。
 */
export async function askReason(
  ui: StopUi,
  title: string,
): Promise<ReasonOutcome> {
  const choice = await ui.select(title, [CONFIRM_WITH_REASON, CONFIRM_WITHOUT_REASON, CANCEL]);
  if (!choice || choice === CANCEL) return { confirmed: false };
  if (choice === CONFIRM_WITHOUT_REASON) return { confirmed: true };
  const typed = await ui.input("停下它的理由（可留空）：");
  const reason = typed?.trim();
  return { confirmed: true, reason: reason ? reason : undefined };
}

/** 停一个：选人 → 三选一 → 执行 */
export async function runStopCommand(ui: StopUi, deps: StopCommandDeps): Promise<void> {
  const keys = deps.listActive();
  if (keys.length === 0) {
    ui.notify("subagent: 当前没有在跑的 worker", "info");
    return;
  }
  const snapshot = deps.snapshot();
  const byId = new Map(snapshot.map((run) => [run.id, run]));
  const labels = keys.map((key) => describeWorker(key, byId.get(key.workerId)));
  // 同批可能存在同名 workerId，选项重复时 select 的返回值无法反查：用 index 后缀兜住
  const unique = labels.map((label, i) =>
    labels.indexOf(label) === i ? label : `${label} [${formatWorkerKey(keys[i])}]`
  );
  const picked = await ui.select("强制停下哪个 worker？", unique);
  if (!picked) return; // 取消
  const at = unique.indexOf(picked);
  if (at < 0) return;
  const key = keys[at];

  const outcome = await askReason(ui, `确认停下 ${key.workerId}？`);
  if (!outcome.confirmed) return;

  const reason = outcome.reason ?? "";
  const stopped = deps.stopOne(key, reason);
  if (!stopped) {
    ui.notify(`${key.workerId} 已经不在跑了`, "warning");
    return;
  }
  ui.notify(reason ? `已停 ${key.workerId}：${reason}` : `已停 ${key.workerId}`, "info");
}

/** 停全部：跳过选人，直接三选一 */
export async function runStopAllCommand(ui: StopUi, deps: StopCommandDeps): Promise<void> {
  const keys = deps.listActive();
  if (keys.length === 0) {
    ui.notify("subagent: 当前没有在跑的 worker", "info");
    return;
  }
  const outcome = await askReason(ui, `确认停下全部 ${keys.length} 个 worker？`);
  if (!outcome.confirmed) return;

  const reason = outcome.reason ?? "";
  const stopped = deps.stopAll(reason);
  ui.notify(
    reason ? `已停 ${stopped} 个 worker：${reason}` : `已停 ${stopped} 个 worker`,
    stopped > 0 ? "info" : "warning",
  );
}
