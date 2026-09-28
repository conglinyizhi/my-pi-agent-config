// repo-prompts/widget.ts — 编辑器上方的常驻提示（纯函数，便于单测）
//
// 为什么不是只有 ui.notify：notify 是一次性 toast，几秒就没了。用户没看到的那一刻
// 就永远错过了 —— 而「本目录注入了哪些规则」是**整个会话都成立**的事实，值得一直摆着。
// setWidget 的内容常驻在编辑器上方（同 key 覆盖，传 undefined 清除），可以随时回看。
//
// notify 仍然发一遍（跳出来那一下最醒目），这里负责留在原地。
//
// 只在真有事说的时候才给行：没命中规则、也没告警 → 返回空数组，调用方不设 widget（零打扰）。

export const WIDGET_ID = "repo-prompts";

/** 注入告知里每条规则要说清的：叫什么、来自哪个文件 */
export interface InjectedBrief {
	name: string;
	from: string;
}

export interface WidgetInput {
	/** 本会话攒下的配置告警（factory 期 + 装配期） */
	warnings: string[];
	/** 当前 cwd 真命中的规则 */
	injected: InjectedBrief[];
	/** 最多显示几行（含标题与告警行），超出折叠成一行提示。缺省 6 */
	maxLines?: number;
}

/**
 * 组装常驻提示的行。没有内容可说时返回空数组（调用方据此不设 widget）。
 *
 * 行序：先注入（本目录发生了什么），再告警（配置有问题）——
 * 前者是每次进目录都该知道的，后者通常在修好之前一直在。
 */
export function buildWidgetLines(input: WidgetInput): string[] {
	const maxLines = input.maxLines ?? 6;
	const lines: string[] = [];

	if (input.injected.length > 0) {
		lines.push(`[repo-prompts] 本目录注入 ${input.injected.length} 条规则：`);
		for (const rule of input.injected) lines.push(`· ${rule.name} ← ${rule.from}`);
	}

	if (input.warnings.length > 0) {
		const rest = input.warnings.length > 1 ? `（共 ${input.warnings.length} 条）` : "";
		lines.push(`[repo-prompts] 配置告警${rest}：${input.warnings[0]}`);
		if (input.warnings.length > 1) lines.push("  …/repo-prompts 看全部");
	}

	if (maxLines > 0 && lines.length > maxLines) {
		const hidden = lines.length - (maxLines - 1);
		lines.length = maxLines - 1;
		lines.push(`…还有 ${hidden} 行（/repo-prompts）`);
	}

	return lines;
}
