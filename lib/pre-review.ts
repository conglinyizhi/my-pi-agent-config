// lib/pre-review.ts — 预审：对话模型 → 分类器 → 合并 → 自动放行（不含人工闸门）
//
// 这条链路原来由"流程文件"描述（review-flows/bash-pre*.ts）。流程那层废掉之后，
// 顺序写死在这里：档位决定跑哪几步，判据仍然只有那一处 decideWithRules。
// 问人是调用方那一步（approveBashCommand），所以这里没有闸门这一步。

import { autoApproveDecision, type BashPreReviewResult } from "./bash-approval.ts";
import { decideWithRules, defaultRulesPath, loadReviewRules } from "./review-rules.ts";
import {
	reviewCacheKey,
	toAdvisorNote,
	type LlmReviewConfig,
	type ReviewCache,
	type ReviewResult,
} from "../extensions/sandbox-permissions/llm-review.ts";
import {
	makeAutoApproveNode,
	makeChatReviewNode,
	makeClassifierNode,
	makeMergeNode,
	type BashFlowInput,
	type NodeRunContext,
	type ReviewNodeDeps,
} from "./review-steps.ts";

/** 整次预审的硬上限：超了就当没结论，交给人 */
const DEADLINE_MS = 60_000;

export interface PreReviewOptions {
	input: BashFlowInput;
	config: LlmReviewConfig;
	/** 与旧链同一份缓存：键是命令原文加命中规则，缓存的是整条链的结论 */
	cache: ReviewCache;
	nodes?: ReviewNodeDeps;
}

type Backend = LlmReviewConfig["backend"];

function context(
	nodeId: string,
	settings: Record<string, unknown>,
	input: BashFlowInput,
	upstream: Record<string, unknown>,
	signal: AbortSignal,
): NodeRunContext {
	return { nodeId, kind: nodeId, settings, input, upstream, spend: () => {}, signal };
}

function outputOf(outcome: { status: string; output?: unknown }): ReviewResult | undefined {
	return outcome.status === "ok" ? (outcome.output as ReviewResult | undefined) : undefined;
}

/** 按档位跑模型那几步，返回"最终判决"那一份结论（chat 档取对话模型，其余取合并） */
async function runChain(
	input: BashFlowInput,
	backend: Backend,
	deps: ReviewNodeDeps,
	signal: AbortSignal,
): Promise<ReviewResult | undefined> {
	// 档位决定跑哪几步：classifier 档不许顺手把对话模型也拉起来（白花钱，用例盯着这条）
	let chatReview: ReviewResult | undefined;
	if (backend !== "classifier") {
		chatReview = outputOf(await makeChatReviewNode(deps)(context("chat", {}, input, {}, signal)));
	}
	if (backend === "chat") return chatReview;

	const upstream: Record<string, unknown> = chatReview ? { chat: chatReview } : {};
	const classify = await makeClassifierNode(deps)(context("classify", {}, input, upstream, signal));
	upstream.classify = outputOf(classify);
	const merged = outputOf(await makeMergeNode()(context("merge", {}, input, upstream, signal)));

	// 分类器超时/挂了但对话模型有结论：视为分类器绿灯，只按对话模型判（提督 2026-10-05 定的）。
	// 这是有意放宽：分类器打不通时按对话模型的结论走，而不是每次都把人叫来。
	// 代价记在这里——对话模型比分类器弱，误放行的风险由它的 verdict 兜着（它判 risky 仍会问人）。
	if (merged?.verdict === "error" && chatReview && chatReview.verdict !== "error") {
		return {
			...chatReview,
			reason: `分类器没给出结论（${merged.reason}），本次按对话模型判：${chatReview.reason}`,
			// 把对话模型自己的话也挂到 chatReview：审批窗那张「LLM 审核」卡读的是这个字段，
			// 不挂的话卡是空的（踩过：结论写着"按对话模型判"，那张卡却什么都没显示）
			chatReview: toAdvisorNote(chatReview, chatReview.verdict),
			// 给界面一个明说的机会：卡上不该写"寄了"，那是"分类器没结论、这是替代判断"
			classifierFailed: merged.reason,
		};
	}
	return merged;
}

/** 判哪一份结论：两个模型都跑时看合并，只跑对话模型时看它（与原来一致） */
function judgeFrom(backend: Backend): string {
	return backend === "chat" ? "chat" : "merge";
}

/**
 * 跑预审。与旧链同形：拿不到结论就是 review = undefined、autoApproved = false。
 *
 * 缓存在这一层（缓的是整条链的结论，不是某一步的），所以模型步骤不再各自查缓存，
 * 免得把对话模型的结论当成整链结论写进去。
 */
export async function preReview(options: PreReviewOptions): Promise<BashPreReviewResult> {
	const { input, config, cache } = options;
	if (!config.enabled) return { config, review: undefined, autoApproved: false };

	const loadRules = options.nodes?.loadRules ?? (() => loadReviewRules(defaultRulesPath()));
	const key = reviewCacheKey(input.command, input.rules);
	const hit = cache.get(key);
	if (hit) {
		// 缓存命中也要过规则：规则改了不必等缓存失效，否则开关会时灵时不灵
		const decision = decideWithRules({
			builtinApprove: autoApproveDecision(hit, config),
			masterSwitchOn: config.mode === "auto",
			facts: { verdict: hit.verdict, dimensions: hit.dimensions, command: input.command },
			rules: loadRules(),
		});
		return { config, review: hit, autoApproved: decision.approve };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
	const deps: ReviewNodeDeps = { ...options.nodes, loadConfig: () => config };
	try {
		const review = await runChain(input, config.backend, deps, controller.signal);
		const from = judgeFrom(config.backend);
		// 决定仍由那一步判：规则只修正它，放行也仍受总开关管
		const auto = await makeAutoApproveNode(deps)(
			context("auto", { from, command: input.command }, input, { [from]: review }, controller.signal),
		);
		// 只缓存有效结论（error 是瞬态的：没 key、超时、限流，下次重试）
		if (review && review.verdict !== "error") cache.set(key, review);
		return { config, review, autoApproved: auto.status === "ok" && auto.terminal === "allow" };
	} finally {
		clearTimeout(timer);
	}
}
