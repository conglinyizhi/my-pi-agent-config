// lib/ab-watch.ts — pi 侧的观察层：记一次往返，但永不把异常抛进审核路径
//
// 与 CLI 的分工：CLI 该报错就报错（人正看着终端）；这一层在审核路径上被调用，
// 任何失败——未初始化、目录权限不对、盘写不进去——都必须无声降级，
// 只把结果装进返回值里让调用方决定要不要提一句。
//
// 「干净往返」的口径（见 docs/plans/2026-10-05-ab-update.md）：
//   gui   有结论、没崩、没超时、没人叉掉窗口
//   audit 一次审计走完并给出结论（模型判安全或有风险都算成功，链自己报错才算失败）

import { homedir } from "node:os";
import { join } from "node:path";
import { noteRoundTrip } from "./ab-store.ts";
import { componentInitialized } from "./ab-store.ts";
import type { AbComponent } from "./ab-slots.ts";

export interface WatchResult {
	/** 是否真的记上了；false 时看 skipped 的原因 */
	noted: boolean;
	skipped?: string;
	clean?: number;
	threshold?: number;
	promoted?: boolean;
	action?: "promote" | "notify" | "keep";
	reason?: string;
}

export function resolveRuntimeRoot(explicit?: string): string {
	return explicit ?? process.env.PI_RUNTIME_ROOT ?? join(homedir(), ".pi", "runtime");
}

/**
	* 记一次往返。调用点全在审核路径上，所以这里绝不抛异常。
	*
	* 运行时目录没初始化就直接跳过：不在别人机器上凭空造目录，也让这个引擎是"先建目录才生效"。
	*/
export function watchRoundTrip(options: {
	component: AbComponent;
	outcome: "clean" | "failure";
	reason?: string;
	runtimeRoot?: string;
	threshold?: number;
	autoPromote?: boolean;
	at?: string;
}): WatchResult {
	try {
		const runtimeRoot = resolveRuntimeRoot(options.runtimeRoot);
		if (!componentInitialized(runtimeRoot, options.component)) {
			return { noted: false, skipped: "运行时目录未初始化" };
		}
		const result = noteRoundTrip({
			runtimeRoot,
			component: options.component,
			outcome: options.outcome,
			...(options.reason ? { reason: options.reason } : {}),
			...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
			...(options.autoPromote !== undefined ? { autoPromote: options.autoPromote } : {}),
			...(options.at ? { at: options.at } : {}),
		});
		return {
			noted: true,
			clean: result.clean,
			threshold: result.threshold,
			promoted: result.promoted,
			action: result.action,
			reason: result.reason,
		};
	} catch (error) {
		return { noted: false, skipped: error instanceof Error ? error.message : String(error) };
	}
}

/**
	* 从窗口往返的结果判干净与否。
	*
	* 叉掉窗口按提督的约定算错误信号：对结果不满意就直接关掉，等于投了反对票。
	*/
export function classifyWindowOutcome(result: { ok?: boolean; data?: unknown; reason?: string }): {
	outcome: "clean" | "failure";
	reason: string;
} {
	const reason = result?.reason ?? "";
	if (result?.ok) return { outcome: "clean", reason: "窗口给出结论" };
	if (reason === "timeout") return { outcome: "failure", reason: "窗口超时没给结论" };
	if (reason === "aborted") return { outcome: "failure", reason: "审批被中止" };
	if (reason === "exited") return { outcome: "failure", reason: "窗口被关掉，没写响应文件" };
	if (reason === "spawn") return { outcome: "failure", reason: "窗口进程起不来" };
	if (reason === "unavailable") return { outcome: "failure", reason: "找不到 GUI 可执行文件" };
	return { outcome: "failure", reason: reason === "" ? "窗口没给结论" : `窗口异常：${reason}` };
}

/** 一次审计的成败：链自己报错算失败，判安全或有风险都算走完了 */
export function classifyAuditOutcome(verdict: string | undefined, failureReason?: string): {
	outcome: "clean" | "failure";
	reason: string;
} {
	if (verdict === undefined) return { outcome: "failure", reason: failureReason ?? "审核链没给出结论" };
	if (verdict === "error") return { outcome: "failure", reason: failureReason ?? "审核链自己报错" };
	return { outcome: "clean", reason: `审核结论：${verdict}` };
}
