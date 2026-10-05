// lib/ab-crash.ts — 崩溃现场：失败时留下一份能复现的东西
//
// 起因很具体：2026-10-05 两次 Electron SIGTRAP，事后只剩一个内核转储，
// 连一行 stderr、连当时发的请求都没了。这一层就是补那个缺口。
//
// 现场按敏感内容对待：目录 0700、文件 0600，只留在状态目录里，不进仓。
// 只保留最近若干份，清理时只删自己认得的那种时间戳目录，别的一律不碰。

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AbComponent } from "./ab-slots.ts";

/** 每个组件保留最近多少份现场 */
export const CRASH_KEEP = 10;

/** 时间戳转目录名：ISO 里的冒号与点在部分场合不友好 */
export function stampOf(at: string): string {
	return at.replace(/[:.]/g, "-");
}

/** 这个目录名长得像不像我们自己写的时间戳（清理时的唯一凭据） */
export function isStampName(name: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(name);
}

export function crashRoot(runtimeRoot: string, component: AbComponent): string {
	return join(runtimeRoot, component, "crash");
}

export function crashDir(runtimeRoot: string, component: AbComponent, at: string): string {
	return join(crashRoot(runtimeRoot, component), stampOf(at));
}

export interface CrashSceneInput {
	runtimeRoot: string;
	component: AbComponent;
	at: string;
	reason?: string;
	exitCode?: number | null;
	signal?: string | null;
	stderr?: string;
	/** 当时发出去的请求：原样存，含命令内容，所以按敏感内容对待 */
	request?: unknown;
}

export interface CrashSceneResult {
	saved: boolean;
	dir?: string;
	skipped?: string;
	pruned?: number;
}

/** 存一份现场。永不抛异常：它是在失败路径上被调的 */
export function saveCrashScene(input: CrashSceneInput): CrashSceneResult {
	try {
		if (!existsSync(join(input.runtimeRoot, input.component))) {
			return { saved: false, skipped: "运行时目录未初始化" };
		}
		const dir = crashDir(input.runtimeRoot, input.component, input.at);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const scene = {
			at: input.at,
			component: input.component,
			reason: input.reason ?? "",
			exitCode: input.exitCode ?? null,
			signal: input.signal ?? null,
			hint: "信号 5（SIGTRAP）多是 Chromium 断言；内核转储用 coredumpctl list 看",
		};
		writeFileSync(join(dir, "scene.json"), JSON.stringify(scene, null, 2) + "\n", { mode: 0o600 });
		if (typeof input.stderr === "string" && input.stderr !== "") {
			writeFileSync(join(dir, "stderr.txt"), input.stderr, { mode: 0o600 });
		}
		if (input.request !== undefined) {
			writeFileSync(join(dir, "request.json"), JSON.stringify(input.request, null, 2) + "\n", { mode: 0o600 });
		}
		const pruned = pruneCrashScenes(input.runtimeRoot, input.component);
		return { saved: true, dir, ...(pruned > 0 ? { pruned } : {}) };
	} catch (error) {
		return { saved: false, skipped: error instanceof Error ? error.message : String(error) };
	}
}

/** 现有的现场目录名（按时间序，旧的在前） */
export function listCrashScenes(runtimeRoot: string, component: AbComponent): string[] {
	const root = crashRoot(runtimeRoot, component);
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root).filter((name) => isStampName(name)).sort();
	} catch {
		return [];
	}
}

/**
	* 只留最近 keep 份。
	*
	* 清理只针对 isStampName 认得的目录：别的文件（人放的笔记、别的工具留的东西）一律不碰。
	* 所以删除目标不是"扫出什么删什么"，而是"扫出来的东西里通过白名单校验的那部分"。
	*/
export function pruneCrashScenes(runtimeRoot: string, component: AbComponent, keep = CRASH_KEEP): number {
	const names = listCrashScenes(runtimeRoot, component);
	if (names.length <= keep) return 0;
	let removed = 0;
	for (const name of names.slice(0, names.length - keep)) {
		if (!isStampName(name)) continue;
		try {
			rmSync(join(crashRoot(runtimeRoot, component), name), { recursive: true, force: true });
			removed += 1;
		} catch {
			// 删不掉就留着，不影响主流程
		}
	}
	return removed;
}
