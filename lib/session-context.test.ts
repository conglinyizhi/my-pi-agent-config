// lib/session-context.test.ts — 从会话条目取上下文（纯函数，造假数据）
// 跑法：node --test --experimental-strip-types lib/session-context.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lastGoal, lastTodo, recentUserRequests, sessionContextText } from "./session-context.ts";

function user(text: string) {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

function tool(name: string, args: Record<string, unknown>) {
	return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name, arguments: args }] } };
}

describe("最近几条用户消息", () => {
	it("按早到晚返回，最多 ten 条", () => {
		const entries = Array.from({ length: 12 }, (_, i) => user(`第 ${i + 1} 条`));
		const recent = recentUserRequests(entries, 10);
		assert.equal(recent.length, 10);
		assert.equal(recent[0], "第 3 条", "只留最近十条");
		assert.equal(recent[9], "第 12 条", "最新的在最后");
	});

	it("跳过助手消息与空消息", () => {
		const entries = [user("要干这个"), { type: "message", message: { role: "assistant", content: [{ type: "text", text: "好" }] } }, user("  ")];
		assert.deepEqual(recentUserRequests(entries, 10), ["要干这个"]);
	});
});

describe("任务清单与目标", () => {
	it("取最后一次 todo_write", () => {
		const entries = [
			tool("todo_write", { todos: [{ content: "旧任务", status: "pending" }] }),
			tool("todo_write", { todos: [{ content: "写用例", status: "in_progress" }, { content: "提交", status: "pending" }] }),
		];
		assert.equal(lastTodo(entries), "- [in_progress] 写用例\n- [pending] 提交");
	});

	it("目标认 create_goal 与 update_goal(edit)，取最新的那个", () => {
		const entries = [tool("create_goal", { objective: "老目标" }), tool("update_goal", { action: "edit", objective: "新目标" })];
		assert.equal(lastGoal(entries), "新目标");
	});

	it("没有就不返回东西（空标题会误导模型）", () => {
		assert.equal(lastTodo([user("嗨")]), undefined);
		assert.equal(lastGoal([tool("update_goal", { action: "complete" })]), undefined);
	});
});

describe("上下文块", () => {
	it("三段按 要求 → 清单 → 目标 排列", () => {
		const entries = [
			user("把审核维度打开"),
			user("继续"),
			tool("todo_write", { todos: [{ content: "开维度", status: "in_progress" }] }),
			tool("create_goal", { objective: "让判定少误报" }),
		];
		const text = sessionContextText(entries) ?? "";
		assert.ok(text.includes("[用户最近的要求]（2 条，早到新）"));
		assert.ok(text.indexOf("把审核维度打开") < text.indexOf("继续"), "早的在前");
		assert.ok(text.indexOf("[当前任务清单]") < text.indexOf("[全局目标]"));
		assert.ok(text.includes("- [in_progress] 开维度"));
		assert.ok(text.includes("让判定少误报"));
	});

	it("什么都没有时返回 undefined", () => {
		assert.equal(sessionContextText([]), undefined);
	});
});
