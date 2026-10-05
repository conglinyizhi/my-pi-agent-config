// lib/pre-review.test.ts — 预审直连版：档位分支、判据、缓存、规则（全部注入假实现）
// 跑法：node --test --experimental-strip-types lib/pre-review.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createReviewCache, toAdvisorNote, type ReviewResult } from "../extensions/sandbox-permissions/llm-review.ts";
import { preReview } from "./pre-review.ts";

const CTX = { cwd: "/tmp" } as never;
const SAFE: ReviewResult = { verdict: "safe", reason: "看着没事", suggestion: "" };
const RISKY: ReviewResult = { verdict: "risky", reason: "改了系统文件", suggestion: "别这么干" };

function makeDeps(classifierVerdict: ReviewResult = RISKY, chatVerdict: ReviewResult = SAFE) {
	const calls = { chat: 0, classifier: 0 };
	return {
		calls,
		nodes: {
			reviewCommand: async () => {
				calls.chat += 1;
				return chatVerdict;
			},
			classifierReview: async () => {
				calls.classifier += 1;
				return classifierVerdict;
			},
			loadRules: () => [],
		},
	};
}

function options(backend: "chat" | "classifier" | "chain", deps: ReturnType<typeof makeDeps>, cache = createReviewCache()) {
	return {
		input: { pi: {} as never, ctx: CTX, command: "rm -rf /", rules: [] },
		config: { enabled: true, mode: "auto", backend, timeoutMs: 1000, tokenIdleMs: 1000, maxCache: 10 } as never,
		cache,
		nodes: deps.nodes as never,
	};
}

describe("预审（直连）", () => {
	it("全链：分类器的判决说了算，对话模型的意见只挂成附注", async () => {
		const deps = makeDeps(RISKY, SAFE);
		const result = await preReview(options("chain", deps));
		assert.equal(result.review?.verdict, "risky");
		assert.deepEqual(result.review?.chatReview, toAdvisorNote(SAFE, "risky"));
		assert.equal(result.autoApproved, false);
		assert.deepEqual(deps.calls, { chat: 1, classifier: 1 });
	});

	it("对话档只跑对话模型，别把分类器也拉起来", async () => {
		const deps = makeDeps();
		const result = await preReview(options("chat", deps));
		assert.equal(result.review?.verdict, "safe");
		assert.equal(deps.calls.classifier, 0);
		assert.equal(result.autoApproved, true);
	});

	it("分类器档不跑对话模型", async () => {
		const deps = makeDeps(RISKY);
		const result = await preReview(options("classifier", deps));
		assert.equal(result.review?.verdict, "risky");
		assert.equal(deps.calls.chat, 0);
	});

	it("判安全且档位 auto 才自动放行", async () => {
		const deps = makeDeps(SAFE);
		const result = await preReview(options("chain", deps));
		assert.equal(result.autoApproved, true);
	});

	it("关掉就什么都不跑", async () => {
		const deps = makeDeps();
		const opts = options("chain", deps);
		opts.config = { enabled: false, mode: "auto", backend: "chain" } as never;
		const result = await preReview(opts);
		assert.equal(result.review, undefined);
		assert.deepEqual(deps.calls, { chat: 0, classifier: 0 });
	});

	it("缓存命中不再调模型，但规则照过", async () => {
		const deps = makeDeps(SAFE);
		const cache = createReviewCache();
		await preReview(options("chain", deps, cache));
		const second = await preReview(options("chain", deps, cache));
		assert.equal(second.review?.verdict, "safe");
		assert.deepEqual(deps.calls, { chat: 1, classifier: 1 });

		const withRule = makeDeps(SAFE);
		withRule.nodes.loadRules = () => [{ id: "r", verdict: "safe", then: "deny", note: "这条命令不许自动放行" }] as never;
		const denied = await preReview(options("chain", withRule, createReviewCache()));
		assert.equal(denied.autoApproved, false, "规则 deny 要拦住自动放行");
	});

	it("分类器超时但对话模型有结论：按对话模型判（分类器视为绿灯）", async () => {
		const deps = makeDeps({ verdict: "error", reason: "分类器超时", suggestion: "" }, SAFE);
		const result = await preReview(options("chain", deps));
		assert.equal(result.review?.verdict, "safe");
		assert.match(result.review?.reason ?? "", /分类器没给出结论/);
		assert.equal(result.autoApproved, true, "对话模型判安全就该放行");
		// 界面要能说清"这是替代判断"：挂上对话模型自己的话，并标明分类器没结论
		assert.equal(result.review?.chatReview?.verdict, "safe");
		assert.match(String(result.review?.classifierFailed ?? ""), /分类器超时/);
	});

	it("分类器超时且对话模型判风险：照样问人", async () => {
		const deps = makeDeps({ verdict: "error", reason: "分类器超时", suggestion: "" }, RISKY);
		const result = await preReview(options("chain", deps));
		assert.equal(result.review?.verdict, "risky");
		assert.equal(result.autoApproved, false);
	});

	it("两个都失败：没有结论，交给人", async () => {
		const err = { verdict: "error", reason: "都挂了", suggestion: "" } as ReviewResult;
		const deps = makeDeps(err, err);
		const result = await preReview(options("chain", deps));
		assert.equal(result.autoApproved, false);
	});
});
