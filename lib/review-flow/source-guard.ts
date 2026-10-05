// lib/review-flow/source-guard.ts — 流程文件的越界检查（防手滑，不是安全边界）
//
// 流程文件跑在 pi 进程里，与插件同权限。这一层只拦"直接去碰原生接口"的手滑：
// 原生模块导入、require、动态 import，以及 process / globalThis 这类全局。
//
// 说清它不是安全边界：能绕（eval、从别的包间接拿到、等等）。它的价值是把手滑变成一句明话，
// 并且让越界在加载时就被拒（fail-closed），而不是等它真的把会话带走。

import { builtinModules } from "node:module";
import type * as TS from "typescript";

/** 原生模块清单：带不带 node: 前缀都认（"fs" 与 "node:fs" 都能载进来） */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** 这个 import 是不是只借类型（type-only 会被整段擦掉，运行期没有任何耦合） */
function isTypeOnlyImport(ts: typeof TS, node: TS.ImportDeclaration | TS.ExportDeclaration): boolean {
	if (ts.isExportDeclaration(node) && node.isTypeOnly) return true;
	// 注意：没有 importClause 的两种写法都要拒——import "node:fs"（副作用导入，照样执行）
	// 与 export ... from "..."。它们都不是"只借类型"。
	const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
	if (!clause) return false;
	if (clause.isTypeOnly) return true;
	// import { type ReviewKit } from "..."：具名里每一项都标了 type，整句就只借类型
	const named = clause.namedBindings;
	if (named && ts.isNamedImports(named) && named.elements.length > 0) {
		return named.elements.every((element) => element.isTypeOnly);
	}
	return false;
}

export interface SourceViolation {
	line: number;
	column: number;
	message: string;
}

/** 直接去碰进程与全局的名字：碰到就拒 */
const BANNED_GLOBALS: ReadonlyArray<{ name: string; why: string }> = [
	{ name: "process", why: "碰进程：环境变量、退出、信号都在这里" },
	{ name: "require", why: "CommonJS 载入，绕过这里的导入检查" },
	{ name: "module", why: "模块对象，同上" },
	{ name: "global", why: "往全局上挂东西" },
	{ name: "globalThis", why: "往全局上挂东西" },
	{ name: "__dirname", why: "文件系统路径" },
	{ name: "__filename", why: "文件系统路径" },
];

async function typescript(): Promise<typeof TS> {
	return import("typescript");
}

/** 名字出现在 a.process 这种属性位置时不算引用 */
function isPropertyName(ts: typeof TS, node: TS.Identifier): boolean {
	const parent = node.parent as TS.Node | undefined;
	if (!parent) return false;
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
	if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
	if (ts.isPropertySignature(parent) && parent.name === node) return true;
	return false;
}

/** 名字是声明本身（参数名、变量名、函数名）时不算引用 */
function isDeclarationName(ts: typeof TS, node: TS.Identifier): boolean {
	const parent = node.parent as TS.Node | undefined;
	if (!parent) return false;
	return (
		((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.name === node) ||
		((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)) && parent.name === node) ||
		(ts.isPropertyAssignment(parent) && parent.name === node)
	);
}

/**
 * 扫一份流程源码，返回越界的地方。空数组表示可以加载。
 *
 * 只做语法层的事（typescript 自带解析器，零新依赖），不需要类型信息、也不执行这份代码。
 */
export async function checkFlowSource(source: string, fileName = "flow.ts"): Promise<SourceViolation[]> {
	const ts = await typescript();
	const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
	const found: SourceViolation[] = [];
	const at = (node: TS.Node) => {
		const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
		return { line: pos.line + 1, column: pos.character + 1 };
	};

	const visit = (node: TS.Node): void => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !isTypeOnlyImport(ts, node)) {
			const spec = node.moduleSpecifier;
			if (spec && ts.isStringLiteral(spec)) {
				if (BUILTINS.has(spec.text)) {
					found.push({ ...at(spec), message: `不许导入原生模块：${spec.text}` });
				} else {
					found.push({
						...at(spec),
						message: `流程是单文件：不许导入别的模块（${spec.text}）——要外部能力就写 pi 扩展`,
					});
				}
			}
		}
		// import x = require("fs")：TS 的另一种 require 写法
		if (ts.isImportEqualsDeclaration(node)) {
			found.push({ ...at(node), message: "不许用 import ... = require(...)：它绕过这里的检查" });
		}
		if (ts.isCallExpression(node)) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				found.push({ ...at(node), message: "不许用动态 import：它绕过这里的检查" });
			}
			if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
				found.push({ ...at(node), message: "不许用 require：它绕过这里的检查" });
			}
		}
		if (ts.isIdentifier(node)) {
			const banned = BANNED_GLOBALS.find((item) => item.name === node.text);
			if (banned && !isPropertyName(ts, node) && !isDeclarationName(ts, node)) {
				found.push({ ...at(node), message: `不许用 ${banned.name}：${banned.why}` });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return found;
}

/** 给人看的原因：加载失败时进崩溃报告与报错文案 */
export function formatViolations(violations: SourceViolation[], fileName: string): string {
	const lines = violations.slice(0, 8).map((v) => `  ${fileName}:${v.line}:${v.column} ${v.message}`);
	const more = violations.length > 8 ? `\n  ……还有 ${violations.length - 8} 处` : "";
	return `流程源码越界（流程只做判定，不碰原生接口）：\n${lines.join("\n")}${more}`;
}
