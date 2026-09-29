// selection.ts — ask_question 的选项状态判定（回看高亮 / 自定义输入的历史 / 换选项的二次确认）
//
// 组件（index.ts）只管画和按键路由，这里的判定抽出来单测：哪些事发生在闭包里、
// 又只跟「答过什么」有关，就不该靠桩 TUI 才验得了。
//
// 三个概念：
//   回看    切回已经答过的问题时，高亮原来那一项；答的是自定义文本就高亮「Type something.」
//   历史    被换掉的自定义文本不丢：进内存历史（最多 3 条），列在「Type something.」下面
//   二次确认 从自定义答案改选别的选项时先提示一次，同一个选项再按一次 Enter 才算改

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/** 每题最多留几条被换掉的自定义输入 */
export const HISTORY_LIMIT = 3;

/**
 * 单行预览：多行文本压成一行，按列宽截断（终端宽度有限，只给看前一段）。
 *
 * 自己切片而不走 truncateToWidth：后者会在截断处插 ANSI 复位码，嵌在
 * theme.fg(...) 里会把后面的省略号变成无色（那个函数是给整行用的，不是给片段）。
 */
export function previewOf(text: string, width: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (!oneLine || width <= 2) return "";
	if (visibleWidth(oneLine) <= width) return oneLine;
	return `${sliceByColumn(oneLine, 0, width - 1, true)}…`;
}

/** 记一条被换掉的自定义输入：去重、追加、满了丢最旧的 */
export function pushHistory(history: readonly string[], text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [...history];
	const next = history.filter((t) => t !== trimmed);
	next.push(trimmed);
	return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** 打开编辑器时预填什么：当前答案就是自定义就用它，否则取最近一条历史 */
export function lastCustomText(
	answer: { value: string; wasCustom: boolean } | undefined,
	history: readonly string[],
): string | undefined {
	if (answer?.wasCustom) return answer.value;
	return history.length > 0 ? history[history.length - 1] : undefined;
}

/** 选项表里「Type something.」的行号（不允许自由输入时为 -1） */
function otherRowIndex(optionCount: number, allowOther: boolean): number {
	return allowOther ? optionCount : -1;
}

/**
 * 切回已答的问题时该高亮哪一行。
 * 普通选项用答案里记的行号（1 基），自定义文本落回「Type something.」那行；
 * 没答过就回到第一项。
 */
export function restoreOptionIndex(input: {
	optionCount: number;
	allowOther: boolean;
	historyCount: number;
	answer?: { wasCustom: boolean; index?: number };
}): number {
	const { optionCount, allowOther, historyCount, answer } = input;
	const rowCount = optionCount + (allowOther ? 1 : 0) + historyCount;
	const clamp = (i: number) => Math.max(0, Math.min(i, Math.max(0, rowCount - 1)));
	if (!answer) return 0;
	if (answer.wasCustom) {
		const other = otherRowIndex(optionCount, allowOther);
		return other >= 0 ? clamp(other) : 0;
	}
	return clamp((answer.index ?? 1) - 1);
}

export type SwitchDecision =
	/** 直接改（原来不是自定义答案，或设了别的二次确认状态） */
	| "apply"
	/** 先出提示，同一条再按一次才改 */
	| "confirm";

/**
 * 在某个选项上按下 Enter 时要不要先确认一次。
 *
 * 只有「原来的答案是自定义文本」才拦一道：那条文本是用户亲手打的，换掉之前问一句。
 * 普通选项之间换来换去不拦（不重要的选择不该多一次按键）。
 */
export function switchDecision(
	answer: { wasCustom: boolean } | undefined,
	pending: { optionIndex: number } | undefined,
	optionIndex: number,
): SwitchDecision {
	if (!answer?.wasCustom) return "apply";
	if (pending && pending.optionIndex === optionIndex) return "apply";
	return "confirm";
}
