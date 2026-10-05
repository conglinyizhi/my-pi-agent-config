// lib/review-flow/fixture.ts — 轨迹固化成可重放的用例
//
// 设计稿 §11：（提督 2026-10-05）不是导出 JSON 日志，而是固化成一条可回归的用例
//（输入 + 各节点结论 + 最终决定），能直接进测试集重放。一条夹具 = 一条用例。

import type { Flow, NodeKind, Terminal, TraceRecord } from "./types.ts";
import type { NodeImpl, NodeOutcome } from "./runner.ts";

export interface FlowFixture {
	flowId: string;
	capturedAt: string;
	/** 重放所需的输入（命令、命中的规则名、场景） */
	input: { command: string; rules: string[]; scenario?: string };
	decision: Terminal;
	/** 决定从哪来 */
	via: string;
	timedOut?: boolean;
	budgetExhausted?: boolean;
	/** 每个走到过的节点：结论、理由、以及它去了哪条边（跳过与失败也要记） */
	nodes: Array<{
		nodeId: string;
		kind: NodeKind;
		status: TraceRecord["status"];
		verdict?: string;
		reason?: string;
		via?: string;
		to?: string;
		calls?: number;
	}>;
	note?: string;
}

/** 从一次运行结果取一条夹具 */
export function fixtureOf(
	result: {
		decision: Terminal;
		via: string;
		trace: TraceRecord[];
		timedOut: boolean;
		budgetExhausted: boolean;
	},
	meta: { flowId: string; capturedAt: string; input: FlowFixture["input"]; note?: string },
): FlowFixture {
	return {
		flowId: meta.flowId,
		capturedAt: meta.capturedAt,
		input: meta.input,
		decision: result.decision,
		via: result.via,
		...(result.timedOut ? { timedOut: true } : {}),
		...(result.budgetExhausted ? { budgetExhausted: true } : {}),
		nodes: result.trace.map((record) => ({
			nodeId: record.nodeId,
			kind: record.kind,
			status: record.status,
			...(record.verdict ? { verdict: record.verdict } : {}),
			...(record.reason ? { reason: record.reason } : {}),
			...(record.via ? { via: record.via } : {}),
			...(record.to ? { to: record.to } : {}),
			...(record.calls ? { calls: record.calls } : {}),
		})),
		...(meta.note ? { note: meta.note } : {}),
	};
}

/** 生成一个 .ts 模块（人可读、能进代码评审、能直接 import） */
export function formatFixtureTs(fixture: FlowFixture, typeImport = "../fixture.ts"): string {
	const lines: string[] = [];
	lines.push("// 由一次运行固化下来的审核轨迹：输入 + 各节点结论 + 最终决定。");
	lines.push("// 重放见 lib/review-flow/fixture.test.ts");
	lines.push("import type { FlowFixture } from " + JSON.stringify(typeImport) + ";");
	lines.push("");
	lines.push("export const fixture: FlowFixture = " + JSON.stringify(fixture, null, 1) + ";");
	lines.push("");
	return lines.join("\n");
}

/** 把夹具里记的规则名还原成规则对象（pi 与 ctx 由调用方补） */
export function inputOf(fixture: FlowFixture): Record<string, unknown> {
	return {
		command: fixture.input.command,
		rules: fixture.input.rules.map((name) => ({ name })),
		...(fixture.input.scenario ? { scenario: fixture.input.scenario } : {}),
	};
}

/**
 * 重放用的假节点：按夹具里记的结论把每个节点演一遍。
 *
 * 于是在没有模型、没有人、没有网络的情况下，也能验这条轨迹当时为什么这么判。
 * 夹具漏记了一个节点，重放会当场露馅（流程跑到它时没有实现）。
 */
export function replayNodesOf(flow: Flow, fixture: FlowFixture): Partial<Record<NodeKind, NodeImpl>> {
	const byId = new Map(flow.nodes.map((node) => [node.id, node]));
	const nodes: Partial<Record<NodeKind, NodeImpl>> = {};
	for (const record of fixture.nodes) {
		const node = byId.get(record.nodeId);
		if (!node || nodes[node.kind]) continue;
		nodes[node.kind] = async () => {
			if (record.status === "failed" || record.status === "timedout") {
				return { status: "error", message: record.reason ?? "重放：这一步当时失败了" } as NodeOutcome;
			}
			if (record.verdict === "弃权") return { status: "abstain", reason: record.reason } as NodeOutcome;
			if (record.to === "allow" || record.to === "deny") {
				return { status: "ok", terminal: record.to, verdict: record.verdict ?? record.to } as NodeOutcome;
			}
			return { status: "ok", verdict: record.verdict, reason: record.reason } as NodeOutcome;
		};
	}
	return nodes;
}
