// silence.ts — 静默崩溃：worker 多久没动静算崩，以及哪些情况不算静默
//
// 背景：worker 卡住时（上游流断开、模型不回、进程僵着），界面上只有一行「静默 40s」，
// 它却会一直占着并发槽位，直到预算用完才收场。这里立一条线：静默超过阈值即判崩溃，
// 标记状态并中止，让结果尽快回到主 agent 手里。
//
// 豁免（与 dispatch-view 显示的是**同一套判定**，共用这里的函数）：在跑工具、等审批、
// 暂存中、排队中。`go build` 两分钟没输出落在「在跑工具」那一类，不该判崩。
// 不豁免的：启动后一声不吭（上游握手就卡住也属这一类）。
//
// 判定纯函数放这里，看门狗（batch.ts）只负责定时调用 + 中止。

import type { TimelineEvent } from "../../lib/subagent-run.ts";
import type { WorkerRun } from "./status.ts";

/** 静默多久判定崩溃 */
export const SILENT_CRASH_MS = 30_000;
/** 看门狗检查间隔 */
export const CRASH_CHECK_INTERVAL_MS = 5_000;

/** 最后一条非 lifecycle 事件：判断「工具还在飞」只看它 */
export function lastNonLifecycle(events: readonly TimelineEvent[]): TimelineEvent | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type !== "lifecycle") return events[i];
	}
	return undefined;
}

/** 有没有工具还没回来（尾部 tool 事件 ok 未定） */
export function hasToolInFlight(run: WorkerRun): boolean {
	const tail = lastNonLifecycle(run.timeline ?? []);
	return tail?.type === "tool" && tail.ok === undefined;
}

/** 距最近一次活动的静默时长（已终态为 0） */
export function silentMsOf(run: WorkerRun, nowMs: number): number {
	if (run.finishedAt !== undefined) return 0;
	const lastActivityMs = run.lastActivityAt ? Date.parse(run.lastActivityAt) : Date.parse(run.startedAt);
	if (!Number.isFinite(lastActivityMs)) return 0;
	return Math.max(0, nowMs - lastActivityMs);
}

/** 静默这一维不看的几类：它们不是「卡了」，是在等别的东西 */
const EXEMPT_STATUSES: ReadonlySet<string> = new Set(["queued", "needs_approval", "holding"]);

export interface SilentCrash {
	/** 判崩溃时的静默时长（毫秒） */
	silentMs: number;
	/** 给人/给模型看的一句说明 */
	reason: string;
}

/** 看门狗参数：runs / markStatus 由调用方注入，本模块不直接读状态库 */
export interface SilenceWatchOptions {
	/**
	 * 本批在飞的 worker（调用方自己过滤）。
	 * 过滤不能只按 worker id：状态快照是全局的，挂起批次与新批次的 id 会撞名（都是 w1），
	 * 按批内唯一的 inboxId 过滤才不会去动别人的 worker。
	 */
	runs: () => WorkerRun[];
	/** 取消句柄（判崩后中止用），键是 worker id */
	controllers: ReadonlyMap<string, AbortController>;
	/** 崩溃标记表：看门狗写，终态读（applyCrashMark），保证崩溃不被 aborted 盖掉 */
	marks: Map<string, SilentCrash>;
	/** 判定那一刻立刻写状态（生产：status.ts 的 updateWorker） */
	markStatus: (run: WorkerRun, crash: SilentCrash) => void;
	/** 判定阈值（缺省 SILENT_CRASH_MS） */
	thresholdMs?: number;
	intervalMs?: number;
	now?: () => number;
	onCrash?: (run: WorkerRun, crash: SilentCrash) => void;
}

/**
 * 这条 worker 是不是静默崩了。
 *
 * 返回说明 = 判崩；undefined = 不算（终态、在豁免状态里、或工具还在跑、或没到阈值）。
 * thresholdMs 可注入，便于测试用短阈值。
 */
export function quietCrashOf(run: WorkerRun, nowMs: number, thresholdMs: number = SILENT_CRASH_MS): SilentCrash | undefined {
	if (run.finishedAt !== undefined) return undefined;
	if (EXEMPT_STATUSES.has(run.status)) return undefined;
	if (hasToolInFlight(run)) return undefined;
	const silentMs = silentMsOf(run, nowMs);
	if (silentMs < thresholdMs) return undefined;
	// 不足 1 秒时说「静默 1 秒」：阈值被调得极短时（测试）不该出现「静默 0 秒」这种话
	const seconds = Math.max(1, Math.round(silentMs / 1000));
	return {
		silentMs,
		reason: `静默 ${seconds} 秒没有任何事件（没有在跑的工具、不在等审批/暂存），判定为崩溃并中止`,
	};
}

/** 一轮检查：在飞且未被标记过的 worker 里，挑出静默崩的 */
export function detectSilentCrashes(
	runs: readonly WorkerRun[],
	nowMs: number,
	options: { thresholdMs?: number; alreadyMarked?: ReadonlySet<string> } = {},
): Array<{ run: WorkerRun; crash: SilentCrash }> {
	const out: Array<{ run: WorkerRun; crash: SilentCrash }> = [];
	for (const run of runs) {
		if (options.alreadyMarked?.has(run.id)) continue;
		const crash = quietCrashOf(run, nowMs, options.thresholdMs);
		if (crash) out.push({ run, crash });
	}
	return out;
}

/** 中止 worker 用的理由（带这句，worker 自己的轨迹里会写「外部停止：…」而不是「用户强停」） */
export function silentCrashReason(crash: SilentCrash): Error {
	return new Error(crash.reason);
}

/**
 * 起看门狗：定期扫这批在飞的 worker，判崩就写状态 + 中止。返回停止函数。
 *
 * 顺序是「先写状态，再中止」：崩溃要立刻可见（状态文件是 GUI 的输入），
 * 而中止只是让 worker 快点收场；终态再算一遍时由 marks 里的标记赢得（applyCrashMark）。
 */
export function startSilenceWatch(opts: SilenceWatchOptions): () => void {
	const tick = () => {
		const nowMs = (opts.now ?? Date.now)();
		const hits = detectSilentCrashes(opts.runs(), nowMs, {
			thresholdMs: opts.thresholdMs,
			alreadyMarked: new Set(opts.marks.keys()),
		});
		for (const { run, crash } of hits) {
			opts.marks.set(run.id, crash);
			opts.markStatus(run, crash);
			const controller = opts.controllers.get(run.id);
			if (controller && !controller.signal.aborted) controller.abort(silentCrashReason(crash));
			opts.onCrash?.(run, crash);
		}
	};
	const timer = setInterval(tick, opts.intervalMs ?? CRASH_CHECK_INTERVAL_MS);
	// 看门狗不该把进程钉在事件循环里（批次收完就该能退出）
	timer.unref?.();
	return () => clearInterval(timer);
}

/**
 * 把终态补丁改写成崩溃。
 *
 * 崩溃优先于「怎么中止的」：中止只是手段，进程被 abort 后算出来的 aborted/aborted
 * 不是结论。这里最后写一遍，免得终态把已经标记好的崩溃盖回去。
 */
export function applyCrashMark<T extends { status?: string; output?: string }>(
	patch: T,
	crash: SilentCrash | undefined,
): T {
	if (!crash) return patch;
	// "crashed" 是 WorkerStatus 与 BatchItemStatus 共同认识的取值，这里的窄化是安全的
	return { ...patch, status: "crashed", output: crash.reason };
}
