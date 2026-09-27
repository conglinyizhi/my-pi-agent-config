// thinking-fold/detector.ts — thinking 块内「复读段」检测核心
//
// 纯逻辑，不依赖 pi API，便于离线回放校准与单测。
//
// ── 与 loop-guard 的分工 ────────────────────────────────────────
// loop-guard/detector.ts 判的是「整块失控」：字母表极小 + 没有新内容，
// 命中后可以在流式阶段中止生成。这里的形态更轻：模型在超长会话里
// 会退化成复读（「好。/ 执行。/ Output.」反复几十上百次），但自己还能
// 继续出 toolCall、任务照常推进，所以不该中止生成，只需要在渲染层
// 把复读段折起来，别占满屏幕。两块检测的输入都走同一套行归一化
// （复用 loop-guard 的 normalizeLine / hasSubstance），避免两份口径漂移。
//
// ── 为什么不是「只折尾巴」 ────────────────────────────────────
// 真会话里模型经常复读一段后自己恢复，继续写正事，复读段因此落在块中间。
// 只认「尾部后缀」会整段漏掉。所以这里按段判：块内每个合格的复读段都
// 单独折，段与段之间的内容原样保留。
//
// ── 算法 ──────────────────────────────────────────────────────
// 1. 逐行归一化，只保留「非空且有实义字符」的行，并记住原始行号
// 2. 统计整块每行的出现次数：
//    出现 ≥ minCount 次、且长度 ≤ maxLineLen 的行算「复读行」
//    整块最常见行的出现次数不到 maxTopCount → 根本没复读，直接放过
// 3. 复读行聚成区间：区间内允许夹 ≤ gapMax 个连续非复读行（循环里夹的
//    变化词），夹不下就断开，下一段从下一个复读行重新起头
// 4. 每个区间套规模 / 密度判据：行数 ≥ minLines、字符数 ≥ minChars、
//    段内复读行种类 ≤ maxKinds、复读字符占比 ≥ minDensity。
//    区间天然对齐在复读行上（起于第一个、止于最后一个），段外的正常内容
//    一行都不吞 —— 实测这道对齐把「整块折光」从 17 次降到 0
// 5. 段与段之间的内容由调用方（applyFold）原样保留
//
// 复杂度 O(n)：一次线性扫描切段，每段只扫一遍算统计；top 排序只在
// 复读行种类 ≤ maxKinds 时才做，代价与块长无关。

import { hasSubstance, normalizeLine } from "../loop-guard/detector.ts";

/** 命中的复读段（一个块里可能有多段） */
export interface DupSegment {
	/** 段第一行在原始 text.split("\n") 里的下标（不是有效行下标） */
	startLine: number;
	/** 段最后一行（含）之后的原始行下标：用于按行 splice，[startLine, endLine) 即被折掉的行 */
	endLine: number;
	/** 段内的有效行数（含夹在中间的非复读行） */
	lines: number;
	/** 段字符数（按归一化行长 + 1 累计） */
	chars: number;
	/** 段内复读行的种类数 */
	kinds: number;
	/** 段内出现最多的前 4 行，格式「文本 ×次数」 */
	top: string[];
}

export interface DupOptions {
	/** 一行至少出现几次才算「复读行」 */
	minCount: number;
	/** 复读行的长度上限（长行不算） */
	maxLineLen: number;
	/** 复读字符占段字符的比例下限 */
	minDensity: number;
	/** 折叠段字符下限 */
	minChars: number;
	/** 折叠段行数下限 */
	minLines: number;
	/** 折叠段内复读行种类上限 */
	maxKinds: number;
	/** 整块最常见行至少出现次数 */
	maxTopCount: number;
	/** 同一个段内允许夹的连续非复读行数上限（超过就断成两段） */
	gapMax: number;
}

export const DEFAULT_DUP_OPTIONS: DupOptions = {
	minCount: 3,
	maxLineLen: 20,
	minDensity: 0.75,
	minChars: 600,
	minLines: 40,
	maxKinds: 20,
	maxTopCount: 5,
	gapMax: 2,
};

/** 取段内出现次数最多的前 4 项，格式「文本 ×次数」 */
function topEntries(counts: Map<string, number>, limit = 4): string[] {
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([text, n]) => `${text} ×${n}`);
}

/**
 * 找 thinking 块内所有合格的复读段，按块内顺序返回（无命中返回空数组）。
 * opts 支持只给部分字段（其余用 DEFAULT_DUP_OPTIONS 补齐）。
 */
export function findDupSegments(text: string, opts: Partial<DupOptions> = {}): DupSegment[] {
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
	if (lines.length < o.minLines) return [];

	// 整块每行出现次数
	const total = new Map<string, number>();
	for (const l of lines) total.set(l, (total.get(l) ?? 0) + 1);

	let topCount = 0;
	for (const v of total.values()) if (v > topCount) topCount = v;
	if (topCount < o.maxTopCount) return [];

	// 复读行标记
	const isRepeat = new Array<boolean>(lines.length);
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		isRepeat[i] = (total.get(l) ?? 0) >= o.minCount && l.length <= o.maxLineLen;
	}

	const gapMax = Math.max(0, o.gapMax);
	const out: DupSegment[] = [];

	/** 一个范围的统计：行数 / 字符数 / 复读字符数 / 复读行种类数 */
	interface RangeStats {
		lines: number;
		chars: number;
		repeatChars: number;
		kinds: number;
	}

	const statsOf = (lo: number, hi: number): RangeStats => {
		let chars = 0;
		let repeatChars = 0;
		const kinds = new Set<string>();
		for (let k = lo; k <= hi; k++) {
			const l = lines[k];
			chars += l.length + 1;
			if (isRepeat[k]) {
				repeatChars += l.length + 1;
				kinds.add(l);
			}
		}
		return { lines: hi - lo + 1, chars, repeatChars, kinds: kinds.size };
	};

	/** 段内复读行的出现次数（只在最终落地时算一次） */
	const countsOf = (lo: number, hi: number): Map<string, number> => {
		const counts = new Map<string, number>();
		for (let k = lo; k <= hi; k++) {
			if (!isRepeat[k]) continue;
			const l = lines[k];
			counts.set(l, (counts.get(l) ?? 0) + 1);
		}
		return counts;
	};

	/** 全部判据：行数 ≥ minLines、字符数 ≥ minChars、复读种类 ≤ maxKinds、复读字符占比 ≥ minDensity */
	const fits = (st: RangeStats): boolean =>
		st.lines >= o.minLines &&
		st.chars >= o.minChars &&
		st.kinds <= o.maxKinds &&
		st.repeatChars / st.chars >= o.minDensity;

	/** 只看密度与种类（扫描中途用：规模还没长够不算否决） */
	const dense = (st: RangeStats): boolean =>
		st.kinds <= o.maxKinds && st.repeatChars / st.chars >= o.minDensity;

	/**
	 * 落盘：两端对齐到复读行（段外的正常内容一行不吞），对齐后再复核规模。
	 * 返回实际落地（对齐后）的区间，没落地返回 null。
	 */
	const push = (lo: number, hi: number): { lo: number; hi: number } | null => {
		let s = lo;
		while (s <= hi && !isRepeat[s]) s++;
		let e = hi;
		while (e >= s && !isRepeat[e]) e--;
		if (s > e) return null;
		const st = statsOf(s, e);
		if (st.lines < o.minLines || st.chars < o.minChars) return null;
		const counts = countsOf(s, e);
		out.push({
			startLine: validIdx[s],
			endLine: validIdx[e] + 1,
			lines: st.lines,
			chars: st.chars,
			kinds: counts.size,
			top: topEntries(counts),
		});
		return { lo: s, hi: e };
	};

	/**
	 * 在 [lo, hi] 里找最长的合格后缀，返回左端点（找不到返回 -1）。
	 * 这一步是给「稀头密尾」的区间兜底：整段密度不够，但尾巴那截够 ——
	 * 老版本从尾往前扫就是这个语义，不能因为切段变细把它丢了。
	 */
	const widestSuffix = (lo: number, hi: number): number => {
		const kinds = new Set<string>();
		let chars = 0;
		let repeatChars = 0;
		let best = -1;
		for (let i = hi; i >= lo; i--) {
			const l = lines[i];
			chars += l.length + 1;
			if (isRepeat[i]) {
				repeatChars += l.length + 1;
				kinds.add(l);
			}
			const st: RangeStats = { lines: hi - i + 1, chars, repeatChars, kinds: kinds.size };
			if (dense(st) && st.chars >= o.minChars && st.lines >= o.minLines) best = i; // 继续往左，最后留下最长的那截
		}
		return best;
	};

	/** 对称地找最长合格前缀（密头稀尾的兜底），返回右端点 */
	const widestPrefix = (lo: number, hi: number): number => {
		const kinds = new Set<string>();
		let chars = 0;
		let repeatChars = 0;
		let best = -1;
		for (let i = lo; i <= hi; i++) {
			const l = lines[i];
			chars += l.length + 1;
			if (isRepeat[i]) {
				repeatChars += l.length + 1;
				kinds.add(l);
			}
			const st: RangeStats = { lines: i - lo + 1, chars, repeatChars, kinds: kinds.size };
			if (dense(st) && st.chars >= o.minChars && st.lines >= o.minLines) best = i;
		}
		return best;
	};

	/**
	 * 处理一个复读区间：整段合格就直接折；不合格就退一步，取最长合格后缀 /
	 * 前缀里更长的那截，剩下的一侧再递归。
	 * 每落地一段至少吃掉 minLines 行，递归深度有限。
	 * 返回本区间里有没有折到东西。
	 */
	const scan = (lo: number, hi: number): boolean => {
		if (hi - lo + 1 < o.minLines) return false;
		if (fits(statsOf(lo, hi))) {
			push(lo, hi);
			return true;
		}
		const suffix = widestSuffix(lo, hi);
		const prefix = widestPrefix(lo, hi);
		let pickLo = -1;
		let pickHi = -1;
		if (suffix >= 0) {
			pickLo = suffix;
			pickHi = hi;
		}
		if (prefix >= 0 && (pickLo < 0 || statsOf(lo, prefix).chars > statsOf(pickLo, pickHi).chars)) {
			pickLo = lo;
			pickHi = prefix;
		}
		if (pickLo < 0) return false;
		const landed = push(pickLo, pickHi);
		if (!landed) return false;
		scan(lo, landed.lo - 1);
		scan(landed.hi + 1, hi);
		return true;
	};

	// 复读行聚成区间：区间内允许 ≤ gapMax 个连续非复读行，超了就断开
	const intervals: Array<{ lo: number; hi: number }> = [];
	let i = 0;
	while (i < lines.length) {
		if (!isRepeat[i]) {
			i++;
			continue;
		}
		let last = i;
		let j = i + 1;
		let gap = 0;
		while (j < lines.length) {
			if (isRepeat[j]) {
				last = j;
				gap = 0;
				j++;
				continue;
			}
			gap++;
			if (gap > gapMax) break;
			j++;
		}
		// [i, last] 两端都落在复读行上，段外内容不吞
		intervals.push({ lo: i, hi: last });
		i = last + 1;
	}

	const folded = intervals.map((it) => scan(it.lo, it.hi));

	// 兜底：相邻区间各自都太小（够不着 minLines / minChars）时，允许跨间隙合并。
	// 合并后仍要过全部判据 —— 密度那条会把大段正常内容挡在外面，所以合并不等于
	// 放纵：它只救「两截密集复读被几行变化词隔开、各自差一点」的形态。
	for (let k = 0; k < intervals.length; k++) {
		if (folded[k]) continue;
		let end = k;
		for (let m = k + 1; m < intervals.length && !folded[m]; m++) {
			if (!fits(statsOf(intervals[k].lo, intervals[m].hi))) break;
			end = m;
		}
		if (end === k) continue;
		if (!push(intervals[k].lo, intervals[end].hi)) continue;
		for (let m = k; m <= end; m++) folded[m] = true;
		k = end;
	}

	return out.sort((a, b) => a.startLine - b.startLine);
}
