// e-stop.test.ts — ESC 急停语义测试
//
// 覆盖：active goal 急停（pause + persist + notify）、非 active 不打扰、
// 竞态兜底（abort 瞬间状态已变则不误报）、无 goal 不动作。
//
// 跑法：node --experimental-strip-types --test extensions/dsh-goal/e-stop.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalDomain, type GoalChange } from "./state.ts";
import { emergencyStop, registerGoalDriver } from "./driver.ts";

function freshDomain(): GoalDomain {
	return new GoalDomain({ defaultMaxGoalRounds: 5 });
}

function createGoal(domain: GoalDomain, objective = "长期目标"): void {
	domain.mutate({ operation: "create", objective });
}

describe("emergencyStop（ESC 急停）", () => {
	it("active+armed goal → pause + persist + notify", () => {
		const domain = freshDomain();
		createGoal(domain);
		assert.equal(domain.view!.activation, "armed");

		const changes: GoalChange[] = [];
		const notices: string[] = [];
		const ok = emergencyStop(domain, (c) => changes.push(c), (m) => notices.push(m));

		assert.equal(ok, true);
		assert.equal(domain.view!.phase, "paused");
		assert.equal(domain.view!.activation, "disarmed");
		assert.equal(changes.length, 1);
		assert.equal(changes[0].operation, "pause");
		assert.equal(changes[0].goal.revision, 2);
		assert.equal(notices.length, 1);
		assert.match(notices[0], /\/goal resume/);
	});

	it("active+disarmed 也 pause（无论是否在自动续行，急停一律停）", () => {
		const domain = freshDomain();
		createGoal(domain);
		domain.disarm();

		const ok = emergencyStop(domain, () => {}, () => {});
		assert.equal(ok, true);
		assert.equal(domain.view!.phase, "paused");
		assert.equal(domain.view!.activation, "disarmed");
	});

	it("paused goal → 不动作不 notify", () => {
		const domain = freshDomain();
		createGoal(domain);
		domain.mutate({ operation: "pause", ref: domain.ref });

		const changes: GoalChange[] = [];
		const notices: string[] = [];
		const ok = emergencyStop(domain, (c) => changes.push(c), (m) => notices.push(m));

		assert.equal(ok, false);
		assert.equal(changes.length, 0);
		assert.equal(notices.length, 0);
		assert.equal(domain.view!.phase, "paused");
	});

	it("无 goal → false，不动作", () => {
		const domain = freshDomain();
		const changes: GoalChange[] = [];
		const notices: string[] = [];
		const ok = emergencyStop(domain, (c) => changes.push(c), (m) => notices.push(m));
		assert.equal(ok, false);
		assert.equal(changes.length, 0);
		assert.equal(notices.length, 0);
	});

	it("complete 后 → false，不打扰", () => {
		const domain = freshDomain();
		createGoal(domain);
		domain.mutate({ operation: "complete", ref: domain.ref });

		const ok = emergencyStop(domain, () => {}, () => {});
		assert.equal(ok, false);
		assert.equal(domain.view!.phase, "complete");
	});

	it("急停后 agent_settled 不再注入（driver 条件：phase 非 active 直接 return）", () => {
		const domain = freshDomain();
		createGoal(domain);
		emergencyStop(domain, () => {}, () => {});
		// 模拟 driver 的 settled 检查条件
		const view = domain.view!;
		const wouldInject = view.phase === "active" && view.activation === "armed";
		assert.equal(wouldInject, false);
	});

	it("急停后可 /goal resume 恢复自动续行", () => {
		const domain = freshDomain();
		createGoal(domain);
		emergencyStop(domain, () => {}, () => {});
		domain.mutate({ operation: "resume", ref: domain.ref });
		assert.equal(domain.view!.phase, "active");
		assert.equal(domain.view!.activation, "armed");
	});

	it("集成：agent_start 挂 abort 监听，signal abort → goal 被 pause + notify", () => {
		const domain = freshDomain();
		createGoal(domain);

		const notices: string[] = [];
		const controller = new AbortController();
		const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
		const fakePi = {
			on: (type: string, handler: (e: unknown, c: unknown) => void) => {
				handlers[type] = handler;
			},
			sendMessage: () => {},
		} as unknown as ExtensionAPI;

		registerGoalDriver(fakePi, domain, { persist: () => {} });

		// agent_start：run 开始，signal 就位
		handlers["agent_start"]?.(
			{},
			{
				signal: controller.signal,
				ui: { notify: (m: string) => notices.push(m) },
			} as never,
		);
		assert.equal(domain.view!.phase, "active"); // 未 abort 前不动

		// 模拟 ESC：abort 当前 run 的 signal
		controller.abort();
		assert.equal(domain.view!.phase, "paused");
		assert.equal(domain.view!.activation, "disarmed");
		assert.equal(notices.length, 1);
		assert.match(notices[0], /\/goal resume/);
	});
});
