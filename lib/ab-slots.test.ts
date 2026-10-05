// lib/ab-slots.test.ts
// 跑法：node --test --experimental-strip-types lib/ab-slots.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_THRESHOLD,
	componentPath,
	currentLink,
	decidePromotion,
	emptyStreak,
	formatManifest,
	formatStreak,
	isComponent,
	isSlot,
	parseManifest,
	parseStreak,
	planPromotion,
	planRollback,
	promoteLogPath,
	slotPath,
	slotToken,
	streakAfter,
} from "./ab-slots.ts";

const ROOT = "/tmp/rt";

describe("路径", () => {
	it("组件与槽拼在 runtime 根下", () => {
		assert.equal(componentPath(ROOT, "gui"), "/tmp/rt/gui");
		assert.equal(slotPath(ROOT, "audit", "previous"), "/tmp/rt/audit/previous");
		assert.equal(currentLink(ROOT, "gui"), "/tmp/rt/gui/current");
		assert.equal(promoteLogPath(ROOT, "gui"), "/tmp/rt/gui/promote.log");
	});

	it("根目录带尾斜杠也认", () => {
		assert.equal(componentPath("/tmp/rt/", "gui"), "/tmp/rt/gui");
	});

	it("组件名与槽名只认白名单", () => {
		assert.equal(isComponent("gui"), true);
		assert.equal(isComponent("guy"), false);
		assert.equal(isSlot("head"), true);
		assert.equal(isSlot("current"), false);
	});
});

describe("manifest", () => {
	it("读写一轮不变形", () => {
		const manifest = { ref: "stable", sha: "abc123", dirty: false, builtAt: "2026-10-05T09:00:00Z", spec: "windows:gate,review" };
		assert.deepEqual(parseManifest(formatManifest(manifest)), manifest);
	});

	it("坏 JSON 给 undefined，不抛", () => {
		assert.equal(parseManifest("{"), undefined);
		assert.equal(parseManifest("null"), undefined);
	});

	it("令牌随槽变化（换槽必须换令牌，否则 import 吃缓存）", () => {
		const a = { sha: "aaa", builtAt: "t1" };
		const b = { sha: "bbb", builtAt: "t2" };
		assert.notEqual(slotToken(a), slotToken(b));
		assert.equal(slotToken(a), slotToken(a));
		assert.equal(slotToken(undefined), "none");
	});

	it("令牌只留安全字符（要拼进 import 的查询串）", () => {
		assert.match(slotToken({ ref: "stable/v1 2", builtAt: "2026-10-05T09:00:00Z" }), /^[A-Za-z0-9._-]+$/);
	});
});

describe("干净往返计数", () => {
	it("干净加一，失败清零并记原因", () => {
		let state = emptyStreak();
		state = streakAfter(state, "clean", { now: "t1" });
		state = streakAfter(state, "clean", { now: "t2" });
		assert.equal(state.clean, 2);
		state = streakAfter(state, "failure", { now: "t3", reason: "窗口被叉掉" });
		assert.equal(state.clean, 0);
		assert.equal(state.failures, 1);
		assert.equal(state.lastReason, "窗口被叉掉");
	});

	it("失败次数不清零（能看出这段有多毛）", () => {
		let state = emptyStreak();
		state = streakAfter(state, "failure");
		state = streakAfter(state, "clean");
		state = streakAfter(state, "failure");
		assert.equal(state.failures, 2);
		assert.equal(state.clean, 0);
	});

	it("读写一轮保住字段", () => {
		const state = streakAfter(emptyStreak("head"), "clean", { now: "t1" });
		assert.deepEqual(parseStreak(formatStreak(state)), state);
	});

	it("坏文件退回空计数", () => {
		assert.deepEqual(parseStreak("nope"), emptyStreak());
		assert.equal(parseStreak(JSON.stringify({ slot: "zzz", clean: -5 })).slot, "dev");
	});
});

describe("晋升判定", () => {
	it("没攒够就不动", () => {
		const decision = decidePromotion({ ...emptyStreak(), clean: 3 }, { threshold: 5 });
		assert.equal(decision.action, "keep");
		assert.match(decision.reason, /还差 2 次/);
	});

	it("攒够了默认自动晋升", () => {
		const decision = decidePromotion({ ...emptyStreak(), clean: DEFAULT_THRESHOLD });
		assert.equal(decision.action, "promote");
	});

	it("关掉自动就只提示", () => {
		const decision = decidePromotion({ ...emptyStreak(), clean: 5 }, { autoPromote: false });
		assert.equal(decision.action, "notify");
	});

	it("门槛非正数不晋升（防呆）", () => {
		assert.equal(decidePromotion({ ...emptyStreak(), clean: 99 }, { threshold: 0 }).action, "keep");
	});
});

describe("晋升与回退该做哪几步", () => {
	it("晋升顺序：先让旧 stable 落到 previous，再让 dev 顶上去", () => {
		const actions = planPromotion({ current: "dev", at: "t1" });
		assert.deepEqual(actions[0], { kind: "move", from: "stable", to: "previous" });
		assert.deepEqual(actions[1], { kind: "move", from: "dev", to: "stable" });
		assert.deepEqual(actions[2], { kind: "link", to: "stable" });
		assert.equal(actions[3].kind, "log");
		assert.match(String(actions[3].text), /"event":"promote"/);
	});

	it("回退就一件事：current 指回 previous", () => {
		const actions = planRollback({ reason: "判断逻辑静默失效" });
		assert.deepEqual(actions[0], { kind: "link", to: "previous" });
		assert.match(String(actions[1].text), /"event":"rollback"/);
		assert.match(String(actions[1].text), /判断逻辑静默失效/);
	});
});
