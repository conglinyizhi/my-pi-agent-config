// lib/text-diff.ts — 行级文本对比（审核窗与 pi 侧共用同一份实现）
//
// 用途：把 edit 的 old/new、以及"同一文件多处改动合并后的净变化"摆成人能读的样子。
//
// 两条设计取舍：
//   1. 先剥掉公共前后缀，再对中间那段做 LCS。真实改动通常只占几行，这一步能把
//      绝大部分开销消掉；中间段仍然过大时**明确返回 too-large**，不硬算——
//      算不完就说不算，别让窗口卡住，也别给出一份看着像全量的假对比。
//   2. 行内高亮只在"成对的改动行"上做（旧的删一行、新的加一行），靠公共前后缀
//      定位差异区间。它不是 diff-match-patch 那种字符级对齐，但对读代码足够，
//      而且完全可预测、可单测。

export type DiffRowKind = "same" | "add" | "del";

/** 行内改动区间（片段内字符坐标，半开） */
export interface IntraRange {
	s: number;
	e: number;
}

export interface DiffRow {
	kind: DiffRowKind;
	text: string;
	/** 旧文本里的行号（1 起）；add 行没有 */
	oldLine?: number;
	/** 新文本里的行号（1 起）；del 行没有 */
	newLine?: number;
	/** 行内改动区间：只有成对的改动行才有 */
	intra?: IntraRange[];
}

export interface DiffResult {
	status: "ok" | "identical" | "too-large";
	rows: DiffRow[];
	added: number;
	removed: number;
}

/** 中间段超过这么多行就不硬算（两个方向都卡住，避免几十万格子的表） */
export const DEFAULT_MAX_LINES = 600;

/** 按行切。尾随换行不产生一个空行（行号才对得上编辑器） */
export function splitLines(text: string): string[] {
	const normalized = typeof text === "string" ? text : "";
	if (normalized === "") return [];
	const lines = normalized.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** 公共前后缀的行数（前缀 + 后缀都不重叠时才算） */
function commonEdges(a: string[], b: string[]): { prefix: number; suffix: number } {
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix += 1;
	}
	return { prefix, suffix };
}

/** LCS 表太大就不算：宁可说"不逐行对比"，也不给一份假的全量 */
function tooLarge(aLength: number, bLength: number, maxLines: number): boolean {
	return Math.min(aLength, bLength) > maxLines || aLength * bLength > maxLines * maxLines;
}

/** 中间段的 LCS 回溯，产出 del/add/same 序列 */
function diffMiddle(a: string[], b: string[]): Array<{ kind: DiffRowKind; text: string }> {
	const n = a.length;
	const m = b.length;
	// 格子表：n*m 已由调用方卡在上限内
	const table = new Uint32Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			table[i * (m + 1) + j] = a[i] === b[j]
				? table[(i + 1) * (m + 1) + (j + 1)] + 1
				: Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + (j + 1)]);
		}
	}
	const out: Array<{ kind: DiffRowKind; text: string }> = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i] });
			i += 1;
			j += 1;
		} else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + (j + 1)]) {
			out.push({ kind: "del", text: a[i] });
			i += 1;
		} else {
			out.push({ kind: "add", text: b[j] });
			j += 1;
		}
	}
	while (i < n) {
		out.push({ kind: "del", text: a[i] });
		i += 1;
	}
	while (j < m) {
		out.push({ kind: "add", text: b[j] });
		j += 1;
	}
	return out;
}

/** 成对的改动行：剥掉公共前后缀，剩下的差异区间就是行内高亮 */
function intraRanges(oldText: string, newText: string): { old: IntraRange[]; next: IntraRange[] } {
	let prefix = 0;
	while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < oldText.length - prefix &&
		suffix < newText.length - prefix &&
		oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
	) {
		suffix += 1;
	}
	const oldEnd = oldText.length - suffix;
	const newEnd = newText.length - suffix;
	return {
		old: oldEnd > prefix ? [{ s: prefix, e: oldEnd }] : [],
		next: newEnd > prefix ? [{ s: prefix, e: newEnd }] : [],
	};
}

/** 给相邻的 del/add 组配对，补上行内高亮 */
function pairIntra(rows: DiffRow[]): void {
	let index = 0;
	while (index < rows.length) {
		if (rows[index].kind !== "del") {
			index += 1;
			continue;
		}
		let delEnd = index;
		while (delEnd < rows.length && rows[delEnd].kind === "del") delEnd += 1;
		let addEnd = delEnd;
		while (addEnd < rows.length && rows[addEnd].kind === "add") addEnd += 1;
		const pairs = Math.min(delEnd - index, addEnd - delEnd);
		for (let offset = 0; offset < pairs; offset += 1) {
			const del = rows[index + offset];
			const add = rows[delEnd + offset];
			const ranges = intraRanges(del.text, add.text);
			if (ranges.old.length > 0) del.intra = ranges.old;
			if (ranges.next.length > 0) add.intra = ranges.next;
		}
		index = addEnd;
	}
}

/**
 * 对比两段文本。
 *
 * too-large 时 rows 为空：调用方该退回"两段分开摆"，而不是假装对比过。
 */
export function lineDiff(
	oldText: string,
	newText: string,
	options: { maxLines?: number } = {},
): DiffResult {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	if (a.length === b.length && a.every((line, index) => line === b[index])) {
		return {
			status: "identical",
			rows: a.map((text, index) => ({ kind: "same", text, oldLine: index + 1, newLine: index + 1 })),
			added: 0,
			removed: 0,
		};
	}
	const { prefix, suffix } = commonEdges(a, b);
	const aMiddle = a.slice(prefix, a.length - suffix);
	const bMiddle = b.slice(prefix, b.length - suffix);
	if (tooLarge(aMiddle.length, bMiddle.length, options.maxLines ?? DEFAULT_MAX_LINES)) {
		return { status: "too-large", rows: [], added: bMiddle.length, removed: aMiddle.length };
	}

	const rows: DiffRow[] = [];
	for (let index = 0; index < prefix; index += 1) {
		rows.push({ kind: "same", text: a[index], oldLine: index + 1, newLine: index + 1 });
	}
	let oldLine = prefix + 1;
	let newLine = prefix + 1;
	let added = 0;
	let removed = 0;
	for (const entry of diffMiddle(aMiddle, bMiddle)) {
		if (entry.kind === "same") {
			rows.push({ kind: "same", text: entry.text, oldLine, newLine });
			oldLine += 1;
			newLine += 1;
		} else if (entry.kind === "del") {
			rows.push({ kind: "del", text: entry.text, oldLine });
			oldLine += 1;
			removed += 1;
		} else {
			rows.push({ kind: "add", text: entry.text, newLine });
			newLine += 1;
			added += 1;
		}
	}
	for (let index = suffix; index > 0; index -= 1) {
		rows.push({ kind: "same", text: a[a.length - index], oldLine: oldLine++, newLine: newLine++ });
	}
	pairIntra(rows);
	return { status: "ok", rows, added, removed };
}

export type DiffBlock = { type: "rows"; rows: DiffRow[] } | { type: "gap"; count: number };

/**
 * 只留改动附近 context 行，其余折成 gap。
 * 没变的部分不占审核窗的地方，改动在哪一眼就能定位。
 */
export function collapseContext(rows: DiffRow[], context = 3): DiffBlock[] {
	const keep = new Array(rows.length).fill(false);
	rows.forEach((row, index) => {
		if (row.kind === "same") return;
		for (let offset = Math.max(0, index - context); offset <= Math.min(rows.length - 1, index + context); offset += 1) {
			keep[offset] = true;
		}
	});
	const blocks: DiffBlock[] = [];
	let index = 0;
	while (index < rows.length) {
		if (keep[index]) {
			const start = index;
			while (index < rows.length && keep[index]) index += 1;
			blocks.push({ type: "rows", rows: rows.slice(start, index) });
		} else {
			const start = index;
			while (index < rows.length && !keep[index]) index += 1;
			blocks.push({ type: "gap", count: index - start });
		}
	}
	return blocks;
}
