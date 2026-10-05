// lib/review-flow/fixture.test.ts — 轨迹夹具的重放
// 跑法：node --test --experimental-strip-types lib/review-flow/fixture.test.ts
//
// 一条夹具 = 一条可回归的用例：输入 + 各节点结论 + 最终决定。
// 重放不需要模型、不需要人、不需要网络；夹具漏记一个节点，重放会当场露馅。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixture as denyFixture } from "./fixtures/bash-2026-10-05-deny.ts";
import { bashFlow } from "./flows/bash.ts";
import { fixtureOf, formatFixtureTs, inputOf, replayNodesOf } from "./fixture.ts";
import { runFlow } from "./runner.ts";

async function replay(fixture = denyFixture) {
	return runFlow(
		bashFlow,
		{ pi: {} as never, ctx: { cwd: "/tmp" } as never, ...inputOf(fixture) },
		{ nodes: replayNodesOf(bashFlow, fixture) },
	);
}

describe("轨迹夹具", () => {
	it("重放出来的决定与夹具一致", async () => {
		const result = await replay();
		assert.equal(result.decision, denyFixture.decision);
		assert.equal(result.via, denyFixture.via);
	});

	it("重放出来的每一步（结论、去向、状态）都与夹具逐条对上", async () => {
		const result = await replay();
		const seen = result.trace.map((r) => ({ nodeId: r.nodeId, status: r.status, verdict: r.verdict, to: r.to }));
		const want = denyFixture.nodes.map((n) => ({ nodeId: n.nodeId, status: n.status, verdict: n.verdict, to: n.to }));
		assert.deepEqual(seen, want);
	});

	it("夹具里记着谁把决定钉下来的", () => {
		const gate = denyFixture.nodes.find((n) => n.nodeId === "gate");
		assert.equal(gate?.status, "ran");
		assert.equal(gate?.to, "deny");
		assert.match(gate?.reason ?? "", /备份/);
	});

	it("格式化出来的 .ts 能读、能 import 的形状", () => {
		const text = formatFixtureTs(denyFixture, "../fixture.ts");
		assert.match(text, /import type \{ FlowFixture \}/);
		assert.match(text, /"decision": "deny"/);
		assert.match(text, /"nodeId": "classify"/);
	});

	it("从运行结果取夹具：跳过与失败的节点也要进夹具", () => {
		const fake = {
			decision: "allow" as const,
			via: "allow",
			timedOut: false,
			budgetExhausted: false,
			trace: [
				{ nodeId: "chat", kind: "chatreview" as const, startedAt: 0, endedAt: 1, status: "ran" as const, to: "classify" },
				{ nodeId: "gate", kind: "gate" as const, startedAt: 0, endedAt: 0, status: "skipped" as const, via: "allow" },
			],
		};
		const made = fixtureOf(fake, { flowId: "bash", capturedAt: "2026-10-05T00:00:00.000Z", input: { command: "ls", rules: [] } });
		assert.equal(made.nodes.length, 2);
		assert.equal(made.nodes[1]?.status, "skipped");
		assert.equal(made.nodes[1]?.via, "allow");
	});
});
