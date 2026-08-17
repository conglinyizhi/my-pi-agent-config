// dsh-tools — DSH 工具能力移植第一批（Track B，见 docs/plans/2026-08-15-dsh-architecture-migration.md §7）
//
//   todo_write         — DSH dsh-tool-todo 移植：全量快照任务列表（writeSteps 持久化到 dsh-todo，last-wins）
//   str_replace_editor — DSH dsh-tool-str-replace-editor 移植：view/create/str_replace/insert 行号编辑
//
// 开关（settings.json，/reload 生效；缺省全部开启，对照 v0.1.0 时置 false）：
//   "dshTodo": true            — 注册 todo_write
//   "dshTodoParallel": true    — 允许多个 in_progress（false = 单活跃纪律）
//   "dshStrReplaceEditor": true — 注册 str_replace_editor
//
// /dsh-todos 命令：从会话 CustomEntry 折叠当前步骤列表（与 plan-mode 共用的统一存储）。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerTodoTool } from "./todo.ts";
import { registerStrReplaceEditor } from "./str-replace.ts";
import { readSteps } from "../../lib/todo-store.ts";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function readSettings(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
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

	// /dsh-todos：显示当前会话步骤列表（统一存储，todo_write 与 plan-mode 共用）
	pi.registerCommand("dsh-todos", {
		description: "显示当前会话的步骤列表（todo_write / plan-mode 共用的最后快照）",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const entries = ctx.sessionManager.getEntries();
			const todos = readSteps(entries);
			if (!todos || todos.length === 0) {
				ctx.ui.notify("dsh-todos: 本会话尚无步骤（调用 todo_write 或进入计划模式创建）", "info");
				return;
			}
			const lines = todos.map((t) => `[${t.status}] ${t.content}`).join("\n");
			ctx.ui.notify(`dsh-todos（${todos.length} 项）:\n${lines}`, "info");
		},
	});
}
