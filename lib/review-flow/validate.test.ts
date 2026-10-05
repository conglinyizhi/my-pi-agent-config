// lib/review-flow/validate.test.ts — 流程静态校验
// 跑法：node --test --experimental-strip-types lib/review-flow/validate.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeProblems, validateFlow } from "./validate.ts";
import type { Flow, FlowNode } from "./types.ts";

function flow(nodes: FlowNode[]): Flow {
	return { id: "bash", nodes };
}

/** bash 那条链的真实形状：chat → 分类器 → 合并 → 自动放行，判不出来才轮到人 */
const BASH_SHAPE: FlowNode[] = [
	{ id: "chat", kind: "chatreview", next: "classify" },
	{ id: "classify", kind: "classifier", after: ["chat"], next: "merge" },
	{ id: "merge", kind: "merge", after: ["classify"], next: "auto" },
	{ id: "auto", kind: "autoapprove", after: ["merge"], next: "allow", onEmpty: "gate" },
	{ id: "gate", kind: "gate", after: ["merge"] },
];

describe("流程静态校验", () => {
	it("bash 那个形状能过", () => {
		assert.deepEqual(validateFlow(flow(BASH_SHAPE)), []);
	});

	it("自己成环、接不上入口的节点会被指出来", () => {
		// 两个节点互相指着，谁也进不去：没有入口，也没有终点
		const problems = validateFlow(flow([
			{ id: "a", kind: "merge", next: "b" },
			{ id: "b", kind: "merge", next: "a" },
		]));
		const text = problems.map((p) => p.message).join("\n");
		assert.match(text, /没有入口/);
		assert.match(text, /走不到/);
	});

	it("走不到终点的节点会被指出来（硬约束 2）", () => {
		const problems = validateFlow(flow([
			{ id: "a", kind: "rule", next: "b" },
			{ id: "b", kind: "merge" },
		]));
		assert.equal(problems.length, 2);
		assert.match(problems.map((p) => p.message).join("\n"), /走不到任何终点/);
	});

	it("id 重复会被指出来", () => {
		const problems = validateFlow(flow([
			{ id: "a", kind: "rule", next: "deny" },
			{ id: "a", kind: "rule", next: "allow" },
		]));
		assert.equal(problems.length, 1);
		assert.match(problems[0]?.message ?? "", /重复/);
	});

	it("边指向不存在的节点会被指出来", () => {
		const problems = validateFlow(flow([
			{ id: "a", kind: "rule", next: "没有这个" },
			{ id: "b", kind: "rule", next: "deny", onTimeout: "也没有这个" },
		]));
		const text = problems.map((p) => p.message).join("\n");
		assert.match(text, /next 指向不存在/);
		assert.match(text, /onTimeout 指向不存在/);
	});

	it("依赖成环会被指出来", () => {
		const problems = validateFlow(flow([
			{ id: "a", kind: "merge", after: ["b"], next: "deny" },
			{ id: "b", kind: "merge", after: ["a"], next: "allow" },
		]));
		assert.match(problems.map((p) => p.message).join("\n"), /成环/);
	});

	it("数据依赖不在控制流上游会被指出来（闸门提前跑就是这么来的）", () => {
		// mixer 想要 rule 的产物，但它走的是另一条支路：rule 在这条路上不一定跑过
		const problems = validateFlow(flow([
			{ id: "facts", kind: "facts", next: "rule" },
			{ id: "rule", kind: "rule", after: ["facts"], next: "deny" },
			{ id: "other", kind: "scan", next: "mixer" },
			{ id: "mixer", kind: "merge", after: ["rule"], next: "allow" },
		]));
		assert.match(problems.map((p) => p.message).join("\n"), /不一定先跑过/);
	});

	it("报错文案带上流程名与节点名", () => {
		const text = describeProblems("bash", [{ nodeId: "孤儿", message: "走不到任何终点" }]);
		assert.match(text, /bash/);
		assert.match(text, /孤儿/);
	});
});
	it("分支出口指向不存在的节点会被指出来", () => {
		const problems = validateFlow(flow([{ id: "judge", kind: "custom", branches: { yes: "没有这个", no: "deny" } }]));
		assert.equal(problems.length, 1);
		assert.match(problems[0]?.message ?? "", /分支出口 yes 指向不存在/);
	});

	it("靠分支走到终点的流程能过", () => {
		assert.deepEqual(validateFlow(flow([{ id: "judge", kind: "custom", branches: { yes: "allow", no: "deny" } }])), []);
	});

