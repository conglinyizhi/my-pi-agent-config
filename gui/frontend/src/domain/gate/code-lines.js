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
export function splitLines(segments, tokens) {
	const lines = [{ no: 1, parts: [] }];
	let current = lines[0];
	for (const segment of Array.isArray(segments) ? segments : []) {
		if (segment?.kind === "chip") {
			current.parts.push({ kind: "chip", chip: segment.chip });
			continue;
		}
		const text = String(segment?.text ?? "");
		const base = typeof segment?.start === "number" ? segment.start : 0;
		let offset = 0;
		text.split("\n").forEach((part, index) => {
			if (index > 0) {
				current = { no: lines.length + 1, parts: [] };
				lines.push(current);
			}
			if (part.length > 0) {
				const from = base + offset;
				const to = from + part.length;
				current.parts.push({
					kind: "text",
					text: part,
					tokens: clip(tokens, from, to),
					marks: clip(segment?.marks, from, to),
				});
			}
			offset += part.length + 1;
		});
	}
	return lines;
}
