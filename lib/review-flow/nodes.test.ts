// lib/review-flow/nodes.test.ts — 节点库（全部注入假实现，不碰真模型）
// 跑法：node --test --experimental-strip-types lib/review-flow/nodes.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toAdvisorNote, type ReviewResult } from "../../extensions/sandbox-permissions/llm-review.ts";
import { makeAutoApproveNode, makeChatReviewNode, makeClassifierNode, makeGateNode, makeMergeNode } from "./nodes.ts";
import type { NodeRunContext } from "./runner.ts";

const CTX = { cwd: "/tmp" } as never;

function ctxWith(upstream: Record<string, unknown>, input: Record<string, unknown> = {}): NodeRunContext {
	return {
		nodeId: "n",
		kind: "merge",
		settings: {},
		input: { command: "rm -rf /", rules: [], ctx: CTX, pi: {} as never, ...input },
		upstream,
		spend: () => {},
	};
}

const SAFE: ReviewResult = { verdict: "safe", reason: "看着没事", suggestion: "" };
const RISKY: ReviewResult = { verdict: "risky", reason: "改了系统文件", suggestion: "别这么干" };

describe("节点库", () => {
	it("合并：分类器说了算，chat 只挂成展示用的附注", async () => {
		const result = await makeMergeNode()(ctxWith({ classify: RISKY, chat: SAFE }));
		assert.equal(result.status, "ok");
		const merged = (result as { output: ReviewResult }).output;
		assert.equal(merged.verdict, "risky");
		assert.deepEqual(merged.chatReview, toAdvisorNote(SAFE, "risky"));
	});

	it("合并：chat 判风险但分类器判安全，判决仍是安全（附注里留着）", async () => {
		const result = await makeMergeNode()(ctxWith({ classify: SAFE, chat: RISKY }));
		const merged = (result as { output: ReviewResult }).output;
		assert.equal(merged.verdict, "safe");
		assert.equal(merged.chatReview?.verdict, "risky");
	});

	it("合并：没有分类器结论就弃权，不硬编一个 verdict", async () => {
		const result = await makeMergeNode()(ctxWith({ chat: SAFE }));
		assert.equal(result.status, "abstain");
	});

	it("自动放行：判安全且档位是自动才放行", async () => {
		const auto = makeAutoApproveNode({ loadConfig: () => ({ enabled: true, mode: "auto" }) as never });
		const allowed = await auto(ctxWith({ merge: SAFE }));
		assert.equal(allowed.status, "ok");
		assert.equal((allowed as { terminal?: string }).terminal, "allow");

		const abstained = await auto(ctxWith({ merge: RISKY }));
		assert.equal(abstained.status, "abstain");
	});

	it("自动放行：档位不是自动时，就算判安全也不放行", async () => {
		const auto = makeAutoApproveNode({ loadConfig: () => ({ enabled: true, mode: "manual" }) as never });
		assert.equal((await auto(ctxWith({ merge: SAFE }))).status, "abstain");
	});

	it("对话模型节点：走 chat 那条支路，档位与场景原样带下去", async () => {
		let seen: { backend?: string; options?: unknown } = {};
		const node = makeChatReviewNode({
			loadConfig: () => ({ enabled: true, mode: "auto", backend: "chain" }) as never,
			reviewCommand: (async (_pi: unknown, _ctx: unknown, _cmd: string, _rules: unknown, _signal: unknown, _cache: unknown, cfg: { backend?: string }, options: unknown) => {
				seen = { backend: cfg.backend, options };
				return SAFE;
			}) as never,
		});
		const result = await node(ctxWith({}, { scenario: "ptc", factsUnavailable: "拿不到" }));
		assert.equal(result.status, "ok");
		assert.equal(seen.backend, "chat");
		assert.deepEqual(seen.options, { factsUnavailable: "拿不到", scenario: "ptc" });
	});

	it("关掉审核时两个模型节点都不去碰模型", async () => {
		let called = 0;
		const bang = (async () => { called += 1; return SAFE; }) as never;
		const deps = { loadConfig: () => ({ enabled: false, mode: "auto" }) as never, reviewCommand: bang, classifierReview: bang };
		const chat = await makeChatReviewNode(deps)(ctxWith({}));
		const classify = await makeClassifierNode(deps)(ctxWith({ chat: SAFE }));
		assert.equal(called, 0);
		assert.equal((chat as { output: ReviewResult }).output.reason, "llm review disabled");
		assert.equal((classify as { output: ReviewResult }).output.reason, "llm review disabled");
	});

	it("分类器节点：把上游 chat 的结论当参考意见传下去", async () => {
		let advisor: unknown;
		const node = makeClassifierNode({
			loadConfig: () => ({ enabled: true, mode: "auto" }) as never,
			classifierReview: (async (_ctx: unknown, _cmd: string, _rules: unknown, _signal: unknown, _options: unknown, _userRequest: unknown, got: unknown) => {
				advisor = got;
				return RISKY;
			}) as never,
		});
		await node(ctxWith({ chat: SAFE }));
		assert.deepEqual(advisor, SAFE);
	});

	it("闸门节点：决定来自人的回答", async () => {
		const allow = makeGateNode({ approval: { channel: async () => ({ action: "allow", comment: "这次可以" }) } as never });
		const allowed = await allow(ctxWith({ merge: RISKY }));
		assert.equal((allowed as { terminal?: string }).terminal, "allow");
		assert.match((allowed as { reason: string }).reason, /这次可以/);

		const deny = makeGateNode({ approval: { channel: async () => ({ action: "deny" }) } as never });
		assert.equal(((await deny(ctxWith({ merge: RISKY }))) as { terminal?: string }).terminal, "deny");
	});
});
