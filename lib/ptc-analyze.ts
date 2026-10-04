// lib/ptc-analyze.ts — run_code 脚本的字面量级扫描（最小实现的第 1 步）
//
// 不解释数据流，只看字面量。目标三件事：
//   1. 脚本里到底（字面上）调了哪些工具 —— 收窄送审材料里的工具面与批准范围
//   2. 这些调用带的路径 / 命令字面量 —— 进审批卡，也是以后 hash 绑定的锚点
//   3. 有没有推不出来的东西（变量、模板、动态工具名、eval）—— 有就标出来，别装作看全了
//
// 解析用 typescript 自带的解析器：零新依赖、容错、JS/TS 都吃，且不需要跑引擎。
// 动态载入（首次扫描才拉编译器），免得给 pi 启动加几百毫秒。

import type * as TS from "typescript";

let tsPromise: Promise<typeof TS> | undefined;
function typescript(): Promise<typeof TS> {
	tsPromise ??= import("typescript");
	return tsPromise;
}

/** 脚本里的一次字面量工具调用 */
export interface LiteralCall {
	tool: string;
	/** 参数里的字符串字面量（键 → 值）；参数不是对象字面量时为空 */
	args: Record<string, string>;
	/** 参数里出现非字面量时置位：这条调用"看得见、看不全" */
	unresolvedArgs?: boolean;
	/** 源码位置（1 起），报错与审批卡都用它 */
	line: number;
	column: number;
}

export interface ScriptScan {
	calls: LiteralCall[];
	/** 用到的工具名（去重，按出现顺序） */
	tools: string[];
	/** 参数里的路径字面量（读与写不分开统计，去重） */
	paths: string[];
	/** 命令字面量（bash 那条） */
	commands: string[];
	/** 推不出来的地方，一句话一条（人看得懂的理由） */
	opaque: string[];
	/** 语法层面就不干净时的原因 */
	parseError?: string;
}

const PATH_FIELDS = new Set(["path", "file", "to", "from", "cwd"]);

/**
 * 值一旦由运行时决定就"看不全"的字段：路径、命令、要写入的内容。
 * 其余字段（timeout、limit、todos 这类）不是字面量也无所谓，不该因此给整段标 opaque。
 */
const RISKY_FIELDS = new Set([...PATH_FIELDS, "command", "content", "edits", "old", "new"]);


const EMPTY_SCAN: ScriptScan = { calls: [], tools: [], paths: [], commands: [], opaque: [] };

/** 扫一段脚本。解析失败不抛错：返回带 parseError 的空结果，让调用方自己决定怎么处理 */
export async function scanScript(source: string): Promise<ScriptScan> {
	const ts = await typescript();
	const file = ts.createSourceFile("script.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

	const calls: LiteralCall[] = [];
	const opaque: string[] = [];
	const paths: string[] = [];
	const commands: string[] = [];

	const positionOf = (node: TS.Node): { line: number; column: number } => {
		const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
		return { line: line + 1, column: character + 1 };
	};

	const stringValueOf = (node: TS.Node | undefined): string | undefined => {
		if (node === undefined) return undefined;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
		return undefined;
	};

	/** 数字/布尔/null 这类字面量藏不了路径，算"看得清" */
	const isPlainLiteral = (node: TS.Node): boolean =>
		node.kind === ts.SyntaxKind.NumericLiteral ||
		node.kind === ts.SyntaxKind.TrueKeyword ||
		node.kind === ts.SyntaxKind.FalseKeyword ||
		node.kind === ts.SyntaxKind.NullKeyword;

	/** 取 `tools` 这个名字：支持 tools.x 与 tools["x"] */
	const calledToolName = (node: TS.Expression): { tool: string; dynamic?: string } | undefined => {
		if (ts.isPropertyAccessExpression(node)) {
			const target = node.expression;
			if (ts.isIdentifier(target) && target.text === "tools") return { tool: node.name.text };
			return undefined;
		}
		if (ts.isElementAccessExpression(node)) {
			const target = node.expression;
			if (!ts.isIdentifier(target) || target.text !== "tools") return undefined;
			const literal = stringValueOf(node.argumentExpression);
			if (literal !== undefined) return { tool: literal };
			const rendered = node.argumentExpression.getText(file);
			return { tool: "", dynamic: rendered };
		}
		return undefined;
	};

	const visit = (node: TS.Node): void => {
		// new Function(...) 是 NewExpression，不在 CallExpression 那一支里
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
			const at = positionOf(node);
			opaque.push(`${at.line}:${at.column} 用了 new Function，代码内容推不出来`);
		} else if (ts.isCallExpression(node)) {
			// 先看不可分析构造：这些一出现，整个脚本就不能当"看全了"
			if (ts.isIdentifier(node.expression) && node.expression.text === "eval") {
				const at = positionOf(node);
				opaque.push(`${at.line}:${at.column} 用了 eval，代码内容推不出来`);
			} else {
				const called = calledToolName(node.expression);
				if (called?.dynamic !== undefined) {
					const at = positionOf(node);
					opaque.push(`${at.line}:${at.column} 工具名是动态算出来的（${called.dynamic.slice(0, 60)}）`);
				} else if (called && called.tool) {
					const at = positionOf(node);
					const args: Record<string, string> = {};
					let unresolvedArgs = false;
					const first = node.arguments[0];
					if (first === undefined) {
						unresolvedArgs = true;
					} else if (ts.isObjectLiteralExpression(first)) {
						// 逐字段看：路径/命令/内容由运行时决定才算看不全
						for (const property of first.properties) {
							if (!ts.isPropertyAssignment(property)) {
								unresolvedArgs = true;
								continue;
							}
							const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
							if (key === undefined) {
								unresolvedArgs = true;
								continue;
							}
							const value = stringValueOf(property.initializer);
							if (value === undefined) {
								// 只有"藏得住路径/命令/内容"的字段才值得报警
								if (RISKY_FIELDS.has(key) && !isPlainLiteral(property.initializer)) unresolvedArgs = true;
								continue;
							}
							args[key] = value;
						}
					} else {
						unresolvedArgs = true;
					}

					calls.push({ tool: called.tool, args, ...(unresolvedArgs ? { unresolvedArgs: true } : {}), ...at });
					if (unresolvedArgs) {
						opaque.push(`${at.line}:${at.column} ${called.tool} 的参数里有非字面量，值只能运行时才知道`);
					}
					for (const [key, value] of Object.entries(args)) {
						if (PATH_FIELDS.has(key)) paths.push(value);
						if (key === "command") commands.push(value);
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);

	// 语法错误：ts 把诊断留在 sourceFile 上（内部字段），有就说明这段源码本身就脏
	const diagnostics = (file as unknown as { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics;
	let parseError: string | undefined;
	if (diagnostics && diagnostics.length > 0) {
		const first = diagnostics[0];
		const at = first.start !== undefined ? file.getLineAndCharacterOfPosition(first.start) : undefined;
		const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
		parseError = at ? `${at.line + 1}:${at.character + 1} ${message}` : message;
	}

	const unique = (values: string[]): string[] => [...new Set(values)];
	return {
		calls,
		tools: unique(calls.map((call) => call.tool)),
		paths: unique(paths),
		commands: unique(commands),
		opaque,
		...(parseError ? { parseError } : {}),
	};
}

/** 空扫描（解析失败或没解析出东西时给调用方一个干净起点） */
export function emptyScan(): ScriptScan {
	return { ...EMPTY_SCAN, calls: [], tools: [], paths: [], commands: [], opaque: [] };
}
