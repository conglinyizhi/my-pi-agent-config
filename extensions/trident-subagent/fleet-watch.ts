// fleet-watch.ts — 把运行时快照推到当前工具行
//
// 同一份内存快照（status.ts）已经同时喂 GUI 和 TUI。工具行只在本次 execute
// 活着的时候收帧：subagent 暂存返回后那一行冻住，续跑由 subagent_resume 另开
// 一行再订一次。这里不 beginBatch、不改 snapshot，只订阅。
//
// 两条限流叠加：
//   - 快照变更经 coalescer 合并（N 个 worker 各自更新 → 最多每 emitIntervalMs 一次）
//   - 无事件时 tick 仍重投影，静默时长和秒级耗时才不会冻在 0
//
// 最后一次必然送达：stop() 先退订、停 tick，再 flush。

import { createCoalescer, projectFleet, type CoalescerScheduler } from "./dispatch-view.ts";
import { getSnapshot, onSnapshotChange, type WorkerRun } from "./status.ts";

/**
 * fleet 实时投影投递间隔：N 个 worker 的更新合并到这一档，足够「看得出在动」。
 */
export const FLEET_EMIT_INTERVAL_MS = 150;
/**
 * fleet 节拍：即使所有 worker 都无事件也要定期重投影。
 *
 * 两个作用：
 *   - 静默/耗时能真正往前走（否则「卡了 40 秒」永远是 0，回到看不出死活的老问题）；
 *   - 行组件在纯思考期也有帧可刷。
 *
 * 250ms 比显示精度（秒级）高至少一档：无事件时秒数最多晚 250ms 才翻。
 */
export const FLEET_TICK_MS = 250;

export type FleetWatchOnUpdate = (partial: {
  content: [{ type: "text"; text: string }];
  details: { phase: "running"; fleet: ReturnType<typeof projectFleet> };
}) => void;

export interface FleetWatchScheduler extends CoalescerScheduler {
  interval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: { unref?: () => void }) => void;
}

export interface WatchFleetOptions {
  emitIntervalMs?: number;
  tickMs?: number;
  now?: () => number;
  scheduler?: FleetWatchScheduler;
  getWorkers?: () => WorkerRun[];
  subscribe?: (listener: (workers: WorkerRun[]) => void) => () => void;
  summarize?: (workers: WorkerRun[]) => string;
}

export interface FleetWatch {
  /** 立即送达挂起帧并退订；重复调用是空操作 */
  stop: () => void;
}

/**
 * 工具文本面的摘要行（模型可见）。
 *
 * 刻意只放一行计数：表格、吞吐、sparkline 全部走 details + renderResult，
 * 不经 content 进模型上下文。
 */
export function fleetSummaryText(workers: WorkerRun[]): string {
  const total = workers.length;
  const queued = workers.filter((w) => w.status === "queued").length;
  const done = workers.filter((w) => w.status === "success").length;
  const bad = workers.filter((w) => w.status === "failed" || w.status === "aborted" || w.status === "timeout").length;
  const wait = workers.filter((w) => w.status === "needs_approval").length;
  const holding = workers.filter((w) => w.status === "holding").length;
  const running = Math.max(0, total - queued - done - bad - wait - holding);
  const extras: string[] = [];
  if (queued > 0) extras.push(`${queued} 排队中`);
  if (holding > 0) extras.push(`${holding} 暂存`);
  const capacity = extras.length > 0 ? `（${extras.join("，")}）` : "";
  return `${total} 个 subagent：运行 ${running} / 完成 ${done} / 异常 ${bad} / 等待权限 ${wait}${capacity}（表格见工具行，/subagent:gui 可开实时窗口）`;
}

/**
 * 订阅当前批次快照，把投影推给这次工具调用的 onUpdate。
 *
 * 不替换 snapshot。resume 路径必须走这里，不能再 beginBatch。
 */
export function watchFleet(onUpdate: FleetWatchOnUpdate | undefined, opts: WatchFleetOptions = {}): FleetWatch {
  const emitIntervalMs = opts.emitIntervalMs ?? FLEET_EMIT_INTERVAL_MS;
  const tickMs = opts.tickMs ?? FLEET_TICK_MS;
  const now = opts.now ?? (() => Date.now());
  const getWorkers = opts.getWorkers ?? getSnapshot;
  const subscribe = opts.subscribe ?? onSnapshotChange;
  const summarize = opts.summarize ?? fleetSummaryText;
  const scheduleInterval = opts.scheduler?.interval ?? ((fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  });
  const clearTick = opts.scheduler?.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));

  const emitFleet = createCoalescer<WorkerRun[]>(emitIntervalMs, (workers) => {
    onUpdate?.({
      content: [{ type: "text", text: summarize(workers) }],
      details: { phase: "running", fleet: projectFleet(workers, now()) },
    });
  }, opts.scheduler);

  const unsubscribe = subscribe((workers) => emitFleet.push(workers));
  emitFleet.push(getWorkers());
  const tick = scheduleInterval(() => emitFleet.push(getWorkers()), tickMs);
  tick.unref?.();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      clearTick(tick);
      emitFleet.flush();
    },
  };
}
