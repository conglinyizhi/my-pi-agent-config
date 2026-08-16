// dsh-tools — DSH 工具能力移植第一批（Track B，见 docs/plans/2026-08-15-dsh-architecture-migration.md §7）
//
//   todo_write         — DSH dsh-tool-todo 移植：全量快照任务列表（appendEntry 持久化，last-wins）
//   str_replace_editor — DSH dsh-tool-str-replace-editor 移植：view/create/str_replace/insert 行号编辑
//
// 开关（settings.json，/reload 生效；缺省全部开启，对照 v0.1.0 时置 false）：
//   "dshTodo": true            — 注册 todo_write
//   "dshTodoParallel": true    — 允许多个 in_progress（false = 单活跃纪律）
//   "dshStrReplaceEditor": true — 注册 str_replace_editor
//
// /dsh-todos 命令：从会话 CustomEntry 折叠当前 todo 列表（A/B 观察点）。

import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerTodoTool, type TodoItem } from "./todo.ts";
import { registerStrReplaceEditor } from "./str-replace.ts";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function readSettings(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

type TodoEntry = SessionEntry & {
	type: "custom";
	customType: "dsh-todo";
	data?: { todos?: TodoItem[] };
};

function isTodoEntry(entry: SessionEntry): entry is TodoEntry {
	return entry.type === "custom" && entry.customType === "dsh-todo";
}

/** 从会话 entries 折叠最后的 todo 列表（last-wins，与 DSH 投影折叠一致） */
export function foldLatestTodos(entries: SessionEntry[]): TodoItem[] | null {
	let latest: TodoItem[] | null = null;
	for (const entry of entries) {
		if (isTodoEntry(entry) && Array.isArray(entry.data?.todos)) {
			latest = entry.data!.todos!;
		}
	}
	return latest;
}

export default function (pi: ExtensionAPI) {
	const settings = readSettings();

	// todo_write：默认开启，settings dshTodo=false 关闭；dshTodoParallel 控制单/多活跃
	if (settings.dshTodo !== false) {
		registerTodoTool(pi, settings.dshTodoParallel !== false);
	}

	// str_replace_editor：默认开启，settings dshStrReplaceEditor=false 关闭
	if (settings.dshStrReplaceEditor !== false) {
		registerStrReplaceEditor(pi);
	}

	// /dsh-todos：显示当前会话 todo 列表（从 CustomEntry 折叠）
	pi.registerCommand("dsh-todos", {
		description: "显示当前会话的 todo 列表（todo_write 持久化的最后快照）",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const entries = ctx.sessionManager.getEntries();
			const todos = foldLatestTodos(entries);
			if (!todos || todos.length === 0) {
				ctx.ui.notify("dsh-todos: 本会话尚无 todo（调用 todo_write 创建）", "info");
				return;
			}
			const lines = todos.map((t) => `[${t.status}] ${t.content}`).join("\n");
			ctx.ui.notify(`dsh-todos（${todos.length} 项）:\n${lines}`, "info");
		},
	});
}
