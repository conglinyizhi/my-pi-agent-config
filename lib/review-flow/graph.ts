// lib/review-flow/graph.ts — 把流程变成一张图（纯函数，无 IO）
//
// 给 GUI 用的数据层：节点、边、层级与泳道，终端也当成节点画出来。
// 算在这里而不是前端：前端只负责画，图的语义（谁是输入、谁走哪条边、层级怎么排）只有一份实现。

import type { Flow, FlowNode, NodeKind, Terminal } from "./types.ts";

export interface GraphEdge {
	from: string;
	to: string;
	/** 边上写的字：next / yes / no / 出错 / 超时 / 拿不准 */
	label: string;
	kind: "next" | "branch" | "error" | "timeout" | "empty";
}

export interface GraphNode {
	id: string;
	kind: NodeKind | "terminal";
	/** 层级：从入口出发的最长路径（环安全，见 computeRanks） */
	rank: number;
	/** 同一层里的第几条（按声明顺序，稳定） */
	lane: number;
	/** 输入：要哪些上游的产物（就是 after） */
	inputs: string[];
	/** 出口：往哪走（画在盒子上） */
	outputs: Array<{ label: string; to: string }>;
	/** 终端的决定 */
	terminal?: Terminal;
	/** 自己给决定的节点（terminal / gate / custom）：图上画成虚线出口，不画具体边 */
	givesOwnDecision?: boolean;
	settings?: Record<string, unknown>;
}

export interface FlowGraph {
	id: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** 有没有终点接不到（校验器会另外报，这里只标出来给图上色） */
	unreachableTerminal: string[];
}

/** 一个节点的所有出边（带标签），顺序固定：成功边、分支、失败边 */
export function edgesOutOf(node: FlowNode): GraphEdge[] {
	const out: GraphEdge[] = [];
	const push = (to: string | undefined, label: string, kind: GraphEdge["kind"]) => {
		if (to) out.push({ from: node.id, to, label, kind });
	};
	push(node.next, "next", "next");
	for (const [name, target] of Object.entries(node.branches ?? {})) push(target, name, "branch");
	push(node.onEmpty, "拿不准", "empty");
	push(node.onTimeout, "超时", "timeout");
	push(node.onError, "出错", "error");
	return out;
}

/**
 * 层级：从入口出发的最长路径。
 *
 * 控制流允许成环（重试就是环），所以这里做的是「松弛到不再变化」而不是拓扑排序；
 * 每轮最多给一个节点加 1，节点数有限，一定会停。
 */
export function computeRanks(flow: Flow): Map<string, number> {
	const ranks = new Map<string, number>();
	const inbound = new Set<string>();
	for (const node of flow.nodes) for (const edge of edgesOutOf(node)) if (!isTerminalId(edge.to)) inbound.add(edge.to);
	const entries = flow.nodes.filter((node) => !inbound.has(node.id));
	for (const node of entries) ranks.set(node.id, 0);
	const limit = flow.nodes.length + 1;
	let changed = true;
	let rounds = 0;
	while (changed && rounds < limit) {
		changed = false;
		rounds += 1;
		for (const node of flow.nodes) {
			const from = ranks.get(node.id);
			if (from === undefined) continue;
			for (const edge of edgesOutOf(node)) {
				if (isTerminalId(edge.to)) continue;
				const seen = ranks.get(edge.to);
				if (seen === undefined || seen < from + 1) {
					ranks.set(edge.to, from + 1);
					changed = true;
				}
			}
		}
	}
	return ranks;
}

function isTerminalId(id: string): boolean {
	return id === "allow" || id === "deny";
}

/** 把一条流程收成图 */
export function graphOf(flow: Flow): FlowGraph {
	const ranks = computeRanks(flow);
	const edges: GraphEdge[] = [];
	for (const node of flow.nodes) edges.push(...edgesOutOf(node));

	// 终端也画出来：图上看得到「往哪去」，而不是断在半空
	const terminalIds = new Set(edges.map((edge) => edge.to).filter((to) => isTerminalId(to)));
	const terminalRank = Math.max(0, ...[...ranks.values()]) + 1;

	const laneCount = new Map<number, number>();
	const nodes: GraphNode[] = flow.nodes.map((node) => {
		const rank = ranks.get(node.id) ?? 0;
		const lane = laneCount.get(rank) ?? 0;
		laneCount.set(rank, lane + 1);
		return {
			id: node.id,
			kind: node.kind,
			rank,
			lane,
			inputs: [...(node.after ?? [])],
			outputs: edgesOutOf(node).map((edge) => ({ label: edge.label, to: edge.to })),
			...(node.kind === "terminal" || node.kind === "gate" || node.kind === "custom" ? { givesOwnDecision: true } : {}),
			...(node.settings ? { settings: node.settings } : {}),
		};
	});

	let terminalLane = 0;
	for (const id of ["allow", "deny"] as const) {
		if (!terminalIds.has(id)) continue;
		nodes.push({
			id,
			kind: "terminal",
			rank: terminalRank,
			lane: terminalLane,
			inputs: [],
			outputs: [],
			terminal: id,
		});
		terminalLane += 1;
	}

	return { id: flow.id, nodes, edges, unreachableTerminal: [] };
}
