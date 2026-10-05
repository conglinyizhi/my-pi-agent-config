// lib/review-flow/runner.ts — 流程运行器（纯函数：图 + 节点实现 + 时钟 → 决定 + 轨迹）
//
// 设计稿：docs/plans/2026-10-05-review-flow-sdk.md
// 三层里最里面那层：并发、预算、超期、失败边、轨迹都在这里，模型调用一律由节点实现注入。
// 于是它可以用假节点单测（fixedVerdict / timeout / slow），不需要真模型。

import type { Flow, FlowNode, NodeKind, Terminal, TraceRecord } from "./types.ts";
import { describeProblems, validateFlow } from "./validate.ts";

export interface NodeRunContext {
	nodeId: string;
	kind: NodeKind;
	settings: Record<string, unknown>;
	/** 本次运行的输入（命令、规则、事实……），各节点共享只读 */
	input: Record<string, unknown>;
	/** 上游产物，按节点 id 取（由 after 声明） */
	upstream: Record<string, unknown>;
	/** 报告模型调用次数，计入预算 */
	spend(calls?: number): void;
	/** 取消信号：流程超期或外部取消时中止 */
	signal?: AbortSignal;
}

/**
 * 节点的一次运行结果。
 *   ok       有产物；带 terminal 就是它直接给了决定（闸门与出口这样用）
 *   abstain  给不出结论（弃权）→ 走 onEmpty
 *   error    失败 → 走 onError
 */
export type NodeOutcome =
	| {
		status: "ok";
		output?: unknown;
		terminal?: Terminal;
		calls?: number;
		model?: string;
		cached?: boolean;
		inputSummary?: string;
		outputSummary?: string;
		verdict?: string;
		reason?: string;
	  }
	| { status: "abstain"; reason?: string; calls?: number }
	| { status: "error"; message: string; calls?: number };

export type NodeImpl = (ctx: NodeRunContext) => Promise<NodeOutcome>;

export interface RunnerDeps {
	/** 按节点种类给实现；缺哪个种类就是那条流程用不了它 */
	nodes: Partial<Record<NodeKind, NodeImpl>>;
	/** 按节点 id 给实现，优先于按种类那份：作者自己的节点走这里 */
	byId?: Record<string, NodeImpl>;
	/** 测试可注入的时钟 */
	now?: () => number;
}

export interface RunResult {
	decision: Terminal;
	/** 决定从哪来：节点 id、边名、或 fail 出口 */
	via: string;
	/** 各节点产物，按节点 id 取（调用方要拿结论原文，比如预审要看合并那一步的 ReviewResult） */
	outputs: Record<string, unknown>;
	trace: TraceRecord[];
	calls: number;
	timedOut: boolean;
	budgetExhausted: boolean;
}

function isTerminal(value: string | undefined): value is Terminal {
	return value === "allow" || value === "deny";
}

/** 一个节点指出来的边（不区分成功失败，找入口用） */
function outEdgesOf(node: FlowNode): string[] {
	const out: string[] = [];
	for (const edge of [node.next, node.onError, node.onTimeout, node.onEmpty]) {
		if (edge) out.push(edge);
	}
	return out;
}

const FAIL_EXIT = "流程的 fail 出口";

export async function runFlow(
	flow: Flow,
	input: Record<string, unknown>,
	deps: RunnerDeps,
): Promise<RunResult> {
	// 加载即校验：不许静默挂住（硬约束 2）
	const problems = validateFlow(flow);
	if (problems.length > 0) throw new Error(describeProblems(flow.id, problems));

	const now = deps.now ?? (() => Date.now());
	const byId = new Map(flow.nodes.map((node) => [node.id, node]));
	const inbound = new Set<string>();
	for (const node of flow.nodes) for (const edge of outEdgesOf(node)) if (!isTerminal(edge)) inbound.add(edge);

	const outputs = new Map<string, unknown>();
	const started = new Set<string>();
	const trace: TraceRecord[] = [];
	const queue: string[] = flow.nodes.filter((node) => !inbound.has(node.id)).map((node) => node.id);

	const deadlineMs = flow.deadlineMs ?? 60_000;
	const ac = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		ac.abort();
	}, deadlineMs);

	let calls = 0;
	let budgetExhausted = false;
	let decision: Terminal | undefined;
	let via = "";

	const fail = (): Terminal => flow.onError ?? "deny";

	const skipRest = (reason: string): void => {
		for (const node of flow.nodes) {
			if (started.has(node.id)) continue;
			started.add(node.id);
			trace.push({
				nodeId: node.id,
				kind: node.kind,
				startedAt: now(),
				endedAt: now(),
				status: "skipped",
				via: reason,
			});
		}
	};

	while (queue.length > 0 && decision === undefined) {
		const id = queue.shift() as string;
		if (started.has(id)) continue;
		const node = byId.get(id);
		if (!node) continue;
		started.add(id);

		if (flow.budget?.calls !== undefined && calls >= flow.budget.calls) {
			budgetExhausted = true;
			trace.push({ nodeId: id, kind: node.kind, startedAt: now(), endedAt: now(), status: "budget", via: "预算用尽" });
			decision = fail();
			via = FAIL_EXIT;
			break;
		}

		const upstream: Record<string, unknown> = {};
		for (const dep of node.after ?? []) {
			if (outputs.has(dep)) upstream[dep] = outputs.get(dep);
		}

		const impl = deps.byId?.[id] ?? deps.nodes[node.kind];
		const at = now();
		let outcome: NodeOutcome;
		if (!impl) {
			outcome = { status: "error", message: `没有 ${node.kind} 节点的实现（id：${id}）` };
		} else {
			const ctx: NodeRunContext = {
				nodeId: id,
				kind: node.kind,
				settings: node.settings ?? {},
				input,
				upstream,
				spend: (n = 1) => { calls += n; },
				signal: ac.signal,
			};
			try {
				outcome = await Promise.race([
					impl(ctx),
					new Promise<NodeOutcome>((resolve) => {
						if (ac.signal.aborted) return resolve({ status: "error", message: "流程超期" });
						ac.signal.addEventListener("abort", () => resolve({ status: "error", message: "流程超期" }), { once: true });
					}),
				]);
			} catch (err) {
				outcome = { status: "error", message: err instanceof Error ? err.message : String(err) };
			}
		}
		if (outcome.calls) calls += outcome.calls;

		const base: TraceRecord = {
			nodeId: id,
			kind: node.kind,
			startedAt: at,
			endedAt: now(),
			status: "ran",
		};
		if (outcome.status === "ok") {
			if (outcome.output !== undefined) outputs.set(id, outcome.output);
			if (outcome.inputSummary) base.inputSummary = outcome.inputSummary;
			if (outcome.outputSummary) base.outputSummary = outcome.outputSummary;
			if (outcome.model) base.model = outcome.model;
			if (outcome.calls) base.calls = outcome.calls;
			if (outcome.cached) base.cached = outcome.cached;
			if (outcome.verdict) base.verdict = outcome.verdict;
			if (outcome.reason) base.reason = outcome.reason;
			trace.push(base);
			if (outcome.terminal) {
				// via 记的是"决定是怎么来的"：节点自己是哪条，看轨迹里的 nodeId
				decision = outcome.terminal;
				via = outcome.terminal;
				base.to = outcome.terminal;
				break;
			}
			if (node.next) {
				base.to = node.next;
				if (isTerminal(node.next)) {
					decision = node.next;
					via = node.next;
					break;
				}
				queue.push(node.next);
				continue;
			}
			// 没有 next 又没给决定：宁可拒绝也不许静默通过
			trace.push({ nodeId: id, kind: node.kind, startedAt: now(), endedAt: now(), status: "failed", via: "节点没有出口", verdict: "deny" });
			decision = fail();
			via = FAIL_EXIT;
			break;
		}

		const failed = outcome.status === "error";
		base.status = failed ? (timedOut ? "timedout" : "failed") : "ran";
		if (outcome.status === "error") base.reason = outcome.message;
		if (outcome.status === "abstain" && outcome.reason) base.reason = outcome.reason;
		if (outcome.status === "abstain") base.verdict = "弃权";
		if (outcome.calls) base.calls = outcome.calls;
		const edge = failed ? node.onError : node.onEmpty;
		trace.push(base);
		const target = edge ?? (failed ? "" : node.onError ?? "");
		if (isTerminal(target)) {
			base.to = target;
			decision = target;
			via = target;
			break;
		}
		if (target) {
			base.to = target;
			queue.push(target);
			continue;
		}
		base.to = FAIL_EXIT;
		decision = fail();
		via = FAIL_EXIT;
		break;
	}

	clearTimeout(timer);
	if (decision === undefined) {
		// 队列空了却没有决定：校验本该拦住，真出现就按 fail 出口处理
		decision = fail();
		via = FAIL_EXIT;
	}
	skipRest(via);
	return { decision, via, outputs: Object.fromEntries(outputs), trace, calls, timedOut, budgetExhausted };
}
