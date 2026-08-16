// frontmatter.ts — SKILL.md YAML frontmatter 解析（支持块标量折叠）
//
// 第三方技能大量使用 `description: >-` / `description: >` 折叠块；简单正则会把
// 块标记 `>-` 解析成字面 ">-"（摘要显示成「大于号+减号」）。此处实现 YAML
// 块标量语义（> 折叠 / | 字面，- strip / + keep）。

export interface Frontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
}

/** YAML 折叠块标量标记 */
const BLOCK_SCALAR_RE = /^([a-zA-Z0-9_-]+):\s*(>|\||>\||>-|\|\+|\|-)\s*$/;

/** 拼接折叠块内容 */
function joinBlockScalar(lines: string[], kind: string): string {
	let start = 0;
	while (start < lines.length && lines[start].trim() === "") start++;
	const content = lines.slice(start);
	if (content.length === 0) return "";
	const baseIndent = content[0].match(/^\s*/)?.[0].length ?? 0;
	const body = content
		.map((line) => (line.trim() === "" ? "" : line.slice(baseIndent)))
		.join("\n");
	const isLiteral = kind.startsWith("|");
	const strip = kind.endsWith("-");
	if (isLiteral) {
		return strip ? body.replace(/\n+$/, "") : body.replace(/\n+$/, "\n");
	}
	// 折叠块：非空行间换行 → 空格，空行保留
	const folded = body
		.split("\n")
		.map((line, i, arr) => {
			if (line === "") return "\n";
			if (i > 0 && arr[i - 1] !== "" && !line.endsWith(" ")) return " " + line;
			return line;
		})
		.join("");
	return (strip ? folded.replace(/\s+$/, "") : folded.replace(/\s+$/, "") + "\n");
}

/** 解析 frontmatter（--- 之间的 key: value + 块标量）；返回 frontmatter 与正文 */
export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
	const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
	if (!m) return { frontmatter: {}, body: content };
	const fm: Frontmatter = {};
	const lines = m[1].split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const block = BLOCK_SCALAR_RE.exec(line.trim());
		if (block) {
			const collected: string[] = [];
			let j = i + 1;
			while (j < lines.length && (lines[j].startsWith(" ") || lines[j].startsWith("\t") || lines[j].trim() === "")) {
				collected.push(lines[j]);
				j++;
			}
			fm[block[1] as keyof Frontmatter] = joinBlockScalar(collected, block[2]) as never;
			i = j;
			continue;
		}
		const kv = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line.trim());
		if (kv) {
			const value = kv[2].trim();
			if (value === "true") fm[kv[1] as keyof Frontmatter] = true as never;
			else if (value === "false") fm[kv[1] as keyof Frontmatter] = false as never;
			else fm[kv[1] as keyof Frontmatter] = value.replace(/^["']|["']$/g, "") as never;
		}
		i++;
	}
	return { frontmatter: fm, body: m[2] };
}
