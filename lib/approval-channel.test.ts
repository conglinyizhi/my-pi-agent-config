// lib/approval-channel.test.ts — 审批通道解析与 GUI→TUI 回退
// 跑法：node --experimental-strip-types lib/approval-channel.test.ts

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	createGuiTuiApprovalChannel,
	getApprovalChannel,
	normalizeApprovalComment,
	resolveApprovalChannel,
	setApprovalChannel,
	type ApprovalRequest,
} from "./approval-channel.ts";

afterEach(() => {
	setApprovalChannel(undefined);
});

const auditRequest: ApprovalRequest = {
	kind: "audit",
	command: "sudo echo x",
	reason: "命中 sudo",
};

function ctx(opts: { hasUI?: boolean; ui?: boolean } = {}) {
	const hasUI = opts.hasUI ?? false;
	const ui = opts.ui === false
		? undefined
		: {
			select: async () => undefined,
		};
	return { hasUI, ui } as any;
}

describe("normalizeApprovalComment", () => {
	it("空白附言丢掉，非空 trim", () => {
		assert.equal(normalizeApprovalComment("  X  "), "X");
		assert.equal(normalizeApprovalComment("   "), undefined);
		assert.equal(normalizeApprovalComment(undefined), undefined);
		assert.equal(normalizeApprovalComment(1), undefined);
	});
});

describe("resolveApprovalChannel", () => {
	it("单次注入优先于全局通道", async () => {
		setApprovalChannel(async () => ({ action: "deny" }));
		const channel = resolveApprovalChannel({
			channel: async () => ({ action: "allow", comment: "once" }),
		});
		const decision = await channel(auditRequest, ctx());
		assert.equal(decision.action, "allow");
		assert.equal(decision.comment, "once");
	});

	it("setApprovalChannel 之后默认走全局通道", async () => {
		setApprovalChannel(async (request) => ({ action: "allow", comment: request.kind }));
		assert.ok(getApprovalChannel());
		const decision = await resolveApprovalChannel()(auditRequest, ctx());
		assert.equal(decision.comment, "audit");
	});
});

describe("createGuiTuiApprovalChannel", () => {
	it("GUI 明确允许时采纳附言和 pathActions，不走 TUI", async () => {
		let selected = false;
		const channel = createGuiTuiApprovalChannel({
			runGui: async () => ({
				ok: true,
				data: {
					action: "allow",
					comment: "  可以  ",
					pathActions: [{ path: "/opt", list: "allow" }],
				},
			}),
			selectApproval: async () => {
				selected = true;
				return "✅ 允许执行";
			},
		});
		const decision = await channel({
			kind: "sandbox-allow",
			command: "touch /opt/x",
			permission: "write-paths",
			writePaths: ["/opt"],
			justification: "写缓存",
			candidatePaths: ["/opt"],
			persistentRoots: [],
			sessionWriteRoots: [],
			sessionTrustedRoots: [],
			builtinRoots: [],
			workspaceRoot: "/work",
		}, ctx({ hasUI: true }));
		assert.equal(decision.action, "allow");
		assert.equal(decision.comment, "可以");
		assert.deepEqual(decision.pathActions, [{ path: "/opt", list: "allow" }]);
		assert.equal(selected, false);
	});

	it("GUI 不可用时 audit 回退 TUI；无 UI 则拒绝", async () => {
		const channel = createGuiTuiApprovalChannel({
			runGui: async () => ({ ok: false, reason: "unavailable" }),
			selectApproval: async (title, choices) => {
				assert.match(title, /命中 sudo/);
				assert.deepEqual(choices, ["✅ 允许执行", "❌ 拒绝"]);
				return "✅ 允许执行";
			},
		});
		const allowed = await channel(auditRequest, ctx({ ui: true }));
		assert.equal(allowed.action, "allow");
		assert.equal(allowed.comment, undefined);

		const denied = await createGuiTuiApprovalChannel({
			runGui: async () => ({ ok: false, reason: "unavailable" }),
		})(auditRequest, ctx({ ui: false }));
		assert.equal(denied.action, "deny");
	});

	it("GUI 不可用时 capability 只看 hasUI，TUI 二选一没有附言", async () => {
		const channel = createGuiTuiApprovalChannel({
			runGui: async () => ({ ok: false, reason: "exited" }),
			selectApproval: async () => "✅ 允许本次命令",
		});
		const noUi = await channel({
			kind: "capability",
			command: "curl https://example.com",
			capability: "network",
			requestReason: "拉依赖",
		}, ctx({ hasUI: false }));
		assert.equal(noUi.action, "deny");

		const withUi = await channel({
			kind: "capability",
			command: "curl https://example.com",
			capability: "network",
			requestReason: "拉依赖",
			review: { verdict: "risky", reason: "外网", suggestion: "" },
		}, ctx({ hasUI: true }));
		assert.equal(withUi.action, "allow");
		assert.equal(withUi.comment, undefined);
	});

	it("sandbox-allow 的 TUI 回退用仅此一次文案", async () => {
		const channel = createGuiTuiApprovalChannel({
			runGui: async () => ({ ok: false, reason: "unavailable" }),
			selectApproval: async (title, choices) => {
				assert.match(title, /仅此一次/);
				assert.deepEqual(choices, ["✅ 允许执行（仅此一次）", "❌ 拒绝"]);
				return "❌ 拒绝";
			},
		});
		const decision = await channel({
			kind: "sandbox-allow",
			command: "touch /opt/x",
			permission: "write-paths",
			writePaths: ["/opt"],
			justification: "写缓存",
			candidatePaths: ["/opt"],
			persistentRoots: [],
			sessionWriteRoots: [],
			sessionTrustedRoots: [],
			builtinRoots: [],
			workspaceRoot: "/work",
		}, ctx({ hasUI: true }));
		assert.equal(decision.action, "deny");
	});
});
