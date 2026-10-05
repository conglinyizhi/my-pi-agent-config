// lib/bash-approval.ts — 命令审核链的唯一编排（bash / bash_background / subagent capability）
//
// 这里只编排「需确认类」命令：checkCommand 的黑名单、内联脚本和全
// autoReject 结果仍由调用方硬拒。LLM 与 GUI runner 均可注入，便于后台工具
// 和单元测试复用，而不让 extensions 之间互相依赖。
//
// worker 的风险命令（capability 请求）也走这条链：预审与 LLM 缓存同主 agent 一份，
// 只是通过 buildRequest / audit 两个接点换成 capability 卡片与 capability 审计条目。
// 谁判、谁审、什么时候弹人，只有这一处实现。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxCheckResult, TokenRule } from "./sandbox-check.ts";
import type { ApprovalRequest } from "./approval-channel.ts";
import { formatFacts } from "./preshell.ts";
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

/**
 * 本链共用的 LLM 缓存；bash / bash_background / worker capability 不重复审核同一命令。
 * 缓存键是（命令原文 + 命中的规则），与谁发起无关：主 agent 刚判过 safe 的命令，
 * worker 再跑同一条不必重新掷一次骰子。
 */
export const bashApprovalReviewCache = createReviewCache();

export interface BashApprovalDependencies {
	/** 测试或 IM 注入整条通道；优先于 runGui / selectApproval。 */
	channel?: ApprovalChannel;
	/** 测试注入；默认使用真实 GUI 启动器（bin/gui.sh → Electron）。 */
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
	/**
	 * 问人这一步的请求形态；缺省是 audit 卡片（「这条 bash 命令要不要执行」）。
	 * subagent 传自己的构造器换成 capability 卡片 —— 判定与预审是同一条链，
	 * 只有卡片长什么样按通道来定。
	 */
	buildRequest?: (context: ApprovalRequestContext) => ApprovalRequest;
	/**
	 * 审计落点；缺省只在人工真的答过时写 bash-audit（自动放行不写，历史行为如此）。
	 * subagent 用它换成 subagent-capability-approval 条目（那条记录连自动放行也留着，
	 * 因为「worker 什么时候拿到过能力」本身就是要看的事）。
	 */
	audit?: (record: BashAuditRecord, outcome: "approved" | "denied", auto: boolean) => void;
}

/** 构造审批请求时能拿到的东西：判定结果、预审意见与影响面摘要 */
export interface ApprovalRequestContext {
	command: string;
	rules: TokenRule[];
	reason?: string;
	review?: ReviewResult;
	factsText?: string;
	taskId?: string;
	signal?: AbortSignal;
}

/** 交给审计落点的记录；默认实现把它折成 bash-audit 条目 */
export interface BashAuditRecord {
	command: string;
	origin?: "bash" | "bash_background";
	rules: Array<{ name: string; matched?: string[] }>;
	/** 完整预审意见；bash-audit 只取 verdict/reason 落盘 */
	review?: ReviewResult;
	comment?: string;
	ts: number;
}

export interface BashApprovalResult {
	approved: boolean;
	/** GUI 允许/拒绝时用户填写的非空附言（已 trim）。 */
	comment?: string;
	/** 实际发生人工审批时才有；LLM 自动放行不写审计。 */
	review?: ReviewResult;
}

function auditRecord(
	command: string,
	verdict: SandboxCheckResult,
	review: ReviewResult | undefined,
	comment: string | undefined,
	origin: BashApprovalOptions["origin"],
): BashAuditRecord {
	return {
		command,
		...(origin ? { origin } : {}),
		rules: (verdict.rules ?? []).map((rule) => ({ name: rule.name, matched: rule.matched })),
		...(review ? { review } : {}),
		...(comment ? { comment } : {}),
		ts: Date.now(),
	};
}

/** bash-audit 条目的形态：预审只留 verdict 与 reason，全文不进会话记录 */
function bashAuditPayload(record: BashAuditRecord, outcome: "approved" | "denied"): Record<string, unknown> {
	const { review, ...rest } = record;
	return {
		...rest,
		...(review ? { review: { verdict: review.verdict, reason: review.reason } } : {}),
		outcome,
	};
}

async function humanConfirm(
	ctx: ExtensionContext,
	context: ApprovalRequestContext,
	deps: BashApprovalDependencies,
	buildRequest: BashApprovalOptions["buildRequest"],
): Promise<{ approved: boolean; comment?: string }> {
	// 缺省是 audit 卡片（bash / bash_background 的形态）；subagent 换成 capability 卡片
	const request: ApprovalRequest = buildRequest
		? buildRequest(context)
		: {
			kind: "audit",
			command: context.command,
			taskId: context.taskId,
			rules: context.rules,
			review: context.review,
			reason: context.reason,
			// 影响面也给人看一份：审核模型拿到的是同一段事实（含解释器载荷原文）
			...(context.factsText ? { factsText: context.factsText } : {}),
			signal: context.signal,
		};
	const decision = await resolveApprovalChannel(deps)(request, ctx);
	return { approved: decision.action === "allow", comment: decision.comment };
}

/**
 * 执行与内建 bash 对齐的「LLM 预审 → GUI/TUI 人工审批」链。
 * 调用方应先处理 verdict.allow=false 且全 autoReject / 无 rules 的硬拒结果。
 * 该函数在人工审批结束后才返回；调用方应在其后再 registry.start 或执行 shell。
 */
export interface BashPreReviewResult {
	config: LlmReviewConfig;
	review?: ReviewResult;
	/** 判据与主链同款：判 safe 且档位 auto 才算放行 */
	autoApproved: boolean;
}

/**
 * 只跑预审、不碰人工确认的因子化。
 *
 * 给「自己决定要不要惊动用户」的调用方用（worker 的工具守门）：它拿到一个判据，
 * 自己选择自动放行还是走 capability 请求。判据与 approveBashCommand 里的那一处
 * 是同一个表达式，避免两边规则各写一份、日后漂移。
 */
export async function preReviewBashCommand(options: BashApprovalOptions): Promise<BashPreReviewResult> {
	const { pi, ctx, command, verdict, signal } = options;
	const deps = options.deps ?? {};
	const config = (deps.loadReviewConfig ?? loadLlmReviewConfig)();
	let review: ReviewResult | undefined;

	if (config.enabled) {
		try {
			review = await (deps.reviewCommand ?? defaultReviewCommand)(
				pi,
				ctx,
				command,
				verdict.rules ?? [],
				signal,
				deps.reviewCache ?? bashApprovalReviewCache,
				config,
				// 事实层随命令一起给审核模型：它看的是影响面，不只是命令原文
				{ facts: verdict.facts, factsUnavailable: verdict.factsUnavailable },
			);
		} catch {
			review = undefined;
		}
	}

	return { config, review, autoApproved: review?.verdict === "safe" && config.mode === "auto" };
}

export async function approveBashCommand(options: BashApprovalOptions): Promise<BashApprovalResult> {
	const { pi, ctx, command, verdict, taskId, signal, origin } = options;
	const deps = options.deps ?? {};

	// 预审走同一处因子化：判据只有一份，谁调都一样
	const { review, autoApproved } = await preReviewBashCommand(options);
	if (autoApproved) {
		// 预审放行：默认落点不写条目（历史行为），接了 audit 的调用方自己决定记不记
		if (options.audit && review) options.audit(auditRecord(command, verdict, review, undefined, origin), "approved", true);
		return { approved: true, review };
	}

	const context: ApprovalRequestContext = {
		command,
		rules: verdict.rules ?? [],
		reason: verdict.reason,
		review,
		// 事实层的展示文本：与送审的那份同一口径（formatFacts），人看到的和模型看到的一样
		...(verdict.facts ? { factsText: formatFacts(verdict.facts) } : {}),
		...(taskId ? { taskId } : {}),
		signal,
	};
	const decision = await humanConfirm(ctx, context, deps, options.buildRequest);
	const outcome: "approved" | "denied" = decision.approved ? "approved" : "denied";
	const record = auditRecord(command, verdict, review, decision.comment, origin);
	if (options.audit) {
		options.audit(record, outcome, false);
	} else {
		pi.appendEntry("bash-audit", bashAuditPayload(record, outcome));
	}
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
