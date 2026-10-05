// lib/ab-watch.ts — pi 侧的观察层：记一次往返，但永不把异常抛进审核路径
//
// 与 CLI 的分工：CLI 该报错就报错（人正看着终端）；这一层在审核路径上被调用，
// 任何失败——未初始化、目录权限不对、盘写不进去——都必须无声降级，
// 只把结果装进返回值里让调用方决定要不要提一句。
//
// 「干净往返」的口径（见 docs/plans/2026-10-05-ab-update.md）：
//   gui   有结论、没崩、没超时、没人叉掉窗口
//   audit 一次审计走完并给出结论（模型判安全或有风险都算成功，链自己报错才算失败）

import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendCrashReport } from "./ab-crash-report.ts";
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
	/** 看门狗这一笔是否把 current 退回了上一版 */
	rolledBack?: boolean;
	/** 看门狗的判定说明（没触发时也有） */
	watchdog?: string;
	action?: "promote" | "notify" | "keep";
	reason?: string;
}

export function resolveRuntimeRoot(explicit?: string): string {
	return explicit ?? process.env.PI_RUNTIME_ROOT ?? join(homedir(), ".pi", "runtime");
}

/**
 * 观察层只在真跑的时候写状态：测试进程不许碰 ~/.pi/runtime。
 *
 * 踩过的坑（2026-10-05）：测试走审批路径时会记"干净往返"，攒够阈值就自动晋升，
 * 而晋升会把 dev 挪成 stable、改写 current —— 跑一次测试就把槽搅乱了。
 * Node 的测试运行器会设 NODE_TEST_CONTEXT，用它当闸门；测试想写就显式给
 * runtimeRoot，或把 PI_RUNTIME_ROOT 指到临时目录（那说明它知道自己要写哪儿）。
 */
export function writeBlocked(explicitRuntimeRoot?: string): boolean {
	if (explicitRuntimeRoot !== undefined || process.env.PI_RUNTIME_ROOT !== undefined) return false;
	return process.env.NODE_TEST_CONTEXT !== undefined;
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
	failThreshold?: number;
	autoPromote?: boolean;
	at?: string;
}): WatchResult {
	// 测试进程默认不写状态（要写就显式给 runtimeRoot）
	if (writeBlocked(options.runtimeRoot)) {
		return { noted: false, skipped: "测试进程不写运行时状态" };
	}
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
			...(options.failThreshold !== undefined ? { failThreshold: options.failThreshold } : {}),
			...(options.autoPromote !== undefined ? { autoPromote: options.autoPromote } : {}),
			...(options.at ? { at: options.at } : {}),
		});
		return {
			noted: true,
			clean: result.clean,
			threshold: result.threshold,
			promoted: result.promoted,
			rolledBack: result.rolledBack,
			watchdog: result.watchdog,
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

/**
 * 一次闸门往返：这是两个组件共用的观察点。
 *
 * gui 侧看窗口活不活（叉掉/超时/起不来都算失败）；
 * audit 侧看这次审计有没有走完（窗口失败也算，链自己报错也算）。
 * 没有 review 字段说明这次根本没跑审核（开关关着），那就不记 audit 的账。
 */
export function noteGateRoundTrip(options: {
	windowResult: { ok?: boolean; data?: unknown; reason?: string };
	/** 这次请求里带的审核结果（ApprovalRequest.review） */
	review?: unknown;
	runtimeRoot?: string;
	threshold?: number;
	failThreshold?: number;
	autoPromote?: boolean;
	at?: string;
}): { gui: WatchResult; audit?: WatchResult; notices: Array<{ component: AbComponent; text: string }> } {
	// 同 watchRoundTrip：测试进程默认不写状态
	if (writeBlocked(options.runtimeRoot)) {
		return { gui: { noted: false, skipped: "测试进程不写运行时状态" }, notices: [] };
	}
	const shared = {
		...(options.runtimeRoot ? { runtimeRoot: options.runtimeRoot } : {}),
		...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
		...(options.failThreshold !== undefined ? { failThreshold: options.failThreshold } : {}),
		...(options.autoPromote !== undefined ? { autoPromote: options.autoPromote } : {}),
		...(options.at ? { at: options.at } : {}),
	};
	const windowVerdict = classifyWindowOutcome(options.windowResult);
	const gui = watchRoundTrip({ component: "gui", outcome: windowVerdict.outcome, reason: windowVerdict.reason, ...shared });
	if (windowVerdict.outcome === "failure") {
		// 窗口没走完不光记一笔，还要写成给人看的报告：标题一行就能看出该修什么
		appendCrashReport({
			at: options.at ?? new Date().toISOString(),
			component: "gui",
			stage: "审批往返",
			summary: windowVerdict.reason,
			module: "lib/ab-watch.ts（classifyWindowOutcome）",
			context: {
				...(gui.rolledBack ? { 回退: "连续失败已达门槛，已回退" } : {}),
				...(gui.clean !== undefined ? { 干净往返: gui.clean } : {}),
			},
			hint: "看 ~/.pi/runtime/gui/notice.txt 与 promote.log；要立刻回开发态就 make ab-detach COMPONENT=gui",
		});
	}

	let audit: WatchResult | undefined;
	if (options.review !== undefined && options.review !== null) {
		const verdict = typeof options.review === "object" ? (options.review as { verdict?: string }).verdict : undefined;
		const auditVerdict =
			windowVerdict.outcome === "failure"
				? { outcome: "failure" as const, reason: `这次没走完：${windowVerdict.reason}` }
				: classifyAuditOutcome(verdict);
		audit = watchRoundTrip({
			component: "audit",
			outcome: auditVerdict.outcome,
			reason: auditVerdict.reason,
			...shared,
		});
		if (auditVerdict.outcome === "failure") {
			appendCrashReport({
				at: options.at ?? new Date().toISOString(),
				component: "audit",
				stage: "审批往返",
				summary: auditVerdict.reason,
				module: "lib/ab-watch.ts（classifyAuditOutcome）",
				context: { 审核结论: verdict ?? "(没给结论)" },
				hint: "看 ~/.pi/runtime/audit/notice.txt；要立刻回开发态就 make ab-detach COMPONENT=audit",
			});
		}
	}

	const notices: Array<{ component: AbComponent; text: string }> = [];
	for (const [label, result] of [["gui", gui], ["audit", audit]] as const) {
		if (!result?.noted) continue;
		// 回退比晋升更需要被看见：放前面，先报这个
		if (result.rolledBack) notices.push({ component: label, text: `${label} 连续失败已达门槛，已自动回退到上一版` });
		if (result.promoted) notices.push({ component: label, text: `${label} 已自动晋升（连续 ${result.clean} 次干净往返）` });
		else if (result.action === "notify") notices.push({ component: label, text: `${label} 已攒够 ${result.threshold} 次干净往返，可以晋升` });
	}
	return { gui, ...(audit ? { audit } : {}), notices };
}

/** 把一条提示落到运行时目录，供 TUI 在下次启动时读走（期 3 接上展示） */
export function writeNotice(runtimeRoot: string, component: AbComponent, text: string, at?: string): void {
	try {
		const dir = join(runtimeRoot, component);
		if (!existsSync(dir)) return;
		appendFileSync(join(dir, "notice.txt"), `${at ?? new Date().toISOString()} ${text}\n`, "utf8");
	} catch {
		// 提示写不进去也不能影响主流程
	}
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
