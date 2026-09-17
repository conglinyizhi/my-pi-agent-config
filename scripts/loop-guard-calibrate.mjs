// loop-guard/校准：拿一批历史会话回归检测阈值（脚本本体在 scripts/ 下，
// 因为这里的 console 输出就是它的交付物）
//
// 用途：动 extensions/loop-guard/detector.ts 的阈值之前，先跑一遍这个，
// 确认「命中集合」没有变脏。它把每个 assistant 输出块按 delta 粒度重放进
// LoopDetector（模拟真实流式），列出所有命中与「最强近失」，人眼核对。
//
// 跑法：
//   node --experimental-strip-types scripts/loop-guard-calibrate.mjs ~/.pi/agent/sessions
//
// 口径：warn 级会抑制同一块的后续细分，所以这里额外记录 abort 级首次触发的偏移。
// 本机基线（408 个会话 / 13.3 万个块）：命中 7 个块，逐条核对均为真停滞循环。

import fs from "node:fs";
import path from "node:path";
import {
	LoopDetector,
	DEFAULT_OPTIONS,
	windowStats,
} from "../extensions/loop-guard/detector.ts";

const root = process.argv[2];
const CHUNK = Number(process.argv[3] || 48);
if (!root) {
	console.error("用法：node --experimental-strip-types scripts/loop-guard-calibrate.mjs <sessionsDir> [chunkSize]");
	process.exit(2);
}

function walk(dir) {
	let out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out = out.concat(walk(p));
		else if (e.name.endsWith(".jsonl")) out.push(p);
	}
	return out;
}

const fires = [];
const near = [];
let blocks = 0;

for (const file of walk(root).sort()) {
	let lines;
	try {
		lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
	} catch {
		continue;
	}
	let n = 0;
	for (const raw of lines) {
		n++;
		let entry;
		try {
			entry = JSON.parse(raw);
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type !== "thinking" && block.type !== "text") continue;
			const text = block.type === "thinking" ? block.thinking : block.text;
			if (!text) continue;
			blocks++;

			const det = new LoopDetector();
			let firstWarn = null;
			let firstAbort = null;
			for (let i = 0; i < text.length; i += CHUNK) {
				const hit = det.feed(text.slice(i, i + CHUNK));
				if (!hit) continue;
				if (hit.severity === "warn" && !firstWarn) firstWarn = hit;
				if (hit.severity === "abort" && !firstAbort) firstAbort = hit;
			}
			const tag = `${path.basename(path.dirname(file))}/${path.basename(file).slice(0, 19)}#${n}`;
			if (firstWarn || firstAbort) {
				fires.push({ tag, type: block.type, len: text.length, warn: firstWarn, abort: firstAbort });
			} else if (text.length >= 1500) {
				const lns = text.split("\n").map((s) => s.trim()).filter(Boolean);
				let best = null;
				const step = Math.max(1, Math.floor(lns.length / 40));
				for (let end = Math.min(lns.length, 40); end <= lns.length; end += step) {
					const st = windowStats(
						lns.slice(Math.max(0, end - DEFAULT_OPTIONS.maxLines), end),
						DEFAULT_OPTIONS,
					);
					if (st && (!best || st.repeatChars > best.repeatChars)) best = st;
				}
				if (best && best.repeatChars >= 800) near.push({ tag, type: block.type, len: text.length, ...best });
			}
		}
	}
}

console.log(`sessions=${walk(root).length} blocks=${blocks} fires=${fires.length}\n`);
fires.sort((a, b) => (b.abort?.repeatChars ?? b.warn.repeatChars) - (a.abort?.repeatChars ?? a.warn.repeatChars));
for (const f of fires) {
	const w = f.warn ?? f.abort;
	const line = (h) =>
		`rep=${h.repeatChars}C/${h.repeatLines}L alpha=${h.alphabet} avg=${h.avgLineChars} intr=${h.intruderRatio}`;
	console.log(`FIRE ${f.tag} ${f.type} len=${f.len}`);
	console.log(`  warn@${w.offset} ${line(w)} :: ${JSON.stringify(w.samples)}`);
	console.log(f.abort ? `  ABORT@${f.abort.offset} ${line(f.abort)}` : "  （未达中止级）");
}

near.sort((a, b) => b.repeatChars - a.repeatChars);
console.log(`\n--- 未命中块的最强重复窗口 TOP 15（都在门槛之下）---`);
for (const r of near.slice(0, 15)) {
	console.log(
		`  rep=${r.repeatChars}C/${r.repeatLines}L alpha=${r.alphabet} avg=${r.avgLineChars.toFixed(1)} intr=${r.intruderRatio.toFixed(3)} len=${r.len} ${r.tag} ${r.type} :: ${JSON.stringify(r.samples.map((s) => s.slice(0, 28)))}`,
	);
}
