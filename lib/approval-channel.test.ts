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
	toGuiPayload,
	type ApprovalRequest,
} from "./approval-channel.ts";
import { resetGuiFallbackNotices, type GuiDiagnosis } from "./gui-diagnosis.ts";

// 回退提示的去重是进程内全局的，用例之间不隔离就会互相把提示吞掉
afterEach(() => {
	setApprovalChannel(undefined);
	resetGuiFallbackNotices();
});

/** 诊断存根：真跑 collectGuiDiagnosis 会起 systemctl / pkg-config，单测里不碰 */
function diag(overrides: Partial<GuiDiagnosis> = {}): GuiDiagnosis {
	return {
		binary: null,
		candidates: [],
		repoRoot: "/repo",
		hasHubSocket: false,
		hubUnitActive: null,
		hasWailsCli: false,
		hasGo: false,
		hasFrontendDist: false,
		hasWebkit2Gtk41: null,
		hasDisplayEnv: true,
		...overrides,
	};
}

const auditRequest: ApprovalRequest = {
	kind: "audit",
	command: "sudo echo x",
	reason: "命中 sudo",
};

function ctx(opts: { hasUI?: boolean; ui?: boolean; notices?: string[] } = {}) {
	const hasUI = opts.hasUI ?? false;
	const notices = opts.notices;
	const ui = opts.ui === false
		? undefined
		: {
			select: async () => undefined,
			...(notices ? { notify: (message: string) => void notices.push(message) } : {}),
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
			diagnosis: diag(),
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
			diagnosis: diag(),
			runGui: async () => ({ ok: false, reason: "unavailable" }),
		})(auditRequest, ctx({ ui: false }));
		assert.equal(denied.action, "deny");
	});

	it("GUI 不可用时 capability 只看 hasUI，TUI 二选一没有附言", async () => {
		const channel = createGuiTuiApprovalChannel({
			diagnosis: diag(),
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
			diagnosis: diag(),
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

	it("GUI 失败回退 TUI：标题带一行回退说明，notify 给完整修复步骤", async () => {
		const notices: string[] = [];
		let seenTitle = "";
		const channel = createGuiTuiApprovalChannel({
			// 二进制位为空 + hub 没起：回退说明应该是「没找到 wails-gui」，不再是光秃秃一张终端表
			diagnosis: diag({ binary: null, hasHubSocket: false, hubUnitActive: false }),
			runGui: async () => ({ ok: false, reason: "unavailable" }),
			selectApproval: async (title) => {
				seenTitle = title;
				return "❌ 拒绝";
			},
		});
		await channel(auditRequest, ctx({ ui: true, notices }));

		assert.match(seenTitle, /已回退终端审批：没找到 wails-gui 二进制/);
		// 原有标题内容不能被说明挤掉
		assert.match(seenTitle, /命中 sudo/);
		assert.match(seenTitle, /是否允许执行？/);
		assert.equal(notices.length, 1);
		assert.match(notices[0], /没找到 wails-gui 二进制/);
		assert.match(notices[0], /wails build/);
	});

	it("上游原因优先于本跳：hub 连不上时不改口报 no-binary", async () => {
		const notices: string[] = [];
		let seenTitle = "";
		const channel = createGuiTuiApprovalChannel({
			upstreamReason: "hub-unreachable",
			diagnosis: diag({ binary: null, hasHubSocket: false, hubUnitActive: false }),
			runGui: async () => ({ ok: false, reason: "unavailable" }),
			selectApproval: async (title) => {
				seenTitle = title;
				return "❌ 拒绝";
			},
		});
		await channel(auditRequest, ctx({ ui: true, notices }));

		assert.match(seenTitle, /连不上本机审批 hub/);
		// 真正的病因和「顺便也缺什么」都要说：起 hub 与构建 wails-gui 两条
		assert.match(notices[0], /起 hub/);
		assert.match(notices[0], /wails build/);
	});

	it("撤单不算故障：aborted 时既不 notify 也不在标题里挂原因", async () => {
		const notices: string[] = [];
		let seenTitle = "";
		const channel = createGuiTuiApprovalChannel({
			diagnosis: diag(),
			runGui: async () => ({ ok: false, reason: "aborted" }),
			selectApproval: async (title) => {
				seenTitle = title;
				return "❌ 拒绝";
			},
		});
		const decision = await channel(auditRequest, ctx({ ui: true, notices }));

		assert.equal(decision.action, "deny");
		assert.deepEqual(notices, []);
		assert.doesNotMatch(seenTitle, /已回退终端审批/);
	});

	it("request.signal 已中止时同样不报回退提示", async () => {
		const notices: string[] = [];
		const controller = new AbortController();
		controller.abort();
		const channel = createGuiTuiApprovalChannel({
			diagnosis: diag(),
			// 信号中止时 runGuiWindow 也会给 aborted，这里压一手「即使 GUI 报别的」
			runGui: async () => ({ ok: false, reason: "exited" }),
			selectApproval: async () => "❌ 拒绝",
		});
		await channel({ ...auditRequest, signal: controller.signal }, ctx({ ui: true, notices }));

		assert.deepEqual(notices, []);
	});
});

describe("sandbox-allow 的敏感路径命中", () => {
	const request: ApprovalRequest = {
		kind: "sandbox-allow",
		command: "cat /work/project/.env | wc -l",
		permission: "write-paths",
		writePaths: ["/work/project"],
		justification: "统计配置项条数",
		candidatePaths: ["/work/project"],
		persistentRoots: [],
		sessionWriteRoots: [],
		sessionTrustedRoots: [],
		builtinRoots: [],
		workspaceRoot: "/work/project",
		sensitive: [{ pattern: ".env", token: ".env" }],
	};

	it("合成规则条目并入 GUI payload 的 rules（前端不另开一栏）", () => {
		const payload = toGuiPayload(request);
		const rules = payload.rules as Array<{ name: string; tip: string; matched: string[]; autoReject: boolean }>;
		assert.equal(rules.length, 1);
		assert.equal(rules[0].name, "sensitive-path");
		assert.deepEqual(rules[0].matched, [".env"]);
		assert.match(rules[0].tip, /\.env/);
		assert.equal(rules[0].autoReject, false);
	});

	it("原有规则不被覆盖（敏感命中是追加而不是替换）", () => {
		const payload = toGuiPayload({ ...request, rules: [{ name: "dynamic-construct" }] });
		const names = (payload.rules as Array<{ name: string }>).map((r) => r.name);
		assert.deepEqual(names, ["dynamic-construct", "sensitive-path"]);
	});

	it("命令里的赋值随 payload 下发（GUI 标绿与悬停用）", () => {
		const payload = toGuiPayload({ ...request, command: 'export OUT="$HOME/out" && FOO=1 run.sh' });
		const notes = payload.envNotes as Array<{ name: string; value?: string; raw: string }>;
		assert.equal(notes.length, 2);
		assert.deepEqual(notes.map((n) => n.name), ["OUT", "FOO"]);
		assert.equal(notes[0].value, `${process.env.HOME}/out`);
		assert.equal(notes[0].raw, 'OUT="$HOME/out"');
		assert.equal(notes[1].value, "1");
	});

	it("没有赋值就不凭空多出 envNotes", () => {
		assert.equal(toGuiPayload({ ...request, command: "ls -la" }).envNotes, undefined);
	});

	it("解析不了的赋值也下发，带原因", () => {
		const payload = toGuiPayload({ ...request, command: "export OUT=$(pwd)" });
		const notes = payload.envNotes as Array<{ value?: string; reason?: string }>;
		assert.equal(notes.length, 1);
		assert.equal(notes[0].value, undefined);
		assert.match(notes[0].reason ?? "", /命令替换/);
	});

	// 适配器靠 payload.urgent 跳过 card-delay；不带就不能凭空多出这个字段
	it("urgent 随 payload 下发，不设时不下发", () => {
		assert.equal(toGuiPayload(request).urgent, undefined);
		assert.equal(toGuiPayload({ ...request, urgent: true }).urgent, true);
		// 其余字段照旧（包装不能丢东西）
		const payload = toGuiPayload({ ...request, urgent: true });
		assert.equal(payload.kind, "sandbox-allow");
		assert.equal(payload.permission, "write-paths");
		assert.deepEqual(payload.writePaths, ["/work/project"]);
	});

	it("TUI 回退标题写明命中的敏感路径", async () => {
		let seenTitle = "";
		const channel = createGuiTuiApprovalChannel({
			diagnosis: diag(),
			runGui: async () => ({ ok: false, reason: "unavailable" }),
			selectApproval: async (title) => {
				seenTitle = title;
				return "❌ 拒绝";
			},
		});
		await channel(request, ctx({ hasUI: true }));
		assert.match(seenTitle, /敏感路径/);
		assert.match(seenTitle, /\.env/);
		assert.match(seenTitle, /仅此一次/);
	});
});
