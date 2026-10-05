// gui/frontend/src/domain/flows/graph-layout.test.js
// 跑法：node --test gui/frontend/src/domain/flows/graph-layout.test.js

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOX, edgePath, layoutGraph, xOf, yOf } from "./graph-layout.js";

const GRAPH = {
	id: "bash-pre",
	nodes: [
		{ id: "chat", kind: "chatreview", rank: 0, lane: 0, inputs: [], outputs: [] },
		{ id: "classify", kind: "classifier", rank: 1, lane: 0, inputs: ["chat"], outputs: [] },
		{ id: "gate", kind: "gate", rank: 2, lane: 1, inputs: ["classify"], outputs: [], givesOwnDecision: true },
		{ id: "allow", kind: "terminal", rank: 3, lane: 0, inputs: [], outputs: [], terminal: "allow" },
	],
	edges: [
		{ from: "chat", to: "classify", label: "next", kind: "next" },
		{ from: "classify", to: "gate", label: "拿不准", kind: "empty" },
		{ from: "gate", to: "allow", label: "allow", kind: "branch" },
		{ from: "没有这个", to: "allow", label: "??", kind: "next" },
	],
};

describe("流程图布局", () => {
	it("层级决定横坐标，泳道决定纵坐标", () => {
		const laid = layoutGraph(GRAPH);
		const at = (id) => laid.nodes.find((n) => n.id === id);
		assert.equal(at("chat").x, xOf(0));
		assert.equal(at("classify").x, xOf(1));
		assert.equal(at("gate").y, yOf(1));
		assert.ok(at("allow").x > at("gate").x);
	});

	it("边从源盒右缘连到目标盒左缘", () => {
		const laid = layoutGraph(GRAPH);
		const from = laid.nodes.find((n) => n.id === "chat");
		const to = laid.nodes.find((n) => n.id === "classify");
		assert.equal(edgePath(from, to), laid.edges[0].d);
		assert.match(laid.edges[0].d, /^M \d+ \d+ C /);
		assert.equal(laid.edges[0].labelX, (from.x + BOX.width + to.x) / 2);
	});

	it("连到不存在的节点就不画那条线", () => {
		const laid = layoutGraph(GRAPH);
		assert.equal(laid.edges.length, 3);
		assert.equal(laid.edges.some((edge) => edge.label === "??"), false);
	});

	it("画布按内容变大，空图也有个最小尺寸", () => {
		const laid = layoutGraph(GRAPH);
		const right = Math.max(...laid.nodes.map((n) => n.x + n.w)) + BOX.padX;
		assert.equal(laid.width, Math.max(320, right));
		const empty = layoutGraph({ id: "x", nodes: [], edges: [] });
		assert.equal(empty.width, 320);
		assert.equal(empty.height, 180);
	});

	it("自己给决定的节点带着标记过去（前端画虚线出口用）", () => {
		const laid = layoutGraph(GRAPH);
		assert.equal(laid.nodes.find((n) => n.id === "gate").givesOwnDecision, true);
		assert.equal(laid.nodes.find((n) => n.id === "allow").terminal, "allow");
	});
});
