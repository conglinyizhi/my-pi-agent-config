// extensions/fragments/core.ts — 输入框 `&碎片` 的纯逻辑：读配置、找触发、展开
//
// 这里不碰 pi API：解析、触发扫描、展开都是纯函数，好测。
// 喂给模型之前把 `&名字` 换成片段正文的事在 index.ts 里接 input 事件做。

import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

export interface Fragment {
	name: string;
	/** 可选描述，用来给 autocomplete 与 /frag:list 看 */
	desc?: string;
	/** 正文，随便多少行 */
	text: string;
}

export interface FragmentFile {
	fragments: Fragment[];
	/** 配置本身的问题（缺 name/text、名字重了之类），给用户看的一句话 */
	problems: string[];
	/** 文件不存在：还没建过，不算错 */
	missing?: boolean;
	/** 读不动或解析不了 */
	error?: string;
}

/**
 * 名字允许的字符：字母、数字、下划线、连字符，外加中日韩等广义字母（\p{L} 覆盖）。
 * `&` 后面必须紧跟这些字符才算触发，所以 `&&` 与 URL 里的 `&x=1` 不会命中。
 */
const NAME_CHAR = /[\p{L}\p{N}_-]/u;

/** 解析配置文本。`[[fragment]]` 数组表，每项 name / desc? / text */
export function parseFragments(tomlText: string): { fragments: Fragment[]; problems: string[] } {
	let parsed: unknown;
	try {
		parsed = parseToml(tomlText);
	} catch (err) {
		return { fragments: [], problems: [`TOML 解析失败：${err instanceof Error ? err.message : String(err)}`] };
	}
	if (!parsed || typeof parsed !== "object") return { fragments: [], problems: [] };
	const raw = (parsed as { fragment?: unknown }).fragment;
	if (raw === undefined) return { fragments: [], problems: [] };
	if (!Array.isArray(raw)) return { fragments: [], problems: ["fragment 要写成数组表 [[fragment]]"] };

	const fragments: Fragment[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	raw.forEach((item, index) => {
		const where = `第 ${index + 1} 条 fragment`;
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			problems.push(`${where} 不是表`);
			return;
		}
		const record = item as Record<string, unknown>;
		const name = record.name;
		const text = record.text;
		const desc = record.desc;
		if (typeof name !== "string" || name.trim() === "") {
			problems.push(`${where} 缺少 name`);
			return;
		}
		if (/\s/.test(name)) {
			problems.push(`${where} 的名字里有空白（${name}），& 后面打不出来，已跳过`);
			return;
		}
		if (typeof text !== "string" || text === "") {
			problems.push(`${where}（${name}）缺少 text`);
			return;
		}
		if (seen.has(name)) {
			problems.push(`${where} 的名字重复（${name}），保留前面那条`);
			return;
		}
		seen.add(name);
		fragments.push({ name, ...(typeof desc === "string" && desc !== "" ? { desc } : {}), text });
	});
	return { fragments, problems };
}

/** 读配置文件；文件不在不算错（还没建过），读不动/解析不了算错 */
export function loadFragments(path: string): FragmentFile {
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { fragments: [], problems: [], missing: true };
		return { fragments: [], problems: [], error: `读不了 ${path}：${err instanceof Error ? err.message : String(err)}` };
	}
	const parsed = parseFragments(text);
	return { fragments: parsed.fragments, problems: parsed.problems };
}

export function findFragment(fragments: Fragment[], name: string): Fragment | undefined {
	return fragments.find((fragment) => fragment.name === name);
}

/** 触发只认「行首或空白后的 &名字」；`&&`、`a & b`、URL 里的 `&` 都不算 */
function isTriggerAt(line: string, index: number): boolean {
	if (index === 0) return true;
	return /\s/.test(line[index - 1]);
}

function expandLine(line: string, byName: Map<string, Fragment>, expanded: string[], unknown: string[]): string {
	let result = "";
	let i = 0;
	let inCode = false;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "`") {
			inCode = !inCode;
			result += ch;
			i++;
			continue;
		}
		if (ch === "&" && !inCode && isTriggerAt(line, i)) {
			let j = i + 1;
			while (j < line.length && NAME_CHAR.test(line[j])) j++;
			const name = line.slice(i + 1, j);
			if (name !== "") {
				const fragment = byName.get(name);
				if (fragment) {
					expanded.push(name);
					result += fragment.text;
					i = j;
					continue;
				}
				unknown.push(name);
			}
		}
		result += ch;
		i++;
	}
	return result;
}

/**
 * 展开文本里的 `&名字`。
 *
 * - 只认行首/空白后的 `&名字`（`&&`、`a & b` 不碰）
 * - 跳过 fenced 代码块与行内反引号里的内容（贴 shell 代码时不误伤）
 * - 没定义的名字原样留在文本里，只在外层提示一次
 * - 单趟展开：片段正文里再写 `&xxx` 不会继续展开
 */
export function expandFragments(
	text: string,
	fragments: Fragment[],
): { text: string; expanded: string[]; unknown: string[] } {
	if (text === "" || fragments.length === 0) {
		const unknown: string[] = [];
		if (fragments.length === 0) for (const name of collectNames(text)) unknown.push(name);
		return { text, expanded: [], unknown: [...new Set(unknown)] };
	}
	const byName = new Map(fragments.map((fragment) => [fragment.name, fragment]));
	const expanded: string[] = [];
	const unknown: string[] = [];
	let inFence = false;
	const lines = text.split("\n").map((line) => {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			return line;
		}
		if (inFence) return line;
		return expandLine(line, byName, expanded, unknown);
	});
	return { text: lines.join("\n"), expanded: [...new Set(expanded)], unknown: [...new Set(unknown)] };
}

/** 只找名字不替换：配置为空时也要能提示「你写的这些名字一个都没有」 */
function collectNames(text: string): string[] {
	const names: string[] = [];
	let inFence = false;
	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		let i = 0;
		let inCode = false;
		while (i < line.length) {
			const ch = line[i];
			if (ch === "`") {
				inCode = !inCode;
				i++;
				continue;
			}
			if (ch === "&" && !inCode && isTriggerAt(line, i)) {
				let j = i + 1;
				while (j < line.length && NAME_CHAR.test(line[j])) j++;
				if (j > i + 1) names.push(line.slice(i + 1, j));
				i = j;
				continue;
			}
			i++;
		}
	}
	return names;
}
