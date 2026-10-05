// lib/review-flow/flows/bash.test.ts — bash 流程与旧链同输入同决定
// 跑法：node --test --experimental-strip-types lib/review-flow/flows/bash.test.ts
//
// 判定表逐行对着旧链的代码写：
//   旧链 = preReviewBashCommand（判 safe 且档位 auto 才自动放行）+ 否则问人
//   自动放行那一条判据两边共用一个函数（autoApproveDecision），所以漂不了

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoApproveDecision } from "../../bash-approval.ts";
import type { ReviewResult } from "../../../extensions/sandbox-permissions/llm-review.ts";
import { runBashFlow } from "./bash.ts";
import type { ReviewNodeDeps } from "../nodes.ts";

const SAFE: ReviewResult = { verdict: "safe", reason: "没事", suggestion: "" };
const RISKY: ReviewResult = { verdict: "risky", reason: "碰了系统文件", suggestion: "" };
const ERROR: ReviewResult = { verdict: "error", reason: "模型超时", suggestion: "" };
const CTX = { cwd: "/tmp" } as never;

const INPUT = { pi: {} as never, ctx: CTX, command: "rm -rf /tmp/x", rules: [] };

function deps(mode: "auto" | "manual", chat: ReviewResult, classify: ReviewResult, answer: "allow" | "deny" = "deny"): ReviewNodeDeps {
	return {
		loadConfig: () => ({ enabled: true, mode }) as never,
		reviewCommand: (async () => chat) as never,
		classifierReview: (async () => classify) as never,
		approval: { channel: async () => ({ action: answer }) } as never,
	};
}

describe("bash 流程", () => {
	it("判安全且档位自动：自动放行，闸门跳过", async () => {
		const result = await runBashFlow(INPUT, deps("auto", SAFE, SAFE));
		assert.equal(result.decision, "allow");
		assert.equal(result.via, "allow");
		assert.equal(result.trace.find((r) => r.nodeId === "gate")?.status, "skipped");
	});

	it("聊天模型判风险但分类器判安全：仍然自动放行（chat 不否决）", async () => {
		const result = await runBashFlow(INPUT, deps("auto", RISKY, SAFE));
		assert.equal(result.decision, "allow");
	});

	it("分类器判风险：轮到人，人的回答就是决定", async () => {
		const denied = await runBashFlow(INPUT, deps("auto", SAFE, RISKY, "deny"));
		assert.equal(denied.decision, "deny");
		assert.equal(denied.trace.find((r) => r.nodeId === "gate")?.status, "ran");

		const allowed = await runBashFlow(INPUT, deps("auto", SAFE, RISKY, "allow"));
		assert.equal(allowed.decision, "allow");
	});

	it("档位不是自动：就算判安全也要问人", async () => {
		const result = await runBashFlow(INPUT, deps("manual", SAFE, SAFE));
		assert.equal(result.trace.find((r) => r.nodeId === "gate")?.status, "ran");
		assert.equal(result.decision, "deny");
	});

	it("聊天模型失败不影响判决（旧链把 advisor 省略掉继续跑）", async () => {
		const result = await runBashFlow(INPUT, deps("auto", ERROR, SAFE));
		assert.equal(result.decision, "allow");
	});

	it("分类器也判不出来：问人，不静默放行", async () => {
		const result = await runBashFlow(INPUT, deps("auto", SAFE, ERROR));
		assert.equal(result.trace.find((r) => r.nodeId === "gate")?.status, "ran");
		assert.equal(result.decision, "deny");
	});

	it("整次超期：走 fail 出口（默认拒绝）", async () => {
		const hang = (() => new Promise(() => {})) as never;
		const result = await runBashFlow(
			INPUT,
			{ loadConfig: () => ({ enabled: true, mode: "auto" }) as never, reviewCommand: hang },
			{ deadlineMs: 30 },
		);
		assert.equal(result.decision, "deny");
		assert.equal(result.timedOut, true);
	});

	it("自动放行判据两边共用同一个函数（结构性保证）", () => {
		const cfg = (mode: string) => ({ mode }) as never;
		assert.equal(autoApproveDecision(SAFE, cfg("auto")), true);
		assert.equal(autoApproveDecision(SAFE, cfg("manual")), false);
		assert.equal(autoApproveDecision(RISKY, cfg("auto")), false);
		assert.equal(autoApproveDecision(undefined, cfg("auto")), false);
	});
});
