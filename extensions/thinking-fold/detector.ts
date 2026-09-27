// thinking-fold/detector.ts — thinking 块尾部「复读后缀」检测核心
//
// 纯逻辑，不依赖 pi API，便于离线回放校准与单测。
//
// ── 与 loop-guard 的分工 ────────────────────────────────────────
// loop-guard/detector.ts 判的是「整块失控」：字母表极小 + 没有新内容，
// 命中后可以在流式阶段中止生成。这里的形态更轻：模型在超长会话里
// thinking 尾部退化成复读（「好。/ 执行。/ Output.」反复几十上百次），
// 但自己还能继续出 toolCall、任务照常推进，所以不该中止生成，
// 只需要在渲染层把尾部折起来，别占满屏幕。两块检测的输入都走同一套
// 行归一化（复用 loop-guard 的 normalizeLine / hasSubstance），
// 避免两份口径漂移。
//
// ── 算法 ──────────────────────────────────────────────────────
// 1. 逐行归一化，只保留「非空且有实义字符」的行，并记住原始行号
// 2. 统计整块每行的出现次数：
//    出现 ≥ minCount 次、且长度 ≤ maxLineLen 的行算「复读行」
//    整块最常见行的出现次数不到 maxTopCount → 根本没复读，直接放过
// 3. 从尾部往前扩展窗口，增量维护窗口内的复读字符数 / 窗口字符数 /
//    复读行种类；窗口满足「行数 ≥ minLines、字符数 ≥ minChars、
//    复读行种类 ≤ maxKinds、复读字符占比 ≥ minDensity」即候选。
// 4. 取字符最多的候选（即最长合格后缀）。窗口从尾往头只增不减，
//    最后一个合格窗口就是字符最多的那个
// 5. 起点对齐到窗口内第一个复读行：宁可少折，也别把开头那几行正常内容吞掉
//
// 复杂度 O(n)：窗口统计全部增量维护，唯一随候选走的计算是 top 排序，
// 而它在复读行种类 ≤ maxKinds 时才做，代价与块长无关。

import { hasSubstance, normalizeLine } from "../loop-guard/detector.ts";

/** 命中的尾部复读后缀 */
export interface DupSuffix {
	/** 后缀第一行在原始 text.split("\n") 里的下标（不是有效行下标） */
	startLine: number;
	/** 后缀内的有效行数 */
	lines: number;
	/** 后缀字符数（按归一化行长 + 1 累计） */
	chars: number;
	/** 后缀内复读行的种类数 */
	kinds: number;
	/** 后缀内出现最多的前 4 行，格式「文本 ×次数」 */
	top: string[];
}

export interface DupOptions {
	/** 一行至少出现几次才算「复读行」 */
	minCount: number;
	/** 复读行的长度上限（长行不算） */
	maxLineLen: number;
	/** 复读字符占窗口字符的比例下限 */
	minDensity: number;
	/** 折叠段字符下限 */
	minChars: number;
	/** 折叠段行数下限 */
	minLines: number;
	/** 折叠段内复读行种类上限 */
	maxKinds: number;
	/** 整块最常见行至少出现次数 */
	maxTopCount: number;
}

export const DEFAULT_DUP_OPTIONS: DupOptions = {
	minCount: 3,
	maxLineLen: 20,
	minDensity: 0.75,
	minChars: 600,
	minLines: 40,
	maxKinds: 20,
	maxTopCount: 5,
};

/** 取窗口内出现次数最多的前 4 项，格式「文本 ×次数」 */
function topEntries(counts: Map<string, number>, limit = 4): string[] {
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([text, n]) => `${text} ×${n}`);
}

/**
 * 找 thinking 块尾部的复读后缀。
 * opts 支持只给部分字段（其余用 DEFAULT_DUP_OPTIONS 补齐）。
 * 没命中返回 null。
 */
export function findDupSuffix(text: string, opts: Partial<DupOptions> = {}): DupSuffix | null {
	const o: DupOptions = { ...DEFAULT_DUP_OPTIONS, ...opts };

	const raw = text.split("\n");
	/** 有效行的原始行号 */
	const validIdx: number[] = [];
	const lines: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const n = normalizeLine(raw[i]);
		if (n !== "" && hasSubstance(n)) {
			validIdx.push(i);
			lines.push(n);
		}
	}
	if (lines.length < o.minLines) return null;

	// 整块每行出现次数
	const total = new Map<string, number>();
	for (const l of lines) total.set(l, (total.get(l) ?? 0) + 1);

	let topCount = 0;
	for (const v of total.values()) if (v > topCount) topCount = v;
	if (topCount < o.maxTopCount) return null;

	// 复读行标记
	const isRepeat = new Array<boolean>(lines.length);
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		isRepeat[i] = (total.get(l) ?? 0) >= o.minCount && l.length <= o.maxLineLen;
	}

	// 第一遍：从尾往前扩展窗口，只增量记账（不排序），最后留下的就是最长合格后缀
	const inWin = new Map<string, number>();
	let repeatCharsWin = 0;
	let winChars = 0;
	let bestStart = -1;

	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i];
		winChars += l.length + 1;
		if (isRepeat[i]) {
			repeatCharsWin += l.length + 1;
			inWin.set(l, (inWin.get(l) ?? 0) + 1);
		}
		const n = lines.length - i;
		if (n < o.minLines) continue;
		if (winChars < o.minChars) continue;
		if (inWin.size > o.maxKinds) continue;
		if (repeatCharsWin / winChars < o.minDensity) continue;
		bestStart = i;
	}
	if (bestStart < 0) return null;

	// 起点对齐到窗口内的第一个复读行：宁可少折，也别把窗口开头那几行正常内容一起吞掉。
	// 实测这一步把「整块折光」（一行不留）从 17 次降到 0。
	let s = bestStart;
	while (s < lines.length && !isRepeat[s]) s++;
	if (s >= lines.length) return null;

	// 第二遍：只为最终窗口算一次字符数 / 种类 / 样例（排序只做这一次）
	let chars = 0;
	const winCounts = new Map<string, number>();
	for (let i = s; i < lines.length; i++) {
		const l = lines[i];
		chars += l.length + 1;
		if (isRepeat[i]) winCounts.set(l, (winCounts.get(l) ?? 0) + 1);
	}
	if (chars < o.minChars) return null;

	return {
		startLine: validIdx[s],
		lines: lines.length - s,
		chars,
		kinds: winCounts.size,
		top: topEntries(winCounts),
	};
}
