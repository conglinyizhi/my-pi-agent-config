/**
 * 活动 worker 的取消句柄表。
 *
 * 批次共用一个 AbortSignal 时，停一个 worker 只能连坐它的兄弟；这张表给每个
 * worker 自己的句柄，/subagent:stop 与 /subagent:stop-all 从这里取。
 *
 * 只活在主进程内存里：worker 进程由 runSubagent 管理，跑完即注销。命令层拿到的
 * batchId/workerId 与状态快照同源，展示信息从快照拼，这里只管「怎么停」。
 */

import { makeUserStopReason } from "../../lib/subagent-run.ts";

export interface WorkerKey {
  batchId: string;
  workerId: string;
}

/** key 分隔符：batchId 与 workerId 都只含 [A-Za-z0-9_-]，正斜杠不会出现在其中 */
const KEY_SEP = "/";
/** 与 inbox id 同一套字符集：命令层要拿它反查状态快照，不允许含分隔符或空白 */
const KEY_PART = /^[A-Za-z0-9_-]+$/;

export function isValidWorkerKey(key: WorkerKey): boolean {
  return KEY_PART.test(key.batchId) && KEY_PART.test(key.workerId);
}

export function formatWorkerKey(key: WorkerKey): string {
  return `${key.batchId}${KEY_SEP}${key.workerId}`;
}

export function parseWorkerKey(raw: string): WorkerKey | undefined {
  const at = raw.indexOf(KEY_SEP);
  if (at <= 0 || at === raw.length - 1) return undefined;
  const key = { batchId: raw.slice(0, at), workerId: raw.slice(at + 1) };
  return isValidWorkerKey(key) ? key : undefined;
}

const controllers = new Map<string, AbortController>();

/**
 * 登记一个 worker 的取消句柄。
 * 同 key 重复登记以最后一次为准：重试轮次会重建子进程，旧句柄停不到新进程。
 * 畸形 key 直接拒收：命令层拿到的条目必须停得掉，宁可少一条也不能给个假把手。
 */
export function registerWorkerAbort(key: WorkerKey, controller: AbortController): void {
  if (!isValidWorkerKey(key)) return;
  controllers.set(formatWorkerKey(key), controller);
}

export function unregisterWorkerAbort(key: WorkerKey): void {
  controllers.delete(formatWorkerKey(key));
}

/** 当前还在跑的 worker（未收尾的都算，含暂存中）。顺序按登记先后。 */
export function listActiveWorkers(): WorkerKey[] {
  const out: WorkerKey[] = [];
  for (const raw of controllers.keys()) {
    const key = parseWorkerKey(raw);
    if (key) out.push(key);
  }
  return out;
}

/**
 * 停一个 worker。
 * reason 会挂到 abort reason 上，最终进诊断档案，所以命令层要给出「为什么停」。
 * 返回 false 表示该 worker 已经不在表里（跑完了，或从未登记）。
 */
export function stopWorker(key: WorkerKey, reason: string): boolean {
  const controller = controllers.get(formatWorkerKey(key));
  if (!controller) return false;
  // 用带标记的 reason：命令层允许「不写理由直接确认」，那时 reason 是空串，
  // 光看文本分不出这是一次人为叫停；worker 侧据此把「用户叫停」和超时/失联分开措辞
  if (!controller.signal.aborted) controller.abort(makeUserStopReason(reason));
  return true;
}

export function stopAllWorkers(reason: string): number {
  let stopped = 0;
  for (const controller of controllers.values()) {
    if (controller.signal.aborted) continue;
    controller.abort(makeUserStopReason(reason));
    stopped++;
  }
  return stopped;
}

/** 测试与「换批次」时的清理口 */
export function resetActiveWorkers(): void {
  controllers.clear();
}
