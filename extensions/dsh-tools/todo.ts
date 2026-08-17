// todo.ts — DSH dsh-tool-todo 移植：todo_write 全量快照工具
//
// 语义照抄 @deepseek-ai/dsh-tool-todo（见 docs/plans/2026-08-15-dsh-agent-capability-inventory.md）：
//   - 每次调用提交 ENTIRE 列表（整表替换，无局部更新、无单条编辑）
//   - content trim 后非空且唯一；allowParallel 为 false 时最多一个 in_progress
//   - 持久化：writeSteps() 即 appendEntry("dsh-todo", {todos}) 写会话 JSONL（CustomEntry，不进 LLM 上下文）；
//     折叠规则 last-wins（区别于 DSH 的 turn/start 投影重置——pi 端保持会话级持续，
//     /resume 后可恢复）
//
// 纯函数导出供单测；registerTodoTool 在扩展 factory 里调用。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TODO_STATUSES, type Step, writeSteps } from "../../lib/todo-store.ts";

/** DSH 侧叫 TodoItem，统一存储侧叫 Step（同形状，见 lib/todo-store.ts） */
export type TodoItem = Step;

export interface TodoWriteResult {
	todos: Step[];
	counts: { pending: number; inProgress: number; completed: number };
}

/** 校验模型提交的列表并构建规范 Step[]（DSH toTodoList 语义） */
export function toTodoList(raw: Step[], allowParallel: boolean): Step[] {
	const todos: Step[] = [];
	const seen = new Set<string>();
	let active = 0;
	for (const item of raw) {
		const content = item.content.trim();
		if (content.length === 0) throw new Error("invalid todo: `content` must be a non-empty string");
		if (seen.has(content)) throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`);
		seen.add(content);
		if (item.status === "in_progress") active++;
		todos.push({ content, status: item.status });
	}
	if (!allowParallel && active > 1) {
		throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`);
	}
	return todos;
}

const DESCRIPTION_HEAD =
	"Record and update a structured task list for the current work. Send the ENTIRE list every call — it REPLACES the previous list (there are no partial updates, no per-item edits). Use it to plan multi-step work and show progress: add one todo per concrete step before you start. ";
const DESCRIPTION_PARALLEL =
	"Mark every todo being actively worked on `in_progress` — several at once when work genuinely runs in parallel (e.g. concurrent subagents or background commands), one for sequential work; while work remains, at least one task should be `in_progress`. ";
const DESCRIPTION_SINGLE =
	"Keep AT MOST ONE todo `in_progress` at a time; while work remains, exactly one active task should be `in_progress`. ";
const DESCRIPTION_TAIL =
	"Mark a todo `completed` the moment it is done (do not batch completions), and allow no `in_progress` item only once all work is complete. Skip the list for trivial single-step tasks. Statuses: `pending` (not started), `in_progress` (being worked on now), `completed` (finished).";

export function describeTodoTool(allowParallel: boolean): string {
	return DESCRIPTION_HEAD + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE) + DESCRIPTION_TAIL;
}

export function countTodos(todos: Step[]): TodoWriteResult["counts"] {
	return {
		pending: todos.filter((t) => t.status === "pending").length,
		inProgress: todos.filter((t) => t.status === "in_progress").length,
		completed: todos.filter((t) => t.status === "completed").length,
	};
}

/**
 * 注册 todo_write 工具。
 * @param pi ExtensionAPI
 * @param allowParallel 是否允许多个 in_progress（settings dshTodoParallel，默认 true 跟随 DSH base）
 * @param persist (todos) => void 持久化钩子（默认 pi.appendEntry）
 */
export function registerTodoTool(
	pi: ExtensionAPI,
	allowParallel: boolean,
	persist: (todos: Step[]) => void = (todos) => writeSteps(pi, todos),
): void {
	pi.registerTool({
		name: "todo_write",
		label: "Todo Write",
		description: describeTodoTool(allowParallel),
		promptSnippet: "Record and update a structured task list (whole-list replacement)",
		promptGuidelines: [
			"todo_write 是全量替换：每次调用提交完整列表，没有局部更新",
			"在开始多步任务前列出每个具体步骤，随进度更新状态",
			"完成即标记 completed，不要攒批；全部完成时不应有 in_progress 项",
			"这是当前任务的步骤清单；跨轮长期目标（整个会话的唯一使命）用 goal 工具（create_goal），不要用 todo_write 承载目标",
		],
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					content: Type.String({ description: "What the task is — a short imperative line." }),
					status: Type.Union(
						TODO_STATUSES.map((s) => Type.Literal(s)),
						{ description: "pending (not started) | in_progress (now) | completed (done)." },
					),
				}),
				{ description: "The COMPLETE task list, replacing any previous list." },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const todos = toTodoList(params.todos, allowParallel);
			persist(todos);
			const counts = countTodos(todos);
			return {
				content: [
					{
						type: "text",
						text: `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.`,
					},
				],
				details: { todos, counts },
			};
		},
	});
}
