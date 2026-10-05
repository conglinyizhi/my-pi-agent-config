// shell-breaks.js — shell 命令的软换行点：; | && || 之后断开
//
// 为什么在显示层做：bash 的 command 是一长条单色文本，读起来费劲。
// 只算断点、不动文本——偏移一切照旧，高亮/标记都还能对上。

/** 引号外、非注释里的分隔符后面那几个偏移，可以用来换行 */
export function shellBreakPoints(text) {
	const source = typeof text === "string" ? text : "";
	const points = [];
	let quote = "";
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (quote !== "") {
			if (ch === "\\" && quote !== "'") { i += 2; continue; }
			if (ch === quote) quote = "";
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") { quote = ch; i++; continue; }
		if (ch === "#" && (i === 0 || /\s/.test(source[i - 1]))) {
			const nl = source.indexOf("\n", i);
			i = nl < 0 ? source.length : nl;
			continue;
		}
		if (ch === ";") { points.push(i + 1); i++; continue; }
		if (ch === "|" || ch === "&") {
			let end = i + 1;
			if (source[end] === ch) end++;   // && 与 ||
			// 单独的 & 也算分隔（后台执行），单个 | 是管道
			points.push(end);
			i = end;
			continue;
		}
		i++;
	}
	return points;
}
