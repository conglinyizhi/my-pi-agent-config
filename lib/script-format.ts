// lib/script-format.ts — 给审核窗看的脚本重排（只用于显示）
//
// 脚本原文的缩进是模型随手写的：可能整段挤在一行，也可能带一层无谓的深缩进。
// 审核窗要一眼看清结构，所以展示文本重排一遍；执行与批准绑定仍然用原文。
//
// 两条底线：
//   1. 重排用的是 TypeScript 的 printer（与扫描器同一套 AST 理解），不自己拼正则
//   2. 重排前后比对 token 流（含注释）——不一致就退回原文，
//      宁可显示得丑，也不让显示和实际跑的东西对不上
//
// 缩进宽度自己定：TS printer 固定 4 空格，没有选项，所以打印完再按行首重排一次。

import type * as TS from "typescript";

let tsPromise: Promise<typeof TS> | undefined;
function typescript(): Promise<typeof TS> {
	tsPromise ??= import("typescript");
	return tsPromise;
}

export interface FormattedScript {
	/** 展示用文本；没重排成功时就是原文 */
	text: string;
	/** 是否真的重排过 */
	formatted: boolean;
	/** 没重排的原因（有语法问题、或 token 流比对不一致） */
	reason?: string;
}

/** 默认缩进宽度：连字符语法 */
export const DISPLAY_INDENT = 2;

const CLOSERS = new Set<string>(["}])"].flatMap((ch) => ch.split("")));
const OPENERS = new Set<string>(["{[("].flatMap((ch) => ch.split("")));

function isTrivia(kind: TS.SyntaxKind, ts: typeof TS): boolean {
	return kind === ts.SyntaxKind.WhitespaceTrivia || kind === ts.SyntaxKind.NewLineTrivia;
}

/**
 * 取 token 流（跳过空白，保留注释）。
 *
 * 注释算进来是有意的：printer 万一吞掉一条注释，也要能被比对挡住。
 */
function tokenStream(text: string, ts: typeof TS): string[] {
	const scanner = ts.createScanner(ts.ScriptTarget.ESNext, false, ts.LanguageVariant.Standard, text);
	const out: string[] = [];
	let kind = scanner.scan();
	while (kind !== ts.SyntaxKind.EndOfFileToken) {
		if (!isTrivia(kind, ts)) out.push(`${kind}:${scanner.getTokenText()}`);
		kind = scanner.scan();
	}
	return out;
}

/**
 * 按括号深度重排行首空白，其余字符一个不动。
 *
 * 多行 token（模板字符串、块注释）的内部行要跳过：那里的空白是内容的一部分，
 * 动了就是改程序。括号深度只看代码 token，所以字符串里的 "}" 不会把层级带偏。
 */
function reindentLeading(text: string, ts: typeof TS, width: number): string {
	const lines = text.split("\n");
	const scanner = ts.createScanner(ts.ScriptTarget.ESNext, false, ts.LanguageVariant.Standard, text);
	const lineStarts: number[] = [0];
	for (let index = 0; index < text.length; index++) {
		if (text[index] === "\n") lineStarts.push(index + 1);
	}
	const lineAt = (offset: number): number => {
		let low = 0;
		let high = lineStarts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (lineStarts[mid] <= offset) low = mid;
			else high = mid - 1;
		}
		return low;
	};
	const indents = new Array(lines.length).fill(-1);
	const frozen = new Array(lines.length).fill(false); // 多行 token 的内部行
	let depth = 0;
	let kind = scanner.scan();
	while (kind !== ts.SyntaxKind.EndOfFileToken) {
		if (!isTrivia(kind, ts)) {
			const start = scanner.getTokenStart();
			const end = scanner.getTokenEnd();
			const startLine = lineAt(start);
			const endLine = lineAt(Math.max(start, end - 1));
			const raw = scanner.getTokenText();
			if (startLine !== endLine) {
				for (let line = startLine + 1; line <= endLine; line++) frozen[line] = true;
			}
			if (indents[startLine] < 0 && raw.length > 0) {
				indents[startLine] = CLOSERS.has(raw[0]) ? Math.max(0, depth - 1) : depth;
			}
			if (OPENERS.has(raw[raw.length - 1]) || OPENERS.has(raw[0])) {
				for (const ch of raw) {
					if (OPENERS.has(ch)) depth += 1;
					else if (CLOSERS.has(ch)) depth = Math.max(0, depth - 1);
				}
			} else {
				for (const ch of raw) {
					if (CLOSERS.has(ch)) depth = Math.max(0, depth - 1);
				}
			}
		}
		kind = scanner.scan();
	}
	return lines
		.map((line, index) => {
			if (line.trim() === "" || frozen[index] || indents[index] < 0) return line;
			const unit = " ".repeat(width);
			return `${unit.repeat(Math.max(0, indents[index]))}${line.replace(/^[ \t]+/, "")}`;
		})
		.join("\n");
}

/**
 * 把脚本重排成给人读的样子。
 *
 * 有语法问题就不碰：半成品 AST 打印出来可能少东西，那种时候原文更可信。
 */
export async function formatScriptForDisplay(
	source: string,
	options: { indent?: number } = {},
): Promise<FormattedScript> {
	if (typeof source !== "string" || source.trim() === "") {
		return { text: typeof source === "string" ? source : "", formatted: false, reason: "空脚本" };
	}
	const ts = await typescript();
	const file = ts.createSourceFile("script.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
	const diagnostics = (file as unknown as { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics;
	if (diagnostics && diagnostics.length > 0) {
		return { text: source, formatted: false, reason: "语法有问题，展示原文" };
	}
	const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
	const printed = printer.printFile(file);
	const reindented = reindentLeading(printed, ts, options.indent ?? DISPLAY_INDENT);
	const before = tokenStream(source, ts);
	const after = tokenStream(reindented, ts);
	if (before.length !== after.length) {
		return { text: source, formatted: false, reason: "重排前后 token 数不一致，展示原文" };
	}
	for (let index = 0; index < before.length; index++) {
		if (before[index] !== after[index]) {
			return { text: source, formatted: false, reason: `重排前后第 ${index + 1} 个 token 不一致，展示原文` };
		}
	}
	return { text: reindented, formatted: true };
}
