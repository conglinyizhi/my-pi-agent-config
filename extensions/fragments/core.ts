// extensions/fragments/core.ts — 输入框 `&碎片` 的纯逻辑：读配置、找触发、展开、写回
//
// 这里不碰 pi API：解析、触发扫描、展开、序列化都是纯函数，好测。
// 喂给模型之前把 `&名字` 换成片段正文的事在 index.ts 里接 input 事件做；
// /frag:add 的两个 TUI 也在 index.ts，落盘这一段（落成什么字面量、怎么原子替换）在这里。

import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";

export interface Fragment {
	name: string;
	/** 别的触发词，都能展开到同一条正文（改内容只改一处） */
	aliases?: string[];
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

/** 一条碎片能响应的全部触发词：主名 + 别名 */
export function triggerNames(fragment: Fragment): string[] {
	return [fragment.name, ...(fragment.aliases ?? [])];
}

/** 解析配置文本。`[[fragment]]` 数组表，每项 name / aliases? / desc? / text */
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

		const aliases: string[] = [];
		if (record.aliases !== undefined) {
			if (!Array.isArray(record.aliases)) {
				problems.push(`${where}（${name}）的 aliases 要写成字符串数组`);
				return;
			}
			for (const raw of record.aliases) {
				if (typeof raw !== "string" || raw.trim() === "") {
					problems.push(`${where}（${name}）的别名里有空值，已跳过`);
					continue;
				}
				if (/\s/.test(raw)) {
					problems.push(`${where}（${name}）的别名「${raw}」里有空白，& 后面打不出来，已跳过`);
					continue;
				}
				if (raw === name) continue; // 与主名一样，不必重复
				if (seen.has(raw)) {
					problems.push(`${where}（${name}）的别名「${raw}」和已有的名字或别名重复，已跳过`);
					continue;
				}
				seen.add(raw);
				aliases.push(raw);
			}
		}
		fragments.push({
			name,
			...(aliases.length > 0 ? { aliases } : {}),
			...(typeof desc === "string" && desc !== "" ? { desc } : {}),
			text,
		});
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
	return fragments.find((fragment) => triggerNames(fragment).includes(name));
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
	const byName = new Map<string, Fragment>();
	for (const fragment of fragments) {
		for (const key of triggerNames(fragment)) if (!byName.has(key)) byName.set(key, fragment);
	}
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

// ── 写配置：/frag:add 的落盘那一段 ──

/**
 * 名字允许的字符，跟展开时的触发扫描同一套（见上面的 NAME_CHAR）。
 * 不在这套字符里的名字 `&` 后面根本打不出来，写进去也是死条目，所以这里直接拦下。
 */
const NAME_ALLOWED = /^[\p{L}\p{N}_-]+$/u;

/** 不能直接落进 TOML 字符串的控制字符（换行与制表符另算，它们有合法的写法） */
const CTRL_CHAR = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** 转义 TOML 基本字符串里的字符；keepNewline 为真时换行/制表符原样留在多行字符串里 */
function escapeBasic(value: string, keepNewline: boolean): string {
	let out = "";
	for (const ch of value) {
		if (ch === "\\") out += "\\\\";
		else if (ch === '"') out += '\\"';
		else if (ch === "\n") out += keepNewline ? "\n" : "\\n";
		else if (ch === "\t") out += keepNewline ? "\t" : "\\t";
		else if (ch === "\r") out += "\\r";
		else if (CTRL_CHAR.test(ch)) out += `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
		else out += ch;
	}
	return out;
}

/**
 * 把一个值编码成 TOML 字符串字面量（含引号）。挑形状只看一件事：读回来必须一模一样。
 *
 * - 单行、无控制字符：普通字符串 `"..."`，该转的都转掉
 * - 多行、正文里没连写三个单引号、也没控制字符：多行字面量 `'''...'''`，正文原样躺在文件里最好读。
 *   按 TOML 规则开引号后紧跟着的那个换行会被吃掉，所以正文哪怕以换行开头也不会丢字符
 * - 其余（含 `'''`、或含制表符以外的控制字符）：多行基本字符串 `"""..."""`，
 *   正文里的 `"` 与 `\` 全部转义。正文里连写多少个引号都顶不掉收尾的分隔符
 */
export function encodeTomlString(value: string): string {
	if (!value.includes("\n") && !CTRL_CHAR.test(value)) return `"${escapeBasic(value, false)}"`;
	if (!value.includes("'''") && !CTRL_CHAR.test(value)) return `'''\n${value}'''`;
	return `"""\n${escapeBasic(value, true)}"""`;
}

/** 一条碎片拼成一个 TOML 块（含结尾换行），字段顺序照 README 里的例子 */
export function formatFragmentBlock(fragment: Fragment): string {
	const lines = ["[[fragment]]", `name = ${encodeTomlString(fragment.name)}`];
	if (fragment.aliases && fragment.aliases.length > 0) {
		lines.push(`aliases = [${fragment.aliases.map((alias) => encodeTomlString(alias)).join(", ")}]`);
	}
	if (fragment.desc !== undefined && fragment.desc !== "") lines.push(`desc = ${encodeTomlString(fragment.desc)}`);
	lines.push(`text = ${encodeTomlString(fragment.text)}`);
	return `${lines.join("\n")}\n`;
}

/** 追加到原文末尾：原文尾部的空白先去掉，块与块之间空一行 */
export function appendFragmentText(tomlText: string, fragment: Fragment): string {
	const head = tomlText.replace(/\s+$/, "");
	const block = formatFragmentBlock(fragment);
	return head === "" ? block : `${head}\n\n${block}`;
}

export type FragmentWriteResult = { ok: true; fragment: Fragment } | { ok: false; reason: string };

/** 名字这一项的问题；没问题返回 undefined。重名与撞别名都算（撞了的话 & 名字 会先命中别人） */
export function checkFragmentName(name: string, existing: Fragment[]): string | undefined {
	const trimmed = name.trim();
	if (trimmed === "") return "名字不能为空";
	if (/\s/.test(trimmed)) return `名字里不能有空白（${trimmed}）`;
	if (!NAME_ALLOWED.test(trimmed)) return `名字只能用字母、数字、下划线、连字符，${trimmed} 打不出 & 触发`;
	const clash = existing.find((fragment) => triggerNames(fragment).includes(trimmed));
	if (!clash) return undefined;
	return clash.name === trimmed ? `已经有 &${trimmed} 了` : `&${trimmed} 已经是 ${clash.name} 的别名了`;
}

/** 校验一条待写入的碎片：名字、正文都在这里过一遍；名字与描述两端空白去掉 */
export function validateNewFragment(
	name: string,
	desc: string,
	text: string,
	existing: Fragment[],
): FragmentWriteResult {
	const problem = checkFragmentName(name, existing);
	if (problem !== undefined) return { ok: false, reason: problem };
	if (text.trim() === "") return { ok: false, reason: "正文不能为空" };
	const trimmedName = name.trim();
	const trimmedDesc = desc.trim();
	return {
		ok: true,
		fragment: { name: trimmedName, ...(trimmedDesc === "" ? {} : { desc: trimmedDesc }), text },
	};
}

/** 读配置原文；文件不在就当空的（还没建过），别的读不动原因要上报，不能当空覆盖 */
function readConfigText(path: string): { ok: true; text: string } | { ok: false; reason: string } {
	try {
		return { ok: true, text: readFileSync(path, "utf8") };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: true, text: "" };
		return { ok: false, reason: `读不了 ${path}：${err instanceof Error ? err.message : String(err)}` };
	}
}

/** 原文件的权限位；文件不在就按默认的 0644 */
function fileMode(path: string): number {
	try {
		return statSync(path).mode & 0o777;
	} catch {
		return 0o644;
	}
}

/**
 * 往配置里加一条：读原文 → 校验 → 追加块 → 写临时文件再 rename。
 *
 * 失败只说原因，一个字节都不落盘：写得中途炸了也只炸临时文件，配置要么是旧的要么是新的，
 * 不会留下半个块。校验用的 existing 就是原文解析出来的，重名在这里再拦一道。
 */
export function addFragmentToFile(
	path: string,
	input: { name: string; desc?: string; text: string },
): FragmentWriteResult {
	const read = readConfigText(path);
	if (!read.ok) return read;
	const parsed = parseFragments(read.text);
	// 原文解析不了时追加会把坏内容一起带下去，先让用户去修
	const broken = parsed.problems.find((problem) => problem.startsWith("TOML 解析失败"));
	if (broken !== undefined) return { ok: false, reason: `${basename(path)} 现在解析不了（${broken}），先修好再写` };

	const checked = validateNewFragment(input.name, input.desc ?? "", input.text, parsed.fragments);
	if (!checked.ok) return checked;

	const next = appendFragmentText(read.text, checked.fragment);
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	const mode = fileMode(path);
	try {
		writeFileSync(tmp, next, { encoding: "utf8", mode });
		chmodSync(tmp, mode); // umask 可能削掉权限位，按原文件的来
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// 临时文件没建起来（比如目录就不可写），没东西可清
		}
		return { ok: false, reason: `写不进去：${err instanceof Error ? err.message : String(err)}` };
	}
	return checked;
}
