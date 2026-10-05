// lib/review-flow/pre-review.ts — 预审走流程（bash 链的第一步，不含人工闸门）
//
// 旧链的 preReviewBashCommand 做两件事：跑预审、给出"能不能自动放行"的判据。
// 这里换成跑流程：chat → 分类器 → 合并 → 自动放行，自动放行给 allow，否则 deny（= 需人工）。
// 问人仍是调用方那一步（approveBashCommand），所以这条流程里没有 gate 节点。

import { autoApproveDecision, type BashPreReviewResult } from "../bash-approval.ts";
import { reviewCacheKey, type LlmReviewConfig, type ReviewCache, type ReviewResult } from "../../extensions/sandbox-permissions/llm-review.ts";
import { bashFlowNodes, preReviewFlowId, preReviewReviewId, runBashPreReviewFlow } from "./flows/bash.ts";
import { findFlow } from "./load.ts";
import { runFlow } from "./runner.ts";
import type { BashFlowInput, ReviewNodeDeps } from "./nodes.ts";

export interface PreReviewOptions {
	input: BashFlowInput;
	config: LlmReviewConfig;
	/** 与旧链同一份缓存：键是命令原文加命中规则，缓存的是整条链的结论 */
	cache: ReviewCache;
	nodes?: ReviewNodeDeps;
}

/**
 * 跑预审。与旧链同形：拿不到结论就是 review = undefined、autoApproved = false。
 *
 * 缓存在这一层（旧链也是在这里缓存的：缓的是整条链的结论，不是某一步的），
 * 所以流程里的模型节点不再各自查缓存，免得把 chat 的结论当成整链结论写进去。
 */
export async function preReviewViaFlow(options: PreReviewOptions): Promise<BashPreReviewResult> {
	const { input, config, cache } = options;
	if (!config.enabled) return { config, review: undefined, autoApproved: false };

	const key = reviewCacheKey(input.command, input.rules);
	const hit = cache.get(key);
	if (hit) return { config, review: hit, autoApproved: autoApproveDecision(hit, config) };

	const nodes = { ...options.nodes, loadConfig: () => config };
	// 作者写了同名流程就用它（~/.pi/agent/review-flows/<id>.ts），否则内置那条。
	// 走作者那条时，内置种类的节点实现照样能用，作者自己的节点按 id 覆盖。
	const authored = await findFlow(preReviewFlowId(config.backend));
	const result = authored
		? await runFlow(authored.flow, input, { nodes: bashFlowNodes(nodes), byId: authored.nodes })
		: await runBashPreReviewFlow(input, nodes, config.backend);
	const review = result.outputs[preReviewReviewId(config.backend)] as ReviewResult | undefined;
	// 只缓存有效结论（error 是瞬态的：没 key、超时、限流，下次重试）
	if (review && review.verdict !== "error") cache.set(key, review);
	return { config, review, autoApproved: result.decision === "allow" };
}
