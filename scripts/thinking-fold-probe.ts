// scripts/thinking-fold-probe.ts — thinking-fold 的回归探针
//
// 拿历史会话 jsonl 跑 findDupSuffix，只读。放 scripts/ 而不是扩展目录，
// 是因为它只是开发期的校准工具，不进扩展运行时。
//
// 用法（在 ~/.pi/agent 下执行）：
//   node --experimental-strip-types scripts/thinking-fold-probe.ts <jsonl|目录> [更多路径…] \
//        [--limit N] [--samples N] [--min-density X]
//
// 目录参数按文件大小取前 N 个（默认 8）当样本。输出三部分：
//   1. 命中块数 / 折叠字符占比
//   2. 至少 6 个命中样例的折叠提示文本
//   3. 误伤检查：折叠段里有多少非复读行、其中多少是全块唯一的代码/表格/清单行
//
// --min-density 用来试阈值：默认 0.8（照 detector 默认）。调高误伤更小、折得也更少；
// 调到 0.9 以上基本命中不到（尾部总夹着变化词）。
//
// 只读，不写任何文件，不碰会话。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeLine, hasSubstance } from "../extensions/loop-guard/detector.ts";
import { DEFAULT_DUP_OPTIONS, findDupSuffix, type DupOptions } from "../extensions/thinking-fold/detector.ts";
import { buildFoldNotice } from "../extensions/thinking-fold/index.ts";

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

function main(): void {
	const argv = process.argv.slice(2);
	const opts: DupOptions = { ...DEFAULT_DUP_OPTIONS };
	let limit = 8;
	let sampleCount = 8;
	const paths: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--limit") limit = Number(argv[++i]) || limit;
		else if (a === "--samples") sampleCount = Number(argv[++i]) || sampleCount;
		else if (a === "--min-density") opts.minDensity = Number(argv[++i]);
		else if (a.startsWith("--")) {
			console.error(`未知参数：${a}`);
			process.exit(2);
		} else paths.push(a);
	}
	if (paths.length === 0) {
		console.error("用法：scripts/thinking-fold-probe.ts <jsonl|目录> [--limit N] [--samples N] [--min-density X]");
		process.exit(2);
	}

	const files: string[] = [];
	for (const p of paths) {
		const st = statSync(p);
		if (st.isDirectory()) files.push(...listJsonl(p, limit));
		else files.push(p);
	}

	const perFile: Array<{ file: string; blocks: number; hits: number; removed: number; chars: number }> = [];
	const samples: Array<{ block: Block; notice: string; ratio: number }> = [];
	let totalBlocks = 0;
	let totalChars = 0;
	let totalHits = 0;
	let totalRemoved = 0;
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
		const row = { file: name, blocks: 0, hits: 0, removed: 0, chars: 0 };
		for (const block of readBlocks(file)) {
			row.blocks += 1;
			row.chars += block.text.length;
			const hit = findDupSuffix(block.text, opts);
			if (!hit) continue;
			const raw = block.text.split("\n");
			const retained = raw.slice(0, hit.startLine).join("\n");
			const removed = block.text.length - retained.length;
			row.hits += 1;
			row.removed += removed;
			totalEstChars += hit.chars;
			if (hit.startLine === 0) wholeFolds += 1;
			samples.push({
				block,
				notice: buildFoldNotice(hit),
				ratio: removed / Math.max(1, block.text.length),
			});

			// 误伤诊断：看折叠段里的原始行
			const { flags, norm, counts } = repeatFlagsFor(block.text, opts);
			for (let i = hit.startLine; i < raw.length; i++) {
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
		perFile.push(row);
		totalBlocks += row.blocks;
		totalChars += row.chars;
		totalHits += row.hits;
		totalRemoved += row.removed;
	}

	console.log("═══ thinking-fold 回归探针 ═══");
	console.log(`语料：${files.length} 个 jsonl，判定参数：${JSON.stringify(opts)}`);
	console.log("");
	console.log("文件                                    块数  命中  移除字符");
	for (const r of perFile) {
		console.log(`${r.file.slice(0, 38).padEnd(38)}  ${String(r.blocks).padStart(4)}  ${String(r.hits).padStart(4)}  ${String(r.removed).padStart(8)}`);
	}
	console.log("");
	console.log(`合计：thinking 块 ${totalBlocks}，命中 ${totalHits}（${((totalHits / Math.max(1, totalBlocks)) * 100).toFixed(1)}%）`);
	console.log(
		`thinking 总字符 ${totalChars}，命中后从显示里移除 ${totalRemoved} 字符（${((totalRemoved / Math.max(1, totalChars)) * 100).toFixed(1)}%）`,
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
			`#${s.block.index} ${s.block.ts.slice(11, 19)} len=${s.block.text.length} 折=${(s.ratio * 100).toFixed(0)}%  ${s.block.file.split("/").pop()?.slice(0, 24)}`,
		);
		console.log(`   ${s.notice}`);
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
	console.log(`整段折光（startLine=0，一行不留）的命中：${wholeFolds} / ${totalHits}`);
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
