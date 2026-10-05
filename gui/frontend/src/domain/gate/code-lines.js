// code-lines.js — 把折叠后的分段切成"带行号的显示行"
//
// 为什么要切：静态扫描报的是行号，代码区却是一整块 <pre>，用户没法数。
// 切的时候必须把高亮（shiki 令牌）与标记（规则/变量/路径）的偏移重新对上：
// 它们的偏移相对整段文本，切完要变成相对每一行。

/** 把一组区间裁到 [from,to) 并平移，只留真正落在这一段里的 */
function clip(ranges, from, to) {
	const out = [];
	for (const range of Array.isArray(ranges) ? ranges : []) {
		if (!range || typeof range.s !== "number" || typeof range.e !== "number") continue;
		const s = Math.max(range.s, from);
		const e = Math.min(range.e, to);
		if (e <= s) continue;
		out.push({ ...range, s: s - from, e: e - from });
	}
	return out;
}

/**
 * segments（折叠模型的输出）→ 显示行。
 * 文本分段按换行拆，芯片整颗留在它所在的行里；tokens 是整段文本上的令牌。
 */
export function splitLines(segments, tokens, breaks = []) {
	// 软换行点（shell 的 ; | && 之后）：另起一行读起来清楚，但不另占行号——
	// 行号是给"第几行"用的，软换行把它撑开会和别处对不上
	const breakSet = new Set(Array.isArray(breaks) ? breaks : []);
	// 行号按"未折叠"的文本数：扫描报的行号是按那份算的，折起来的块照占它的行数，
	// 否则折一次后面全错位（提督提醒的）
	let nextNo = 1;
	const startLine = () => {
		const line = { no: nextNo, parts: [] };
		nextNo += 1;
		lines.push(line);
		return line;
	};
	const lines = [];
	let current = startLine();
	for (const segment of Array.isArray(segments) ? segments : []) {
		if (segment?.kind === "chip") {
			current.parts.push({ kind: "chip", chip: segment.chip });
			const swallowed = Number(segment.chip?.lines ?? segment.chip?.call?.lines ?? 1) - 1;
			if (swallowed > 0) nextNo += swallowed;
			continue;
		}
		const text = String(segment?.text ?? "");
		const base = typeof segment?.start === "number" ? segment.start : 0;
		let offset = 0;
		text.split("\n").forEach((part, index) => {
			if (index > 0) current = startLine();
			if (part.length > 0) {
				// 两套坐标：tokens 是整段文本上的（要加 base），marks 已被折叠模型平移到片段内
				const cuts = [];
				for (let k = 0; k < part.length; k++) {
					if (breakSet.has(base + offset + k + 1) && k + 1 < part.length) cuts.push(k + 1);
				}
				let cursor = 0;
				for (const stop of cuts.concat([part.length])) {
					if (stop > cursor) {
						current.parts.push({
							kind: "text",
							text: part.slice(cursor, stop),
							tokens: clip(tokens, base + offset + cursor, base + offset + stop),
							marks: clip(segment?.marks, offset + cursor, offset + stop),
						});
					}
					if (stop < part.length) {
						const row = { no: null, soft: true, parts: [] };
						lines.push(row);
						current = row;
					}
					cursor = stop;
				}
			}
			offset += part.length + 1;
		});
	}
	return lines;
}
