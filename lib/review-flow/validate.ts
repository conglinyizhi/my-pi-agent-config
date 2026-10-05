// lib/review-flow/validate.ts — 流程的静态校验（加载即报错，不等到运行）
//
// 硬约束 2：没有 terminal 可达的流程加载即失败，不许静默挂住。
// 纯函数，无 IO：运行器与将来的声明式表示共用这一处校验。

import type { Flow, FlowNode, Terminal } from "./types.ts";

export interface FlowProblem {
	/** 出问题的节点（整条流程级别的问题用流程 id） */
	nodeId: string;
	message: string;
}

function isTerminal(value: string | undefined): value is Terminal {
	return value === "allow" || value === "deny";
}

/** 一个节点可能去向哪些地方：依赖它的节点、失败边、超时边，以及流程出口 */
function successorsOf(node: FlowNode, byId: Map<string, FlowNode>): string[] {
	const out: string[] = [];
	for (const other of byId.values()) {
		if ((other.after ?? []).includes(node.id)) out.push(other.id);
	}
	if (node.onError) out.push(node.onError);
	if (node.onTimeout) out.push(node.onTimeout);
	return out;
}

/**
 * 校验一条流程。返回空数组表示可以加载。
 *
 * 检查项：
 *   1. id 不重复、不为空
 *   2. after / onError / onTimeout 指向存在的节点（或 allow / deny）
 *   3. 依赖不成环
 *   4. 每个节点都能走到一个终点（终点的来源：terminal 节点，或失败边写了 allow / deny）
 */
export function validateFlow(flow: Flow): FlowProblem[] {
	const problems: FlowProblem[] = [];
	const byId = new Map<string, FlowNode>();

	for (const node of flow.nodes) {
		if (!node.id) {
			problems.push({ nodeId: "", message: "节点缺 id" });
			continue;
		}
		if (byId.has(node.id)) {
			problems.push({ nodeId: node.id, message: `节点 id 重复：${node.id}` });
			continue;
		}
		byId.set(node.id, node);
	}

	for (const node of byId.values()) {
		for (const dep of node.after ?? []) {
			if (!byId.has(dep)) problems.push({ nodeId: node.id, message: `after 指向不存在的节点：${dep}` });
		}
		for (const [field, edge] of [["onError", node.onError], ["onTimeout", node.onTimeout]] as const) {
			if (edge && !isTerminal(edge) && !byId.has(edge)) {
				problems.push({ nodeId: node.id, message: `${field} 指向不存在的节点：${edge}` });
			}
		}
	}

	// 环：沿 after 走不回自己
	const state = new Map<string, "visiting" | "done">();
	const visit = (node: FlowNode, path: string[]): void => {
		if (state.get(node.id) === "done") return;
		if (state.get(node.id) === "visiting") {
			problems.push({ nodeId: node.id, message: `依赖成环：${[...path, node.id].join(" -> ")}` });
			return;
		}
		state.set(node.id, "visiting");
		for (const dep of node.after ?? []) {
			const upstream = byId.get(dep);
			if (upstream) visit(upstream, [...path, node.id]);
		}
		state.set(node.id, "done");
	};
	for (const node of byId.values()) visit(node, []);

	// 终点可达：从每个节点出发，能不能走到 terminal（或写了 allow / deny 的边）
	const reachesTerminal = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of byId.values()) {
			if (reachesTerminal.has(node.id)) continue;
			if (node.kind === "terminal" || isTerminal(node.onError) || isTerminal(node.onTimeout)) {
				reachesTerminal.add(node.id);
				changed = true;
				continue;
			}
			if (successorsOf(node, byId).some((next) => reachesTerminal.has(next))) {
				reachesTerminal.add(node.id);
				changed = true;
			}
		}
	}
	for (const node of byId.values()) {
		if (!reachesTerminal.has(node.id)) {
			problems.push({ nodeId: node.id, message: "走不到任何终点：这条流程会静默挂住" });
		}
	}

	return problems;
}

/** 校验失败时的报错文案（加载方直接抛这个） */
export function describeProblems(flowId: string, problems: FlowProblem[]): string {
	const lines = problems.map((p) => (p.nodeId ? `  ${p.nodeId}: ${p.message}` : `  ${p.message}`));
	return `流程 ${flowId} 校验失败：\n${lines.join("\n")}`;
}
