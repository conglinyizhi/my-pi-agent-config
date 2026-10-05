// lib/review-flow/flows/bash.ts — bash 审核链的流程形态
//
// 与旧链（lib/bash-approval.ts 的 preReviewBashCommand + approveBashCommand）等价：
//   chat 先给意见 → 分类器拿它当参考做判决 → 合并（分类器说了算）
//   → 判 safe 且档位 auto 就自动放行，否则问人
//
// 顺序是代码里的事实，不是稿子里的草图：自动放行判不出来才轮到人工闸门。

import type { Flow } from "../types.ts";
import { makeAutoApproveNode, makeChatReviewNode, makeClassifierNode, makeGateNode, makeMergeNode, type BashFlowInput, type ReviewNodeDeps } from "../nodes.ts";
import { runFlow, type RunResult } from "../runner.ts";

export const bashFlow: Flow = {
	id: "bash",
	// 整次运行的硬上限：超了就是这次审计失败，走 fail 出口（默认拒绝）
	deadlineMs: 60_000,
	// 只算模型调用次数：chat、分类器各一次，留点余量
	budget: { calls: 5 },
	nodes: [
		{ id: "chat", kind: "chatreview", next: "classify" },
		{ id: "classify", kind: "classifier", after: ["chat"], next: "merge" },
		{ id: "merge", kind: "merge", after: ["chat", "classify"], next: "auto" },
		{ id: "auto", kind: "autoapprove", after: ["merge"], next: "allow", onEmpty: "gate" },
		{ id: "gate", kind: "gate", after: ["merge"] },
	],
};

/**
 * 预审用的流程：与上面同一条链，只是**没有 gate 节点**。
 *
 * 问人是调用方那一步（approveBashCommand），预审只回答"能不能自动放行"，
 * 所以这里 auto 的两个出口都落在终点的两头：allow = 自动放行，deny = 需人工。
 */
export const bashPreReviewFlow: Flow = {
	id: "bash-pre",
	deadlineMs: 60_000,
	budget: { calls: 5 },
	nodes: [
		{ id: "chat", kind: "chatreview", next: "classify" },
		{ id: "classify", kind: "classifier", after: ["chat"], next: "merge" },
		{ id: "merge", kind: "merge", after: ["chat", "classify"], next: "auto" },
		{ id: "auto", kind: "autoapprove", after: ["merge"], next: "allow", onEmpty: "deny" },
	],
};

/**
 * 按配置档位挑预审流程：只跑对话模型 / 只跑分类器 / 两个都跑。
 *
 * 档位是用户能配的（extensions.toml 的 backend），旧链按它选支路，这里也一样：
 * 档位写 chat 就只问对话模型，别把分类器也拉起来。
 */
export function bashPreReviewFlowFor(backend: "chat" | "classifier" | "chain"): Flow {
	if (backend === "chat") {
		return {
			id: "bash-pre-chat",
			deadlineMs: 60_000,
			budget: { calls: 5 },
			nodes: [
				{ id: "chat", kind: "chatreview", next: "auto" },
				{ id: "auto", kind: "autoapprove", after: ["chat"], settings: { from: "chat" }, next: "allow", onEmpty: "deny" },
			],
		};
	}
	if (backend === "classifier") {
		return {
			id: "bash-pre-classifier",
			deadlineMs: 60_000,
			budget: { calls: 5 },
			nodes: [
				{ id: "classify", kind: "classifier", next: "merge" },
				{ id: "merge", kind: "merge", after: ["classify"], next: "auto" },
				{ id: "auto", kind: "autoapprove", after: ["merge"], next: "allow", onEmpty: "deny" },
			],
		};
	}
	return bashPreReviewFlow;
}
/**
 * 预审结论从哪个节点的产物取：
 *   chat       只有一个模型节点，取它
 *   classifier 走合并（合并把分类器的判决原样端出来）
 *   chain      同上
 */
export function preReviewReviewId(backend: "chat" | "classifier" | "chain"): string {
	return backend === "chat" ? "chat" : "merge";
}

/** 预审流程的 id：作者同名文件就覆盖它（文件名就是流程 id） */
export function preReviewFlowId(backend: "chat" | "classifier" | "chain"): string {
	return bashPreReviewFlowFor(backend).id;
}

/** 跑一次预审流程；决定 allow 就是自动放行 */
export async function runBashPreReviewFlow(
	input: BashFlowInput,
	deps: ReviewNodeDeps = {},
	backend: "chat" | "classifier" | "chain" = "chain",
) {
	return runFlow(bashPreReviewFlowFor(backend), input, { nodes: bashFlowNodes(deps) });
}

/** 这条流程用到的节点实现（注入点原样透给节点工厂） */
export function bashFlowNodes(deps: ReviewNodeDeps = {}) {
	return {
		chatreview: makeChatReviewNode(deps),
		classifier: makeClassifierNode(deps),
		merge: makeMergeNode(),
		autoapprove: makeAutoApproveNode(deps),
		gate: makeGateNode(deps),
	};
}

/**
 * 跑一次 bash 审核链。决定与轨迹都在返回值里。
 *
 * flowOverride 是给测试缩短超期上限用的：真跑流程时别用它改语义。
 */
export async function runBashFlow(
	input: BashFlowInput,
	deps: ReviewNodeDeps = {},
	flowOverride: Partial<Flow> = {},
): Promise<RunResult> {
	return runFlow({ ...bashFlow, ...flowOverride }, input, { nodes: bashFlowNodes(deps) });
}
