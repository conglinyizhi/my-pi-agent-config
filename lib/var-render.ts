// lib/var-render.ts — 命令里变量引用处的静态渲染
//
// 干什么：把命令里 `$NAME` 这类引用在**引用处**渲染成可静态确定的值。三个出口共用同一份结果：
//   1 lib/preshell.ts 的 formatFacts      → LLM 预审（「程序：$P（/usr/bin/jq）」+ 变量表）
//   2 lib/approval-channel.ts 的 varRenders → 审批窗（前端标蓝/标灰，按 target 在命令里定位）
//   3 rule-engine 的 dynamic-construct 收窄：能确定程序名时不再按「未知动态构造」报，
//     改出一条 dynamic-construct-narrowed 规则（仍要过 LLM 预审，见 lib/sandbox-check.ts）
//
// 值的优先级：本命令内成立的赋值 > 环境变量（process.env）> 渲不出来（known:false + reason）。
//
// 作用域按 bash 的真实行为（每条边界都有单测，实测过 bash 的输出）：
//   - `A=1 && echo $A` / `A=1; echo $A` / 换行后 / `export A=1` 之后的引用 → 可渲染
//   - `A=1 B=$A`：同一段里左边先赋值、右边再取值（bash 实测 B=1）→ 可渲染
//   - `export A=1 B=$A`：export 的参数**先**整体展开，赋值后生效（bash 实测 B 为空）→ 不可渲染
//   - `A=1 cmd $A`（前置赋值，同一个 simple command）：参数展开先于赋值生效 → 不可渲染
//   - `echo $A && A=1`（引用在赋值之前）→ 不可渲染
//   - `$1` / `$@` / `$?` 这类特殊参数、`${A:-x}` 这类不支持的展开 → 不可渲染
//   - 同名多次赋值、`unset`、子 shell（`(...)`，含 `$()`）里的赋值、命令替换、单引号里的字面量
//     → 不可渲染
// 拿不准一律 known:false + reason：宁可少渲染，不能渲染错（渲染错会把不该放的命令放过去）。
//
// 不含任何 I/O：只看文本 + 读传进来的 env。target 是命令文本片段，偏移不进 payload
// （审批窗自己按 target 定位；见 wails-gui/frontend/src/domain/gate/var-renders.js）。

import { maskHeredocBodies } from "../extensions/sandbox-permissions/scanner.ts";
import { expandValue, parseValue } from "./env-notes.ts";

export type VarRenderSource = "assignment" | "env";

/**
 * 一条变量渲染。字段名与取值是审批窗的集成契约（前端已照这个形状实现），改动会让集成失败：
 *   known:true  → {name, value, source, target, kind, known}
 *   known:false → {name, reason, target, kind, known}
 */
export interface VarRender {
	/** 变量名 */
	name: string;
	/** 这条渲染对应的命令文本片段（前端按它在命令里定位、画框） */
	target: string;
	/** 引用出现在命令的什么位置：Exec = 命令名位置，Unknown = 参数位置 */
	kind: string;
	known: boolean;
	/** 渲染出来的值（known:true 才有） */
	value?: string;
	/** 值从哪来（known:true 才有） */
	source?: VarRenderSource;
	/** 渲染不了的一句话原因（known:false 才有） */
	reason?: string;
}

/** 带上命令内偏移的渲染结果（内部与测试用；不进 payload） */
export interface VarRenderSite extends VarRender {
	start: number;
	end: number;
}

/** 一次最多这么多条：与 lib/env-notes.ts 的 MAX_NOTES 同值，前端也按 20 截 */
export const MAX_RENDERS = 20;

/** 一个变量在某一处引用点能拿到的值 */
export type StaticValue =
	| { known: true; value: string; source: VarRenderSource }
	| { known: false; reason: string };

// ── 命令结构扫描 ──

/** 命令位置上会出现、但后面仍然是命令的 shell 关键字（`then FOO=1 cmd` 这种也要认出来） */
const KEYWORDS = new Set(["!", "time", "then", "do", "else", "elif", "if", "while", "until", "in", "{"]);
/** 会改变 shell 当前目录的程序：它们的引用点之后 `$PWD` 不再是起始目录 */
const CD_PROGRAMS = new Set(["cd", "pushd", "popd"]);
/** 词的定界符（shell 里这些字符不用空白分隔） */
const SEP_CHARS = new Set([";", "|", "&", "(", ")", "{", "}", "<", ">"]);

interface Word {
	text: string;
	start: number;
	end: number;
	/** 子 shell / 命令替换的嵌套深度：>0 的赋值不会外泄，一律不当作用域依据 */
	depth: number;
}

type Tok =
	| { kind: "word"; word: Word }
	| { kind: "sep"; text: string; start: number; end: number; depth: number; command: boolean };

type Quote = "none" | "single" | "double";

interface Binding {
	name: string;
	/** 值文本（去外层引号）：渲不出来时它就是要给人定位的片段 */
	valueText: string;
	start: number;
	end: number;
	kind: "assignment" | "export" | "prefix";
	/** 所在分段序号：export 的赋值只对**后面的**段生效 */
	segment: number;
	body: string;
	quote: Quote;
	/** 引号没闭合这类，直接判渲不出来 */
	parseError?: string;
	value: StaticValue;
}

interface RefSite {
	name: string;
	/** 引用原文（`$P` / `${P}`） */
	text: string;
	start: number;
	end: number;
	/** 所在分段（-1 = 在子 shell / 命令替换里，拿不到段作用域） */
	segment: number;
	/** 是不是出现在命令名位置（决定 kind：Exec / Unknown） */
	commandPosition: boolean;
	/** 特殊参数（$1 / $@ / $? 这类） */
	special: boolean;
	unsupported?: string;
}

function isWs(ch: string | undefined): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * 环境变量得是字符串才算数。`env[name]` 在原型链上可能摸到 Object.prototype 的东西
 * （`$constructor` 会拿到构造函数），那不是一个变量的值。
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name];
	return typeof value === "string" ? value : undefined;
}

function isIdentStart(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z_]/.test(ch);
}

function isIdentChar(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/** `NAME=VALUE` 形态的词（只认赋值，不做别的解释） */
function isAssignmentWord(text: string): boolean {
	const eq = text.indexOf("=");
	return eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(text.slice(0, eq));
}

/** 跳过一对括号（`(` 起，含嵌套；里面的引号照 shell 规则跳过），返回 `)` 之后 */
function skipBalancedParen(text: string, open: number): number {
	let depth = 0;
	let i = open;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'") {
			const end = text.indexOf("'", i + 1);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (ch === '"') {
			i = skipDoubleQuoted(text, i + 1);
			continue;
		}
		if (ch === "`") {
			const end = text.indexOf("`", i + 1);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
		i++;
	}
	return text.length;
}

/** 双引号内的内容：i 指向内容开头，返回右引号之后（没闭合就当到文本末尾） */
function skipDoubleQuoted(text: string, i: number): number {
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			i = skipBalancedParen(text, i + 1);
			continue;
		}
		if (ch === "`") {
			const end = text.indexOf("`", i + 1);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (ch === '"') return i + 1;
		i++;
	}
	return text.length;
}

/** 读一个词的结束位置：引号、转义、`$(...)`、`${...}` 里的分隔符都不是词的边界 */
function readWordEnd(text: string, start: number): number {
	let i = start;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'") {
			const end = text.indexOf("'", i + 1);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (ch === '"') {
			i = skipDoubleQuoted(text, i + 1);
			continue;
		}
		if (ch === "`") {
			const end = text.indexOf("`", i + 1);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			i = skipBalancedParen(text, i + 1);
			continue;
		}
		if (ch === "$" && text[i + 1] === "{") {
			const end = text.indexOf("}", i + 2);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (isWs(ch) || SEP_CHARS.has(ch)) break;
		i++;
	}
	return i;
}

/** 命令 → 词与分隔符（带嵌套深度；偏移与原文一致） */
function scanTokens(text: string): Tok[] {
	const toks: Tok[] = [];
	let i = 0;
	let depth = 0;
	while (i < text.length) {
		const ch = text[i];
		if (isWs(ch)) {
			// 换行本身就是命令分隔符（`A=1\necho $A` 是两条命令）
			if (ch === "\n") toks.push({ kind: "sep", text: ch, start: i, end: i + 1, depth, command: true });
			i++;
			continue;
		}
		if (!SEP_CHARS.has(ch)) {
			const end = readWordEnd(text, i);
			if (end > i) {
				toks.push({ kind: "word", word: { text: text.slice(i, end), start: i, end, depth } });
				i = end;
				continue;
			}
			i++;
			continue;
		}
		let end = i + 1;
		let command = true;
		if (ch === "&") {
			if (text[i + 1] === "&") end = i + 2;
		} else if (ch === "|") {
			if (text[i + 1] === "|") end = i + 2;
		} else if (ch === "<" || ch === ">") {
			// 重定向：`2>&1` 里的 `&` 属于重定向，不能当命令分隔符
			command = false;
			while (end < text.length && (text[end] === ">" || text[end] === "<" || text[end] === "&" || text[end] === "|")) end++;
		} else if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth = Math.max(0, depth - 1);
		}
		toks.push({ kind: "sep", text: text.slice(i, end), start: i, end, depth, command });
		i = end;
	}
	return toks;
}

/**
 * `\` + 换行是续行：换行不切开命令（`A=1 \` 换行 `&& echo $A` 里 A 是独立赋值）。
 * 换成两个空格，坐标不变；单引号里的反斜杠是字面量，换了也不影响那个字符串的边界。
 */
function stripLineContinuations(text: string): string {
	return text.replace(/\\\n/g, "  ");
}

/** 函数定义的正文不会在定义时执行：整段遮成空格（偏移不变），免得把里面的赋值当作用域依据 */
const FUNCTION_DEF = /(?:^|[\s;&|(])(?:function\s+[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\))\s*\{/g;

function maskFunctionBodies(text: string): string {
	const chars = text.split("");
	FUNCTION_DEF.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FUNCTION_DEF.exec(text)) !== null) {
		const open = m.index + m[0].length - 1; // 匹配以 '{' 结尾
		if (text[open] !== "{") continue;
		let depth = 0;
		let i = open;
		let closed = -1;
		while (i < text.length) {
			const ch = text[i];
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === "'") {
				const end = text.indexOf("'", i + 1);
				i = end === -1 ? text.length : end + 1;
				continue;
			}
			if (ch === '"') {
				i = skipDoubleQuoted(text, i + 1);
				continue;
			}
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					closed = i;
					break;
				}
			}
			i++;
		}
		const stop = closed === -1 ? text.length - 1 : closed;
		for (let j = open; j <= stop; j++) chars[j] = " ";
	}
	return chars.join("");
}

interface Segment {
	index: number;
	words: Word[];
	/** 段内命令名那个词的起点（undefined = 整段都是赋值/空） */
	commandStart?: number;
}

/** 按命令分隔符切段（只用 depth 0 的词：子 shell 里的赋值不参与作用域） */
function splitSegments(toks: Tok[]): Segment[] {
	const segments: Segment[] = [];
	let current: Word[] = [];
	const flush = () => {
		if (current.length > 0) segments.push({ index: segments.length, words: current });
		current = [];
	};
	for (const tok of toks) {
		if (tok.kind === "sep") {
			if (tok.command && tok.depth === 0) flush();
			continue;
		}
		if (tok.word.depth > 0) continue;
		current.push(tok.word);
	}
	flush();
	return segments;
}

// ── 变量引用扫描 ──

/** 特殊参数：位置参数与状态变量，环境里没有、也不该用环境里的同名值冒名顶替 */
const SPECIAL_PARAMS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "@", "*", "#", "?", "$", "!", "-", "_"]);

/** 读一个 `$...` 引用；返回 null 表示这里不是变量引用（`$(` / `$'` / 孤立的 `$`） */
function readReferenceAt(text: string, i: number): Omit<RefSite, "segment" | "commandPosition"> | null {
	const next = text[i + 1];
	if (next === undefined) return null;
	// 命令替换 / 算术展开：里面是另一条命令，值不是「一个变量的值」
	if (next === "(") return null;
	// $'...' / $'...'：字面量字符串
	if (next === "'" || next === '"') return null;
	if (next === "{") {
		const close = text.indexOf("}", i + 2);
		if (close === -1) return null;
		const written = text.slice(i, close + 1);
		const inner = text.slice(i + 2, close);
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) {
			return { name: inner, text: written, start: i, end: close + 1, special: false };
		}
		// `${A:-x}` / `${#A}` / `${A/u/v}` 这类：名字尽量取，值一律不猜
		const lead = /^#?([A-Za-z_][A-Za-z0-9_]*)/.exec(inner);
		return {
			name: lead ? lead[1] : inner,
			text: written,
			start: i,
			end: close + 1,
			special: false,
			unsupported: `不支持的参数展开 ${written}`,
		};
	}
	if (isIdentStart(next)) {
		let j = i + 1;
		while (j < text.length && isIdentChar(text[j])) j++;
		const name = text.slice(i + 1, j);
		return { name, text: text.slice(i, j), start: i, end: j, special: SPECIAL_PARAMS.has(name) };
	}
	if (SPECIAL_PARAMS.has(next)) {
		return { name: next, text: text.slice(i, i + 2), start: i, end: i + 2, special: true };
	}
	return null;
}

/** 扫出所有变量引用（单引号里的是字面量、命令替换里的是另一条命令，都不算） */
function scanRefs(text: string): Array<Omit<RefSite, "segment" | "commandPosition">> {
	const refs: Array<Omit<RefSite, "segment" | "commandPosition">> = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'") {
			const end = text.indexOf("'", i + 1);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (ch === "`") {
			const end = text.indexOf("`", i + 1);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (ch === '"') {
			i = scanRefsInDoubleQuoted(text, i + 1, refs);
			continue;
		}
		if (ch !== "$") {
			i++;
			continue;
		}
		if (text[i + 1] === "(") {
			i = skipBalancedParen(text, i + 1);
			continue;
		}
		const ref = readReferenceAt(text, i);
		if (!ref) {
			i++;
			continue;
		}
		refs.push(ref);
		i = ref.end;
	}
	return refs;
}

function scanRefsInDoubleQuoted(
	text: string,
	start: number,
	out: Array<Omit<RefSite, "segment" | "commandPosition">>,
): number {
	let i = start;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "`") {
			const end = text.indexOf("`", i + 1);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (ch === "$") {
			if (text[i + 1] === "(") {
				i = skipBalancedParen(text, i + 1);
				continue;
			}
			const ref = readReferenceAt(text, i);
			if (ref) {
				out.push(ref);
				i = ref.end;
				continue;
			}
			i++;
			continue;
		}
		if (ch === '"') return i + 1;
		i++;
	}
	return text.length;
}

// ── 分段作用域 ──

interface Analysis {
	refs: RefSite[];
	bindings: Binding[];
	/** 命令里有 cd 这类改目录的程序：`$PWD` / `$OLDPWD` 静态判不准 */
	dirChanged: boolean;
	/** `unset NAME` 出现过的名字：按保守处理，一律不渲染 */
	cleared: Set<string>;
}

function analyze(command: string, env: NodeJS.ProcessEnv): Analysis {
	const text = typeof command === "string" ? command : "";
	const empty: Analysis = { refs: [], bindings: [], dirChanged: false, cleared: new Set() };
	if (text === "") return empty;
	// heredoc 正文是数据、函数体定义时不执行、`\`+换行是续行（不切开命令）：
	// 都先换成等长空格/空格（坐标不变）
	const masked = maskFunctionBodies(stripLineContinuations(maskHeredocBodies(text)));
	const segments = splitSegments(scanTokens(masked));

	const bindings: Binding[] = [];
	const cleared = new Set<string>();
	let dirChanged = false;

	for (const seg of segments) {
		const words = seg.words;
		let j = 0;
		while (j < words.length && KEYWORDS.has(words[j].text)) j++;
		if (words[j]?.text === "unset") {
			// `unset A` 之后 A 就没了：同名的赋值与引用一律不渲染（保守）
			for (const w of words.slice(j + 1)) {
				if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w.text)) cleared.add(w.text);
			}
		}
		if (words[j]?.text === "export") {
			// export A=1 B=2：赋值对 shell 生效，但它的参数是先整体展开的
			let k = j + 1;
			while (k < words.length && /^-[A-Za-z]/.test(words[k].text)) k++;
			for (; k < words.length; k++) {
				const b = bindingAt(words[k], masked, "export", seg.index);
				if (b) bindings.push(b);
			}
			seg.commandStart = words[j].start;
			continue;
		}
		let k = j;
		const candidates: Word[] = [];
		while (k < words.length && isAssignmentWord(words[k].text)) {
			candidates.push(words[k]);
			k++;
		}
		// 整段都是赋值 = 独立赋值（对后面的段生效）；后面还有词 = 前置赋值（只进那条命令的环境）
		const standalone = k >= words.length;
		for (const w of candidates) {
			const b = bindingAt(w, masked, standalone ? "assignment" : "prefix", seg.index);
			if (b) bindings.push(b);
		}
		const cmdWord = words[k];
		if (cmdWord) {
			seg.commandStart = cmdWord.start;
			// 包装器（builtin cd / command cd）后面那个词也可能是 cd：多看一眼只会更保守
			for (const w of [cmdWord, words[k + 1]]) {
				if (!w) continue;
				const base = w.text.slice(w.text.lastIndexOf("/") + 1);
				if (CD_PROGRAMS.has(base)) dirChanged = true;
			}
		}
	}

	// 赋值在原文里的先后顺序就是它们的生效顺序（同一段里的多个赋值也是从左到右）
	bindings.sort((a, b) => a.start - b.start);

	// 引用 → 所在分段 / 是否命令名位置
	const wordInfo: Array<{ start: number; end: number; segment: number; command: boolean }> = [];
	for (const seg of segments) {
		for (const w of seg.words) {
			wordInfo.push({ start: w.start, end: w.end, segment: seg.index, command: seg.commandStart === w.start });
		}
	}
	wordInfo.sort((a, b) => a.start - b.start);
	const rawRefs = scanRefs(masked);
	const refs: RefSite[] = [];
	let wi = 0;
	for (const ref of rawRefs) {
		while (wi < wordInfo.length && wordInfo[wi].end <= ref.start) wi++;
		const word = wordInfo[wi];
		const inWord = word !== undefined && word.start <= ref.start && ref.start < word.end;
		refs.push({
			...ref,
			segment: inWord ? word.segment : -1,
			commandPosition: Boolean(inWord && word.command),
		});
	}

	// 赋值自己的值：按顺序展开，同一段里前面的赋值能供后面的值引用（bash 实测 `A=1 B=$A` 里 B=1）。
	// export 例外：它的参数是先整体展开的（`export A=1 B=$A` 里 B 拿的是旧值），
	// 所以 export 赋值只看**这一段之前**已经生效的值（segEnv 是段首快照）。
	// 合并环境用原型链（Object.create(env)）而不是复制：process.env 有上百个键，
	// 而且它是个代理，展开一次要枚举所有键（几十微秒）——每个带赋值的命令都付不起。
	// expandValue 只按名字取属性（含 HOME），原型链上查得到，语义与合并后的对象一致。
	let resolvedEnv: NodeJS.ProcessEnv | undefined;
	let segEnv: NodeJS.ProcessEnv | undefined;
	let currentSegment = -1;
	for (const b of bindings) {
		if (b.segment !== currentSegment) {
			currentSegment = b.segment;
			segEnv = undefined;
		}
		if (b.kind === "prefix") continue; // 前置赋值只进那条命令的环境，不外泄也不供引用
		if (b.parseError) {
			b.value = { known: false, reason: b.parseError };
			continue;
		}
		if (b.kind === "export" && segEnv === undefined) {
			segEnv = resolvedEnv === undefined ? env : (Object.create(resolvedEnv) as NodeJS.ProcessEnv);
		}
		const expanded = expandValue(b.body, b.quote, b.kind === "export" ? (segEnv as NodeJS.ProcessEnv) : (resolvedEnv ?? env));
		b.value = expanded.ok ? { known: true, value: expanded.value, source: "assignment" } : { known: false, reason: expanded.reason };
		if (b.value.known) {
			if (resolvedEnv === undefined) resolvedEnv = Object.create(env) as NodeJS.ProcessEnv;
			resolvedEnv[b.name] = b.value.value;
		}
	}

	return { refs, bindings, dirChanged, cleared };
}

function bindingAt(word: Word, text: string, kind: Binding["kind"], segment: number): Binding | null {
	const eq = word.text.indexOf("=");
	if (eq <= 0) return null;
	const name = word.text.slice(0, eq);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
	const valueStart = word.start + eq + 1;
	const parsed = parseValue(text, valueStart);
	if ("error" in parsed) {
		return {
			name,
			valueText: "",
			start: word.start,
			end: word.end,
			kind,
			segment,
			body: "",
			quote: "none",
			parseError: parsed.error,
			value: { known: false, reason: parsed.error },
		};
	}
	return {
		name,
		valueText: parsed.body,
		start: word.start,
		end: Math.max(parsed.end, word.end),
		kind,
		segment,
		body: parsed.body,
		quote: parsed.quote,
		value: { known: false, reason: "" }, // 占位，下面按顺序真算
	};
}

/** 一处引用的解析结果；target 只有「阻塞点在赋值里」时才给（其余用引用原文） */
type Resolution = StaticValue & { target?: string };

function resolveRef(ref: RefSite, a: Analysis, env: NodeJS.ProcessEnv): Resolution {
	if (ref.unsupported) return { known: false, reason: ref.unsupported };
	if (ref.special) return { known: false, reason: `特殊参数 ${ref.text}（位置参数/状态变量）不在环境里，无法静态解析` };
	if (a.cleared.has(ref.name)) return { known: false, reason: `命令里有 unset ${ref.name}，按保守处理不渲染` };
	const list = a.bindings.filter((b) => b.name === ref.name);
	if (list.length > 1) {
		return { known: false, reason: `${ref.name} 在命令里被赋值多次，作用域不好确定，不渲染` };
	}
	const binding = list[0];
	if (binding) {
		if (binding.kind === "prefix") {
			return { known: false, reason: `${ref.name} 是前置赋值（同一 simple command），参数展开先于赋值，这一处拿到的是旧值` };
		}
		if (binding.kind === "export" && binding.segment === ref.segment) {
			return { known: false, reason: `export 的同一段里引用 ${ref.name}：参数先展开、赋值后生效` };
		}
		if (ref.start < binding.end) {
			if (ref.start >= binding.start) {
				return { known: false, reason: `${ref.name} 的赋值里引用了自己，拿不到新值` };
			}
			return { known: false, reason: `引用出现在 ${ref.name} 的赋值之前（同一行从左到右生效）` };
		}
		if (binding.value.known) return { known: true, value: binding.value.value, source: "assignment" };
		// 阻塞点在赋值里：target 指那处值文本（审批窗按它在命令里定位）
		return { known: false, reason: binding.value.reason, target: binding.valueText };
	}
	if ((ref.name === "PWD" || ref.name === "OLDPWD") && a.dirChanged) {
		return { known: false, reason: `${ref.name} 随命令内部 cd 变化，静态判不准` };
	}
	const fromEnv = envValue(env, ref.name);
	if (fromEnv !== undefined) return { known: true, value: fromEnv, source: "env" };
	return { known: false, reason: `环境里没有变量 ${ref.name}，命令里也没有赋值（可能是 shell 会话里定义的）` };
}

function toSite(ref: RefSite, resolved: Resolution): VarRenderSite {
	return {
		name: ref.name,
		target: resolved.target ?? ref.text,
		kind: ref.commandPosition ? "Exec" : "Unknown",
		known: resolved.known,
		start: ref.start,
		end: ref.end,
		...(resolved.known
			? { value: resolved.value, source: resolved.source }
			: { reason: resolved.reason }),
	};
}

/**
 * 命令里所有变量引用处的渲染结果（按命令顺序，同一条重复出现只留一条，最多 MAX_RENDERS 条）。
 * 纯函数：只看文本与传进来的 env，不碰磁盘、不起进程。
 */
export function collectVarRenders(command: string, env: NodeJS.ProcessEnv = process.env): VarRenderSite[] {
	const a = analyze(command, env);
	const out: VarRenderSite[] = [];
	const seen = new Set<string>();
	for (const ref of a.refs) {
		const site = toSite(ref, resolveRef(ref, a, env));
		const key = [site.name, site.target, site.kind, String(site.known), site.known ? site.value : site.reason].join("\u0000");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(site);
		if (out.length >= MAX_RENDERS) break;
	}
	return out;
}

/** 审批 payload 用的形状：去掉内部偏移（前端自己按 target 定位） */
export function varRendersForApproval(command: string, env: NodeJS.ProcessEnv = process.env): VarRender[] {
	return collectVarRenders(command, env).map(({ start: _start, end: _end, ...rest }) => rest);
}

/**
 * 命令名位置的变量引用 → 静态值（供 dynamic-construct 收窄）。
 * 收窄门槛（裸命令名 / 系统 bin 目录）在 rule-engine 那边，本函数只负责给出值。
 *
 * 键是引用原文（`$P` / `${P}`），与 rule-engine 的 token 对得上（那边的 tokenize 去引号，
 * 去掉引号之后正好等于引用原文）。同一段文本在多处引用而结果不一致时一律当未知：
 * 收窄只认唯一确定的值。
 */
export function staticProgramValues(command: string, env: NodeJS.ProcessEnv = process.env): Map<string, StaticValue> {
	const map = new Map<string, StaticValue>();
	for (const site of collectVarRenders(command, env)) {
		if (site.kind !== "Exec") continue;
		const value: StaticValue = site.known
			? { known: true, value: site.value ?? "", source: site.source ?? "env" }
			: { known: false, reason: site.reason ?? "" };
		const prev = map.get(site.target);
		if (prev === undefined) {
			map.set(site.target, value);
			continue;
		}
		if (!prev.known || !value.known || prev.value !== value.value) {
			map.set(site.target, { known: false, reason: "同一条引用在命令里出现多次且结果不一致" });
		}
	}
	return map;
}

const IDENT_REF = /^\$?[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 渲染片段在文本里出现吗？名字形态的片段做词边界检查（`$P` 不该在 `$PATH` 里命中），
 * 其它片段（渲不出来时给的 `$(pwd)` 这类）按原文匹配。
 */
export function referenceAppearsIn(text: string, refText: string): boolean {
	if (typeof text !== "string" || refText === "") return false;
	const needsBoundary = IDENT_REF.test(refText);
	let index = text.indexOf(refText);
	while (index !== -1) {
		if (!needsBoundary || !isIdentChar(text[index + refText.length])) return true;
		index = text.indexOf(refText, index + refText.length);
	}
	return false;
}
