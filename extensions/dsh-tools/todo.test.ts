// todo.test.ts — dsh-tools todo_write 语义测试（DSH toTodoList 逐条对照）
//
// 跑法：node --experimental-strip-types extensions/dsh-tools/todo.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countTodos, describeTodoTool, toTodoList } from "./todo.ts";

describe("toTodoList（DSH toTodoList 语义）", () => {
	it("trim content 并保留状态", () => {
		const out = toTodoList(
			[
				{ content: "  写测试  ", status: "in_progress" },
				{ content: "提交", status: "pending" },
			],
			true,
		);
		assert.deepEqual(out, [
			{ content: "写测试", status: "in_progress" },
			{ content: "提交", status: "pending" },
		]);
	});

	it("空 content 抛错", () => {
		assert.throws(() => toTodoList([{ content: "   ", status: "pending" }], true), /non-empty/);
	});

	it("重复 content 抛错", () => {
		assert.throws(
			() =>
				toTodoList(
					[
						{ content: "同一件事", status: "pending" },
						{ content: "同一件事", status: "pending" },
					],
					true,
				),
			/duplicate content/,
		);
	});

	it("allowParallel=false 时多个 in_progress 抛错", () => {
		assert.throws(
			() =>
				toTodoList(
					[
						{ content: "a", status: "in_progress" },
						{ content: "b", status: "in_progress" },
					],
					false,
				),
			/at most one task may be in_progress/,
		);
	});

	it("allowParallel=true 时多个 in_progress 通过", () => {
		const out = toTodoList(
			[
				{ content: "a", status: "in_progress" },
				{ content: "b", status: "in_progress" },
				{ content: "c", status: "completed" },
			],
			true,
		);
		assert.equal(out.length, 3);
	});
});

describe("countTodos", () => {
	it("按状态计数", () => {
		const counts = countTodos([
			{ content: "a", status: "pending" },
			{ content: "b", status: "in_progress" },
			{ content: "c", status: "completed" },
			{ content: "d", status: "completed" },
		]);
		assert.deepEqual(counts, { pending: 1, inProgress: 1, completed: 2 });
	});
});

describe("describeTodoTool", () => {
	it("并行/单活跃描述不同且都含全量替换语义", () => {
		const parallel = describeTodoTool(true);
		const single = describeTodoTool(false);
		assert.ok(parallel.includes("ENTIRE"));
		assert.ok(parallel.includes("several at once"));
		assert.ok(single.includes("AT MOST ONE"));
	});
});
