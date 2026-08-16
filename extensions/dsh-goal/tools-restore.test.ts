// tools-restore.test.ts — dsh-goal 工具权限判断 + 会话恢复折叠测试
//
// 覆盖：lastUserTurnKind（人类 vs goal-round vs none）、isCurrentGoalRound、
// foldChangesFromEntries / countRoundMessages（session_start 恢复路径）
//
// 跑法：node --experimental-strip-types extensions/dsh-goal/tools-restore.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GoalDomain, type GoalChange } from "./state.ts";
import { GOAL_ROUND_CUSTOM_TYPE, isCurrentGoalRound, lastUserTurnKind } from "./tools.ts";
import { countRoundMessages, foldChangesFromEntries } from "./index.ts";

type AnyEntry = Record<string, unknown> & { type: string };

function userEntry(text: string, customType?: string, details?: unknown): AnyEntry {
	return {
		type: "message",
		message: { role: customType ? "custom" : "user", content: text, customType, details },
	};
}

function customEntry(customType: string, data?: unknown): AnyEntry {
	return { type: "custom", customType, data };
}

describe("lastUserTurnKind（工具权限来源）", () => {
	it("最后一条 user 消息 → human", () => {
		const entries = [userEntry("旧轮"), userEntry("人类输入")];
		assert.equal(lastUserTurnKind(entries as never), "human");
	});

	it("最后一条 goal-round custom → goal-round", () => {
		const entries = [userEntry("人类输入"), userEntry("<goal_round>", GOAL_ROUND_CUSTOM_TYPE)];
		assert.equal(lastUserTurnKind(entries as never), "goal-round");
	});

	it("其他 custom（plan-mode 等）不是轮次来源，继续往前找", () => {
		const entries = [userEntry("人类输入"), customEntry("plan-mode", {})];
		assert.equal(lastUserTurnKind(entries as never), "human");
	});

	it("无任何 user/custom 消息 → none", () => {
		assert.equal(lastUserTurnKind([customEntry("x")] as never), "none");
	});
});

describe("isCurrentGoalRound（complete/blocked 的 round 权威）", () => {
	function freshDomainWithGoal(): GoalDomain {
		const domain = new GoalDomain({ defaultMaxGoalRounds: 5 });
		domain.mutate({ operation: "create", objective: "目标" });
		domain.recordGoalRound({ goalId: domain.view!.id, revision: 1, round: 1 });
		return domain;
	}

	it("round 消息匹配当前 goal/revision/round → true", () => {
		const domain = freshDomainWithGoal();
		const entries = [userEntry("<goal_round>", GOAL_ROUND_CUSTOM_TYPE, { goalId: domain.view!.id, revision: 1, round: 1 })];
		assert.equal(isCurrentGoalRound(entries as never, domain), true);
	});

	it("round 号不匹配 → false", () => {
		const domain = freshDomainWithGoal();
		const entries = [userEntry("<goal_round>", GOAL_ROUND_CUSTOM_TYPE, { goalId: domain.view!.id, revision: 1, round: 2 })];
		assert.equal(isCurrentGoalRound(entries as never, domain), false);
	});
});

describe("会话恢复折叠（session_start 路径）", () => {
	it("foldChangesFromEntries：按序收集 durable 变更", () => {
		const domain = new GoalDomain({ defaultMaxGoalRounds: 5 });
		const c1 = domain.mutate({ operation: "create", objective: "目标" });
		const c2 = domain.mutate({ operation: "edit", ref: { id: c1.result.kind === "view" ? c1.result.view.id : ("" as never), revision: 1 }, objective: "目标2" });

		const entries = [customEntry("dsh-goal-change", c1.change), customEntry("other", {}), customEntry("dsh-goal-change", c2.change)];
		const changes = foldChangesFromEntries(entries as never);
		assert.equal(changes.length, 2);
		assert.deepEqual(changes as unknown as GoalChange[], [c1.change, c2.change]);
	});

	it("countRoundMessages：数匹配当前 goal 的 round 消息", () => {
		const domain = new GoalDomain({ defaultMaxGoalRounds: 5 });
		const c1 = domain.mutate({ operation: "create", objective: "目标" });
		const id = (c1.result.kind === "view" ? c1.result.view.id : "") as string;

		const entries = [
			userEntry("<goal_round>", GOAL_ROUND_CUSTOM_TYPE, { goalId: id, round: 1 }),
			userEntry("<goal_round>", GOAL_ROUND_CUSTOM_TYPE, { goalId: id, round: 2 }),
			userEntry("<goal_round>", GOAL_ROUND_CUSTOM_TYPE, { goalId: "other-goal", round: 1 }),
		];
		assert.equal(countRoundMessages(entries as never, id), 2);
	});

	it("恢复闭环：mutate → 持久化 → hydrate 重建（含 round 数，disarmed）", () => {
		const domain = new GoalDomain({ defaultMaxGoalRounds: 5 });
		const changes: GoalChange[] = [];
		const c1 = domain.mutate({ operation: "create", objective: "长期目标" });
		changes.push(c1.change);
		const id = (c1.result.kind === "view" ? c1.result.view.id : "") as string;
		domain.recordGoalRound({ goalId: id, revision: 1, round: 1 });
		domain.recordGoalRound({ goalId: id, revision: 1, round: 2 });

		const restored = new GoalDomain({ defaultMaxGoalRounds: 5 });
		restored.hydrate(changes, countRoundMessages([userEntry("<goal_round>", GOAL_ROUND_CUSTOM_TYPE, { goalId: id }), userEntry("<goal_round>", GOAL_ROUND_CUSTOM_TYPE, { goalId: id })] as never, id));
		assert.equal(restored.view!.objective, "长期目标");
		assert.equal(restored.view!.roundsStarted, 2);
		assert.equal(restored.view!.activation, "disarmed");
	});
});
