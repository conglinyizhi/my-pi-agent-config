// session-context.ts — 从会话条目里取出"审这条命令时该知道的上下文"
//
// 用途：审核模型（分类器的意图维、chat 的提示词）需要知道用户要做什么。
// 早先只取最近一条用户消息，于是"继续""嗯"这种消息等于没给上下文——
// 提督 2026-10-05 要求补上：最近 10 条用户消息 + 当前任务清单 + 全局目标。
//
// 纯函数，不碰 pi 运行时：输入是会话条目（只要 type/role/content 与 toolCall 对得上）。

/** 会话条目里我们关心的那点形状（不 import pi 的类型，避免把运行时拖进测试） */
export interface EntryLike {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

/** 把消息内容拍平成纯文本（字符串直接用；块数组只取 text 块） */
export function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (block && typeof block === "object") {
			const b = block as Record<string, unknown>;
			// 只要 text：thinking 是模型自己的、图片没有文本，都不该混进「用户要求」
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		}
	}
	return parts.join("\n");
}

function messageText(entry: EntryLike, role: string): string | undefined {
	if (entry?.type !== "message") return undefined;
	if (entry.message?.role !== role) return undefined;
	const text = flattenContent(entry.message.content).trim();
	return text === "" ? undefined : text;
}

/** 会话里所有的工具调用块：{name, arguments} */
function toolCalls(entries: readonly EntryLike[]): Array<{ name: string; args: Record<string, unknown> }> {
	const out: Array<{ name: string; args: Record<string, unknown> }> = [];
	for (const entry of entries) {
		const content = entry?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (b.type !== "toolCall" && b.type !== "tool_use") continue;
			const name = typeof b.name === "string" ? b.name : "";
			const args = b.arguments && typeof b.arguments === "object" ? (b.arguments as Record<string, unknown>) : {};
			if (name !== "") out.push({ name, args });
		}
	}
	return out;
}

/** 最近一条用户消息（老接口，保留：单条就够用的地方别拼一串） */
export function lastUserRequest(entries: readonly EntryLike[], maxChars = 1500): string | undefined {
	const recent = recentUserRequests(entries, 1, maxChars);
	return recent.length > 0 ? recent[0] : undefined;
}

/** 最近的 N 条用户消息，按时间从早到晚返回；每条截到 maxChars */
export function recentUserRequests(
	entries: readonly EntryLike[],
	limit = 10,
	maxChars = 1500,
): string[] {
	const out: string[] = [];
	for (let i = entries.length - 1; i >= 0 && out.length < limit; i -= 1) {
		const text = messageText(entries[i] as EntryLike, "user");
		if (!text) continue;
		out.push(text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);
	}
	return out.reverse();
}

/** 当前全局目标：最后一次 create_goal 或 update_goal(edit) 的 objective */
export function lastGoal(entries: readonly EntryLike[]): string | undefined {
	let goal: string | undefined;
	for (const call of toolCalls(entries)) {
		if (call.name === "create_goal" && typeof call.args.objective === "string") goal = call.args.objective;
		if (call.name === "update_goal" && call.args.action === "edit" && typeof call.args.objective === "string") {
			goal = call.args.objective;
		}
	}
	return goal;
}

/** 当前任务清单：最后一次 todo_write 的内容，渲染成紧凑清单 */
export function lastTodo(entries: readonly EntryLike[]): string | undefined {
	let rendered: string | undefined;
	for (const call of toolCalls(entries)) {
		if (call.name !== "todo_write" || !Array.isArray(call.args.todos)) continue;
		const lines: string[] = [];
		for (const item of call.args.todos) {
			if (!item || typeof item !== "object") continue;
			const t = item as Record<string, unknown>;
			const content = typeof t.content === "string" ? t.content : "";
			if (content === "") continue;
			lines.push(`- [${typeof t.status === "string" ? t.status : "?"}] ${content}`);
		}
		if (lines.length > 0) rendered = lines.join("\n");
	}
	return rendered;
}

/**
 * 给审核模型看的上下文块。
 *
 * 顺序：先"用户要什么"（最近几条，旧到新），再"正在做什么"（清单、目标）。
 * 拿不到的部分整段不出现——空标题会让模型以为"确实没有要求"，那比缺字段更误导。
 */
export function sessionContextText(entries: readonly EntryLike[]): string | undefined {
	const past = recentUserRequests(entries, 10, 800);
	const todo = lastTodo(entries);
	const goal = lastGoal(entries);
	const blocks: string[] = [];
	if (past.length > 0) blocks.push(`[用户最近的要求]（${past.length} 条，早到新）\n${past.join("\n---\n")}`);
	if (todo) blocks.push(`[当前任务清单]\n${todo}`);
	if (goal) blocks.push(`[全局目标]\n${goal}`);
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}
