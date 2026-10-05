// lib/review-flow/runner.test.ts — 运行器（全部用假节点，不碰真模型）
// 跑法：node --test --experimental-strip-types lib/review-flow/runner.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runFlow, type NodeImpl, type NodeOutcome } from "./runner.ts";
import type { Flow } from "./types.ts";

/** bash 那条链的形状：chat → 分类器 → 合并 → 自动放行，判不出来才轮到人 */
const BASH_SHAPE: Flow = {
	id: "bash",
	deadlineMs: 5_000,
	nodes: [
		{ id: "chat", kind: "chatreview", next: "classify" },
		{ id: "classify", kind: "classifier", after: ["chat"], next: "merge" },
		{ id: "merge", kind: "merge", after: ["classify"], next: "auto" },
		{ id: "auto", kind: "autoapprove", after: ["merge"], next: "allow", onEmpty: "gate" },
		{ id: "gate", kind: "gate", after: ["merge"] },
	],
};

function fixed(outcome: NodeOutcome): NodeImpl {
	return async () => outcome;
}

function nodesOf(overrides: Partial<Record<string, NodeImpl>>): Record<string, NodeImpl> {
	return {
		chatreview: fixed({ status: "ok", verdict: "safe", verdictKind: undefined } as NodeOutcome),
		...overrides,
	} as Record<string, NodeImpl>;
}

describe("流程运行器", () => {
	it("自动放行那条：到 allow 就停，闸门记成跳过", async () => {
		const result = await runFlow(BASH_SHAPE, {}, {
			nodes: {
				chatreview: fixed({ status: "ok", output: "chat", verdict: "safe" }),
				classifier: fixed({ status: "ok", output: "classify", verdict: "safe" }),
				merge: fixed({ status: "ok", output: "merged", verdict: "safe" }),
				autoapprove: fixed({ status: "ok", output: "auto", terminal: "allow", verdict: "allow" }),
			},
		});
		assert.equal(result.decision, "allow");
		// via 记的是决定怎么来的；是哪条节点给的，看轨迹里谁把 to 写成了 allow
		assert.equal(result.via, "allow");
		// 产物要能取回来：预审就是靠合并那一步的结论
		assert.equal(result.outputs.merge, "merged");
		assert.equal(result.trace.find((r) => r.to === "allow" && r.status === "ran")?.nodeId, "auto");
		const gate = result.trace.find((r) => r.nodeId === "gate");
		assert.equal(gate?.status, "skipped");
		assert.match(gate?.via ?? "", /allow/);
	});

	it("自动放行判不出来：走 onEmpty 去闸门，闸门给决定", async () => {
		const result = await runFlow(BASH_SHAPE, {}, {
			nodes: {
				chatreview: fixed({ status: "ok", output: "chat", verdict: "risky" }),
				classifier: fixed({ status: "ok", output: "classify", verdict: "risky" }),
				merge: fixed({ status: "ok", output: "merged", verdict: "risky" }),
				autoapprove: fixed({ status: "abstain", reason: "需人工确认" }),
				gate: fixed({ status: "ok", terminal: "deny", verdict: "deny" }),
			},
		});
		assert.equal(result.decision, "deny");
		assert.equal(result.via, "deny");
		assert.equal(result.trace.find((r) => r.to === "deny" && r.status === "ran")?.nodeId, "gate");
		const auto = result.trace.find((r) => r.nodeId === "auto");
		assert.equal(auto?.verdict, "弃权");
		assert.equal(auto?.to, "gate");
	});

	it("上游节点失败：走 onError，没接就走 fail 出口", async () => {
		const result = await runFlow(BASH_SHAPE, {}, {
			nodes: {
				chatreview: fixed({ status: "error", message: "模型超时" }),
				classifier: fixed({ status: "ok", output: "classify" }),
				merge: fixed({ status: "ok", output: "merged" }),
				autoapprove: fixed({ status: "ok", terminal: "allow" }),
				gate: fixed({ status: "ok", terminal: "allow" }),
			},
		});
		assert.equal(result.decision, "deny");
		const chat = result.trace.find((r) => r.nodeId === "chat");
		assert.equal(chat?.status, "failed");
		assert.equal(chat?.reason, "模型超时");
		assert.equal(result.trace.filter((r) => r.status === "skipped").length >= 1, true);
	});

	it("整次超期：超了走 fail 出口，轨迹里能看出是谁挂住了", async () => {
		const hang: NodeImpl = () => new Promise<NodeOutcome>(() => {});
		const result = await runFlow({ ...BASH_SHAPE, deadlineMs: 30 }, {}, {
			nodes: { chatreview: hang, classifier: fixed({ status: "ok" }), merge: fixed({ status: "ok" }), autoapprove: fixed({ status: "ok" }), gate: fixed({ status: "ok" }) },
		});
		assert.equal(result.decision, "deny");
		assert.equal(result.timedOut, true);
		const chat = result.trace.find((r) => r.nodeId === "chat");
		assert.equal(chat?.status, "timedout");
	});

	it("预算用尽：走 fail 出口，并标出是预算", async () => {
		const result = await runFlow({ ...BASH_SHAPE, budget: { calls: 1 } }, {}, {
			nodes: {
				chatreview: fixed({ status: "ok", output: "chat", calls: 1 }),
				classifier: fixed({ status: "ok", output: "classify", calls: 1 }),
				merge: fixed({ status: "ok" }),
				autoapprove: fixed({ status: "ok", terminal: "allow" }),
				gate: fixed({ status: "ok" }),
			},
		});
		assert.equal(result.budgetExhausted, true);
		assert.equal(result.calls, 1);
		assert.equal(result.decision, "deny");
		assert.equal(result.trace.some((r) => r.status === "budget"), true);
	});

	it("校验不过的流程直接抛错，不跑", async () => {
		await assert.rejects(
			() => runFlow({ id: "坏的", nodes: [{ id: "a", kind: "merge", next: "b" }, { id: "b", kind: "merge", next: "a" }] }, {}, { nodes: {} }),
			/校验失败/,
		);
	});

	it("没有实现的节点种类：算失败，走 fail 出口", async () => {
		const result = await runFlow(BASH_SHAPE, {}, { nodes: { chatreview: fixed({ status: "ok" }) } });
		assert.equal(result.decision, "deny");
		assert.match(result.trace.find((r) => r.nodeId === "classify")?.reason ?? "", /没有 classifier 节点的实现/);
	});
});
