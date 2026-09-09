// dsh-jobs/tools.test.ts — bash_background 前置审批链
// 跑法：node --experimental-strip-types extensions/dsh-jobs/tools.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerJobsTools } from "./tools.ts";
import type { JobSnapshot } from "./registry.ts";

function fakeSnapshot(id: string): JobSnapshot {
	return {
		id,
		kind: "bash",
		label: "fake command",
		status: "running",
		startedAt: Date.now(),
		reported: false,
	};
}

function setup(options: { approveBash?: (input: any) => Promise<any> } = {}) {
	const tools = new Map<string, any>();
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	};
	let starts = 0;
	const registry = {
		start(_spec: unknown) {
			starts++;
			return `bash-${starts}`;
		},
		get(id: string) {
			return fakeSnapshot(id);
		},
	};
	registerJobsTools(pi as any, registry as any, {
		approveBash: options.approveBash as any,
	});
	const ctx = {
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "tools-test" },
		ui: undefined,
	};
	return { tool: tools.get("bash_background"), ctx, starts: () => starts };
}

describe("bash_background 审批链", () => {
	it("黑名单命令直接拒绝，不调用审批器", async () => {
		let approvals = 0;
		const { tool, ctx, starts } = setup({
			approveBash: async () => {
				approvals++;
				return { approved: true };
			},
		});
		const result = await tool.execute("call-1", { command: "cat ~/.ssh/id_rsa" }, undefined, undefined, ctx);
		assert.equal(approvals, 0);
		assert.equal(starts(), 0);
		assert.match(result.content[0].text, /拦截|黑名单/);
	});

	it("需确认类获批后才启动后台任务", async () => {
		let approvals = 0;
		const { tool, ctx, starts } = setup({
			approveBash: async () => {
				approvals++;
				return { approved: true, comment: "X" };
			},
		});
		const result = await tool.execute("call-2", { command: "sudo echo approval-test" }, undefined, undefined, ctx);
		assert.equal(approvals, 1);
		assert.equal(starts(), 1);
		assert.match(result.content[0].text, /bash-1/);
		assert.match(result.content[0].text, /X/);
	});

	it("需确认类被拒绝时不启动并返回拒绝文案", async () => {
		const { tool, ctx, starts } = setup({
			approveBash: async () => ({ approved: false, comment: "稍后再审" }),
		});
		const result = await tool.execute("call-3", { command: "sudo echo approval-test" }, undefined, undefined, ctx);
		assert.equal(starts(), 0);
		assert.match(result.content[0].text, /已拒绝/);
		assert.match(result.content[0].text, /稍后再审/);
	});

	it("checkCommand allow 时直接启动且不调用审批器", async () => {
		let approvals = 0;
		const { tool, ctx, starts } = setup({
			approveBash: async () => {
				approvals++;
				return { approved: false };
			},
		});
		const result = await tool.execute("call-4", { command: "echo safe-background" }, undefined, undefined, ctx);
		assert.equal(approvals, 0);
		assert.equal(starts(), 1);
		assert.match(result.content[0].text, /bash-1/);
	});
});
