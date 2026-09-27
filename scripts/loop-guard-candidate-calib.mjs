#!/usr/bin/env node
// loop-guard「极纯循环」档 离线校准
//
// 校准对象：现行判据之外附加的那一档「极纯循环」提前中止（detector.ts 的 PureTier）——
//   形态：字母表 ≤ 3 种  ∧  重复行平均行长 ≤ 5 字符  ∧  窗口内新行占比 ≤ 0.05
//   起始线：形态成立且重复字符 ≥ pureRepeatChars（默认 2000）→ armed
//   持续确认：armed 后再重复积累 ≥ pureConfirmChars 仍满足形态 → 真 abort；
//             期间块结束（模型自己收尾 / 生成结束）则静默放弃，不 abort
//
// 产出：
//  1) 现行判据 vs 候选判据的历史对比（保留口径，供回归对账）
//  2) 极纯档 confirmChars 扫描表：命中块数 / 真 abort 次数 / 被确认期挡下的次数
//     （= armed 了但块结束或形态中断，没动手的那些）
//  3) 逐例证据（每个会 fire 的块：armed 点、fire 点、剩余字符、现行档会不会拦）
//  4) 逐会话真 abort 次数（定 maxActionsPerSession 的依据）
//  5) 误伤对账：text / toolResult 两个对照组在极纯档下仍然零命中
//  6) 校验：mirror 的极纯状态机与真 LoopDetector 并行 replay 逐检查点比对
//
// 跑法：
//   node --experimental-strip-types scripts/loop-guard-candidate-calib.mjs \
//     --root=/home/clyzhi/.pi/agent/sessions --limit=0 --chunk=8 \
//     --pure-confirm=0,400,800,1200,2000
//
// 实现要点：
// - 逐文件流式读（readline），逐块 replay；不把 sessions 读进内存
// - 预筛：块内「字符总量最大的 3 / 10 种行」的字符和是 repeatChars 的健全上界，
//   上界不足者不必 replay；跳过的块由 --audit 抽样用真 LoopDetector 复核
// - 主判据由 mirror 复刻 LoopDetector 的缓冲/裁剪/节流（同一窗口、同一检查点）；
//   极纯档直接复用 detector.ts 导出的 PureTier（同一份状态机，不另抄一遍）
// - 并行校验：现行档的比对用 pureEnabled=false 的真 LoopDetector；
//   极纯档每个 confirm 值再各起一个真 LoopDetector，逐检查点比对首次 fire
// - 另有一份锚：会话里真实发生过的 loop-guard 注入记录（custom_message），
//   与离线 replay 的 abort 次数对账

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
	LoopDetector,
	DEFAULT_OPTIONS,
	PureTier,
	isPureShape,
	windowStats,
	judgeStats,
	normalizeLine,
	hasSubstance,
} from "../extensions/loop-guard/detector.ts";

// ── 参数 ────────────────────────────────────────────────────────
const DEFAULTS = {
	root: "/home/clyzhi/.pi/agent/sessions",
	/** 0 = 全量；>0 = 只跑前 N 个会话文件 */
	limit: 0,
	/** replay 喂入的 delta 粒度（字符）。真机 delta 多为 1~4 字符，8 已足够贴近 */
	chunk: 8,
	/** 主扫描的块类型 */
	kinds: "thinking,text",
	/** 是否单独扫 toolResult 通道 */
	toolresult: true,
	/** 候选档主阈值（出逐例证据的那一档） */
	candChars: 2000,
	/** 候选档形态 */
	candAlphabet: 3,
	candAvg: 5,
	candIntruder: 0.05,
	/** 阈值扫描：决策曲线用 */
	candLines: "1200,1500,2000,2500,3000",
	// ── 极纯档（本体里新加的那一档附加提前中止）──
	/** 极纯形态的重复字符起始线 */
	pureRepeatChars: 2000,
	/** 极纯档形态 */
	pureAlphabet: 3,
	pureAvg: 5,
	pureIntruder: 0.05,
	/** 持续确认量的扫描表（出决策曲线；0 = armed 当拍就动手） */
	pureConfirm: "0,400,800,1200,2000",
	/** 出逐例证据、定 maxActionsPerSession 用的主档 */
	purePrimary: 800,
	/** 「近失」记录门槛：候选形态成立但没到最低候选线，重复字符达到这个值就记一笔 */
	nearChars: 800,
	nearKeep: 40,
	/** 证据落盘路径 */
	evidence: "/tmp/loop-guard-candidate-evidence.json",
	maxEvidence: 200,
	/** 前 N 个文件跑真 LoopDetector 并行校验 */
	fidelityFiles: 60,
	/** 预筛跳过的块里抽查多少个复核 */
	audit: 300,
	/** 抽查步长：每 K 个被预筛跳过的块复核一次 */
	auditStride: 337,
	/** 只处理文件名含该子串的会话（调试用） */
	grep: "",
};

function parseArgs(argv) {
	const o = { ...DEFAULTS };
	for (const a of argv) {
		const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a);
		if (!m) continue;
		const k = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		if (!(k in o)) {
			console.error(`未知参数：--${m[1]}`);
			process.exit(2);
		}
		const v = m[2] ?? "true";
		o[k] = typeof DEFAULTS[k] === "number" ? Number(v) : v === "false" ? false : v;
	}
	o.candLines = String(o.candLines)
		.split(",")
		.map((s) => Number(s.trim()))
		.filter((n) => Number.isFinite(n) && n > 0)
		.sort((a, b) => a - b);
	o.pureConfirm = String(o.pureConfirm)
		.split(",")
		.map((s) => Number(s.trim()))
		.filter((n) => Number.isFinite(n) && n >= 0)
		.sort((a, b) => a - b);
	return o;
}

const o = parseArgs(process.argv.slice(2));
const KINDS = o.kinds.split(",").map((s) => s.trim()).filter(Boolean);
const T = o.candLines;
/** confirm 扫描表 */
const PC = o.pureConfirm;
/** 出逐例证据的主档（不在扫描表里就补进去） */
const PPRIMARY = PC.includes(o.purePrimary) ? o.purePrimary : PC[0];

/** 极纯档的 detector 选项：形态与起始线固定，只换确认量 */
function pureOpts(confirm) {
	return {
		...DEFAULT_OPTIONS,
		pureEnabled: true,
		pureRepeatChars: o.pureRepeatChars,
		pureConfirmChars: confirm,
		pureMaxAlphabet: o.pureAlphabet,
		pureMaxAvgLineChars: o.pureAvg,
		pureMaxIntruderRatio: o.pureIntruder,
	};
}

// ── 小工具 ──────────────────────────────────────────────────────
function walk(dir) {
	let out = [];
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out = out.concat(walk(p));
		else if (e.name.endsWith(".jsonl")) out.push(p);
	}
	return out;
}

/** 逐行遍历但不构造整段 line 数组（大块内存友好） */
function forEachLine(text, cb) {
	let start = 0;
	const n = text.length;
	while (start <= n) {
		const idx = text.indexOf("\n", start);
		if (idx < 0) {
			if (start < n) cb(text.slice(start), start);
			break;
		}
		cb(text.slice(start, idx), start);
		start = idx + 1;
	}
}

const short = (s, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);
const fmt = (n) => n.toLocaleString("en-US");

// ── 候选档判据 ──────────────────────────────────────────────────
/** 形态闸：字母表 ≤3 / 平均行长 ≤5 / 新行占比 ≤0.05 */
function candShape(st) {
	return (
		st.alphabet <= o.candAlphabet &&
		st.avgLineChars <= o.candAvg &&
		st.intruderRatio <= o.candIntruder
	);
}

/** 复刻 LoopDetector 的缓冲/裁剪/节流，一次 windowStats 同时喂现行判据与候选形态 */
class Mirror {
	constructor() {
		this.opts = { ...DEFAULT_OPTIONS };
		this.reset();
	}
	reset() {
		this.lines = [];
		this.keptChars = 0;
		this.partial = "";
		this.fed = 0;
		this.sinceCheck = 0;
	}
	feed(delta) {
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
	check() {
		const st = windowStats(this.lines, this.opts);
		return { st, def: st ? judgeStats(st, this.opts) : null };
	}
	trim() {
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

/** 命中时把窗口内重复行按出现次数列出来（字母表取尾部 150 行，与 detector 一致） */
function lineDetail(lines) {
	const tail = lines.slice(Math.max(0, lines.length - DEFAULT_OPTIONS.alphabetLines));
	const alpha = new Set(tail);
	const counts = new Map();
	for (const l of lines) if (alpha.has(l)) counts.set(l, (counts.get(l) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 6)
		.map(([line, count]) => ({ line, len: line.length, count }));
}

/** 从触发点往回走，定位重复段起点，取出起点前后的原文 */
function runContext(text, off, alphaSet, backLines = 20) {
	const from = Math.max(0, off - 20000);
	const raws = text.slice(from, off).split("\n");
	// 末尾是 off 处的半行（可能是 "好" 这种没写完的），走路时跳过它
	const last = raws.length - 1;
	let i = last - 1;
	while (i >= 0) {
		const nl = normalizeLine(raws[i]);
		if (nl === "" || alphaSet.has(nl)) {
			i--;
			continue;
		}
		break;
	}
	const transition = i + 1;
	const runLines = Math.max(0, last - transition);
	const ctxStart = Math.max(0, transition - 12);
	const ctxEnd = Math.min(last, transition + 6);
	return {
		runLinesBeforeFire: runLines,
		context: raws.slice(ctxStart, ctxEnd).map((s) => short(s, 100)),
		backLines,
	};
}

// ── 统计容器 ────────────────────────────────────────────────────
const kinds = [...KINDS];
if (o.toolresult) kinds.push("toolResult");

const S = {};
for (const k of kinds) {
	S[k] = {
		blocks: 0,
		chars: 0,
		skippedSmall: 0,
		skippedByPrefilter: 0,
		replayed: 0,
		defWarn: 0,
		defAbort: 0,
		cand: 0,
		candGated: 0,
		candOnly: 0,
		overlap: 0,
		candOnlyChars: 0,
		saved: 0,
		/** 未触发一侧（该块在任何阈值都没命中）的最大形态字符数：replayed 为实测，跳过的块为上界 */
		noFireShape: { chars: 0, tag: "", exact: false },
	};
}

/** 阈值扫描：t -> { kind: {fires, gated, candOnly, candOnlyChars, saved, minFireChars} } */
const sweep = new Map();
for (const t of T) {
	const m = {};
	for (const k of kinds)
		m[k] = { fires: 0, gated: 0, candOnly: 0, candOnlyChars: 0, saved: 0, minFire: Infinity, maxNoFire: 0 };
	sweep.set(t, m);
}

const evidence = []; // 候选独有命中（按块聚合，含各阈值）
const fires = []; // 所有命中（候选或现行）
const near = []; // 近失
const fidelity = { checked: 0, mismatch: [] };
const audit = { checked: 0, mismatch: [], longest: 0 };
const liveLoop = []; // 会话里真实的 loop-guard 注入记录

// ── 极纯档统计 ──────────────────────────────────────────────────
/** PB[kind][confirm] —— 极纯档扫描统计 */
const PB = {};
for (const k of kinds) {
	PB[k] = {};
	for (const c of PC) {
		PB[k][c] = {
			/** 进入过 armed 的块数 */
			armed: 0,
			/** 真 abort 的块数（确认期满、形态仍成立） */
			fires: 0,
			/** armed 过但整块没 fire（确认期没走完 / 形态中断后没再 armed） */
			vetoed: 0,
			/** 块结束时仍停在 armed（= 贴块尾，被确认期挡下的那一类） */
			endedArmed: 0,
			/** armed 与 fire 之间被省下的字符（对比现行 abort 或块尾） */
			saved: 0,
			minArm: Infinity,
			minFire: Infinity,
			/** 未 fire 一侧观察到的最大极纯形态重复字符数（离起始线的距离） */
			maxNoFireShape: 0,
			maxNoFireTag: "",
			maxNoFireExact: false,
		};
	}
}
/** 全部极纯 fire 记录（逐会话统计用） */
const pureFires = [];
/** armed 了但没动手的记录（贴块尾白拦的逐例证据） */
const pureVetoes = [];
/** 极纯档 mirror vs 真 LoopDetector 的并行校验 */
const pureFidelity = { checked: 0, mismatch: [] };

function pushNear(rec) {
	near.push(rec);
	near.sort((a, b) => b.repeatChars - a.repeatChars);
	if (near.length > o.nearKeep) near.length = o.nearKeep;
}

/** 记「未触发一侧」的形态幅度：逐阈值记 maxNoFire，整块没命中的记 noFireShape */
function noteNoFire(kind, hitsMap, bsm) {
	for (const t of T) {
		const row = sweep.get(t)[kind];
		if (!hitsMap.has(t)) row.maxNoFire = Math.max(row.maxNoFire, bsm.chars);
	}
	if (hitsMap.size === 0) {
		const s = S[kind];
		if (bsm.chars > s.noFireShape.chars) s.noFireShape = bsm;
	}
}

// ── 单块分析 ────────────────────────────────────────────────────
let blocksSeen = 0;
function analyze(text, meta) {
	const s = S[meta.kind];
	s.blocks += 1;
	s.chars += text.length;
	blocksSeen += 1;
	if (text.length < o.candChars) {
		s.skippedSmall += 1;
		return;
	}

	// 预筛：块内字符总量最大的 3 / 10 种行的字符和（repeatChars 的健全上界）
	const counts = new Map();
	let blockLines = 0;
	forEachLine(text, (raw) => {
		const nl = normalizeLine(raw);
		if (nl === "") return;
		blockLines += 1;
		const e = counts.get(nl);
		if (e) e.n += 1;
		else counts.set(nl, { n: 1, len: nl.length });
	});
	const byChars = [...counts.values()].sort((a, b) => b.n * b.len - a.n * a.len);
	let top3 = 0;
	let top10 = 0;
	for (let i = 0; i < byChars.length; i++) {
		if (i < 3) top3 += byChars[i].n * byChars[i].len;
		if (i < 10) top10 += byChars[i].n * byChars[i].len;
	}

	const minT = T[0];
	const nearPossible = top3 >= o.nearChars;
	const defPossible = top10 >= DEFAULT_OPTIONS.warnRepeatChars;
	const candPossible = top3 >= minT;
	/** 极纯档：top3 同样是 repeatChars 的上界，够不到起始线的块不必 replay */
	const purePossible = top3 >= o.pureRepeatChars;

	if (!candPossible && !defPossible && !nearPossible && !purePossible) {
		s.skippedByPrefilter += 1;
		// top3 < nearChars，所以本块的候选形态窗口不可能达到 nearChars
		noteNoFire(meta.kind, new Map(), { chars: top3, tag: meta.tag, exact: false });
		// 抽查：预筛跳过的块用真 LoopDetector 复核，确认没漏网
		if (audit.checked < o.audit && blocksSeen % o.auditStride === 0) {
			audit.checked += 1;
			const real = new LoopDetector();
			let hit = null;
			const probe = Math.min(text.length, 200000);
			audit.longest = Math.max(audit.longest, probe);
			for (let i = 0; i < probe && !hit; i += 64) {
				const h = real.feed(text.slice(i, i + 64));
				if (h) hit = h;
			}
			if (hit) audit.mismatch.push({ tag: meta.tag, hit, top3, top10 });
		}
		return;
	}

	s.replayed += 1;
	const m = new Mirror();
	// 现行档的并行校验要用 pureEnabled=false：极纯档会提前 fire，混在一起就没法逐检查点对账
	const real = meta.fidelity ? new LoopDetector({ pureEnabled: false }) : null;
	/** 极纯档：mirror 侧每个 confirm 值一份状态机；fidelity 时另起同参数的真检测器 */
	const pures = PC.map((c) => ({ c, opts: pureOpts(c), tier: new PureTier(), arm: null, fire: null }));
	const realPures = meta.fidelity ? PC.map((c) => new LoopDetector(pureOpts(c))) : null;
	const realPureHits = meta.fidelity ? PC.map(() => null) : null;
	const hits = new Map(); // 阈值 -> {st, offset, gated, detail}
	let defWarn = null;
	let defAbort = null;
	let realWarn = null;
	let realAbort = null;
	let bestNear = null;
	let alphaSet = null;
	let blockShapeMax = { chars: 0, tag: meta.tag, exact: false };
	/** 本块在极纯形态下观察到的最大重复量（量「离极纯起始线还有多远」） */
	let pureShapeMax = { chars: 0, tag: meta.tag, exact: true };

	for (let i = 0; i < text.length; i += o.chunk) {
		const delta = text.slice(i, i + o.chunk);
		const res = m.feed(delta);
		if (real) {
			const h = real.feed(delta);
			if (h && h.severity === "warn" && !realWarn) realWarn = h;
			if (h && h.severity === "abort" && !realAbort) realAbort = h;
			if (res) {
				fidelity.checked += 1;
				const expectedSev = res.def === "abort" ? "abort" : res.def === "warn" ? "warn" : null;
				const got = h ? h.severity : null;
				const sigMismatch =
					h && res.st
						? h.repeatChars !== res.st.repeatChars ||
							h.repeatLines !== res.st.repeatLines ||
							h.alphabet !== res.st.alphabet
						: false;
				if ((expectedSev !== got || sigMismatch) && fidelity.mismatch.length < 20) {
					fidelity.mismatch.push({
						tag: meta.tag,
						offset: m.fed,
						mirror: expectedSev,
						real: got,
						mirrorRepeatChars: res.st ? res.st.repeatChars : null,
						realRepeatChars: h ? h.repeatChars : null,
					});
				}
			}
		}
		if (realPures) {
			for (let idx = 0; idx < PC.length; idx++) {
				const h = realPures[idx].feed(delta);
				if (h && h.tier === "pure" && !realPureHits[idx]) realPureHits[idx] = h;
			}
		}
		if (!res) continue;
		// 极纯档：与现行档同一批检查点、同一份窗口统计（mirror 与真检测器都只在自己节流点上判定）
		for (const p of pures) {
			const fire = p.tier.tick(res.st, p.opts);
			if (p.tier.armCount > 0 && !p.arm) {
				p.arm = { offset: m.fed, repeatChars: p.tier.isArmed ? p.tier.armedAtChars : null };
			}
			if (fire && !p.fire) p.fire = { offset: m.fed, repeatChars: res.st ? res.st.repeatChars : null, st: res.st };
			if (realPures) {
				const idx = pures.indexOf(p);
				const rp = realPures[idx];
				// 逐检查点比对状态机（armed 状态一致）+ 首次 fire 偏移一致
				const mFire = p.fire ? p.fire.offset : null;
				const rFire = realPureHits[idx] ? realPureHits[idx].offset : null;
				const sameArmed = p.tier.isArmed === rp.pureArmed;
				const sameFire = mFire !== null && rFire !== null ? mFire === rFire : mFire === null && rFire === null;
				pureFidelity.checked += 1;
				if ((!sameArmed || !sameFire) && pureFidelity.mismatch.length < 20) {
					pureFidelity.mismatch.push({
						tag: meta.tag,
						confirm: p.c,
						mirrorArmed: p.tier.isArmed,
						realArmed: rp.pureArmed,
						mirrorFire: mFire,
						realFire: rFire,
						offset: m.fed,
					});
				}
			}
		}
		if (res.st && isPureShape(res.st, pures[0].opts) && res.st.repeatChars > pureShapeMax.chars) {
			pureShapeMax = { chars: res.st.repeatChars, tag: meta.tag, exact: true };
		}
		if (!res.st) continue;
		const st = res.st;
		if (candShape(st)) {
			if (st.repeatChars > blockShapeMax.chars) blockShapeMax = { chars: st.repeatChars, tag: meta.tag, exact: true };
			for (const t of T) {
				if (!hits.has(t) && st.repeatChars >= t) {
					hits.set(t, {
						st,
						offset: m.fed,
						gated: st.repeatLines >= DEFAULT_OPTIONS.minRepeatLines && hasSubstance(st.dominant),
						detail: lineDetail(m.lines),
					});
					if (!alphaSet) alphaSet = new Set(m.lines.slice(-DEFAULT_OPTIONS.alphabetLines));
				}
			}
			if (!hits.has(minT) && (!bestNear || st.repeatChars > bestNear.st.repeatChars)) {
				bestNear = { st, offset: m.fed };
			}
		}
		if (res.def === "warn" && !defWarn) defWarn = { st, offset: m.fed };
		if (res.def === "abort" && !defAbort) defAbort = { st, offset: m.fed };

		const candDone = T.every((t) => hits.has(t) || t > top3);
		const defDone = defAbort || !defPossible;
		const wantNear = !hits.has(minT) && nearPossible;
		// 极纯档还没走完确认期的块必须看到底，不能提前收工
		const pureDone = pures.every((p) => p.fire);
		if (candDone && defDone && !wantNear && pureDone) break;
	}

	// ── 极纯档记账（与候选/现行是否命中无关，先记完再走下面的分支）──
	for (const p of pures) {
		const row = PB[meta.kind][p.c];
		const armed = p.tier.armCount > 0;
		if (armed) {
			row.armed += 1;
			row.minArm = Math.min(row.minArm, p.arm && p.arm.repeatChars != null ? p.arm.repeatChars : o.pureRepeatChars);
		}
		if (p.fire) {
			row.fires += 1;
			row.minFire = Math.min(row.minFire, p.fire.repeatChars ?? Infinity);
			const saved = defAbort ? Math.max(0, defAbort.offset - p.fire.offset) : text.length - p.fire.offset;
			row.saved += saved;
			pureFires.push({
				file: meta.file,
				tag: meta.tag,
				kind: meta.kind,
				confirm: p.c,
				blockLen: text.length,
				blockLines,
				head300: text.slice(0, 300),
				armOffset: p.arm ? p.arm.offset : null,
				armChars: p.arm ? p.arm.repeatChars : null,
				fireOffset: p.fire.offset,
				fireChars: p.fire.repeatChars,
				alphabet: p.fire.st ? p.fire.st.alphabet : null,
				avgLineChars: p.fire.st ? +p.fire.st.avgLineChars.toFixed(1) : null,
				intruderRatio: p.fire.st ? +p.fire.st.intruderRatio.toFixed(3) : null,
				dominant: p.fire.st ? p.fire.st.dominant : "",
				samples: p.fire.st ? p.fire.st.samples.slice(0, 3) : [],
				lines: lineDetail(m.lines),
				leftAfterFire: text.length - p.fire.offset,
				defWarnOffset: defWarn ? defWarn.offset : null,
				defAbortOffset: defAbort ? defAbort.offset : null,
				saved,
			});
		} else if (armed) {
			row.vetoed += 1;
			if (p.tier.isArmed) row.endedArmed += 1;
			pureVetoes.push({
				file: meta.file,
				tag: meta.tag,
				kind: meta.kind,
				confirm: p.c,
				blockLen: text.length,
				blockLines,
				armOffset: p.arm ? p.arm.offset : null,
				armChars: p.arm ? p.arm.repeatChars : null,
				leftAfterArm: p.arm ? text.length - p.arm.offset : null,
				endedArmed: p.tier.isArmed,
				shapeMaxChars: pureShapeMax.chars,
			});
		} else if (pureShapeMax.chars > row.maxNoFireShape) {
			row.maxNoFireShape = pureShapeMax.chars;
			row.maxNoFireTag = pureShapeMax.tag;
			row.maxNoFireExact = true;
		}
	}

	// 逐阈值记未触发一侧的幅度（含本块没命中任何阈值的情况）
	noteNoFire(meta.kind, hits, blockShapeMax);

	if (bestNear) {
		pushNear({
			kind: meta.kind,
			tag: meta.tag,
			fired: hits.size > 0,
			blockLen: text.length,
			blockLines,
			offset: bestNear.offset,
			repeatChars: bestNear.st.repeatChars,
			repeatLines: bestNear.st.repeatLines,
			alphabet: bestNear.st.alphabet,
			avgLineChars: +bestNear.st.avgLineChars.toFixed(1),
			intruderRatio: +bestNear.st.intruderRatio.toFixed(3),
			samples: bestNear.st.samples.slice(0, 3),
		});
	}

	if (hits.size === 0 && !defWarn && !defAbort) return;
	if (defWarn) s.defWarn += 1;
	if (defAbort) s.defAbort += 1;

	const shape = {
		defWarn: defWarn ? { offset: defWarn.offset, repeatChars: defWarn.st.repeatChars } : null,
		defAbort: defAbort
			? {
					offset: defAbort.offset,
					repeatChars: defAbort.st.repeatChars,
					repeatLines: defAbort.st.repeatLines,
					alphabet: defAbort.st.alphabet,
					avgLineChars: +defAbort.st.avgLineChars.toFixed(1),
					intruderRatio: +defAbort.st.intruderRatio.toFixed(3),
				}
			: null,
	};

	const hitByT = {};
	for (const [t, h] of hits) {
		hitByT[t] = {
			offset: h.offset,
			repeatChars: h.st.repeatChars,
			repeatLines: h.st.repeatLines,
			alphabet: h.st.alphabet,
			avgLineChars: +h.st.avgLineChars.toFixed(1),
			intruderRatio: +h.st.intruderRatio.toFixed(3),
			dominant: h.st.dominant,
			gated: h.gated,
			lines: h.detail,
		};
	}

	const primary = hits.has(o.candChars) ? hits.get(o.candChars) : null;
	if (primary) {
		s.cand += 1;
		if (primary.gated) s.candGated += 1;
		if (defAbort) {
			s.overlap += 1;
			s.saved += Math.max(0, defAbort.offset - primary.offset);
		} else {
			s.candOnly += 1;
			s.candOnlyChars += primary.st.repeatChars;
			s.saved += text.length - primary.offset;
		}
	}
	for (const [t, h] of hits) {
		const row = sweep.get(t)[meta.kind];
		row.fires += 1;
		if (h.gated) row.gated += 1;
		row.minFire = Math.min(row.minFire, h.st.repeatChars);
		if (defAbort) row.saved += Math.max(0, defAbort.offset - h.offset);
		else {
			row.candOnly += 1;
			row.candOnlyChars += h.st.repeatChars;
			row.saved += text.length - h.offset;
		}
	}

	const rec = {
		kind: meta.kind,
		tag: meta.tag,
		file: meta.file,
		lineNo: meta.lineNo,
		blockLen: text.length,
		blockLines,
		hits: hitByT,
		...shape,
		realWarn: realWarn ? realWarn.offset : null,
		realAbort: realAbort ? realAbort.offset : null,
	};
	fires.push(rec);

	// 候选独有：某阈值命中、但该块现行判据整块没 abort
	if (!defAbort && hits.size > 0 && evidence.length < o.maxEvidence) {
		const firstHit = hits.get(minT) ?? [...hits.values()][0];
		const ctx = runContext(text, firstHit.offset, alphaSet ?? new Set([firstHit.st.dominant]));
		evidence.push({
			...rec,
			firedThresholds: [...hits.keys()].sort((a, b) => a - b),
			head300: text.slice(0, 300),
			charsLeftAfterFireLowest: text.length - firstHit.offset,
			...ctx,
		});
	}
}

// ── 主循环 ──────────────────────────────────────────────────────
const all = walk(o.root).sort().filter((f) => !o.grep || f.includes(o.grep));
const files = o.limit > 0 ? all.slice(0, o.limit) : all;
const t0 = Date.now();
let fileIdx = 0;
let parseErrors = 0;

for (const file of files) {
	fileIdx += 1;
	const useFidelity = fileIdx <= o.fidelityFiles;
	const rl = readline.createInterface({
		input: fs.createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});
	let lineNo = 0;
	let liveHere = 0;
	for await (const line of rl) {
		lineNo += 1;
		if (!line) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			parseErrors += 1;
			continue;
		}
		if (entry.type === "custom_message" && entry.customType === "loop-guard") {
			liveHere += 1;
			const d = entry.details ?? {};
			liveLoop.push({
				file: path.basename(file),
				lineNo,
				repeatChars: d.repeatChars ?? null,
				repeatLines: d.repeatLines ?? null,
				alphabet: d.alphabet ?? null,
				avgLineChars: d.avgLineChars ?? null,
				samples: d.samples ?? [],
			});
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || !Array.isArray(msg.content)) continue;
		const role = msg.role;
		if (role === "assistant") {
			let bi = 0;
			for (const block of msg.content) {
				if (block.type !== "thinking" && block.type !== "text") continue;
				if (!KINDS.includes(block.type)) continue;
				const text = block.type === "thinking" ? block.thinking : block.text;
				if (typeof text !== "string" || !text) continue;
				analyze(text, {
					kind: block.type,
					tag: `${path.relative(o.root, file)}#${lineNo}:${block.type}[${bi++}]`,
					file,
					lineNo,
					fidelity: useFidelity,
				});
			}
		} else if (role === "toolResult" && o.toolresult) {
			let bi = 0;
			for (const block of msg.content) {
				if (block.type !== "text" || typeof block.text !== "string" || !block.text) continue;
				analyze(block.text, {
					kind: "toolResult",
					tag: `${path.relative(o.root, file)}#${lineNo}:toolResult:${block.toolName ?? "?"}[${bi++}]`,
					file,
					lineNo,
					fidelity: false,
				});
			}
		}
	}
	if (fileIdx % 50 === 0) {
		const el = ((Date.now() - t0) / 1000).toFixed(0);
		console.error(`  [${fileIdx}/${files.length}] ${el}s blocks=${blocksSeen} fires=${fires.length}`);
	}
}

// ── 报告 ────────────────────────────────────────────────────────
const L = [];
const p = (s = "") => L.push(s);

p(`# loop-guard 极纯档离线校准（confirmChars 扫描 + 现行档对账）`);
p();
p(`- 语料：${o.root}　会话文件 ${fmt(files.length)}${o.limit > 0 ? `（全量 ${fmt(all.length)}，本次抽样前 ${o.limit} 个）` : ""}`);
p(`- 块类型：主扫描 ${KINDS.join("/")}${o.toolresult ? "；另单独扫 toolResult（toolResult 不参与主统计，单列）" : ""}`);
p(`- delta 粒度：${o.chunk} 字符；预筛：块内 top3/top10 重复字符上界不足者不 replay`);
p(
	`- 极纯档（本体已实现，见 detector.ts 的 PureTier）：形态 字母表 ≤ ${o.pureAlphabet} ∧ 平均行长 ≤ ${o.pureAvg} ∧ 新行占比 ≤ ${o.pureIntruder}，重复 ≥ ${o.pureRepeatChars} 进 armed，再确认 ${PC.join("/")} 之一即 abort；主档 ${PPRIMARY}`,
);
p(
	`- 候选形态（上一轮的历史口径，保留对账用）：字母表 ≤ ${o.candAlphabet} ∧ 平均行长 ≤ ${o.candAvg} ∧ 新行占比 ≤ ${o.candIntruder}；主阈值 ${o.candChars} 字符，另扫 ${T.join("/")}`,
);
p(
	`- 现行判据：warn ≥ ${DEFAULT_OPTIONS.warnRepeatChars} / abort ≥ ${DEFAULT_OPTIONS.abortRepeatChars}（字母表 ≤ ${DEFAULT_OPTIONS.maxAlphabet}、平均行长 ≤ ${DEFAULT_OPTIONS.maxAvgLineChars}、新行占比 ≤ ${DEFAULT_OPTIONS.maxIntruderRatio}、重复行 ≥ ${DEFAULT_OPTIONS.minRepeatLines}、主导行须有实义字符）`,
);
p(`- 解析失败行：${fmt(parseErrors)}　用时：${((Date.now() - t0) / 1000).toFixed(0)}s`);
p(`## 1. 命中对比表（主阈值 ${o.candChars}）`);
p();
p(`| 通道 | 块数 | 字符总量 | 过小跳过 | 预筛跳过 | replay | 现行 warn | 现行 abort | 候选命中 | 其中 gated | 候选独有 | 两者都命中 | 候选独有重复字符 | 少烧字符 |`);
p(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const k of kinds) {
	const s = S[k];
	p(
		`| ${k} | ${fmt(s.blocks)} | ${fmt(s.chars)} | ${fmt(s.skippedSmall)} | ${fmt(s.skippedByPrefilter)} | ${fmt(s.replayed)} | ${fmt(s.defWarn)} | ${fmt(s.defAbort)} | ${fmt(s.cand)} | ${fmt(s.candGated)} | ${fmt(s.candOnly)} | ${fmt(s.overlap)} | ${fmt(s.candOnlyChars)} | ${fmt(s.saved)} |`,
	);
}
p();
p(`- 「候选独有」= 候选命中但该块现行判据整块都没 abort（现行判据原本不会拦它）；「两者都命中」= 现行判据也会拦，只是晚得多。`);
p(`- 「少烧字符」含两者都命中时的提前量，以及候选独有块中候选命中点之后剩余的全部字符（保守：那块本来可能自然收敛）。`);
p();
p(`### 各通道「未触发一侧」的最大形态幅度（离候选线多远）`);
p();
p(`| 通道 | 任一阈值都未命中的块里最大候选形态字符数 | 来源 | 性质 | 与 ${o.candChars} 线的距离 | 本通道最小命中重复字符数 |`);
p(`|---|---|---|---|---|---|`);
for (const k of kinds) {
	const s = S[k];
	const minFire = Math.min(...T.map((t) => sweep.get(t)[k].minFire));
	p(
		`| ${k} | ${fmt(s.noFireShape.chars)} | ${s.noFireShape.tag || "（无）"} | ${s.noFireShape.exact ? "实测" : `上界（该块 top3，且 < ${o.nearChars}）`} | ${o.candChars - s.noFireShape.chars} | ${Number.isFinite(minFire) ? fmt(minFire) : "-"} |`,
	);
}
p();
p(`- 口径：候选形态（字母表/平均行长/新行占比三闸）成立时记一笔。replayed 的块是实测；没 replay 的块受预筛保证（top3 < ${o.nearChars}），所以那一列真循环外不可能超过 ${o.nearChars - 1}。`);
p();
p(`## 2. 候选独有命中（主阈值 ${o.candChars}，逐例）`);
p();
const primaryOnly = evidence.filter((e) => e.firedThresholds.includes(o.candChars));
if (primaryOnly.length === 0) p(`（无）`);
for (const e of primaryOnly) {
	printEvidence(e, e.hits[o.candChars], o.candChars);
}
p();
p(`## 3. 阈值扫描（决策曲线）`);
p();
p(`| 候选线 | 通道 | 命中块 | 其中 gated | 候选独有块 | 独有块重复字符 | 少烧字符 | 最小命中重复字符数 | 同阈值未触发侧最大形态字符数 |`);
p(`|---|---|---|---|---|---|---|---|---|`);
for (const t of T) {
	for (const k of kinds) {
		const r = sweep.get(t)[k];
		p(
			`| ${t} | ${k} | ${fmt(r.fires)} | ${fmt(r.gated)} | ${fmt(r.candOnly)} | ${fmt(r.candOnlyChars)} | ${fmt(r.saved)} | ${r.minFire === Infinity ? "-" : fmt(r.minFire)} | ${fmt(r.maxNoFire)} |`,
		);
	}
}
p();
p(`低于主阈值才被捉到的块（即「降线」新增的部分）：`);
p();
const lowerOnly = evidence.filter((e) => !e.firedThresholds.includes(o.candChars));
if (lowerOnly.length === 0) p(`（无）`);
for (const e of lowerOnly) {
	const t = e.firedThresholds[0];
	printEvidence(e, e.hits[t], t, true);
}
p(`## 4. 候选与现行 abort 同时命中的块（看提前量）`);
p();
const overlaps = fires.filter((f) => f.hits[o.candChars] && f.defAbort).sort((a, b) => b.blockLen - a.blockLen);
if (overlaps.length === 0) p(`（无）`);
p(`| 块 | 通道 | 块字符 | 候选偏移 | 现行 abort 偏移 | 提前字符 | 现行 abort 重复字符 | 候选重复行样例 |`);
p(`|---|---|---|---|---|---|---|---|`);
for (const f of overlaps.slice(0, 60)) {
	const c = f.hits[o.candChars];
	p(
		`| ${f.tag} | ${f.kind} | ${fmt(f.blockLen)} | ${fmt(c.offset)} | ${fmt(f.defAbort.offset)} | ${fmt(Math.max(0, f.defAbort.offset - c.offset))} | ${fmt(f.defAbort.repeatChars)} | ${c.lines.slice(0, 3).map((l) => JSON.stringify(short(l.line, 14))).join(" ")} |`,
	);
}
p();
p(`## 5. 近失：候选形态成立、但没到最低候选线（${T[0]}）的最大窗口 TOP ${near.length}`);
p();
p(`| 重复字符 | 行数 | 字母表 | 平均行长 | 新行占比 | 块字符 | 通道 | 该块是否命中过阈值 | 位置 | 样例 |`);
p(`|---|---|---|---|---|---|---|---|---|---|`);
for (const n of near) {
	p(
		`| ${fmt(n.repeatChars)} | ${fmt(n.repeatLines)} | ${n.alphabet} | ${n.avgLineChars} | ${n.intruderRatio} | ${fmt(n.blockLen)} | ${n.kind} | ${n.fired ? "是" : "否"} | ${n.tag} | ${n.samples.map((s) => JSON.stringify(short(s, 16))).join(" ")} |`,
	);
}
p();
p(`## 6. 校验`);
p();
p(`- mirror vs 真 LoopDetector（前 ${o.fidelityFiles} 个文件并行 replay，逐检查点比对级别+repeatChars）：比对 ${fmt(fidelity.checked)} 次，不一致 ${fidelity.mismatch.length}`);
for (const m of fidelity.mismatch.slice(0, 10)) p(`  - ${m.tag} @${m.offset} mirror=${m.mirror}(${m.mirrorRepeatChars}) real=${m.real}(${m.realRepeatChars})`);
p(
	`- 极纯档的 mirror（PureTier）vs 真 LoopDetector（同参数，逐检查点比对 armed 状态与首次 fire 偏移）：比对 ${fmt(pureFidelity.checked)} 次，不一致 ${pureFidelity.mismatch.length}`,
);
for (const m of pureFidelity.mismatch.slice(0, 10))
	p(`  - ${m.tag} confirm=${m.confirm} @${m.offset} mirror(armed=${m.mirrorArmed},fire=${m.mirrorFire}) real(armed=${m.realArmed},fire=${m.realFire})`);
p(`- 预筛跳过的块抽查（真 LoopDetector 回放前 20 万字符）：抽 ${fmt(audit.checked)} 块，意外命中 ${audit.mismatch.length}`);
for (const m of audit.mismatch.slice(0, 10)) p(`  - ${m.tag} ${JSON.stringify(m.hit)} top3=${m.top3} top10=${m.top10}`);
p();
p(`### 与真机注入记录对账`);
p();
p(`语料里 loop-guard 真实注入记录 ${fmt(liveLoop.length)} 条，涉及 ${new Set(liveLoop.map((v) => v.file)).size} 个会话。离线 replay（现行判据，delta ${o.chunk}）在同一批会话上的 abort 对照如下；数量对齐说明离线口径可信，偏差则看是 chunk 粒度还是真机与存储内容不一致。`);
p();
p(`| 会话 | 真机注入次数 | 真机 repeatChars | 离线 abort 次数 | 离线 abort 位置 |`);
p(`|---|---|---|---|---|`);
const byFile = new Map();
for (const v of liveLoop) {
	if (!byFile.has(v.file)) byFile.set(v.file, []);
	byFile.get(v.file).push(v);
}
for (const [f, vs] of byFile) {
	const offline = fires.filter((x) => path.basename(x.file) === f && x.defAbort);
	p(`| ${short(f, 46)} | ${vs.length} | ${vs.map((v) => fmt(v.repeatChars)).join(" / ")} | ${offline.length} | ${offline.map((x) => `偏移 ${fmt(x.defAbort.offset)}/${fmt(x.blockLen)}`).join(" / ")} |`);
}
p();

// ── 7. 极纯档扫描 ───────────────────────────────────────────────
p(`## 7. 极纯档：confirmChars 扫描（本体已实现的附加提前中止档）`);
p();
p(
	`- 口径：「命中块」= 形态成立且重复量过 ${o.pureRepeatChars} 进入过 armed 的块；「真 abort」= armed 后确认期满且形态没断、会真动手的块（一个块最多一次）；「被确认期挡下」= armed 过但整块没动手，其中「块尾仍 armed」是确认期没走完块就结束的那部分（就是要避开的白拦）。`,
);
p(`- 「少烧字符」：该块现行 abort 也命中时取提前量，否则取 fire 点之后剩余的全部字符（保守：那块本来可能自然收敛）。`);
p(`- toolResult 与 assistant 正文是误伤对照组，只看「真 abort」是不是 0。`);
p();
p(`| confirmChars | 通道 | 命中块(armed) | 真 abort | 被确认期挡下 | 其中块尾仍 armed | 少烧字符 | 最小 fire 重复量 | 未命中侧最大极纯形态重复量 |`);
p(`|---|---|---|---|---|---|---|---|---|`);
for (const c of PC) {
	for (const k of kinds) {
		const r = PB[k][c];
		p(
			`| ${c} | ${k} | ${fmt(r.armed)} | ${fmt(r.fires)} | ${fmt(r.vetoed)} | ${fmt(r.endedArmed)} | ${fmt(r.saved)} | ${r.minFire === Infinity ? "-" : fmt(r.minFire)} | ${fmt(r.maxNoFireShape)} |`,
		);
	}
}
p();
p(`- 「未命中侧最大极纯形态重复量」= 没 armed 的块里、极纯形态成立时观察到的最大重复字符数（即离 ${o.pureRepeatChars} 这条线还有多远）。`);
for (const k of kinds) {
	const r = PB[k][PPRIMARY];
	if (r.maxNoFireTag) p(`  - ${k}：最大来自 ${r.maxNoFireTag}${r.maxNoFireExact ? "（实测）" : "（预筛上界）"}`);
}
p();
p(`### 每档合计（assistant 侧 thinking+text）`);
p();
p(`| confirmChars | 命中块 | 真 abort | 被确认期挡下 | 块尾仍 armed | 少烧字符 |`);
p(`|---|---|---|---|---|---|`);
for (const c of PC) {
	let a = 0;
	let f = 0;
	let v = 0;
	let e = 0;
	let s = 0;
	for (const k of KINDS) {
		const r = PB[k][c];
		a += r.armed;
		f += r.fires;
		v += r.vetoed;
		e += r.endedArmed;
		s += r.saved;
	}
	p(`| ${c} | ${fmt(a)} | ${fmt(f)} | ${fmt(v)} | ${fmt(e)} | ${fmt(s)} |`);
}
p();
p(`### 逐会话真 abort 次数（confirmChars = ${PPRIMARY}，assistant 侧）`);
p();
p(
	`定 maxActionsPerSession 的依据：一次 abort 会真掐掉当前生成、并注入一条约 4~5 千字符的纠正消息，所以要看的是「一个会话里会被掐几次」。`,
);
p();
const perSession = new Map();
for (const f of pureFires) {
	if (f.confirm !== PPRIMARY || f.kind === "toolResult") continue;
	const key = path.basename(f.file);
	if (!perSession.has(key)) perSession.set(key, []);
	perSession.get(key).push(f);
}
p(`| 会话 | 真 abort 次数 | 各次 fire 位置（剩余字符） | 该块现行档 abort 位置 |`);
p(`|---|---|---|---|`);
for (const [key, list] of [...perSession.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
	p(
		`| ${short(key, 48)} | ${list.length} | ${list.map((x) => `${fmt(x.fireOffset)}（剩 ${fmt(x.leftAfterFire)}）`).join(" / ")} | ${list.map((x) => (x.defAbortOffset ? fmt(x.defAbortOffset) : "否")).join(" / ")} |`,
	);
}
p();
p(`### 逐例证据：会 fire 的块（confirmChars = ${PPRIMARY}）`);
p();
const primaryFires = pureFires.filter((x) => x.confirm === PPRIMARY);
if (primaryFires.length === 0) p(`（无）`);
for (const f of primaryFires) printPureFire(f);
p();
p(`### 逐例证据：被确认期挡下的块（confirmChars = ${PPRIMARY}）`);
p();
const primaryVetoes = pureVetoes.filter((x) => x.confirm === PPRIMARY);
if (primaryVetoes.length === 0) p(`（无）`);
for (const v of primaryVetoes) {
	p(
		`- ${v.kind} ${v.tag}：armed@${fmt(v.armOffset)}（重复 ${fmt(v.armChars)}）→ 块在 ${fmt(v.blockLen)} 结束，armed 之后只剩 ${fmt(v.leftAfterArm)} 字符，确认期没走完（块尾仍 armed=${v.endedArmed}）`,
	);
}
p();

function printEvidence(e, h, threshold, compact = false) {
	p(`### ${e.tag}　（阈值 ${threshold}）`);
	p();
	p(`- 通道 ${e.kind}　块总字符 ${fmt(e.blockLen)}　块总行数 ${fmt(e.blockLines)}　该块命中阈值：${e.firedThresholds.map((t) => `${t}@${fmt(e.hits[t].offset)}`).join("、")}`);
	p(
		`- 候选命中：偏移 ${fmt(h.offset)}　重复 ${fmt(h.repeatChars)} 字符 / ${fmt(h.repeatLines)} 行　字母表 ${h.alphabet}　平均行长 ${h.avgLineChars}　新行占比 ${h.intruderRatio}　gated=${h.gated}`,
	);
	p(`- 现行判据：warn ${e.defWarn ? `@${fmt(e.defWarn.offset)}（${fmt(e.defWarn.repeatChars)} 字符）` : "无"}；abort ${e.defAbort ? `@${fmt(e.defAbort.offset)}` : "无"}`);
	p(`- 该阈值命中点之后块内还剩 ${fmt(e.blockLen - h.offset)} 字符（最低阈值命中点之后还剩 ${fmt(e.charsLeftAfterFireLowest)}）`);
	p(`- 重复行（次数）：${h.lines.map((l) => `${JSON.stringify(short(l.line, 20))}×${l.count}(len ${l.len})`).join("　")}`);
	p(`- 块前 300 字符：`);
	p("````");
	p(e.head300);
	p("````");
	p(`- 触发点前连续重复行数 ${fmt(e.runLinesBeforeFire)}；重复段起点附近原文（每行截断 100）：`);
	for (const c of e.context) p(`  - ${JSON.stringify(c)}`);
	p();
}

function printPureFire(f) {
	p(`### ${f.tag}　（confirmChars ${f.confirm}）`);
	p();
	p(
		`- 通道 ${f.kind}　块总字符 ${fmt(f.blockLen)}　块总行数 ${fmt(f.blockLines)}　armed@${fmt(f.armOffset)}（重复 ${fmt(f.armChars)}）→ fire@${fmt(f.fireOffset)}（重复 ${fmt(f.fireChars)}）　fire 之后块内还剩 ${fmt(f.leftAfterFire)} 字符`,
	);
	p(
		`- fire 点形态：字母表 ${f.alphabet}　平均行长 ${f.avgLineChars}　新行占比 ${f.intruderRatio}　主导行 ${JSON.stringify(short(f.dominant, 30))}`,
	);
	p(
		`- 现行判据：warn ${f.defWarnOffset ? `@${fmt(f.defWarnOffset)}` : "无"}；abort ${f.defAbortOffset ? `@${fmt(f.defAbortOffset)}` : "无（本块现行档整块不会拦）"}　本档提前量 ${fmt(f.saved)} 字符`,
	);
	p(`- 重复行（次数）：${f.lines.map((l) => `${JSON.stringify(short(l.line, 20))}×${l.count}(len ${l.len})`).join("　")}`);
	p(`- 块前 300 字符：`);
	p("````");
	p(f.head300);
	p("````");
	p();
}

// 落盘
const out = {
	params: o,
	stats: S,
	sweep: Object.fromEntries([...sweep.entries()].map(([t, m]) => [t, m])),
	pure: { stats: PB, fires: pureFires, vetoes: pureVetoes, fidelity: pureFidelity },
	evidence,
	overlaps: overlaps.slice(0, 60),
	near,
	fidelity: { checked: fidelity.checked, mismatches: fidelity.mismatch },
	audit,
	liveLoop,
};
try {
	fs.writeFileSync(o.evidence, JSON.stringify(out, null, 2));
	console.error(`证据已写入 ${o.evidence}`);
} catch (err) {
	console.error(`证据写入失败：${err.message}`);
}

console.log(L.join("\n"));
