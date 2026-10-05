// lib/review-flow/graph.test.ts — 流程图的数据层
// 跑法：node --test --experimental-strip-types lib/review-flow/graph.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeRanks, graphOf } from "./graph.ts";
import type { Flow } from "./types.ts";

const BASH: Flow = {
	id: "bash-pre",
	nodes: [
		{ id: "chat", kind: "chatreview", next: "classify" },
		{ id: "classify", kind: "classifier", after: ["chat"], next: "merge" },
		{ id: "merge", kind: "merge", after: ["chat", "classify"], next: "auto" },
		{ id: "auto", kind: "autoapprove", after: ["merge"], next: "allow", onEmpty: "gate" },
		{ id: "gate", kind: "gate", after: ["merge"] },
	],
};

describe("流程图", () => {
	it("层级：入口 0，往下每步加一，终端排最后", () => {
		const graph = graphOf(BASH);
		const rank = (id: string) => graph.nodes.find((n) => n.id === id)?.rank;
		assert.equal(rank("chat"), 0);
		assert.equal(rank("classify"), 1);
		assert.equal(rank("merge"), 2);
		assert.equal(rank("auto"), 3);
		assert.equal(rank("gate"), 4);
		assert.equal(rank("allow"), 5, "终端画在最右一列");
	});

	it("输入是 after，出口带标签", () => {
		const graph = graphOf(BASH);
		const merge = graph.nodes.find((n) => n.id === "merge");
		assert.deepEqual(merge?.inputs, ["chat", "classify"]);
		assert.deepEqual(merge?.outputs, [{ label: "next", to: "auto" }]);
		const auto = graph.nodes.find((n) => n.id === "auto");
		assert.deepEqual(auto?.outputs, [{ label: "next", to: "allow" }, { label: "拿不准", to: "gate" }]);
	});

	it("分支出口的名字就是边上的字", () => {
		const graph = graphOf({ id: "b", nodes: [{ id: "judge", kind: "custom", branches: { yes: "gate", no: "deny" } }, { id: "gate", kind: "gate" }] });
		const judge = graph.nodes.find((n) => n.id === "judge");
		assert.deepEqual(judge?.outputs, [{ label: "yes", to: "gate" }, { label: "no", to: "deny" }]);
		const edge = graph.edges.find((e) => e.label === "no");
		assert.equal(edge?.kind, "branch");
	});

	it("成环（重试）不会把层级算挂住", () => {
		const loop: Flow = {
			id: "loop",
			nodes: [
				{ id: "start", kind: "chatreview", next: "a" },
				{ id: "a", kind: "custom", next: "b" },
				{ id: "b", kind: "classifier", next: "judge" },
				{ id: "judge", kind: "custom", branches: { again: "a", done: "allow" } },
			],
		};
		const ranks = computeRanks(loop);
		assert.equal(typeof ranks.get("a"), "number");
		assert.equal(graphOf(loop).nodes.length, 5);
	});

	it("没连终端的流程照样画得出来", () => {
		const graph = graphOf({ id: "x", nodes: [{ id: "a", kind: "merge" }] });
		assert.equal(graph.nodes.length, 1);
		assert.deepEqual(graph.edges, []);
	});
});
