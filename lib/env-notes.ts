// lib/env-notes.ts — 审批窗里的赋值解析：`export NAME=VALUE` 与前置赋值 `NAME=VALUE cmd`
//
// 干什么：把命令里写死的赋值挑出来，按 shell 规则把值展开（`$HOME`、`${VAR:-默认}`、裸值里的 `~`），
// 让审批窗能标绿并悬停显示「这个变量解析后是什么」。解析基准是 pi 进程的环境变量，
// 也就是这条命令真正会拿到的那个环境。
//
// 不做什么（有意）：shell 会话里**先前**定义的变量我们看不见，所以
//   - 引用了环境里没有的变量 → 不猜，标「解析不了」并说明是哪种情况
//   - `$(...)`、反引号这类命令替换 → 不执行、也不猜，标「解析不了」
//   - 通配符（`*`、`?`）不展开：那是路径展开，不是变量
// 不含任何 I/O：只看文本 + 读传进来的 env。

import { maskNonShellHeredocBodies } from "../extensions/sandbox-permissions/scanner.ts";

export interface EnvNote {
	/** 变量名 */
	name: string;
	/** 原始写法（含引号），前端拿它跟命令文本对照 */
	raw: string;
	/** 在命令文本里的起止偏移（与命令同坐标系） */
	start: number;
	end: number;
	/** 解析出来的值（能解析时才有） */
	value?: string;
	/** 解析不了的原因（不能解析时才有），写给用户看的一句话 */
	reason?: string;
}

/** 一次最多标这么多条：命令里写几百个赋值不值得把 payload 撑大 */
const MAX_NOTES = 20;

/** 引号形态：单引号里什么都不展开，双引号里 $ 与 ` 展开、反斜杠只转义少数几个字符 */
type Quote = "none" | "single" | "double";

type Resolved = { ok: true; value: string } | { ok: false; reason: string };

function isNameStart(ch: string): boolean {
	return /[A-Za-z_]/.test(ch);
}

function isNameChar(ch: string): boolean {
	return /[A-Za-z0-9_]/.test(ch);
}

function readName(text: string, at: number): { name: string; next: number } | null {
	if (at >= text.length || !isNameStart(text[at])) return null;
	let i = at + 1;
	while (i < text.length && isNameChar(text[i])) i++;
	return { name: text.slice(at, i), next: i };
}

/** 值里出现的名字查环境；查不到就把「这是哪种情况」说清楚 */
function lookup(name: string, env: NodeJS.ProcessEnv): Resolved {
	const value = env[name];
	if (value === undefined) return { ok: false, reason: `引用了环境里没有的变量 ${name}（可能是 shell 会话里定义的）` };
	return { ok: true, value };
}

/**
 * 展开一段值的文本（不含外层引号）。quote 说明它写在哪种引号里。
 * 任何一处拿不准就整条判失败：宁可标「解析不了」，也不给一个可能错的答案。
 */
export function expandValue(body: string, quote: Quote, env: NodeJS.ProcessEnv = process.env): Resolved {
	if (quote === "single") return { ok: true, value: body };
	let out = "";
	let i = 0;
	if (quote === "none" && body.startsWith("~") && (body.length === 1 || body[1] === "/")) {
		const home = env.HOME;
		if (!home) return { ok: false, reason: "裸值以 ~ 开头，但环境里没有 HOME" };
		out += home;
		i = 1;
	}
	while (i < body.length) {
		const ch = body[i];
		if (ch === "\\") {
			if (i + 1 >= body.length) return { ok: false, reason: "值以反斜杠结尾，写法不完整" };
			const next = body[i + 1];
			// 双引号里反斜杠只转义 $ ` " \ 与换行，其余字符的反斜杠得留着
			if (quote === "double" && !"$`\"\\\n".includes(next)) {
				out += ch + next;
			} else if (next === "\n") {
				// 续行：整体去掉
			} else {
				out += next;
			}
			i += 2;
			continue;
		}
		if (ch === "`") return { ok: false, reason: "值里含命令替换（反引号），无法静态解析" };
		if (ch !== "$") {
			out += ch;
			i++;
			continue;
		}
		if (body[i + 1] === "(") return { ok: false, reason: "值里含命令替换 $(...)，无法静态解析" };
		if (body[i + 1] === "{") {
			const end = body.indexOf("}", i + 2);
			if (end === -1) return { ok: false, reason: "值里的 ${...} 没有闭合" };
			const written = body.slice(i, end + 1);
			const inner = body.slice(i + 2, end);
			const m = /^([A-Za-z_][A-Za-z0-9_]*)(:?[-=+?])?([\s\S]*)$/.exec(inner);
			if (!m) return { ok: false, reason: `不支持的参数展开 ${written}` };
			const [, name, op, arg] = m;
			if (op === undefined) {
				// 只认干净的 ${NAME}：`${USER/u/v}`、`${#USER}` 这类形式一律不算
				if (arg !== "") return { ok: false, reason: `不支持的参数展开 ${written}` };
				const looked = lookup(name, env);
				if (!looked.ok) return looked;
				out += looked.value;
			} else if (op === ":-" || op === "-") {
				const current = env[name];
				const usable = op === ":-" ? current !== undefined && current !== "" : current !== undefined;
				if (usable) {
					out += current as string;
				} else {
					const expanded = expandValue(arg, "double", env);
					if (!expanded.ok) return expanded;
					out += expanded.value;
				}
			} else {
				return { ok: false, reason: `不支持的参数展开 ${written}` };
			}
			i = end + 1;
			continue;
		}
		const name = readName(body, i + 1);
		if (!name) {
			const special = body.slice(i, i + 2);
			return { ok: false, reason: `值里含特殊参数 ${special}（$1、$? 这类）` };
		}
		const looked = lookup(name.name, env);
		if (!looked.ok) return looked;
		out += looked.value;
		i = name.next;
	}
	return { ok: true, value: out };
}

/** 从 `=` 之后读一个值：给出原始区间、内容（去引号）与引号形态 */
export function parseValue(text: string, at: number): { end: number; body: string; quote: Quote } | { error: string } {
	if (at >= text.length) return { end: at, body: "", quote: "none" };
	const quoteChar = text[at];
	if (quoteChar === "'" || quoteChar === '"') {
		const quote: Quote = quoteChar === "'" ? "single" : "double";
		let i = at + 1;
		let body = "";
		while (i < text.length) {
			const ch = text[i];
			if (quote === "double" && ch === "\\" && i + 1 < text.length) {
				body += ch + text[i + 1];
				i += 2;
				continue;
			}
			if (ch === quoteChar) return { end: i + 1, body, quote };
			body += ch;
			i++;
		}
		return { error: "引号没有闭合" };
	}
	let i = at;
	let body = "";
	// 括号要配对地吃：`FOO=$(pwd)` 里的括号属于命令替换，不能当作词的结尾
	let depth = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\" && i + 1 < text.length) {
			body += ch + text[i + 1];
			i += 2;
			continue;
		}
		if (ch === "(") {
			depth++;
			body += ch;
			i++;
			continue;
		}
		if (ch === ")") {
			if (depth === 0) break;
			depth--;
			body += ch;
			i++;
			continue;
		}
		if (/[\s;|&<>]/.test(ch)) break;
		body += ch;
		i++;
	}
	return { end: i, body, quote: "none" };
}

/** 命令位置上会出现、但后面仍然是命令的 shell 关键字（`then FOO=1 cmd` 这种也要认出来） */
const KEYWORDS = new Set(["!", "time", "then", "do", "else", "elif", "if", "while", "until", "in", "{"]);
const SEPARATORS = new Set(["\n", ";", "|", "&", "(", "{"]);

/** 读一个词（到空白或分隔符），返回词与结束位置 */
function readWord(text: string, at: number): { word: string; next: number } {
	let i = at;
	while (i < text.length && !/[\s;|&()<>{}]/.test(text[i])) i++;
	return { word: text.slice(at, i), next: i };
}

/**
 * 挑出命令里的赋值并解析。
 *
 * 正文属于「不会被 shell 执行」的 heredoc 时不算：`cat > x.sh <<EOF` 里写的 `export FOO=1`
 * 是在给文件写内容，不是在设置这次执行的环境。而 `bash <<EOF` 那种正文会被当命令跑，照旧扫。
 */
export function collectEnvAssignments(command: string, env: NodeJS.ProcessEnv = process.env): EnvNote[] {
	const text = typeof command === "string" ? command : "";
	if (text === "") return [];
	const masked = maskNonShellHeredocBodies(text);
	const notes: EnvNote[] = [];

	/** 试读一个 `NAME=VALUE`；不成返回 null，成则记一条并给出下一个位置 */
	function tryAssignment(at: number): { next: number } | null {
		const name = readName(masked, at);
		if (!name || masked[name.next] !== "=") return null;
		const valueStart = name.next + 1;
		const parsed = parseValue(masked, valueStart);
		if ("error" in parsed) {
			notes.push({ name: name.name, raw: text.slice(at, valueStart), start: at, end: valueStart, reason: parsed.error });
			return { next: valueStart };
		}
		const resolved = expandValue(parsed.body, parsed.quote, env);
		const note: EnvNote = {
			name: name.name,
			raw: text.slice(at, parsed.end),
			start: at,
			end: parsed.end,
			...(resolved.ok ? { value: resolved.value } : { reason: resolved.reason }),
		};
		notes.push(note);
		return { next: parsed.end };
	}

	let i = 0;
	let atCommandPosition = true;
	while (i < masked.length && notes.length < MAX_NOTES) {
		const ch = masked[i];
		if (ch === " " || ch === "\t") {
			i++;
			continue;
		}
		if (SEPARATORS.has(ch)) {
			atCommandPosition = true;
			i++;
			continue;
		}
		if (!atCommandPosition) {
			// 非命令位置：快进到下一个分隔符（`echo A=1` 里的 A=1 不是赋值）
			while (i < masked.length && !SEPARATORS.has(masked[i]) && !/\s/.test(masked[i])) i++;
			continue;
		}

		const word = readWord(masked, i);
		if (word.word === "export") {
			// export 后面可能跟 -n / -p 这类开关，然后是一串赋值
			let p = word.next;
			for (;;) {
				const ws = /^\s*/.exec(masked.slice(p));
				p += ws ? ws[0].length : 0;
				const flag = /^-[a-zA-Z]/.exec(masked.slice(p));
				if (!flag) break;
				p += flag[0].length;
			}
			for (;;) {
				const ws = /^\s*/.exec(masked.slice(p));
				p += ws ? ws[0].length : 0;
				const attempt = tryAssignment(p);
				if (!attempt) break;
				p = attempt.next;
			}
			i = Math.max(p, i + word.word.length);
			continue;
		}
		if (KEYWORDS.has(word.word)) {
			i = word.next;
			continue;
		}
		const attempt = tryAssignment(i);
		if (attempt) {
			// 前置赋值可以连着写：FOO=1 BAR=2 cmd
			let p = attempt.next;
			for (;;) {
				const ws = /^\s*/.exec(masked.slice(p));
				const next = p + (ws ? ws[0].length : 0);
				const more = tryAssignment(next);
				if (!more) break;
				p = more.next;
			}
			i = p;
			continue;
		}
		atCommandPosition = false;
		i = Math.max(word.next, i + 1);
	}

	return notes.sort((a, b) => a.start - b.start).slice(0, MAX_NOTES);
}
