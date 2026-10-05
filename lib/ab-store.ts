// lib/ab-store.ts — A/B 更新引擎的动盘那一层（CLI 与 pi 侧共用一份）
//
// 分工：ab-slots.ts 只算「该做什么」，这里负责「照着做」，CLI 与 pi 侧都调它。
// 两套实现各自跑偏是这个项目的头号风险，所以动盘逻辑只许有一份。
//
// 不抛异常的约定只给 pi 侧那层包装（ab-watch.ts）：审核路径上任何失败都必须无声降级，
// 而 CLI 该报错就报错——人正看着终端呢。

import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	AB_SLOTS,
	DEFAULT_FAIL_THRESHOLD,
	DEFAULT_THRESHOLD,
	componentPath,
	decideRollback,
	currentLink,
	decidePromotion,
	emptyStreak,
	formatStreak,
	formatManifest,
	isSlot,
	parseManifest,
	parseStreak,
	planPromotion,
	planRollback,
	promoteLogPath,
	slotPath,
	slotToken,
	streakAfter,
	streakPath,
	type AbComponent,
	type AbSlot,
	type SlotManifest,
	type StreakState,
} from "./ab-slots.ts";

/** 运行时根不许是 / 或空：下面有删除动作，目标必须是收窄过的目录 */
export function assertRuntimeRoot(root: string): string {
	const resolved = resolve(root);
	if (resolved === "/" || basename(resolved) === "") {
		throw new Error(`运行时根不合法：${root}`);
	}
	return resolved;
}

/** 运行时目录是否已被初始化过（没有就什么都不做，别在别人机器上凭空造目录） */
export function componentInitialized(runtimeRoot: string, component: AbComponent): boolean {
	return existsSync(componentPath(runtimeRoot, component));
}

/** 原子换软链：先写临时名再 rename 覆盖，任何时刻 current 都指向完整目标 */
export function atomicLink(runtimeRoot: string, component: AbComponent, slot: AbSlot): void {
	const componentDir = componentPath(runtimeRoot, component);
	mkdirSync(componentDir, { recursive: true });
	const tmp = `${currentLink(runtimeRoot, component)}.tmp-${process.pid}`;
	rmSync(tmp, { force: true });
	symlinkSync(slotPath(runtimeRoot, component, slot), tmp);
	renameSync(tmp, currentLink(runtimeRoot, component));
}

export function moveSlot(runtimeRoot: string, component: AbComponent, from: AbSlot, to: AbSlot): void {
	const source = slotPath(runtimeRoot, component, from);
	const target = slotPath(runtimeRoot, component, to);
	rmSync(target, { recursive: true, force: true });
	if (existsSync(source)) renameSync(source, target);
}

export function appendLog(runtimeRoot: string, component: AbComponent, line: string, at: string): void {
	const path = promoteLogPath(runtimeRoot, component);
	mkdirSync(componentPath(runtimeRoot, component), { recursive: true });
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	writeFileSync(path, `${existing}${at} ${line}\n`, "utf8");
}

export function writeManifest(runtimeRoot: string, component: AbComponent, slot: AbSlot, manifest: SlotManifest): void {
	const dir = slotPath(runtimeRoot, component, slot);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), formatManifest(manifest), "utf8");
}

export function readManifest(runtimeRoot: string, component: AbComponent, slot: AbSlot): SlotManifest | undefined {
	const path = join(slotPath(runtimeRoot, component, slot), "manifest.json");
	if (!existsSync(path)) return undefined;
	return parseManifest(readFileSync(path, "utf8"));
}

export function readStreak(runtimeRoot: string, component: AbComponent): StreakState {
	const path = streakPath(runtimeRoot, component);
	return existsSync(path) ? parseStreak(readFileSync(path, "utf8")) : emptyStreak();
}

export function writeStreak(runtimeRoot: string, component: AbComponent, state: StreakState): void {
	mkdirSync(componentPath(runtimeRoot, component), { recursive: true });
	writeFileSync(streakPath(runtimeRoot, component), formatStreak(state), "utf8");
}

/** current 现在指向哪个槽（没有或指到别处都算未设置） */
export function currentSlot(runtimeRoot: string, component: AbComponent): AbSlot | undefined {
	const link = currentLink(runtimeRoot, component);
	if (!existsSync(link)) return undefined;
	try {
		const name = basename(readlinkSync(link));
		return isSlot(name) ? name : undefined;
	} catch {
		return undefined;
	}
}

export function nowIso(): string {
	return new Date().toISOString();
}

/** 晋升：dev 升 stable、旧 stable 落 previous、current 指 stable */
export function promote(runtimeRoot: string, component: AbComponent, note: string, at = nowIso()): void {
	for (const action of planPromotion({ current: currentSlot(runtimeRoot, component), at, note })) {
		if (action.kind === "move" && action.from && action.to) moveSlot(runtimeRoot, component, action.from, action.to);
		if (action.kind === "link" && action.to) atomicLink(runtimeRoot, component, action.to);
		if (action.kind === "log" && action.text) appendLog(runtimeRoot, component, action.text, at);
	}
	writeStreak(runtimeRoot, component, emptyStreak("dev"));
}

export function rollback(runtimeRoot: string, component: AbComponent, reason: string | undefined, at = nowIso()): void {
	for (const action of planRollback({ at, ...(reason ? { reason } : {}) })) {
		if (action.kind === "link" && action.to) atomicLink(runtimeRoot, component, action.to);
		if (action.kind === "log" && action.text) appendLog(runtimeRoot, component, action.text, at);
	}
}

export interface NoteResult {
	noted: boolean;
	clean: number;
	threshold: number;
	action: "promote" | "notify" | "keep";
	promoted: boolean;
	reason: string;
	/** 看门狗这一笔是否把 current 退回了上一版 */
	rolledBack: boolean;
	/** 看门狗的判定说明（没触发时也有，便于看清为什么没退） */
	watchdog: string;
}

/**
	* 记一次往返结果。CLI 的 note 与 pi 侧的观察层都走这里。
	*
	* 门槛判定与动盘是两个动作：判定永远做（人能看状态），动盘只在 promote 时发生。
	*/
export function noteRoundTrip(options: {
	runtimeRoot: string;
	component: AbComponent;
	outcome: "clean" | "failure";
	reason?: string;
	threshold?: number;
	failThreshold?: number;
	autoPromote?: boolean;
	at?: string;
}): NoteResult {
	const at = options.at ?? nowIso();
	const threshold = options.threshold ?? DEFAULT_THRESHOLD;
	const next = streakAfter(readStreak(options.runtimeRoot, options.component), options.outcome, {
		now: at,
		...(options.reason ? { reason: options.reason } : {}),
	});
	writeStreak(options.runtimeRoot, options.component, next);
	appendLog(
		options.runtimeRoot,
		options.component,
		JSON.stringify({ event: "note", outcome: options.outcome, clean: next.clean, ...(options.reason ? { reason: options.reason } : {}) }),
		at,
	);
	const decision = decidePromotion(next, { threshold, autoPromote: options.autoPromote });
	if (decision.action === "promote") {
		promote(options.runtimeRoot, options.component, decision.reason, at);
		return {
			noted: true,
			clean: next.clean,
			threshold,
			action: "promote",
			promoted: true,
			reason: decision.reason,
			rolledBack: false,
			watchdog: "刚晋升，看门狗不参与",
		};
	}

	// 看门狗：连续失败到门槛就把 current 退回上一版。累加计数同时清零，
	// 免得退过一次之后每一笔失败都再退一次。
	const watchdog = decideRollback(next, {
		...(options.failThreshold !== undefined ? { threshold: options.failThreshold } : {}),
		hasPrevious: existsSync(slotPath(options.runtimeRoot, options.component, "previous")),
		currentIsPrevious: currentSlot(options.runtimeRoot, options.component) === "previous",
	});
	let rolledBack = false;
	if (watchdog.action === "rollback") {
		rollback(options.runtimeRoot, options.component, watchdog.reason, at);
		appendLog(
			options.runtimeRoot,
			options.component,
			JSON.stringify({ event: "watchdog-rollback", reason: watchdog.reason }),
			at,
		);
		writeStreak(options.runtimeRoot, options.component, { ...next, failing: 0 });
		rolledBack = true;
	}

	if (decision.action === "notify") {
		appendLog(options.runtimeRoot, options.component, JSON.stringify({ event: "promote-notice" }), at);
		return {
			noted: true,
			clean: next.clean,
			threshold,
			action: "notify",
			promoted: false,
			reason: decision.reason,
			rolledBack,
			watchdog: watchdog.reason,
		};
	}
	return {
		noted: true,
		clean: next.clean,
		threshold,
		action: "keep",
		promoted: false,
		reason: decision.reason,
		rolledBack,
		watchdog: watchdog.reason,
	};
}

export interface SlotReport {
	slot: AbSlot;
	path: string;
	exists: boolean;
	manifest?: SlotManifest;
	token?: string;
}

export interface ComponentStatus {
	component: AbComponent;
	current?: AbSlot;
	slots: SlotReport[];
	streak: StreakState;
	decision: ReturnType<typeof decidePromotion>;
}

export function statusOf(
	runtimeRoot: string,
	component: AbComponent,
	options: { threshold?: number; autoPromote?: boolean } = {},
): ComponentStatus {
	const slots = AB_SLOTS.map((slot) => {
		const dir = slotPath(runtimeRoot, component, slot);
		const manifest = readManifest(runtimeRoot, component, slot);
		return {
			slot,
			path: dir,
			exists: existsSync(dir),
			...(manifest ? { manifest, token: slotToken(manifest) } : {}),
		};
	});
	const streak = readStreak(runtimeRoot, component);
	return {
		component,
		...(currentSlot(runtimeRoot, component) ? { current: currentSlot(runtimeRoot, component) } : {}),
		slots,
		streak,
		decision: decidePromotion(streak, options),
	};
}

export function tailLog(runtimeRoot: string, component: AbComponent, tail: number): string[] {
	const path = promoteLogPath(runtimeRoot, component);
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
	return lines.slice(Math.max(0, lines.length - tail));
}
