// lib/bash-approval.ts — bash / bash_background 共用的审批编排
//
// 这里只编排「需确认类」命令：checkCommand 的黑名单、内联脚本和全
// autoReject 结果仍由调用方硬拒。LLM 与 GUI runner 均可注入，便于后台工具
// 和单元测试复用，而不让 extensions 之间互相依赖。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxCheckResult, TokenRule } from "./sandbox-check.ts";
import {
	createReviewCache,
	formatReviewNote,
	loadLlmReviewConfig,
	reviewCommand as defaultReviewCommand,
	type LlmReviewConfig,
	type ReviewCache,
	type ReviewResult,
} from "../extensions/sandbox-permissions/llm-review.ts";
import { runGuiWindow, type GuiRunResult, type GuiRunOptions } from "./gui-runner.ts";

const GUI_TIMEOUT_MS = 3_600_000;

/** bash 审批链共用的 LLM 缓存；bash 与 bash_background 不重复审核同一命令。 */
export const bashApprovalReviewCache = createReviewCache();

export interface BashApprovalDependencies {
	/** 测试注入；默认使用真实 wails-gui runner。 */
	runGui?: (windowName: string, request: unknown, options?: GuiRunOptions) => Promise<GuiRunResult>;
	/** 测试注入；默认使用 ctx.ui.select；不注入时保持 TUI 回退语义。 */
	selectApproval?: (title: string, choices: string[]) => Promise<string | undefined>;
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

/** 审批附言的统一规范：空白附言不回传、不入审计。 */
export function normalizeApprovalComment(comment: unknown): string | undefined {
	if (typeof comment !== "string") return undefined;
	const trimmed = comment.trim();
	return trimmed.length > 0 ? trimmed : undefined;
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
	runGui: NonNullable<BashApprovalDependencies["runGui"]>,
	selectApproval: BashApprovalDependencies["selectApproval"],
): Promise<{ approved: boolean; comment?: string }> {
	const gui = await runGui(
		"gate",
		{ kind: "audit", command, taskId, rules, review },
		{ timeoutMs: GUI_TIMEOUT_MS, signal },
	);
	if (gui.ok && gui.data && (gui.data.action === "allow" || gui.data.action === "deny")) {
		return {
			approved: gui.data.action === "allow",
			comment: normalizeApprovalComment(gui.data.comment),
		};
	}

	if (!ctx?.ui && !selectApproval) return { approved: false };
	const reviewNote = review && (review.reason || review.suggestion || review.opinion)
		? `\n\n${formatReviewNote(review)}`
		: "";
	const choice = await (selectApproval ?? ((title, choices) => ctx.ui.select(title, choices)))(
		`⚠️ 命令需确认：\n\n  ${reason ?? "命中风险规则"}${reviewNote}\n\n是否允许执行？`,
		["✅ 允许执行", "❌ 拒绝"],
	);
	return { approved: choice?.includes("允许") ?? false };
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
		deps.runGui ?? runGuiWindow,
		deps.selectApproval,
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
