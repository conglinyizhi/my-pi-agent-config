// lib/bash-approval.test.ts — 共享审批器的 GUI 注入与审计附言
// 跑法：node --experimental-strip-types lib/bash-approval.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendApprovalComment, approveBashCommand, isHardRejected, rethrowWithApprovalComment } from "./bash-approval.ts";

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

// 变量渲染收窄（dynamic-construct-narrowed）：allow=false + 一条 autoReject:false 的规则，
// 走的就是这个审批器。这里的断言就是「收窄后 LLM 那道闸还在」：预审判 safe 才自动放行，
// 判 risky/dangerous 才落到人。
describe("收窄命令的审批链", () => {
	/** 一条收窄过的命令的判定结果（形状与 lib/sandbox-check.ts 产出的完全一致） */
	const narrowedVerdict = {
		allow: false,
		reason: "命令需人工确认（命中危险/动态规则）",
		rules: [
			{
				name: "dynamic-construct-narrowed",
				tip: "命令名是变量，已静态确定为 $P = /usr/bin/jq，交预审确认",
				autoReject: false,
				matched: ["$P"],
			},
		],
	};
	const reviewConfig = { enabled: true, mode: "auto" as const, timeoutMs: 1, tokenIdleMs: 1, maxCache: 1 };

	it("不是硬拒（autoReject:false）→ 进得来审批器", () => {
		assert.equal(isHardRejected(narrowedVerdict), false);
		// 对照：无规则的拒绝（黑名单/内联脚本）不进审批器
		assert.equal(isHardRejected({ allow: false, reason: "拦截" }), true);
		assert.equal(isHardRejected({ allow: false, rules: [] }), true);
		assert.equal(isHardRejected({ allow: false, rules: [{ name: "x", tip: "硬拒规则", autoReject: true }] }), true);
	});

	it("LLM 预审判 safe + mode=auto → 自动放行，不弹窗、不写审计", async () => {
		const entries: unknown[] = [];
		let guiCalls = 0;
		const decision = await approveBashCommand({
			pi: { appendEntry: (name: string, entry: unknown) => entries.push({ name, entry }) } as any,
			ctx: context(),
			command: "cd /tmp && P=/usr/bin/jq && $P --version",
			verdict: narrowedVerdict as any,
			deps: {
				loadReviewConfig: () => reviewConfig,
				reviewCommand: async () => ({ verdict: "safe", reason: "只读程序版本查询", suggestion: "" }),
				runGui: async () => {
					guiCalls++;
					return { ok: true, data: { action: "deny" } };
				},
			},
		});
		assert.equal(decision.approved, true);
		assert.equal(decision.review?.verdict, "safe");
		assert.equal(guiCalls, 0, "预审放行不该再弹窗");
		assert.equal(entries.length, 0, "LLM 自动放行不写 bash-audit");
	});

	it("LLM 预审判 risky → 交给人工闸门（规则里带着 narrowed）", async () => {
		let seen: any;
		const decision = await approveBashCommand({
			pi: { appendEntry: () => {} } as any,
			ctx: context(),
			command: "cd /tmp && P=/usr/bin/jq && $P --version",
			verdict: narrowedVerdict as any,
			deps: {
				loadReviewConfig: () => reviewConfig,
				reviewCommand: async () => ({ verdict: "risky", reason: "参数不确定", suggestion: "" }),
				runGui: async (_kind: string, request: any) => {
					seen = request;
					return { ok: true, data: { action: "allow" } };
				},
			},
		});
		assert.equal(decision.approved, true);
		assert.equal(seen.rules[0].name, "dynamic-construct-narrowed", JSON.stringify(seen.rules));
		assert.match(seen.review.reason, /参数不确定/);
	});

	it("LLM 预审判 dangerous → 同样落到人（预审不放行任何非 safe 结果）", async () => {
		let guiCalls = 0;
		const decision = await approveBashCommand({
			pi: { appendEntry: () => {} } as any,
			ctx: context(),
			command: "cd /tmp && P=/usr/bin/jq && $P --version",
			verdict: narrowedVerdict as any,
			deps: {
				loadReviewConfig: () => reviewConfig,
				reviewCommand: async () => ({ verdict: "dangerous", reason: "不该跑", suggestion: "" }),
				runGui: async () => {
					guiCalls++;
					return { ok: true, data: { action: "deny" } };
				},
			},
		});
		assert.equal(decision.approved, false);
		assert.equal(guiCalls, 1);
	});
});
