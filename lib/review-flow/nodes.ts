// lib/review-flow/nodes.ts — 节点库：把已有能力包成节点，不重写任何判定
//
// 设计稿的硬约束 1：模型节点不授予权限。所以这里的 chat / classifier / merge 只产出结论，
// 能放行的只有 gate（人）与 autoapprove（显式判据）。
//
// 每个工厂都留注入点：测试里换掉 reviewCommand / classifierReview / 审批通道，不碰真模型。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TokenRule } from "../sandbox-check.ts";
import type { SandboxCheckResult } from "../sandbox-check.ts";
import { humanConfirm, type ApprovalRequestContext, type BashApprovalDependencies } from "../bash-approval.ts";
import {
	createReviewCache,
	loadLlmReviewConfig,
	reviewCommand as defaultReviewCommand,
	runClassifierReview,
	sessionUserRequest,
	toAdvisorNote,
	type LlmReviewConfig,
	type ReviewCache,
	type ReviewCallOptions,
	type ReviewResult,
} from "../../extensions/sandbox-permissions/llm-review.ts";
import type { NodeImpl, NodeRunContext } from "./runner.ts";

/** 本链共用的 LLM 缓存（与 bash 链同一份，键是命令原文加命中规则） */
const sharedReviewCache = createReviewCache();

/** 一条 bash 流程需要的东西：运行前一次带齐 */
export interface BashFlowInput extends Record<string, unknown> {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	command: string;
	rules: TokenRule[];
	reason?: string;
	facts?: SandboxCheckResult["facts"];
	factsUnavailable?: string;
	scenario?: "bash" | "ptc";
	taskId?: string;
	signal?: AbortSignal;
}

export interface ReviewNodeDeps {
	/** 测试注入；默认是真预审 */
	reviewCommand?: typeof defaultReviewCommand;
	/** 测试注入；默认是那条带 advisor 的分类器支路 */
	classifierReview?: typeof runClassifierReview;
	loadConfig?: () => LlmReviewConfig;
	reviewCache?: ReviewCache;
	/** 交给 gate 节点的审批通道 */
	approval?: BashApprovalDependencies;
}

function inputOf(ctx: NodeRunContext): BashFlowInput {
	return ctx.input as BashFlowInput;
}

/** 送审材料的口径：与旧链一处不差（场景与事实层都带上） */
function callOptions(input: BashFlowInput): ReviewCallOptions {
	return {
		...(input.facts ? { facts: input.facts } : {}),
		...(input.factsUnavailable ? { factsUnavailable: input.factsUnavailable } : {}),
		...(input.scenario ? { scenario: input.scenario } : {}),
	};
}

/** 关掉时与旧链同一句话，且不去碰模型 */
const DISABLED: ReviewResult = { verdict: "error", reason: "llm review disabled", suggestion: "" };

function summarize(result: ReviewResult): string {
	const dims = result.dimensions?.length ? `，${result.dimensions.length} 个维度` : "";
	return `${result.verdict}${dims}`;
}

/** 对话模型节点：给意见，不改判决（旧链里它排在最前面） */
export function makeChatReviewNode(deps: ReviewNodeDeps = {}): NodeImpl {
	return async (ctx) => {
		const input = inputOf(ctx);
		const cfg = (deps.loadConfig ?? loadLlmReviewConfig)();
		if (!cfg.enabled) {
			return { status: "ok", output: DISABLED, verdict: DISABLED.verdict, reason: DISABLED.reason };
		}
		const result = await (deps.reviewCommand ?? defaultReviewCommand)(
			input.pi,
			input.ctx,
			input.command,
			input.rules,
			input.signal,
			deps.reviewCache ?? sharedReviewCache,
			{ ...cfg, backend: "chat" },
			callOptions(input),
		);
		// 调用次数先按节点记 1 次：节点内部换模型重试的情况 v1 不细分
		return {
			status: "ok",
			output: result,
			calls: 1,
			verdict: result.verdict,
			reason: result.reason,
			inputSummary: input.command.slice(0, 80),
			outputSummary: summarize(result),
		};
	};
}

/** 分类器节点：判决者。上游 chat 的意见作为参考材料传下去，不单独触发弹窗 */
export function makeClassifierNode(deps: ReviewNodeDeps = {}): NodeImpl {
	return async (ctx) => {
		const input = inputOf(ctx);
		const cfg = (deps.loadConfig ?? loadLlmReviewConfig)();
		if (!cfg.enabled) {
			return { status: "ok", output: DISABLED, verdict: DISABLED.verdict, reason: DISABLED.reason };
		}
		const advisor = ctx.upstream.chat as ReviewResult | undefined;
		const userRequest = sessionUserRequest(input.ctx);
		const result = await (deps.classifierReview ?? runClassifierReview)(
			input.ctx,
			input.command,
			input.rules,
			input.signal,
			callOptions(input),
			userRequest,
			advisor,
		);
		return {
			status: "ok",
			output: result,
			calls: 1,
			verdict: result.verdict,
			reason: result.reason,
			outputSummary: summarize(result),
		};
	};
}

/**
 * 合并节点：**分类器的判决就是最终判决**（与 runChainedReview 一致）。
 * chat 的结论只挂成 chatReview 给人看：它会瞎报，让它一票否决等于把误报变成满屏弹窗。
 */
export function makeMergeNode(): NodeImpl {
	return async (ctx) => {
		const classifier = ctx.upstream.classify as ReviewResult | undefined;
		const chat = ctx.upstream.chat as ReviewResult | undefined;
		if (!classifier) {
			return { status: "abstain", reason: "分类器没有给结论" };
		}
		const merged: ReviewResult = {
			...classifier,
			...(chat ? { chatReview: toAdvisorNote(chat, classifier.verdict) } : {}),
		};
		return {
			status: "ok",
			output: merged,
			verdict: merged.verdict,
			reason: merged.reason,
			outputSummary: `${summarize(merged)}${chat ? `｜对话模型：${chat.verdict}` : ""}`,
		};
	};
}

/**
 * 自动放行节点：判据与主链同一处（判 safe 且档位 auto），不另写一份。
 * 放行就直接给决定；判不出来就弃权，由控制流把人接上。
 */
export function makeAutoApproveNode(deps: ReviewNodeDeps = {}): NodeImpl {
	return async (ctx) => {
		const merged = ctx.upstream.merge as ReviewResult | undefined;
		const cfg = (deps.loadConfig ?? loadLlmReviewConfig)();
		const autoApproved = merged?.verdict === "safe" && cfg.mode === "auto";
		if (autoApproved) {
			return { status: "ok", output: merged, terminal: "allow", verdict: "allow", reason: "预审判安全且档位是自动" };
		}
		const why = merged ? `判为 ${merged.verdict}` : "没有结论";
		return { status: "abstain", reason: `${why}，需人工确认` };
	};
}

/** 人工闸门节点：就是旧链里问人那一步（请求怎么构造不另抄一份） */
export function makeGateNode(deps: ReviewNodeDeps = {}): NodeImpl {
	return async (ctx) => {
		const input = inputOf(ctx);
		const merged = ctx.upstream.merge as ReviewResult | undefined;
		const context: ApprovalRequestContext = {
			command: input.command,
			rules: input.rules,
			reason: input.reason,
			review: merged,
			...(input.taskId ? { taskId: input.taskId } : {}),
			signal: input.signal,
		};
		const decision = await humanConfirm(input.ctx, context, deps.approval ?? {}, undefined);
		return {
			status: "ok",
			output: { approved: decision.approved, comment: decision.comment },
			terminal: decision.approved ? "allow" : "deny",
			verdict: decision.approved ? "allow" : "deny",
			reason: decision.comment ?? (decision.approved ? "人工放行" : "人工拒绝"),
		};
	};
}

/** 出口节点：把决定落成结论（有的流程直接用它收尾） */
export function makeTerminalNode(decision: "allow" | "deny"): NodeImpl {
	return async () => ({ status: "ok", terminal: decision, verdict: decision });
}
