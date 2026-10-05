// lib/review-flow/validate.test.ts — 流程静态校验
// 跑法：node --test --experimental-strip-types lib/review-flow/validate.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeProblems, validateFlow } from "./validate.ts";
import type { Flow } from "./types.ts";

function flow(nodes: Flow["nodes"]): Flow {
	return { id: "t", nodes };
}

describe("流程静态校验", () => {
	it("每个节点都能走到终点就通过", () => {
		const problems = validateFlow(flow([
			{ id: "chat", kind: "chatreview" },
			{ id: "merge", kind: "merge", after: ["chat"] },
			{ id: "out", kind: "terminal", after: ["merge"] },
		]));
		assert.deepEqual(problems, []);
	});

	it("走不到终点的节点会被指出来（硬约束 2）", () => {
		const problems = validateFlow(flow([
			{ id: "chat", kind: "chatreview" },
			{ id: "merge", kind: "merge", after: ["chat"] },
			{ id: "out", kind: "terminal", after: ["merge"] },
			{ id: "孤儿", kind: "rule" },
		]));
		assert.equal(problems.length, 1);
		assert.equal(problems[0]?.nodeId, "孤儿");
		assert.match(problems[0]?.message ?? "", /走不到任何终点/);
	});

	it("失败边写了 allow / deny 也算终点", () => {
		assert.deepEqual(validateFlow(flow([{ id: "chat", kind: "chatreview", onError: "deny" }])), []);
	});

	it("id 重复会被指出来", () => {
		const problems = validateFlow(flow([
			{ id: "a", kind: "rule", onError: "deny" },
			{ id: "a", kind: "rule", onError: "deny" },
		]));
		assert.equal(problems.length, 1);
		assert.match(problems[0]?.message ?? "", /重复/);
	});

	it("边指向不存在的节点会被指出来", () => {
		const problems = validateFlow(flow([
			{ id: "chat", kind: "chatreview", after: ["没有这个"], onError: "deny" },
			{ id: "out", kind: "terminal", after: ["chat"], onTimeout: "也没有这个" },
		]));
		assert.equal(problems.length, 2);
		assert.match(problems.map((p) => p.message).join("\n"), /after 指向不存在/);
		assert.match(problems.map((p) => p.message).join("\n"), /onTimeout 指向不存在/);
	});

	it("依赖成环会被指出来", () => {
		const problems = validateFlow(flow([
			{ id: "a", kind: "merge", after: ["b"], onError: "deny" },
			{ id: "b", kind: "merge", after: ["a"], onError: "deny" },
		]));
		assert.match(problems.map((p) => p.message).join("\n"), /成环/);
	});

	it("报错文案带上流程名与节点名", () => {
		const text = describeProblems("bash", [{ nodeId: "孤儿", message: "走不到任何终点" }]);
		assert.match(text, /bash/);
		assert.match(text, /孤儿/);
	});
});
