// lib/ptc-canon.ts — PTC 脚本的规范化重写（给审核看的那一份）
//
// 为什么：审核模型看到 `const p = "..."; tools.read({ path: p })` 时，会写
// "用了动态变量、值只能运行时才知道" —— 可那个变量就在上一行。这份重写把这类
// 字面量常量内联回使用处、把纯字面量拼接折起来，让送审的脚本自己把路径与命令说清楚。
//
// 引擎：typescript 自带的解析器 + printer（与 ptc-analyze.ts 同源，零新依赖，容错好，
// JS/TS 都吃）。不引 acorn/babel —— 它们能干的活这一个就够，还省一次依赖。
//
// 三条硬约束（改本文件前先读）：
//   1 只做保守的等价变换：同块 const 字面量内联、纯字面量拼接折叠、无插值模板折叠、
//     内联后不再被引用的声明删掉、格式交给 printer。遮蔽（同名内层声明）、重赋值、
//     有副作用的初始化（函数调用 / await / new）一律不碰。
//   2 改完必须过校验：与原文的 scanScript 结果（工具序列、字面量参数、opaque 条数）一致，
//     不一致就放弃重写，调用方退回原文。审核看到错的东西，比看到花哨的东西危险得多。
//   3 解析失败 / 语法错误 / 没有可改的地方：原样返回，changed=false。
//
// 注意：执行体始终是原文。这份规范化文本是"审核视图"，不参与执行。

import { scanScript, type ScriptScan } from "./ptc-analyze.ts";
import type * as TS from "typescript";

let tsPromise: Promise<typeof TS> | undefined;
function typescript(): Promise<typeof TS> {
	tsPromise ??= import("typescript");
	return tsPromise;
}

export interface CanonResult {
	/** 规范化后的脚本（changed=false 时就是原文） */
	code: string;
	/** 有没有真的改过 */
	changed: boolean;
	/** 被内联 / 折叠掉的常量名（按发现顺序，审核材料里注明改了什么） */
	inlined: string[];
	/** 等价性校验通过没有；false 时调用方必须用原文 */
	verified: boolean;
	/** 没重写 / 没通过校验的原因（人话，排查用） */
	skipped?: string;
	/** 规范化后那份的扫描结果（校验时顺手算的，送审材料直接拿来用，省一次扫描） */
	scan?: ScriptScan;
}

/** 把脚本规范化成审核视图；任何时候都不抛，失败就是原样返回 */
export async function canonicalizeScript(source: string): Promise<CanonResult> {
	const original = source;
	const unchanged = (skipped?: string): CanonResult => ({ code: original, changed: false, inlined: [], verified: false, ...(skipped ? { skipped } : {}) });
	if (!source.trim()) return unchanged("空脚本");
	try {
		const ts = await typescript();
		const file = ts.createSourceFile("script.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
		const diagnostics = (file as unknown as { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics;
		if (diagnostics && diagnostics.length > 0) return unchanged("脚本有语法错误，不做重写");

		const inlined: string[] = [];
		const ctx = { ts, factory: ts.factory, file, inlined };
		const statements = rewriteBlock(ctx, file.statements, new Map());
		if (inlined.length === 0) return unchanged("没有可内联的字面量常量");

		const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
		const updated = ctx.factory.updateSourceFile(file, statements);
		const code = printer.printNode(ts.EmitHint.Unspecified, updated, file).trim();
		if (code === original.trim()) return unchanged("重写后与原文一致");

		// 等价性校验：静态扫描的结论必须一模一样（工具序列 + 字面量参数 + opaque 不增多）
		const before = await scanScript(original);
		const after = await scanScript(code);
		const mismatch = compareScans(before, after);
		if (mismatch) {
			return { code: original, changed: false, inlined, verified: false, skipped: `校验没过：${mismatch}` };
		}
		return { code, changed: true, inlined, verified: true, scan: after };
	} catch (err) {
		return unchanged(`重写出错：${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * 两份扫描结果的等价性对比（纯函数，可单测）。
 * 返回不一致的原因；一致返回 undefined。
 *
 * 方向很重要：规范化只许**让更多东西看得清**，不许让原本看清的东西变模糊。所以：
 *   - 工具序列（顺序 + 名字 + 条数）必须一模一样
 *   - 原文里已经解析出来的字面量参数，值一个都不能变；规范化后多出来的参数是好事
 *   - 「参数里有非字面量」这个标记只许从有到无，反过来就是错
 *   - opaque（推不出来的地方）只许变少
 * 不比行列号——重排格式必然让位置变。
 */
export function compareScans(before: ScriptScan, after: ScriptScan): string | undefined {
	if (before.tools.join(",") !== after.tools.join(",")) {
		return `工具集合变了（${before.tools.join("/") || "无"} → ${after.tools.join("/") || "无"}）`;
	}
	if (before.calls.length !== after.calls.length) {
		return `工具调用条数变了（${before.calls.length} → ${after.calls.length}）`;
	}
	for (let i = 0; i < before.calls.length; i += 1) {
		const a = before.calls[i];
		const b = after.calls[i];
		if (a.tool !== b.tool) return `第 ${i + 1} 个调用换工具了（${a.tool} → ${b.tool}）`;
		// 原本看不清、重写后看清了：这是这份重写的意义，放行；反过来才是错
		if (!a.unresolvedArgs && b.unresolvedArgs) return `第 ${i + 1} 个调用（${a.tool}）反而看不清了`;
		for (const key of Object.keys(a.args)) {
			if (!(key in b.args)) return `第 ${i + 1} 个调用（${a.tool}）丢了参数 ${key}`;
			if (a.args[key] !== b.args[key]) {
				return `第 ${i + 1} 个调用（${a.tool}）的 ${key} 值变了：${a.args[key]} → ${b.args[key]}`;
			}
		}
	}
	if (after.opaque.length > before.opaque.length) return `推不出来的地方变多了（${before.opaque.length} → ${after.opaque.length}）`;
	return undefined;
}

interface Ctx {
	ts: typeof TS;
	factory: TS.NodeFactory;
	file: TS.SourceFile;
	inlined: string[];
}

/** 纯字面量求值：字符串、无插值模板、字面量之间的 + 拼接。别的（数字、布尔、变量）一律 undefined */
function literalOf(ts: typeof TS, node: TS.Node): string | undefined {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = literalOf(ts, node.left);
		const right = literalOf(ts, node.right);
		return left !== undefined && right !== undefined ? left + right : undefined;
	}
	return undefined;
}

/** 模板串折叠：`a${"b"}c` 这类插值全是字面量的，折成一个字符串 */
function foldTemplate(ts: typeof TS, node: TS.TemplateExpression): string | undefined {
	let out = node.head.text;
	for (const span of node.templateSpans) {
		const value = literalOf(ts, span.expression);
		if (value === undefined) return undefined;
		out += value + span.literal.text;
	}
	return out;
}

/** 把绑定名（含解构）逐个加进集合 */
function addBindingNames(ts: typeof TS, names: Set<string>, name: TS.BindingName): void {
	if (ts.isIdentifier(name)) {
		names.add(name.text);
		return;
	}
	for (const element of name.elements) {
		if (!ts.isOmittedExpression(element)) addBindingNames(ts, names, element.name);
	}
}

/** 形参名集合（含解构、含默认值） */
function parameterNames(ts: typeof TS, parameters: readonly TS.ParameterDeclaration[]): Set<string> {
	const names = new Set<string>();
	for (const p of parameters) addBindingNames(ts, names, p.name);
	return names;
}

/** 带函数体的函数形态（SignatureDeclaration 里那些没 body 的声明不算） */
function functionBodyOf(ts: typeof TS, node: TS.Node): TS.Block | TS.Expression | undefined {
	if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node)) {
		return node.body;
	}
	return undefined;
}

/** 一个块里出现过的名字（let/const/var/function/class）——用来挡遮蔽 */
function declaredNamesIn(ts: typeof TS, statements: readonly TS.Statement[]): Set<string> {
	const names = new Set<string>();
	const add = (name: TS.BindingName): void => addBindingNames(ts, names, name);
	for (const st of statements) {
		if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) add(d.name);
		else if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) if (st.name) names.add(st.name.text);
	}
	return names;
}

/** 子作用域环境：父环境里可见的常量，去掉子块/参数自己声明的同名（那是别的绑定） */
function childEnv(env: Map<string, string>, shadowed: Iterable<string>): Map<string, string> {
	const next = new Map(env);
	for (const name of shadowed) next.delete(name);
	return next;
}

/**
 * 重写一个语句列表。
 *
 * 顺序扫（不预收集）：遇到字面量常量声明就把名字放进环境，所以只有声明之后的使用处才会
 * 被内联——const 的 TDZ 语义照旧，不会把"用在声明前"的代码改得更宽松。
 */
function rewriteBlock(ctx: Ctx, statements: readonly TS.Statement[], outerEnv: Map<string, string>): TS.Statement[] {
	const { ts, factory } = ctx;
	const env = childEnv(outerEnv, declaredNamesIn(ts, statements));
	/** 本块声明的字面量常量：名字 → 字面量值；以及它的声明符（用于最后清理） */
	const consts = new Map<string, { value: string; statement: TS.VariableStatement; declaration: TS.VariableDeclaration }>();
	/** 内联发生的次数：>0 且最终没人引用时，这条声明就没用了 */
	const used = new Map<string, number>();
	const out: TS.Statement[] = [];

	for (const st of statements) {
		if (ts.isVariableStatement(st) && (st.declarationList.flags & ts.NodeFlags.Const) !== 0) {
			for (const d of st.declarationList.declarations) {
				if (!ts.isIdentifier(d.name) || !d.initializer) continue;
				const value = literalOf(ts, d.initializer) ?? (ts.isTemplateExpression(d.initializer) ? foldTemplate(ts, d.initializer) : undefined);
				if (value === undefined) continue;
				env.set(d.name.text, value);
				consts.set(d.name.text, { value, statement: st, declaration: d });
				used.set(d.name.text, 0);
			}
			// 同一条语句里可能既有字面量声明也有别的（const a = "x", b = f()）：照着改写其余部分
			out.push(ts.visitNode(rewriteNode(ctx, st, env, used), (n) => n) as TS.Statement);
			continue;
		}
		out.push(rewriteNode(ctx, st, env, used) as TS.Statement);
	}

	// 清掉被内联、且重写后没有任何引用的声明（初始化是纯字面量，删掉不改行为）
	const result: TS.Statement[] = [];
	for (const st of out) {
		if (ts.isVariableStatement(st) && (st.declarationList.flags & ts.NodeFlags.Const) !== 0) {
			const kept = st.declarationList.declarations.filter((d) => {
				if (!ts.isIdentifier(d.name)) return true;
				const info = consts.get(d.name.text);
				if (!info) return true;
				if ((used.get(d.name.text) ?? 0) === 0) return true; // 没人内联它，保持原样
				ctx.inlined.push(d.name.text);
				return false;
			});
			if (kept.length === 0) continue;
			if (kept.length !== st.declarationList.declarations.length) {
				result.push(factory.updateVariableStatement(st, st.modifiers, factory.updateVariableDeclarationList(st.declarationList, kept)));
				continue;
			}
		}
		result.push(st);
	}
	return result;
}

/** 表达式/语句级重写：把环境里的常量换回字面量，顺手折叠纯字面量拼接 */
function rewriteNode(ctx: Ctx, node: TS.Node, env: Map<string, string>, used: Map<string, number>): TS.Node {
	const { ts, factory } = ctx;

	// 声明本身不替换：名字是绑定，不是取值。踩过——把 `const p = "x"` 写成 `const "x" = "x"`，
	// 后面的清理逻辑就再也认不出这条声明了
	if (ts.isVariableDeclaration(node)) {
		return factory.updateVariableDeclaration(
			node,
			node.name,
			node.exclamationToken,
			node.type,
			node.initializer ? (rewriteNode(ctx, node.initializer, env, used) as TS.Expression) : undefined,
		);
	}

	// 属性名 / 成员名 / 解构名都是"名字位置"，不是取值：不替换。
	// 踩过——`const path = "..."` 之后，`{ path: "..." }` 的属性名被换成字面量，
	// 参数名整个丢了，扫描结果对不上。
	if (ts.isPropertyAssignment(node)) {
		return factory.updatePropertyAssignment(node, node.name, rewriteNode(ctx, node.initializer, env, used) as TS.Expression);
	}
	if (ts.isPropertyAccessExpression(node)) {
		return factory.updatePropertyAccessExpression(node, rewriteNode(ctx, node.expression, env, used) as TS.Expression, node.name);
	}
	if (ts.isBindingElement(node) || ts.isParameter(node)) return node;
	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return node; // 类体不做重写（PTC 脚本里罕见，不值得为它冒风险）

	// 简写属性 { path } → { path: "/x" }：名字本身就是取值，得摊开成普通属性（
	// 直接换 name 会写出结构非法的 shorthand，扫描时反而丢参数——踩过）
	if (ts.isShorthandPropertyAssignment(node)) {
		const value = env.get(node.name.text);
		if (value === undefined) return node;
		used.set(node.name.text, (used.get(node.name.text) ?? 0) + 1);
		// 属性名用标识符（不是字符串字面量）：打印出来就是 { path: "/x" }，跟原文一个风格
		return factory.createPropertyAssignment(factory.createIdentifier(node.name.text), factory.createStringLiteral(value));
	}

	// 标识符 → 字面量（只认环境里的，且它在本块没被遮蔽——遮蔽在 childEnv 里已经处理）
	if (ts.isIdentifier(node) && env.has(node.text)) {
		const value = env.get(node.text) as string;
		used.set(node.text, (used.get(node.text) ?? 0) + 1);
		return factory.createStringLiteral(value);
	}

	// 纯字面量拼接 → 折成一个字面量。先递归子节点再折：`p + "/y"` 里 p 要先被换掉，
	// 换完这一层才看得出是纯字面量（顺序反了会漏折，踩过）
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const rewritten = ts.visitEachChild(node, (child) => rewriteNode(ctx, child, env, used), undefined) as TS.Expression;
		const folded = literalOf(ts, rewritten);
		return folded !== undefined ? factory.createStringLiteral(folded) : rewritten;
	}

	// 模板：插值全是字面量（或被内联成字面量）就折成字符串，同样先递归
	if (ts.isTemplateExpression(node)) {
		const rewritten = ts.visitEachChild(node, (child) => rewriteNode(ctx, child, env, used), undefined) as TS.TemplateExpression;
		const folded = foldTemplate(ts, rewritten);
		return folded !== undefined ? factory.createStringLiteral(folded) : rewritten;
	}

	// 函数：参数与函数体自己声明的名字对内部是遮蔽；父环境的常量仍被闭包捕获，保留
	const fnBody = functionBodyOf(ts, node);
	if (fnBody !== undefined) {
		const shadowed = parameterNames(ts, (node as TS.FunctionLikeDeclaration).parameters);
		if (ts.isBlock(fnBody)) {
			// 函数体内部整块重写（含它自己的声明清理），处理完就别再 visitEachChild 走一遍
			const inner = rewriteBlock(ctx, fnBody.statements, childEnv(env, shadowed));
			return replaceBody(ctx, node, factory.updateBlock(fnBody, inner));
		}
		// 单表达式体：() => p 这种
		const body = rewriteNode(ctx, fnBody, childEnv(env, shadowed), used);
		return replaceBody(ctx, node, body);
	}

	// 嵌套块：子作用域
	if (ts.isBlock(node)) {
		const inner = rewriteBlock(ctx, node.statements, env);
		return factory.updateBlock(node, inner);
	}

	return ts.visitEachChild(node, (child) => rewriteNode(ctx, child, env, used), undefined);
}

/** 把新的 body 装回各种函数节点（TS 里没有统一的 updateFunctionBody） */
function replaceBody(ctx: Ctx, node: TS.Node, body: TS.Node): TS.Node {
	const { ts, factory } = ctx;
	if (ts.isFunctionDeclaration(node)) return factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body as TS.Block);
	if (ts.isFunctionExpression(node)) return factory.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body as TS.Block);
	if (ts.isArrowFunction(node)) return factory.updateArrowFunction(node, node.modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, body as TS.ConciseBody);
	if (ts.isMethodDeclaration(node)) return factory.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, body as TS.Block);
	if (ts.isGetAccessorDeclaration(node)) return factory.updateGetAccessorDeclaration(node, node.modifiers, node.name, node.parameters, node.type, body as TS.Block);
	if (ts.isSetAccessorDeclaration(node)) return factory.updateSetAccessorDeclaration(node, node.modifiers, node.name, node.parameters, body as TS.Block);
	if (ts.isConstructorDeclaration(node)) return factory.updateConstructorDeclaration(node, node.modifiers, node.parameters, body as TS.Block);
	return node;
}
