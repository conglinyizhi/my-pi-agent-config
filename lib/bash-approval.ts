// lib/bash-approval.ts — bash / bash_background 共用的审批编排
//
// 这里只编排「需确认类」命令：checkCommand 的黑名单、内联脚本和全
// autoReject 结果仍由调用方硬拒。LLM 与 GUI runner 均可注入，便于后台工具
// 和单元测试复用，而不让 extensions 之间互相依赖。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxCheckResult, TokenRule } from "./sandbox-check.ts";
import {
	createReviewCache,
	loadLlmReviewConfig,
	reviewCommand as defaultReviewCommand,
	type LlmReviewConfig,
	type ReviewCache,
	type ReviewResult,
} from "../extensions/sandbox-permissions/llm-review.ts";
import {
	normalizeApprovalComment,
	resolveApprovalChannel,
	type ApprovalChannel,
	type ApprovalRunGui,
	type ApprovalSelect,
} from "./approval-channel.ts";

export { normalizeApprovalComment };

/** bash 审批链共用的 LLM 缓存；bash 与 bash_background 不重复审核同一命令。 */
export const bashApprovalReviewCache = createReviewCache();

export interface BashApprovalDependencies {
	/** 测试或 IM 注入整条通道；优先于 runGui / selectApproval。 */
	channel?: ApprovalChannel;
	/** 测试注入；默认使用真实 wails-gui runner。 */
	runGui?: ApprovalRunGui;
	/** 测试注入；默认使用 ctx.ui.select；不注入时保持 TUI 回退语义。 */
	selectApproval?: ApprovalSelect;
	/** 测试注入；默认使用 sandbox-permissions 的 LLM 配置。 */
	loadReviewConfig?: () => LlmReviewConfig;
	/** 测试注入；默认调用真实 LLM 预审。 */
	reviewCommand?: typeof defaultReviewCommand;
	/** 测试或隔离调用方注入独立缓存。 */
	reviewCache?: ReviewCache;
}

export interface BashApprovalOptions {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	command: string;
	verdict: SandboxCheckResult;
	taskId?: string;
	signal?: AbortSignal;
	/** 审批来源，写进 bash-audit 条目便于事后分辨前台/后台。 */
	origin?: "bash" | "bash_background";
	deps?: BashApprovalDependencies;
}

export interface BashApprovalResult {
	approved: boolean;
	/** GUI 允许/拒绝时用户填写的非空附言（已 trim）。 */
	comment?: string;
	/** 实际发生人工审批时才有；LLM 自动放行不写审计。 */
	review?: ReviewResult;
}

function auditEntry(
	command: string,
	verdict: SandboxCheckResult,
	review: ReviewResult | undefined,
	comment: string | undefined,
	origin: BashApprovalOptions["origin"],
): Record<string, unknown> {
	return {
		command,
		...(origin ? { origin } : {}),
		rules: (verdict.rules ?? []).map((rule) => ({ name: rule.name, matched: rule.matched })),
		...(review ? { review: { verdict: review.verdict, reason: review.reason } } : {}),
		...(comment ? { comment } : {}),
		ts: Date.now(),
	};
}

async function humanConfirm(
	ctx: ExtensionContext,
	command: string,
	rules: TokenRule[],
	reason: string | undefined,
	review: ReviewResult | undefined,
	taskId: string | undefined,
	signal: AbortSignal | undefined,
	deps: BashApprovalDependencies,
): Promise<{ approved: boolean; comment?: string }> {
	const decision = await resolveApprovalChannel(deps)({
		kind: "audit",
		command,
		taskId,
		rules,
		review,
		reason,
		signal,
	}, ctx);
	return { approved: decision.action === "allow", comment: decision.comment };
}

/**
 * 执行与内建 bash 对齐的「LLM 预审 → GUI/TUI 人工审批」链。
 * 调用方应先处理 verdict.allow=false 且全 autoReject / 无 rules 的硬拒结果。
 * 该函数在人工审批结束后才返回；调用方应在其后再 registry.start 或执行 shell。
 */
export async function approveBashCommand(options: BashApprovalOptions): Promise<BashApprovalResult> {
	const { pi, ctx, command, verdict, taskId, signal, origin } = options;
	const deps = options.deps ?? {};
	const config = (deps.loadReviewConfig ?? loadLlmReviewConfig)();
	const cache = deps.reviewCache ?? bashApprovalReviewCache;
	let review: ReviewResult | undefined;

	if (config.enabled) {
		try {
			review = await (deps.reviewCommand ?? defaultReviewCommand)(
				pi,
				ctx,
				command,
				verdict.rules ?? [],
				signal,
				cache,
				config,
				// 事实层随命令一起给审核模型：它看的是影响面，不只是命令原文
				{ facts: verdict.facts, factsUnavailable: verdict.factsUnavailable },
			);
		} catch {
			review = undefined;
		}
		if (review?.verdict === "safe" && config.mode === "auto") {
			return { approved: true, review };
		}
	}

	const decision = await humanConfirm(
		ctx,
		command,
		verdict.rules ?? [],
		verdict.reason,
		review,
		taskId,
		signal,
		deps,
	);
	const entry = auditEntry(command, verdict, review, decision.comment, origin);
	pi.appendEntry("bash-audit", { ...entry, outcome: decision.approved ? "approved" : "denied" });
	return { approved: decision.approved, comment: decision.comment, review };
}

/** 把人工审批附言附加到工具结果；无附言时保持原结果不变。 */
export function appendApprovalComment<T extends { content?: Array<{ type: string; text?: string }> }>(
	result: T,
	comment: string | undefined,
): T {
	if (!comment || !Array.isArray(result.content)) return result;
	const content = result.content.map((item) =>
		item.type === "text" ? { ...item, text: `${item.text ?? ""}\n[审批附言：${comment}]` } : item,
	);
	return { ...result, content } as T;
}

/**
 * 工具 execute 抛错时也要带上附言：pi 的 bash 工具在非零退出时是 throw，
 * 不处理就会把附言丢掉。这里把 header 并入错误信息，交给 pi 的工具错误通道展示。
 */
export function rethrowWithApprovalComment(err: unknown, header: string | undefined): never {
	if (!header) throw err;
	const message = err instanceof Error ? err.message : String(err);
	throw new Error(`${header}\n${message}`);
}

/** 生成后台工具的拒绝文案，与 bash 的人工拒绝文案保持一致。 */
export function bashApprovalDeniedText(reason: string | undefined, comment?: string): string {
	const userNote = comment ? `（用户理由：${comment}）` : "";
	return `已拒绝：${reason ?? "命令需人工确认"}${userNote}`;
}

/** 仅供需要判断硬拒的调用方，集中避免不同工具漏掉 autoReject 分支。 */
export function isHardRejected(verdict: SandboxCheckResult): boolean {
	return !verdict.allow && (
		!verdict.rules || verdict.rules.length === 0 || verdict.rules.every((rule) => rule.autoReject)
	);
}

// 保留类型导出，便于调用方不重复从 sandbox-check 引入规则类型。
export type { SandboxCheckResult, TokenRule };
