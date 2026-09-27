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

/** 命中来自哪一档：default=现行判据；pure=附加的「极纯循环」提前中止档 */
export type LoopTier = "default" | "pure";

export interface LoopHit {
	severity: LoopSeverity;
	/** 命中来自哪一档（缺省按 default 读） */
	tier?: LoopTier;
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
	// ── 极纯档（附加的提前中止档）──────────────────────────────
	// 极纯循环的形态与现行判据完全同族，只是三条闸都拧到最紧：
	// 字母表 ≤ 3、平均行长 ≤ 5、新行占比 ≤ 0.05。形态这么纯时没必要等到
	// abortRepeatChars 才动手，可以把中止线压到 pureRepeatChars；
	// 但「块尾命中」会白付一次 abort，所以再要求持续确认 pureConfirmChars。
	// 关掉（false）后行为与旧版一字不差。
	/** 极纯档总开关 */
	pureEnabled: boolean;
	/** 极纯档：形态成立且重复字符达这个量进入 armed（持续确认开始） */
	pureRepeatChars: number;
	/** 极纯档：armed 后还要再重复积累这么多字符才真中止 */
	pureConfirmChars: number;
	/** 极纯档形态：重复字母表上限 */
	pureMaxAlphabet: number;
	/** 极纯档形态：重复行平均行长上限 */
	pureMaxAvgLineChars: number;
	/** 极纯档形态：窗口内新行占比上限 */
	pureMaxIntruderRatio: number;
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
	pureEnabled: true,
	pureRepeatChars: 2000,
	pureConfirmChars: 800,
	pureMaxAlphabet: 3,
	pureMaxAvgLineChars: 5,
	pureMaxIntruderRatio: 0.05,
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
 * 极纯档的形态判据（三条同时成立）：
 *   字母表 ≤ pureMaxAlphabet ∧ 重复行平均行长 ≤ pureMaxAvgLineChars
 *   ∧ 窗口内新行占比 ≤ pureMaxIntruderRatio
 *
 * 另外保留现行档同一条底线「主导重复行要有实义字符」：纯符号行
 * （} ``` │ ──┬──）在正常代码、表格、ASCII 图里天然重复，不能当停滞证据。
 *
 * 注：窗口统计在字母表超过 maxAlphabet 时直接不成立（windowStats 返回 null），
 * 所以极纯档实际能看到的字母表上限是 min(pureMaxAlphabet, maxAlphabet)。
 */
export function isPureShape(st: WindowStats, opts: LoopGuardOptions): boolean {
	if (st.alphabet > Math.min(opts.pureMaxAlphabet, opts.maxAlphabet)) return false;
	if (st.avgLineChars > opts.pureMaxAvgLineChars) return false;
	if (st.intruderRatio > opts.pureMaxIntruderRatio) return false;
	return hasSubstance(st.dominant);
}

/**
 * 极纯档状态机：idle → armed →（持续确认）→ fire。
 *
 * armed 是干嘛的：极纯形态在块尾也会成立 —— 模型刚开始重复几百字符、块就结束了。
 * 那时动手等于白付一次 abort 加一条约 4000 字符的纠正消息。实测 9 次命中里有 2 次
 * 命中点之后只剩 432 / 437 字符，拦下来纯亏。所以形态成立且重复量过线时先只记下
 * armed 位置，要求再重复积累 pureConfirmChars 仍满足形态，才认为是真循环。
 *
 * 形态中断（字母表变大 / 新行占比回升）立即解除 armed；块结束（模型自己收尾、
 * 生成结束）由调用方 reset() 丢弃，不 fire。
 *
 * 独立成类是为了让离线校准脚本用同一份状态机（scripts/loop-guard-candidate-calib.mjs），
 * 不必再抄一遍逻辑。
 */
export class PureTier {
	private armed = false;
	private armedRepeatChars = 0;
	/** 一个块最多 fire 一次：fire 后不再 arm，直到 reset() */
	private fired = false;
	/** 本块进入 armed 的次数（观测/校准用） */
	private armEvents = 0;

	/** 是否正处于「已 armed、等持续确认」 */
	get isArmed(): boolean {
		return this.armed;
	}

	/** armed 时的重复字符数（未 armed 返回 0） */
	get armedAtChars(): number {
		return this.armed ? this.armedRepeatChars : 0;
	}

	/** 本块进入 armed 的次数 */
	get armCount(): number {
		return this.armEvents;
	}

	reset(): void {
		this.armed = false;
		this.armedRepeatChars = 0;
		this.fired = false;
		this.armEvents = 0;
	}

	/**
	 * 每个检查点喂一次窗口统计，返回 true 表示持续确认期满、可以中止。
	 * st 为 null（窗口统计不成立）等同于形态不成立，会解除 armed。
	 */
	tick(st: WindowStats | null, opts: LoopGuardOptions): boolean {
		if (this.fired || !opts.pureEnabled || !st || !isPureShape(st, opts)) {
			this.armed = false;
			return false;
		}
		if (!this.armed) {
			if (st.repeatChars < opts.pureRepeatChars) return false;
			this.armed = true;
			this.armedRepeatChars = st.repeatChars;
			this.armEvents += 1;
		}
		// 「再重复积累」按重复字符数算（与 pureRepeatChars 同单位），
		// 不按喂入字符数：一行「好。」带换行喂进去是 3 字符、重复量只算 2。
		if (st.repeatChars - this.armedRepeatChars < opts.pureConfirmChars) return false;
		this.armed = false;
		this.fired = true;
		return true;
	}
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
	/** 极纯档状态机（与现行判据共用同一个窗口、同一批检查点） */
	private pure = new PureTier();

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
		this.pure.reset();
	}

	get fedChars(): number {
		return this.fed;
	}

	/** 本块是否已经报过 */
	get alreadyFired(): boolean {
		return this.fired;
	}

	/** 极纯档是否处于「已 armed、等持续确认」 */
	get pureArmed(): boolean {
		return this.pure.isArmed;
	}

	/** 极纯档 armed 时的重复字符数（未 armed 返回 0） */
	get pureArmedAtChars(): number {
		return this.pure.armedAtChars;
	}

	/** 本块极纯档进入 armed 的次数 */
	get pureArmCount(): number {
		return this.pure.armCount;
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
		// 极纯档先看一眼：形态成立时它的中止线比现行 abort 早得多，两档取先到者。
		// st 为 null 时也要 tick，好让形态中断解除 armed。
		const pureFire = this.pure.tick(st, this.opts);
		if (!st) return null;
		if (pureFire) {
			this.fired = true;
			return this.buildHit("abort", st, "pure");
		}
		// 现行档：判据与触发时机一字未动，只是可能被上面更早的极纯档抢在前头
		const severity = judgeStats(st, this.opts);
		if (!severity) return null;
		this.fired = true;
		return this.buildHit(severity, st, "default");
	}

	private buildHit(severity: LoopSeverity, st: WindowStats, tier: LoopTier): LoopHit {
		// 置信度按本档自己的参考跨度归一：极纯档的线本来就低，别拿 9000 去比
		const refSpan =
			tier === "pure" ? this.opts.pureRepeatChars + this.opts.pureConfirmChars : this.opts.abortRepeatChars;
		const spanScore = Math.min(1, st.repeatChars / (Math.max(1, refSpan) * 2));
		const alphaScore = 1 - st.alphabet / (this.opts.maxAlphabet + 1);
		return {
			severity,
			tier,
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
