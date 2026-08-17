// lib/todo-store.ts — 统一步骤存储（todo_write 与 plan-mode 共用）
//
// 一个会话只有一份「步骤列表」，持久化为会话 CustomEntry（customType "dsh-todo"）：
//   appendEntry("dsh-todo", { todos: Step[] })   —— 全量快照，last-wins
// 读取时折叠最后一条 dsh-todo entry 得到当前列表。
//
// Step 形状沿用 DSH dsh-tool-todo 的 TodoItem：
//   { content: string, status: "pending" | "in_progress" | "completed" }
// plan-mode 的计划步骤也映射到此形状：step 编号 = 数组下标 + 1，completed → status。

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

/** dsh-todo entry 的 customType */
export const TODO_ENTRY_TYPE = "dsh-todo";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** 统一步骤项（= DSH TodoItem） */
export interface Step {
	content: string;
	status: TodoStatus;
}

type TodoEntry = SessionEntry & {
	type: "custom";
	customType: typeof TODO_ENTRY_TYPE;
	data?: { todos?: Step[] };
};

function isTodoEntry(entry: SessionEntry): entry is TodoEntry {
	return entry.type === "custom" && entry.customType === TODO_ENTRY_TYPE;
}

/** 从会话 entries 折叠最后的步骤列表（last-wins；从未写过则 null） */
export function readSteps(entries: SessionEntry[]): Step[] | null {
	let latest: Step[] | null = null;
	for (const entry of entries) {
		if (isTodoEntry(entry) && Array.isArray(entry.data?.todos)) {
			latest = entry.data!.todos!;
		}
	}
	return latest;
}

/** 写步骤列表（全量快照，追加一条 dsh-todo entry） */
export function writeSteps(pi: ExtensionAPI, steps: Step[]): void {
	pi.appendEntry(TODO_ENTRY_TYPE, { todos: steps });
}
