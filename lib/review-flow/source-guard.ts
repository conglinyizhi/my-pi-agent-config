// lib/review-flow/source-guard.ts — 流程文件的越界检查（防手滑，不是安全边界）
//
// 流程文件跑在 pi 进程里，与插件同权限。这一层只拦"直接去碰原生接口"的手滑：
// 原生模块导入、require、动态 import，以及 process / globalThis 这类全局。
//
// 说清它不是安全边界：能绕（eval、从别的包间接拿到、等等）。它的价值是把手滑变成一句明话，
// 并且让越界在加载时就被拒（fail-closed），而不是等它真的把会话带走。

import type * as TS from "typescript";

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
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("node:")) {
			found.push({ ...at(node.moduleSpecifier), message: `不许导入原生模块：${node.moduleSpecifier.text}` });
		}
		if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("node:")) {
			found.push({ ...at(node.moduleSpecifier), message: `不许从原生模块导出：${node.moduleSpecifier.text}` });
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
