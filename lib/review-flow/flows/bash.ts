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
