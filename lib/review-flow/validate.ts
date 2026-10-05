// lib/review-flow/validate.ts — 流程的静态校验（加载即报错，不等到运行）
//
// 硬约束 2：没有 terminal 可达的流程加载即失败，不许静默挂住。
// 纯函数，无 IO：运行器与将来的声明式表示共用这一处校验。
//
// 控制流 = 边（next / onError / onTimeout / onEmpty）；数据流 = after。
// 这里查的是控制流那张图能不能走到终点，以及数据依赖是不是真的在前面。

import type { Flow, FlowNode, Terminal } from "./types.ts";

export interface FlowProblem {
	/** 出问题的节点（整条流程级别的问题用空串） */
	nodeId: string;
	message: string;
}

function isTerminal(value: string | undefined): value is Terminal {
	return value === "allow" || value === "deny";
}

/** 一个节点的出边：成功边、三条失败边 */
function outEdgesOf(node: FlowNode): string[] {
	const out: string[] = [];
	for (const edge of [node.next, node.onError, node.onTimeout, node.onEmpty]) {
		if (edge && !isTerminal(edge)) out.push(edge);
	}
	return out;
}

/** 有没有写死终点的出边，或本身就是出口节点（gate 由人给决定，也算出口） */
function hasTerminalEdge(node: FlowNode): boolean {
	if (node.kind === "terminal" || node.kind === "gate") return true;
	return [node.next, node.onError, node.onTimeout, node.onEmpty].some((edge) => isTerminal(edge));
}

/**
 * 校验一条流程。返回空数组表示可以加载。
 *
 * 检查项：
 *   1. id 不重复、不为空
 *   2. after 与四条边都指向存在的节点（或 allow / deny）
 *   3. 依赖不成环
 *   4. 有入口（没人指向的节点），且每个节点都从某个入口可达
 *   5. 每个节点都能走到终点
 *   6. 数据依赖真的在控制流的上游（after 写的那个节点，得先跑得到）
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
		for (const [field, edge] of [["next", node.next], ["onError", node.onError], ["onTimeout", node.onTimeout], ["onEmpty", node.onEmpty]] as const) {
			if (edge && !isTerminal(edge) && !byId.has(edge)) {
				problems.push({ nodeId: node.id, message: `${field} 指向不存在的节点：${edge}` });
			}
		}
	}
	if (problems.length > 0) return problems;

	// 依赖成环
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

	// 入口与可达
	const inbound = new Set<string>();
	for (const node of byId.values()) for (const edge of outEdgesOf(node)) inbound.add(edge);
	const entries = [...byId.values()].filter((node) => !inbound.has(node.id));
	if (entries.length === 0) {
		problems.push({ nodeId: "", message: "没有入口：所有节点都被别的节点指着" });
	}
	const reachable = new Set<string>();
	const queue = entries.map((node) => node.id);
	while (queue.length > 0) {
		const id = queue.shift() as string;
		if (reachable.has(id) || !byId.has(id)) continue;
		reachable.add(id);
		queue.push(...outEdgesOf(byId.get(id) as FlowNode));
	}
	for (const node of byId.values()) {
		if (!reachable.has(node.id)) problems.push({ nodeId: node.id, message: "从任何入口都走不到它" });
	}

	// 每个节点都能走到终点
	const reachesTerminal = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of byId.values()) {
			if (reachesTerminal.has(node.id)) continue;
			if (hasTerminalEdge(node) || outEdgesOf(node).some((next) => reachesTerminal.has(next))) {
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

	// 数据依赖得在控制流的上游：B.after 含 A 时，从入口到 B 必须经过 A
	const ancestors = (target: string): Set<string> => {
		const seen = new Set<string>();
		const stack = [...inboundTo(target)];
		while (stack.length > 0) {
			const id = stack.pop() as string;
			if (seen.has(id) || !byId.has(id)) continue;
			seen.add(id);
			stack.push(...inboundTo(id));
		}
		return seen;
	};
	function inboundTo(target: string): string[] {
		const sources: string[] = [];
		for (const node of byId.values()) if (outEdgesOf(node).includes(target)) sources.push(node.id);
		return sources;
	}
	for (const node of byId.values()) {
		for (const dep of node.after ?? []) {
			const before = ancestors(node.id);
			if (!before.has(dep) && inbound.has(dep)) {
				problems.push({ nodeId: node.id, message: `after 里的 ${dep} 在控制流上不一定先跑过` });
			}
		}
	}

	return problems;
}

/** 校验失败时的报错文案（加载方直接抛这个） */
export function describeProblems(flowId: string, problems: FlowProblem[]): string {
	const lines = problems.map((p) => (p.nodeId ? `  ${p.nodeId}: ${p.message}` : `  ${p.message}`));
	return `流程 ${flowId} 校验失败：\n${lines.join("\n")}`;
}
