// lib/bash-approval.test.ts — 共享审批器的 GUI 注入与审计附言
// 跑法：node --experimental-strip-types lib/bash-approval.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendApprovalComment, approveBashCommand, rethrowWithApprovalComment } from "./bash-approval.ts";

const verdict = {
	allow: false,
	reason: "命令需人工确认（命中危险/动态规则）",
	rules: [{ name: "sudo", tip: "提权命令", matched: ["sudo"] }],
};

function context() {
	return { ui: undefined } as any;
}

describe("共享 bash 审批器", () => {
	it("GUI allow + comment：返回附言并写入 bash-audit", async () => {
		const entries: unknown[] = [];
		const decision = await approveBashCommand({
			pi: { appendEntry: (name: string, entry: unknown) => entries.push({ name, entry }) } as any,
			ctx: context(),
			command: "sudo echo test",
			verdict,
			origin: "bash_background",
			deps: {
				loadReviewConfig: () => ({ enabled: false, mode: "auto", timeoutMs: 1, tokenIdleMs: 1, maxCache: 1 }),
				runGui: async () => ({ ok: true, data: { action: "allow", comment: "  X  " } }),
			},
		});
		assert.equal(decision.approved, true);
		assert.equal(decision.comment, "X");
		assert.equal((entries[0] as any).name, "bash-audit");
		assert.equal((entries[0] as any).entry.comment, "X");
		assert.equal((entries[0] as any).entry.origin, "bash_background");
		const result = appendApprovalComment({ content: [{ type: "text" as const, text: "started" }] }, decision.comment);
		assert.match(result.content[0].text, /X/);
	});

	it("GUI deny + comment：不批准但仍写入审计附言", async () => {
		const entries: any[] = [];
		const decision = await approveBashCommand({
			pi: { appendEntry: (name: string, entry: unknown) => entries.push({ name, entry }) } as any,
			ctx: context(),
			command: "sudo echo test",
			verdict,
			deps: {
				loadReviewConfig: () => ({ enabled: false, mode: "auto", timeoutMs: 1, tokenIdleMs: 1, maxCache: 1 }),
				runGui: async () => ({ ok: true, data: { action: "deny", comment: "不要执行" } }),
			},
		});
		assert.equal(decision.approved, false);
		assert.equal(entries[0].entry.comment, "不要执行");
		assert.equal(entries[0].entry.outcome, "denied");
	});

	it("非零退出（execute 抛错）时附言并入错误信息", () => {
		// pi 的 bash 工具在非零退出时是 throw：不处理就会丢掉附言
		assert.throws(
			() => rethrowWithApprovalComment(new Error("Command exited with code 6"), "[主 agent 附言] X"),
			(err: unknown) => err instanceof Error && err.message === "[主 agent 附言] X\nCommand exited with code 6",
		);
	});

	it("无附言时原样重抛，不改错误信息", () => {
		const original = new Error("boom");
		assert.throws(
			() => rethrowWithApprovalComment(original, undefined),
			(err: unknown) => err === original,
		);
	});
});
