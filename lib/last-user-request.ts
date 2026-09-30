// lib/last-user-request.ts — 从会话条目里取「用户最后要求了什么」
//
// 用途：审核模型（分类器的 intent 维度 / chat 的提示词）需要知道用户的原始请求，
// 才能判断「这条命令与要求的关系」。拿不到时 intent 只能猜，倾向判成「无关」，
// 于是满屏误报——所以这个字段必须真的接上。
//
// 纯函数，不碰 pi 运行时：输入是 SessionEntry 形状的东西（只要 type/role/content 对得上），
// 方便单测直接造假数据。

/** 会话条目里我们关心的那点形状（不 import pi 的类型，避免把运行时拖进测试） */
interface EntryLike {
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

/**
 * 从会话条目里取最近一条用户消息的文本。
 *
 * 为什么从后往前找：审批发生时的「当前任务」就是用户最近说的那句。
 * 从前往后会拿到会话开头那句，早已过期。
 *
 * 单条命令触发的审批（bash_background 等）也一样：用户最近一句仍然是最相关的上下文。
 */
export function lastUserRequest(entries: readonly EntryLike[], maxChars = 1500): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "user") continue;
		const text = flattenContent(message.content).trim();
		if (!text) continue;
		return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
	}
	return undefined;
}
