// loop-guard/detector.ts — 重复输出（死循环）检测核心
//
// 纯逻辑状态机，不依赖 pi API，便于离线回放校准与单测。
//
// ── 要抓的东西 ────────────────────────────────────────────────
// 模型在 CoT 或正文里陷入停滞态：同几句短话反复输出，直到撞上 token 上限。
// 形态是「字母表极小 + 行很短 + 没有任何新内容」，例如
//   好。 / 做。 / （输出） 反复几万字符。
//
// ── 要避开的误伤（实测语料：408 个 session，13.3 万个输出块）───────
// 有几类输出天然带重复，绝不能掐：
//   1. 工具输出回显：tar 的 158 条同款警告（平均行长 31）、CI 矩阵日志
//      （平均 19.5、且每隔十来行就冒一条新的 job 头）、logcat、hexdump、
//      bc 缺失报错刷屏（平均 28.5）、50KB 单行源码回显（平均 2.5 万）
//   2. 表格 / 代码 / ASCII 图：纯符号行（} ``` │ ──┬──）
//   3. 正常排版：少量重复行散落在大量新内容之间
//
// 校准结论（真循环平均行长 2.4~12.3，最快出现的误伤样本 19.5）：
// 用两个互相独立的判据同时把关 ——
//   判据一「行要短」：停滞标记都是短句，日志正文整行长
//   判据二「不许有新内容」：停滞时几乎没有新行，
//     而回显日志每隔几行就有变化的 job 头/文件名
// 两个判据任一不满足就放过。再加「符号行不算重复」「跨度下限」兜底。

/** 判定级别：warn=只提示；abort=证据充分，可中止当前输出 */
export type LoopSeverity = "warn" | "abort";

export interface LoopHit {
	severity: LoopSeverity;
	/** 触发时已喂入的字符数 */
	offset: number;
	/** 重复内容字符数 */
	repeatChars: number;
	/** 重复内容行数 */
	repeatLines: number;
	/** 窗口内不同行数（字母表） */
	alphabet: number;
	/** 重复行平均行长 */
	avgLineChars: number;
	/** 窗口内「新行」占比 */
	intruderRatio: number;
	/** 出现最多的那一行（截断 80 字） */
	sample: string;
	/** 字母表前几项，便于人快速判读 */
	samples: string[];
	/** 自评置信度 0..1 */
	confidence: number;
}

export interface LoopGuardOptions {
	/** 保留的已解析行数上限 */
	maxLines: number;
	/** 保留的字符数上限（按行边界裁剪） */
	maxBufferChars: number;
	/** 每积累多少字符判定一次 */
	checkEveryChars: number;
	/** 确定「字母表」用的尾部行数 */
	alphabetLines: number;
	/** 字母表上限：超过就不算停滞 */
	maxAlphabet: number;
	/** 重复行数下限 */
	minRepeatLines: number;
	/** warn 级重复字符下限 */
	warnRepeatChars: number;
	/** abort 级重复字符下限 */
	abortRepeatChars: number;
	/** 判据一：重复行平均行长上限（停滞标记都很短） */
	maxAvgLineChars: number;
	/** 单行超过这个长度算「长行」 */
	longLineChars: number;
	/** 重复行里长行占比上限：堆了太多长行就不是停滞标记，是日志正文 */
	maxLongLineRatio: number;
	/** 判据二：窗口内「不在字母表里的新行」占比上限 */
	maxIntruderRatio: number;
	/** 补充判据：长句停滞（字母表极小 + 重复量极大），只 warn */
	longStallRepeatChars: number;
	longStallMaxAlphabet: number;
	longStallMaxAvgLineChars: number;
}

export const DEFAULT_OPTIONS: LoopGuardOptions = {
	maxLines: 8000,
	maxBufferChars: 49152,
	checkEveryChars: 400,
	alphabetLines: 150,
	maxAlphabet: 10,
	minRepeatLines: 60,
	warnRepeatChars: 2500,
	abortRepeatChars: 9000,
	maxAvgLineChars: 20,
	longLineChars: 32,
	maxLongLineRatio: 0.2,
	maxIntruderRatio: 0.3,
	longStallRepeatChars: 25000,
	longStallMaxAlphabet: 4,
	longStallMaxAvgLineChars: 40,
};

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu;
const ALNUM_RE = /[0-9A-Za-z]/g;

/**
 * 归一化一行用于比较：
 * - 去掉行首的列表/序号/引用标记（- 、1. 、> 之类）
 * - 削掉首尾的 markdown 装饰符（成对 * _ ` ~），保留行内的
 * - 折叠内部空白
 */
export function normalizeLine(raw: string): string {
	let s = raw.trim();
	for (let i = 0; i < 4; i++) {
		const next = s.replace(/^(?:[-*>+]|\d+[.)]|\(\d+\))\s+/, "");
		if (next === s) break;
		s = next;
	}
	s = s.replace(/^[*_`~]+/, "").replace(/[*_`~]+$/, "");
	return s.replace(/\s+/g, " ").trim();
}

/**
 * 一行是否「有内容」。
 * 纯符号/装饰行（} ``` │ ──┬── 分隔线）以及只有一两个字符的行
 * （0, | ）不算：正常代码、表格、ASCII 图、数据 fixture 里这类行
 * 天然重复，不能当停滞证据。
 * 代价：真在 `{"a":1},` 这种行上死循环时抓不到（字符数太少）。
 */
export function hasSubstance(line: string): boolean {
	const dense = line.replace(/\s+/g, "");
	if (dense.length === 0) return false;
	if ((dense.match(CJK_RE)?.length ?? 0) >= 1) return true;
	return (dense.match(ALNUM_RE)?.length ?? 0) >= 3;
}

export interface WindowStats {
	/** 窗口内非空行总数 */
	totalLines: number;
	/** 不同行数（字母表大小） */
	alphabet: number;
	/** 落在字母表里的行数 */
	repeatLines: number;
	/** 落在字母表里的行字符数 */
	repeatChars: number;
	/** 重复行平均行长 */
	avgLineChars: number;
	/** 重复行里长行占比 */
	longLineRatio: number;
	/** 不在字母表里的「新行」占比 */
	intruderRatio: number;
	/** 出现最多的重复行 */
	dominant: string;
	/** 重复行按出现次数排序的前几项 */
	samples: string[];
}

/**
 * 对一个行窗口求「重复质量」。
 * 字母表由尾部 alphabetLines 行决定；窗口里落在字母表内的行算重复内容，
 * 其余算新内容（intruder）。
 */
export function windowStats(lines: string[], opts: LoopGuardOptions): WindowStats | null {
	if (lines.length === 0) return null;
	const tail = lines.slice(Math.max(0, lines.length - opts.alphabetLines));
	const alphabet = new Set(tail);
	if (alphabet.size === 0 || alphabet.size > opts.maxAlphabet) return null;

	const counts = new Map<string, number>();
	let repeatLines = 0;
	let repeatChars = 0;
	let long = 0;
	for (const l of lines) {
		if (alphabet.has(l)) {
			counts.set(l, (counts.get(l) ?? 0) + 1);
			repeatLines += 1;
			repeatChars += l.length;
			if (l.length > opts.longLineChars) long += 1;
		}
	}
	if (repeatLines === 0) return null;

	let dominant = "";
	let best = 0;
	for (const [k, v] of counts) {
		if (v > best) {
			best = v;
			dominant = k;
		}
	}
	return {
		totalLines: lines.length,
		alphabet: alphabet.size,
		repeatLines,
		repeatChars,
		avgLineChars: repeatChars / repeatLines,
		longLineRatio: long / repeatLines,
		intruderRatio: (lines.length - repeatLines) / lines.length,
		dominant,
		samples: [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 4)
			.map(([k]) => k),
	};
}

/** 把 WindowStats 判成命中级别（导出便于单测） */
export function judgeStats(st: WindowStats, opts: LoopGuardOptions): LoopSeverity | null {
	if (st.repeatLines < opts.minRepeatLines) return null;
	if (!hasSubstance(st.dominant)) return null;

	// 两个独立判据同时成立才算停滞
	const shortLines =
		st.avgLineChars <= opts.maxAvgLineChars && st.longLineRatio <= opts.maxLongLineRatio;
	const noNewContent = st.intruderRatio <= opts.maxIntruderRatio;
	if (shortLines && noNewContent) {
		if (st.repeatChars >= opts.abortRepeatChars) return "abort";
		if (st.repeatChars >= opts.warnRepeatChars) return "warn";
	}

	// 补充判据：字母表极小的长句停滞。只 warn，不 abort。
	if (
		noNewContent &&
		st.repeatChars >= opts.longStallRepeatChars &&
		st.alphabet <= opts.longStallMaxAlphabet &&
		st.avgLineChars <= opts.longStallMaxAvgLineChars
	) {
		return "warn";
	}
	return null;
}

/**
 * 流式检测器：喂入增量文本，命中时返回 LoopHit。
 * 一个实例对应一个输出块（thinking 或正文），块结束调用 reset()。
 */
export class LoopDetector {
	private opts: LoopGuardOptions;
	/** 已解析的完整行（归一化、去空行） */
	private lines: string[] = [];
	private keptChars = 0;
	/** 尚未收尾的当前行 */
	private partial = "";
	private fed = 0;
	private sinceCheck = 0;
	private fired = false;

	constructor(opts: Partial<LoopGuardOptions> = {}) {
		this.opts = { ...DEFAULT_OPTIONS, ...opts };
	}

	reset(): void {
		this.lines = [];
		this.keptChars = 0;
		this.partial = "";
		this.fed = 0;
		this.sinceCheck = 0;
		this.fired = false;
	}

	get fedChars(): number {
		return this.fed;
	}

	/** 本块是否已经报过 */
	get alreadyFired(): boolean {
		return this.fired;
	}

	feed(delta: string): LoopHit | null {
		if (!delta) return null;
		this.fed += delta.length;
		this.sinceCheck += delta.length;

		const parts = (this.partial + delta).split("\n");
		this.partial = parts.pop() ?? "";
		for (const p of parts) {
			const nl = normalizeLine(p);
			if (nl !== "") {
				this.lines.push(nl);
				this.keptChars += nl.length + 1;
			}
		}
		this.trim();
		if (this.sinceCheck < this.opts.checkEveryChars) return null;
		this.sinceCheck = 0;
		return this.check();
	}

	/** 立即判定一次 */
	check(): LoopHit | null {
		const st = windowStats(this.lines, this.opts);
		if (!st) return null;
		const severity = judgeStats(st, this.opts);
		if (!severity) return null;
		this.fired = true;
		const spanScore = Math.min(1, st.repeatChars / (this.opts.abortRepeatChars * 2));
		const alphaScore = 1 - st.alphabet / (this.opts.maxAlphabet + 1);
		return {
			severity,
			offset: this.fed,
			repeatChars: st.repeatChars,
			repeatLines: st.repeatLines,
			alphabet: st.alphabet,
			avgLineChars: +st.avgLineChars.toFixed(1),
			intruderRatio: +st.intruderRatio.toFixed(3),
			sample: st.dominant.slice(0, 80),
			samples: st.samples.map((s) => s.slice(0, 40)),
			confidence: +Math.min(1, 0.5 * spanScore + 0.5 * alphaScore).toFixed(3),
		};
	}

	/** 按行数 / 字符数上限裁剪窗口 */
	private trim(): void {
		const over = this.lines.length - this.opts.maxLines;
		if (over > 0) {
			for (let i = 0; i < over; i++) this.keptChars -= this.lines[i].length + 1;
			this.lines.splice(0, over);
		}
		while (this.keptChars > this.opts.maxBufferChars && this.lines.length > 1) {
			this.keptChars -= this.lines[0].length + 1;
			this.lines.shift();
		}
	}
}
