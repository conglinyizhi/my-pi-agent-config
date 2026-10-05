// lib/review-flow/inspect.ts — 流程的体检：给 GUI 的数据（纯读，不写盘）
//
// 一个作者流程可能有三种状态：生效中（作者那条）、被内置覆盖（作者那条坏了）、内置。
// GUI 列表与图上都要能用一句话说清现在是哪一种，所以把这件事收成一处。

import { graphOf, type FlowGraph } from "./graph.ts";
import { flowsDir, listFlowFiles, loadFlowFile, loadKitExtra } from "./load.ts";
import { bashPreReviewFlowFor } from "./flows/bash.ts";
import { describeProblems, validateFlow } from "./validate.ts";
import type { Flow } from "./types.ts";

export interface FlowStatus {
	id: string;
	/** 作者写的文件；内置那条没有 */
	source?: string;
	/** 现在真正会跑的是谁 */
	active: "authored" | "builtin";
	/** 作者那条为什么没生效（有值就说明它没生效） */
	problems: string[];
	/** 现在跑的那条（坏掉且没有同名内置时，没有图可画） */
	flow?: Flow;
	graph?: FlowGraph;
	/** 这条 id 是不是内置也有 */
	builtin: boolean;
}

/** 内置的三条预审流程（按档位） */
export function builtinPreFlows(): Flow[] {
	return [bashPreReviewFlowFor("chain"), bashPreReviewFlowFor("chat"), bashPreReviewFlowFor("classifier")];
}

/**
 * 体检一个目录：每条作者流程一条记录，再加没被覆盖的内置流程。
 *
 * 读类操作，不写盘、不改状态；坏掉的作者流程照样列出来（active 是内置那条，problems 写着原因）。
 */
export async function inspectFlows(dir = flowsDir()): Promise<FlowStatus[]> {
	const out: FlowStatus[] = [];
	const taken = new Set<string>();
	const { kit } = await loadKitExtra(dir);

	for (const { id, path } of listFlowFiles(dir)) {
		const loaded = await loadFlowFile(id, path, kit);
		if (!("error" in loaded)) {
			out.push({ id, source: path, active: "authored", problems: [], flow: loaded.flow, graph: graphOf(loaded.flow), builtin: false });
			taken.add(id);
			continue;
		}
		const fallback = builtinPreFlows().find((flow) => flow.id === id);
		if (!fallback) {
			// 没有对应内置：这条流程现在压根不会跑，但照样列出来给人改
			out.push({ id, source: path, active: "builtin", problems: [loaded.error], builtin: false });
			continue;
		}
		out.push({ id, source: path, active: "builtin", problems: [loaded.error], flow: fallback, graph: graphOf(fallback), builtin: true });
		taken.add(id);
	}

	for (const flow of builtinPreFlows()) {
		if (taken.has(flow.id)) continue;
		// 注意：describeProblems 有没有问题都会给标题行，所以要按校验结果判空
		const checked = validateFlow(flow);
		out.push({
			id: flow.id,
			active: "builtin",
			problems: checked.length > 0 ? [describeProblems(flow.id, checked)] : [],
			flow,
			graph: graphOf(flow),
			builtin: true,
		});
	}

	return out.sort((a, b) => a.id.localeCompare(b.id));
}
