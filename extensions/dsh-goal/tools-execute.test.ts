// tools-execute.test.ts — update_goal 的运行时校验（schema 层面刻意拍平了，边界在这里）
//
// 背景：OpenAI function schema 只收根 object，所以 UPDATE_PARAMETERS 把所有 action 专属字段
// 都写成可选，谁配谁不配由 execute 拒。tools-schema.test.ts 只钉形状，
// 「哪个 action 必须带什么」归这里。
//
// 跑法：node --experimental-strip-types extensions/dsh-goal/tools-execute.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalDomain } from "./state.ts";
import { registerGoalTools, UPDATE_PARAMETERS } from "./tools.ts";

type AnyEntry = Record<string, unknown> & { type: string };

type UpdateParams = {
	goal_id: string;
	revision: number;
	action: "edit" | "pause" | "resume" | "complete" | "blocked";
	objective?: string;
	max_goal_rounds?: number;
	blocked_reason?: string;
};

/** 捕获 registerTool 的注册，拿真 execute 调 */
function fakePi() {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const entries: AnyEntry[] = [];
	return {
		tools,
		entries,
		api: {
			registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(tool.name, tool);
			},
			appendEntry() {
				// 变更落盘不是这组用例关心的
			},
		},
	};
}

function humanTurn(): AnyEntry {
	return { type: "message", message: { role: "user", content: "人类输入" } };
}

function setup(action: UpdateParams["action"], extra: Partial<UpdateParams> = {}) {
	const pi = fakePi();
	const domain = new GoalDomain({ defaultMaxGoalRounds: 5 });
	domain.mutate({ operation: "create", objective: "目标" });
	registerGoalTools(pi.api as unknown as ExtensionAPI, domain);
	const update = pi.tools.get("update_goal");
	assert.ok(update, "update_goal 没注册上");
	pi.entries.push(humanTurn());
	const ctx = { sessionManager: { getEntries: () => pi.entries } };
	const params: UpdateParams = { goal_id: domain.view!.id, revision: 1, action, ...extra };
	const run = () => update.execute("call", params, undefined, undefined, ctx);
	return { run, domain, params };
}

async function rejection(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
		return "";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

describe("update_goal 运行时：action 专属字段", () => {
	it("blocked 必须带 blocked_reason（schema 拍平了，靠这里拒）", async () => {
		const missing = await rejection(setup("blocked").run);
		assert.match(missing, /blocked_reason is required with action blocked/);

		// 带上理由就不该因为这一条被拒（轮次阈值那条另说，所以不写死成功）
		const withReason = await rejection(setup("blocked", { blocked_reason: "持续阻塞" }).run);
		assert.doesNotMatch(withReason, /blocked_reason is required/);
	});

	it("blocked_reason 只属于 blocked", async () => {
		for (const action of ["edit", "pause", "resume", "complete"] as const) {
			const message = await rejection(setup(action, { blocked_reason: "不该出现" }).run);
			assert.match(message, /blocked_reason is valid only with action blocked/, `${action} 应拒绝多余字段`);
		}
	});

	it("objective / max_goal_rounds 只属于 edit", async () => {
		for (const action of ["pause", "resume", "complete", "blocked"] as const) {
			const message = await rejection(setup(action, { objective: "不该出现", blocked_reason: action === "blocked" ? "理由" : undefined }).run);
			assert.match(message, /valid only with action edit/, `${action} 应拒绝 edit 字段`);
		}
	});

	it("schema 拍平不等于放行：字段都在参数表里（所以模型看得到）", () => {
		const properties = (UPDATE_PARAMETERS as { properties?: Record<string, unknown> }).properties ?? {};
		assert.deepEqual(Object.keys(properties).sort(), ["action", "blocked_reason", "goal_id", "max_goal_rounds", "objective", "revision"]);
	});
});
