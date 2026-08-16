// state.test.ts — dsh-goal 状态机/CAS/折叠语义测试（DSH GoalService 逐条对照）
//
// 跑法：node --experimental-strip-types extensions/dsh-goal/state.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	GoalDomain,
	GoalError,
	applyGoalChange,
	emptyGoalFoldState,
	foldGoalChanges,
	type GoalChange,
	type GoalView,
} from "./state.ts";

function freshDomain(): GoalDomain {
	return new GoalDomain({ defaultMaxGoalRounds: 5 });
}

function createGoal(domain: GoalDomain, objective = "长期目标"): { change: GoalChange; view: GoalView | undefined } {
	const created = domain.mutate({ operation: "create", objective });
	return { change: created.change, view: created.result.kind === "view" ? created.result.view : undefined };
}

describe("create", () => {
	it("创建：revision=1, active, armed, rounds=0", () => {
		const domain = freshDomain();
		const { view } = createGoal(domain);
		assert.ok(view);
		assert.equal(view!.revision, 1);
		assert.equal(view!.phase, "active");
		assert.equal(view!.activation, "armed");
		assert.equal(view!.roundsStarted, 0);
		assert.equal(view!.maxGoalRounds, 5);
	});

	it("已有非 complete goal 时重复 create 拒绝", () => {
		const domain = freshDomain();
		createGoal(domain);
		assert.throws(() => domain.mutate({ operation: "create", objective: "x" }), GoalError);
	});

	it("complete 后可重新 create", () => {
		const domain = freshDomain();
		const first = createGoal(domain);
		domain.mutate({ operation: "complete", ref: { id: first.view!.id, revision: 1 } });
		const second = createGoal(domain, "新目标");
		assert.notEqual(second.view!.id, first.view!.id);
		assert.equal(second.view!.revision, 1);
	});
});

describe("CAS 与转换", () => {
	it("陈旧 ref 拒绝（GOAL_STALE_REVISION）", () => {
		const domain = freshDomain();
		const first = createGoal(domain);
		assert.throws(
			() => domain.mutate({ operation: "pause", ref: { id: first.view!.id, revision: 99 } }),
			(e: unknown) => e instanceof GoalError && e.code === "GOAL_STALE_REVISION",
		);
	});

	it("edit：改 objective/上限，revision+1，保 phase/activation", () => {
		const domain = freshDomain();
		const first = createGoal(domain);
		const edited = domain.mutate({
			operation: "edit",
			ref: { id: first.view!.id, revision: 1 },
			objective: "改了的目标",
			maxGoalRounds: 9,
		});
		const view = edited.result.kind === "view" ? edited.result.view : undefined;
		assert.equal(view!.objective, "改了的目标");
		assert.equal(view!.maxGoalRounds, 9);
		assert.equal(view!.revision, 2);
		assert.equal(view!.phase, "active");
		assert.equal(view!.activation, "armed");
	});

	it("edit 无字段拒绝", () => {
		const domain = freshDomain();
		const first = createGoal(domain);
		assert.throws(
			() => domain.mutate({ operation: "edit", ref: { id: first.view!.id, revision: 1 } }),
			(e: unknown) => e instanceof GoalError && e.code === "GOAL_INVALID_EDIT",
		);
	});

	it("pause: active → paused, disarmed；再 pause 拒绝", () => {
		const domain = freshDomain();
		const first = createGoal(domain);
		domain.mutate({ operation: "pause", ref: { id: first.view!.id, revision: 1 } });
		assert.equal(domain.view!.phase, "paused");
		assert.equal(domain.view!.activation, "disarmed");
		assert.throws(() => domain.mutate({ operation: "pause", ref: { id: first.view!.id, revision: 2 } }));
	});

	it("resume: paused → active, armed；预算耗尽拒绝；active+armed 重复 resume 拒绝", () => {
		const domain = freshDomain();
		const first = createGoal(domain);
		domain.mutate({ operation: "pause", ref: { id: first.view!.id, revision: 1 } });
		domain.mutate({ operation: "resume", ref: { id: first.view!.id, revision: 2 } });
		assert.equal(domain.view!.phase, "active");
		assert.equal(domain.view!.activation, "armed");
		// active+armed 重复 resume 拒绝
		assert.throws(() => domain.mutate({ operation: "resume", ref: { id: first.view!.id, revision: 3 } }));

		// 预算耗尽（max=2）：active 时 record 两轮 → pause → resume 被拒
		const d2 = new GoalDomain({ defaultMaxGoalRounds: 2 });
		const g2 = createGoal(d2);
		d2.recordGoalRound({ goalId: g2.view!.id, revision: 1, round: 1 });
		d2.recordGoalRound({ goalId: g2.view!.id, revision: 1, round: 2 });
		d2.mutate({ operation: "pause", ref: { id: g2.view!.id, revision: 1 } });
		// 预算耗尽 → 拒绝
		assert.throws(
			() => d2.mutate({ operation: "resume", ref: { id: g2.view!.id, revision: 2 } }),
			/exhausted 2 goal rounds/,
		);
	});

	it("complete: active/paused/blocked → complete, disarmed", () => {
		const domain = freshDomain();
		const first = createGoal(domain);
		domain.mutate({ operation: "complete", ref: { id: first.view!.id, revision: 1 } });
		assert.equal(domain.view!.phase, "complete");
		assert.equal(domain.view!.activation, "disarmed");
	});

	it("block: active → blocked 带 reason；非 active 拒绝", () => {
		const domain = freshDomain();
		const first = createGoal(domain);
		domain.mutate({
			operation: "block",
			ref: { id: first.view!.id, revision: 1 },
			blockedReason: { code: "model-reported", message: "同一阻塞持续三轮" },
		});
		assert.equal(domain.view!.phase, "blocked");
		assert.equal(domain.view!.blockedReason!.code, "model-reported");
		assert.throws(() => domain.mutate({ operation: "block", ref: { id: first.view!.id, revision: 2 } }));
	});

	it("非法 block reason 拒绝（code 非 kebab-case / message 空）", () => {
		const domain = freshDomain();
		const first = createGoal(domain);
		assert.throws(
			() =>
				domain.mutate({
					operation: "block",
					ref: { id: first.view!.id, revision: 1 },
					blockedReason: { code: "Bad Code!", message: "x" },
				}),
			(e: unknown) => e instanceof GoalError && e.code === "GOAL_INVALID_BLOCK_REASON",
		);
	});
});

describe("clear 与折叠", () => {
	it("clear: tombstone revision+1，之后无当前目标，可再 create", () => {
		const domain = freshDomain();
		const first = createGoal(domain);
		const cleared = domain.mutate({ operation: "clear", ref: { id: first.view!.id, revision: 1 } });
		const tomb = cleared.result.kind === "tombstone" ? cleared.result.ref : undefined;
		assert.equal(tomb!.revision, 2);
		assert.equal(domain.view, undefined);
		createGoal(domain, "清除后的新目标");
	});

	it("折叠：last-wins 重建视图（create→edit→complete）", () => {
		const domain = freshDomain();
		const changes: GoalChange[] = [];
		const c1 = createGoal(domain, "目标A");
		changes.push(c1.change);
		const e1 = domain.mutate({ operation: "edit", ref: { id: c1.view!.id, revision: 1 }, objective: "目标A2" });
		changes.push(e1.change);
		const p1 = domain.mutate({ operation: "complete", ref: { id: c1.view!.id, revision: 2 } });
		changes.push(p1.change);

		const folded = foldGoalChanges(changes);
		assert.equal(folded.goal!.objective, "目标A2");
		assert.equal(folded.goal!.phase, "complete");
		assert.equal(folded.lastRef!.revision, 3);
	});

	it("折叠：clear tombstone 后无当前目标", () => {
		const domain = freshDomain();
		const changes: GoalChange[] = [];
		const c1 = createGoal(domain);
		changes.push(c1.change);
		const cl = domain.mutate({ operation: "clear", ref: { id: c1.view!.id, revision: 1 } });
		changes.push(cl.change);
		const folded = foldGoalChanges(changes);
		assert.equal(folded.goal, undefined);
		assert.equal(folded.lastRef!.revision, 2);
	});

	it("折叠：乱序/跳号变更拒绝（fail-loud）", () => {
		const domain = freshDomain();
		const c1 = createGoal(domain);
		// 跳过 revision 2 直接到 3
		assert.throws(() =>
			applyGoalChange(emptyGoalFoldState(), {
				kind: "goal/change",
				version: 1,
				operation: "edit",
				goal: { ...c1.view!, id: c1.view!.id, revision: 3, objective: "跳号" },
				roundsStarted: 0,
				createdAt: 1,
				updatedAt: 2,
			}),
		);
	});
});

describe("hydrate 与 recordGoalRound", () => {
	it("hydrate 重建（含 round 消息数），激活位 disarmed", () => {
		const domain = freshDomain();
		const changes: GoalChange[] = [];
		const c1 = createGoal(domain);
		changes.push(c1.change);
		domain.recordGoalRound({ goalId: c1.view!.id, revision: 1, round: 1 });
		domain.recordGoalRound({ goalId: c1.view!.id, revision: 1, round: 2 });

		const restored = new GoalDomain({ defaultMaxGoalRounds: 5 });
		restored.hydrate(changes, 2);
		assert.equal(restored.view!.roundsStarted, 2);
		assert.equal(restored.view!.activation, "disarmed");
	});

	it("recordGoalRound 校验连续性与预算", () => {
		const domain = freshDomain();
		const c1 = createGoal(domain);
		assert.throws(
			() => domain.recordGoalRound({ goalId: c1.view!.id, revision: 1, round: 3 }),
			/not the next admitted round/,
		);
		domain.recordGoalRound({ goalId: c1.view!.id, revision: 1, round: 1 });
		domain.recordGoalRound({ goalId: c1.view!.id, revision: 1, round: 2 });
		domain.recordGoalRound({ goalId: c1.view!.id, revision: 1, round: 3 });
		domain.recordGoalRound({ goalId: c1.view!.id, revision: 1, round: 4 });
		domain.recordGoalRound({ goalId: c1.view!.id, revision: 1, round: 5 });
		assert.throws(
			() => domain.recordGoalRound({ goalId: c1.view!.id, revision: 1, round: 6 }),
			/exceed|not the next admitted round/,
		);
	});

	it("round 消息数超过预算时 hydrate 抛错", () => {
		const domain = freshDomain();
		const c1 = createGoal(domain);
		assert.throws(
			() => domain.hydrate([c1.change], 99),
			/exceed maxGoalRounds/,
		);
	});
});
