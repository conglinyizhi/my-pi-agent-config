// scripts/thinking-fold-probe.ts — thinking-fold 的回归探针
//
// 拿历史会话 jsonl 跑 findDupSegments，只读。放 scripts/ 而不是扩展目录，
// 是因为它只是开发期的校准工具，不进扩展运行时。
//
// 用法（在 ~/.pi/agent 下执行）：
//   node --experimental-strip-types scripts/thinking-fold-probe.ts <jsonl|目录> [更多路径…] \
//        [--limit N] [--samples N] [--mid-samples N] [--min-density X]
//
// 目录参数按文件大小取前 N 个（默认 8）当样本。输出四部分：
//   1. 命中块数 / 折叠字符占比（区分尾段与中段）
//   2. 命中样例的折叠提示文本（含中段样例）
//   3. 误伤检查：折叠段里有多少非复读行、其中多少是全块唯一的代码/表格/清单行
//   4. 整块折光的命中数
//
// --min-density 用来试阈值：默认 0.75（照 detector 默认）。调高误伤更小、折得也更少；
// 调到 0.9 以上基本命中不到（段里总夹着变化词）。
//
// 只读，不写任何文件，不碰会话。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeLine, hasSubstance } from "../extensions/loop-guard/detector.ts";
import {
	DEFAULT_DUP_OPTIONS,
	findDupSegments,
	type DupOptions,
	type DupSegment,
} from "../extensions/thinking-fold/detector.ts";
import { applyFold, buildFoldNotice } from "../extensions/thinking-fold/index.ts";

interface Block {
	file: string;
	index: number;
	ts: string;
	text: string;
}

/** 一行是否「复读行」（与 detector 内部同一套判据，供误伤诊断复算） */
function repeatFlagsFor(
	text: string,
	opts: DupOptions,
): { flags: boolean[]; norm: Array<string | null>; counts: Map<string, number> } {
	const raw = text.split("\n");
	const norm: Array<string | null> = new Array(raw.length).fill(null);
	const valid: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const n = normalizeLine(raw[i]);
		if (n && hasSubstance(n)) {
			norm[i] = n;
			valid.push(n);
		}
	}
	const counts = new Map<string, number>();
	for (const l of valid) counts.set(l, (counts.get(l) ?? 0) + 1);
	const flags = new Array<boolean>(raw.length).fill(false);
	for (let i = 0; i < raw.length; i++) {
		const l = norm[i];
		if (l === null) continue;
		flags[i] = (counts.get(l) ?? 0) >= opts.minCount && l.length <= opts.maxLineLen;
	}
	return { flags, norm, counts };
}

/** 非复读行里疑似「真内容」的特征 */
function structureKind(raw: string): string | null {
	const t = raw.trim();
	if (t.startsWith("```")) return "code-fence";
	if (t.startsWith("|") && t.endsWith("|")) return "table";
	if (/^[-*+] /.test(t) || /^\d+[.)] /.test(t)) return "list";
	if (/^ {4,}\S/.test(raw)) return "indented-code";
	if (/^\s*(const|let|var|function|export|import|return|class|def|if|for|while)\b/.test(t)) return "code";
	if (/[{};]$/.test(t)) return "code";
	return null;
}

function* readBlocks(file: string): Generator<Block> {
	let index = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part?.type === "thinking" && part.thinking) {
				index += 1;
				yield { file, index, ts: entry.timestamp ?? "", text: part.thinking };
			}
		}
	}
}

function listJsonl(dir: string, limit: number): string[] {
	const files = readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
		.map((e) => join(dir, e.name))
		.sort((a, b) => statSync(b).size - statSync(a).size);
	return files.slice(0, limit);
}

/** 段后还留着多少行非空内容（被折掉的位置之后，原样保留在屏幕上的行） */
function keptAfter(raw: string[], seg: DupSegment): number {
	return raw.slice(seg.endLine).filter((l) => l.trim() !== "").length;
}

/**
 * 段分类：段后还留着 ≥ 3 行内容算「中段」。
 * 0-2 行只是块尾那点收束（老算法折尾巴时也会把它一起折掉），不当中段看。
 */
const MID_MIN_KEPT_LINES = 3;

function main(): void {
	const argv = process.argv.slice(2);
	const opts: DupOptions = { ...DEFAULT_DUP_OPTIONS };
	let limit = 8;
	let sampleCount = 8;
	let midSamples = 5;
	const paths: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--limit") limit = Number(argv[++i]) || limit;
		else if (a === "--samples") sampleCount = Number(argv[++i]) || sampleCount;
		else if (a === "--mid-samples") midSamples = Number(argv[++i]) || midSamples;
		else if (a === "--min-density") opts.minDensity = Number(argv[++i]);
		else if (a.startsWith("--")) {
			console.error(`未知参数：${a}`);
			process.exit(2);
		} else paths.push(a);
	}
	if (paths.length === 0) {
		console.error(
			"用法：scripts/thinking-fold-probe.ts <jsonl|目录> [--limit N] [--samples N] [--mid-samples N] [--min-density X]",
		);
		process.exit(2);
	}

	const files: string[] = [];
	for (const p of paths) {
		const st = statSync(p);
		if (st.isDirectory()) files.push(...listJsonl(p, limit));
		else files.push(p);
	}

	const perFile: Array<{
		file: string;
		blocks: number;
		hits: number;
		segs: number;
		mids: number;
		removed: number;
	}> = [];
	const samples: Array<{ block: Block; notices: string[]; segs: number; ratio: number }> = [];
	const midSamplesOut: Array<{ block: Block; seg: DupSegment; notices: string[]; after: number }> = [];
	let totalBlocks = 0;
	let totalChars = 0;
	let totalHits = 0;
	let totalRemoved = 0;
	let totalNetRemoved = 0;
	let totalSegs = 0;
	let totalTailSegs = 0;
	let totalMidSegs = 0;
	let midSegChars = 0;
	const keptAfterDist = new Map<number, number>();
	let totalEstChars = 0;

	// 误伤统计
	let suffixRawLines = 0;
	let suffixRepeatLines = 0;
	let suffixNonRepeatLines = 0;
	let suffixNonRepeatLongLines = 0;
	let suffixNonRepeatLongChars = 0;
	let suffixUniqueLines = 0;
	let suffixUniqueStructural = 0;
	let wholeFolds = 0;
	const uniqueStructCounts = new Map<string, number>();
	const repeatedLongCounts = new Map<string, number>();
	const uniqueStructSamples: string[] = [];
	const uniqueProseSamples: string[] = [];

	for (const file of files) {
		const name = file.split("/").pop() ?? file;
		const row = { file: name, blocks: 0, hits: 0, segs: 0, mids: 0, removed: 0 };
		for (const block of readBlocks(file)) {
			row.blocks += 1;
			const segs = findDupSegments(block.text, opts);
			if (segs.length === 0) continue;

			const raw = block.text.split("\n");
			const inSeg = new Array<boolean>(raw.length).fill(false);
			for (const s of segs) for (let i = s.startLine; i < s.endLine && i < raw.length; i++) inSeg[i] = true;
			const keptChars = raw.filter((_, i) => !inSeg[i]).join("\n").length;
			const removed = block.text.length - keptChars;
			const folded = applyFold(block.text, opts).text;

			row.hits += 1;
			row.segs += segs.length;
			row.removed += removed;
			totalEstChars += segs.reduce((n, s) => n + s.chars, 0);
			totalSegs += segs.length;
			totalNetRemoved += block.text.length - folded.length;
			if (!raw.some((l, i) => l.trim() !== "" && !inSeg[i])) wholeFolds += 1;

			const notices = segs.map((s) => buildFoldNotice(s));
			const mids = segs.filter((s) => keptAfter(raw, s) >= MID_MIN_KEPT_LINES);
			row.mids += mids.length;
			totalTailSegs += segs.length - mids.length;
			totalMidSegs += mids.length;
			midSegChars += mids.reduce((n, s) => n + s.chars, 0);
			for (const s of segs) {
				const after = keptAfter(raw, s);
				keptAfterDist.set(after, (keptAfterDist.get(after) ?? 0) + 1);
			}

			samples.push({
				block,
				notices,
				segs: segs.length,
				ratio: removed / Math.max(1, block.text.length),
			});
			for (const seg of mids.slice(0, 2)) {
				midSamplesOut.push({
					block,
					seg,
					notices: [buildFoldNotice(seg)],
					after: keptAfter(raw, seg),
				});
			}

			// 误伤诊断：看折叠段里的原始行
			const { flags, norm, counts } = repeatFlagsFor(block.text, opts);
			for (const seg of segs) {
				for (let i = seg.startLine; i < seg.endLine && i < raw.length; i++) {
					if (!raw[i].trim()) continue;
					suffixRawLines += 1;
					if (flags[i]) {
						suffixRepeatLines += 1;
						continue;
					}
					suffixNonRepeatLines += 1;
					if (raw[i].trim().length > (opts.maxLineLen ?? DEFAULT_DUP_OPTIONS.maxLineLen)) {
						suffixNonRepeatLongLines += 1;
						suffixNonRepeatLongChars += raw[i].trim().length;
					}
					const n = norm[i];
					const occurrences = n ? (counts.get(n) ?? 1) : 1;
					const kind = structureKind(raw[i]);
					if (occurrences === 1) {
						// 全块只出现一次：折掉就是真的丢内容
						suffixUniqueLines += 1;
						if (kind) {
							suffixUniqueStructural += 1;
							uniqueStructCounts.set(kind, (uniqueStructCounts.get(kind) ?? 0) + 1);
							if (uniqueStructSamples.length < 15) {
								uniqueStructSamples.push(`${kind}: ${raw[i].trim().slice(0, 90)}`);
							}
						} else if (uniqueProseSamples.length < 6) {
							uniqueProseSamples.push(raw[i].trim().slice(0, 90));
						}
					} else if (kind) {
						// 出现过多次，只是行长超限才没被判成复读行 —— 本质上还是复读内容
						repeatedLongCounts.set(kind, (repeatedLongCounts.get(kind) ?? 0) + 1);
					}
				}
			}
		}
		perFile.push(row);
		totalBlocks += row.blocks;
		totalHits += row.hits;
		totalRemoved += row.removed;
	}

	// thinking 总字符单独扫一遍（命中与不命中的块都要计入）
	for (const file of files) for (const block of readBlocks(file)) totalChars += block.text.length;

	console.log("═══ thinking-fold 回归探针 ═══");
	console.log(`语料：${files.length} 个 jsonl，判定参数：${JSON.stringify(opts)}`);
	console.log("");
	console.log("文件                                    块数  命中  段数  中段  移除字符");
	for (const r of perFile) {
		console.log(
			`${r.file.slice(0, 38).padEnd(38)}  ${String(r.blocks).padStart(4)}  ${String(r.hits).padStart(4)}  ${String(r.segs).padStart(4)}  ${String(r.mids).padStart(4)}  ${String(r.removed).padStart(8)}`,
		);
	}
	console.log("");
	console.log(`合计：thinking 块 ${totalBlocks}，命中 ${totalHits}（${((totalHits / Math.max(1, totalBlocks)) * 100).toFixed(1)}%）`);
	console.log(
		`thinking 总字符 ${totalChars}，命中后从显示里移除 ${totalRemoved} 字符（${((totalRemoved / Math.max(1, totalChars)) * 100).toFixed(1)}%）`,
	);
	console.log(
		`段统计：共 ${totalSegs} 段（尾段 ${totalTailSegs} / 中段 ${totalMidSegs}）；中段折掉 ${midSegChars} 字符，占折叠总量 ${((midSegChars / Math.max(1, totalEstChars)) * 100).toFixed(1)}%`,
	);
	const dist = [...keptAfterDist.entries()].sort((a, b) => a[0] - b[0]);
	console.log(
		`段后保留行数分布（该段之后还有多少行非空内容留在屏幕上）：${dist.map(([k, v]) => `${k} 行 ${v} 段`).join(" / ")}`,
	);
	console.log(
		`净减字符（扣掉插回去的提示行，口径最严）：${totalNetRemoved}（${((totalNetRemoved / Math.max(1, totalChars)) * 100).toFixed(1)}%）`,
	);
	console.log(`（按归一化行长估的折叠量 ${totalEstChars} 字符，与上方口径不同，仅供参考）`);
	console.log("");
	// 样例挑两组：最早命中的几个（折叠比例通常小）+ 折叠最狠的几个
	const earliest = [...samples]
		.sort((a, b) => a.block.file.localeCompare(b.block.file) || a.block.index - b.block.index)
		.slice(0, Math.ceil(sampleCount / 2));
	const heaviest = [...samples]
		.sort((a, b) => b.ratio - a.ratio)
		.slice(0, Math.max(1, Math.floor(sampleCount / 2)));
	const picked = [...earliest, ...heaviest.filter((s) => !earliest.includes(s))];
	console.log(`── 命中样例（最早命中 + 折叠最狠，共 ${picked.length} 个）──`);
	for (const s of picked) {
		console.log(
			`#${s.block.index} ${s.block.ts.slice(11, 19)} len=${s.block.text.length} 折=${(s.ratio * 100).toFixed(0)}% ${s.segs} 段  ${s.block.file.split("/").pop()?.slice(0, 24)}`,
		);
		for (const n of s.notices.slice(0, 4)) console.log(`   ${n}`);
	}
	console.log("");
	const midsPicked = [...midSamplesOut]
		.sort((a, b) => b.seg.chars - a.seg.chars)
		.slice(0, midSamples);
	console.log(`── 中段样例（段后还留着 ≥ ${MID_MIN_KEPT_LINES} 行内容，共 ${totalMidSegs} 段，列最大的 ${midsPicked.length} 段）──`);
	if (midsPicked.length === 0) console.log("（没有中段命中）");
	for (const m of midsPicked) {
		console.log(
			`#${m.block.index} ${m.block.ts.slice(11, 19)} 段 ${m.seg.lines} 行 / ${m.seg.chars} 字（原始行 ${m.seg.startLine}-${m.seg.endLine}），段后还有 ${m.after} 行正常内容`,
		);
		for (const n of m.notices) console.log(`   ${n}`);
	}
	console.log("");
	console.log("── 误伤检查 ──");
	console.log(
		`折叠段内原始行 ${suffixRawLines} 行：复读行 ${suffixRepeatLines}（${((suffixRepeatLines / Math.max(1, suffixRawLines)) * 100).toFixed(1)}%），非复读行 ${suffixNonRepeatLines}`,
	);
	console.log(
		`非复读行 ${suffixNonRepeatLines} 行，其中长行（> ${opts.maxLineLen ?? DEFAULT_DUP_OPTIONS.maxLineLen} 字）${suffixNonRepeatLongLines} 行 / ${suffixNonRepeatLongChars} 字符，占折叠段字符的 ${((suffixNonRepeatLongChars / Math.max(1, totalEstChars)) * 100).toFixed(1)}%（密度口径下长行就是反对票，这个数越小越好）`,
	);
	console.log(
		`非复读行里「全块只出现一次」的 ${suffixUniqueLines} 行（折掉就是真丢内容，占折叠段落行数的 ${((suffixUniqueLines / Math.max(1, suffixRawLines)) * 100).toFixed(1)}%），其中带代码/表格/清单特征的 ${suffixUniqueStructural} 行`,
	);
	console.log(`整块折光（一行正常内容都不留）的命中：${wholeFolds} / ${totalHits}`);
	if (uniqueStructCounts.size > 0) {
		console.log(
			`全块唯一的代码/表格/清单行明细：${[...uniqueStructCounts.entries()].map(([k, v]) => `${k} ${v}`).join(" / ")}`,
		);
		for (const s of uniqueStructSamples) console.log(`   [唯一] ${s}`);
	} else {
		console.log("折叠段里没有「全块唯一」的代码 / 表格 / 清单行。");
	}
	if (repeatedLongCounts.size > 0) {
		console.log(
			`出现过多次、仅因行长超限没被判成复读行的结构行（本质仍是复读）：${[...repeatedLongCounts.entries()].map(([k, v]) => `${k} ${v}`).join(" / ")}`,
		);
	}
	if (uniqueProseSamples.length > 0) {
		console.log("全块唯一的普通行样例（折掉会丢的推理）：");
		for (const s of uniqueProseSamples) console.log(`   [唯一] ${s}`);
	}
}

main();
