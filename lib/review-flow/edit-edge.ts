// lib/review-flow/edit-edge.ts — 图上改一条边：只替换那一个字符串字面量
//
// 为什么不用"图 → 重新生成整份源码"：那会把你写的注释、顺序、格式全冲掉，而且一次失败
// 就毁掉整份文件。这里只做定点手术：找到那个节点对象里那个属性，替换它的字面量。
//
// 属性不存在时插一条（插在对象自己的风格里：多行对象插新行，单行对象插同一行）。
// 目标不是字面量（比如变量拼出来的）就报错，不改——猜错位置比不改更坏。

import type * as TS from "typescript";

async function typescript(): Promise<typeof TS> {
	return import("typescript");
}

/** 要改的那条边 */
export interface EdgeEditRequest {
	source: string;
	/** 哪个节点上的边 */
	nodeId: string;
	/** next / branch / error / timeout / empty */
	kind: "next" | "branch" | "error" | "timeout" | "empty";
	/** kind=branch 时的出口名（yes / no / upload…） */
	label?: string;
	/** 改成去哪（节点 id，或 allow / deny） */
	to: string;
	fileName?: string;
}

export interface EdgeEditResult {
	ok: boolean;
	source?: string;
	changed?: boolean;
	error?: string;
}

const FIELD_OF: Record<Exclude<EdgeEditRequest["kind"], "branch">, string> = {
	next: "next",
	error: "onError",
	timeout: "onTimeout",
	empty: "onEmpty",
};

/**
 * 找这个节点要改的地方。两种写法都认：
 *
 *   kit.node("chatreview", { id: "chat", next: "classify" })   → 改那个对象字面量
 *   kit.custom("judge", impl, { branches: {…} })                → 改第三个参数；没有第三个参数就补一个
 *
 * 别的地方（变量、拼出来的 id）一律不认，宁可报错也不猜。
 */
type NodeTarget =
	| { kind: "object"; object: TS.ObjectLiteralExpression }
	| { kind: "call"; call: TS.CallExpression }
	| { kind: "options-not-literal"; call: TS.CallExpression };

function findNodeTarget(ts: typeof TS, sf: TS.SourceFile, nodeId: string): NodeTarget | undefined {
	let found: NodeTarget | undefined;
	const visit = (node: TS.Node): void => {
		if (found) return;
		if (ts.isObjectLiteralExpression(node)) {
			for (const prop of node.properties) {
				if (!ts.isPropertyAssignment(prop)) continue;
				const name = prop.name;
				const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
				if (key !== "id") continue;
				const value = prop.initializer;
				if (ts.isStringLiteral(value) && value.text === nodeId) {
					found = { kind: "object", object: node };
					return;
				}
			}
		}
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
			const first = node.arguments[0];
			if (name === "custom" && first && ts.isStringLiteral(first) && first.text === nodeId) {
				const options = node.arguments[2];
				if (!options) {
					found = { kind: "call", call: node };
					return;
				}
				if (ts.isObjectLiteralExpression(options)) {
					found = { kind: "object", object: options };
					return;
				}
				found = { kind: "options-not-literal", call: node };
				return;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return found;
}

function propertyOf(ts: typeof TS, object: TS.ObjectLiteralExpression, key: string): TS.PropertyAssignment | undefined {
	for (const prop of object.properties) {
		if (!ts.isPropertyAssignment(prop)) continue;
		const name = prop.name;
		const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
		if (text === key) return prop;
	}
	return undefined;
}

/** 往对象里插一条属性：多行对象插新行，单行对象插同一行 */
function insertProperty(ts: typeof TS, sf: TS.SourceFile, object: TS.ObjectLiteralExpression, entry: string): string | { error: string } {
	const text = sf.text.slice(object.getStart(sf), object.getEnd());
	if (object.properties.length === 0) {
		return text.includes("\n") ? `{\n\t\t${entry},\n\t}` : `{ ${entry} }`;
	}
	if (!text.includes("\n")) {
		// 单行对象：去掉尾逗号再补一条，保持一行
		const trimmed = text.replace(/,\s*}$/, " }");
		return `${trimmed.slice(0, -2)}, ${entry} }`;
	}
	// 多行：按最后一条属性的缩进插一行
	const last = object.properties[object.properties.length - 1] as TS.ObjectLiteralExpression["properties"][number];
	const lineStart = sf.text.lastIndexOf("\n", last.getStart(sf)) + 1;
	const indent = sf.text.slice(lineStart, last.getStart(sf));
	return `${text.replace(/\s*$/, "")},\n${indent}${entry}`;
}

/** 改一条边。返回新的源码（原样不动时才返回 changed:false） */
export async function editEdgeInSource(request: EdgeEditRequest): Promise<EdgeEditResult> {
	const ts = await typescript();
	const fileName = request.fileName ?? "flow.ts";
	const sf = ts.createSourceFile(fileName, request.source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
	const target = findNodeTarget(ts, sf, request.nodeId);
	if (!target) {
		return {
			ok: false,
			error: `找不到节点 ${request.nodeId}：它得写在 nodes 里，要么有 id: "…"，要么是 kit.custom("…", …) 的第一个参数`,
		};
	}
	if (target.kind === "options-not-literal") {
		return { ok: false, error: `节点 ${request.nodeId} 的第三个参数不是字面量对象，改不动（手工改吧）` };
	}

	const literal = JSON.stringify(request.to);
	if (request.kind === "branch" && !request.label) return { ok: false, error: "改分支要给出出口名（label）" };
	if (target.kind === "call") {
		// kit.custom("id", impl) 没有第三个参数：补一个只带这条边的对象
		const entry = request.kind === "branch"
			? `branches: { ${JSON.stringify(request.label)}: ${literal} }`
			: `${FIELD_OF[request.kind]}: ${literal}`;
		const end = target.call.getEnd() - 1;   // 右括号前
		const out = request.source.slice(0, end) + `, { ${entry} }` + request.source.slice(end);
		return { ok: true, source: out, changed: true };
	}
	const object = target.object;
	const splices: Array<{ start: number; end: number; text: string }> = [];

	if (request.kind === "branch") {
		if (!request.label) return { ok: false, error: "改分支要给出出口名（label）" };
		const branches = propertyOf(ts, object, "branches");
		if (!branches) {
			const entry = `branches: { ${JSON.stringify(request.label)}: ${literal} }`;
			const inserted = insertProperty(ts, sf, object, entry);
			if (typeof inserted !== "string") return { ok: false, error: inserted.error };
			splices.push({ start: object.getStart(sf), end: object.getEnd(), text: inserted });
		} else {
			if (!ts.isObjectLiteralExpression(branches.initializer)) {
				return { ok: false, error: "branches 不是字面量对象，改不动（手工改吧）" };
			}
			const inner = propertyOf(ts, branches.initializer, request.label);
			if (inner && ts.isStringLiteral(inner.initializer)) {
				if (inner.initializer.text === request.to) return { ok: true, source: request.source, changed: false };
				splices.push({ start: inner.initializer.getStart(sf), end: inner.initializer.getEnd(), text: literal });
			} else if (inner) {
				return { ok: false, error: `出口 ${request.label} 的目标不是字面量，改不动` };
			} else {
				const inserted = insertProperty(ts, sf, branches.initializer, `${JSON.stringify(request.label)}: ${literal}`);
				if (typeof inserted !== "string") return { ok: false, error: inserted.error };
				splices.push({ start: branches.initializer.getStart(sf), end: branches.initializer.getEnd(), text: inserted });
			}
		}
	} else {
		const field = FIELD_OF[request.kind];
		const prop = propertyOf(ts, object, field);
		if (prop) {
			if (!ts.isStringLiteral(prop.initializer)) {
				return { ok: false, error: `${field} 不是字面量，改不动（手工改吧）` };
			}
			if (prop.initializer.text === request.to) return { ok: true, source: request.source, changed: false };
			splices.push({ start: prop.initializer.getStart(sf), end: prop.initializer.getEnd(), text: literal });
		} else {
			const inserted = insertProperty(ts, sf, object, `${field}: ${literal}`);
			if (typeof inserted !== "string") return { ok: false, error: inserted.error };
			splices.push({ start: object.getStart(sf), end: object.getEnd(), text: inserted });
		}
	}

	// 从后往前替换，位置才不会串
	let out = request.source;
	for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
		out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
	}
	return { ok: true, source: out, changed: true };
}
