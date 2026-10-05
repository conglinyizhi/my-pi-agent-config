// add-node.ts — 往流程源码里定点加一个节点
//
// 与 edit-edge 同一套手法：只动该动的那几处字面量，不重新生成整份源码——
// 重新生成会把注释、顺序、你手写的格式全冲掉，一次失败就毁掉整份文件。
//
// 加节点比改边多一步：新节点得有人指向它，否则 validateFlow 会判「不可达」。
// 所以这里可以顺手把一条既有边改接到新节点上（复用 editEdgeInSource）。

import type * as TS from "typescript";
import { editEdgeInSource } from "./edit-edge.ts";

async function typescript(): Promise<typeof TS> {
	return import("typescript");
}

/** 内建节点种类（源码里 kit.node 的第一个参数） */
export const BUILTIN_NODE_KINDS = ["chatreview", "classifier", "merge", "autoapprove", "gate", "terminal"] as const;

export interface AddNodeRequest {
	source: string;
	/** 新节点的 id（写进源码的字符串字面量） */
	id: string;
	/** 内建种类，或 "custom"（插一段带回退的 JS stub） */
	kind: string;
	/** 把谁的边改接到新节点上：不给的话新节点不可达，校验会指出来 */
	connect?: {
		nodeId: string;
		edge: { kind: "next" | "branch" | "error" | "timeout" | "empty"; label?: string };
	};
	/** 插在哪个既有节点之前（缺省追加到末尾） */
	before?: string;
	fileName?: string;
}

export interface AddNodeResult {
	ok: boolean;
	source?: string;
	error?: string;
}

/** 名单是 nodes 的那个数组字面量 */
function nodesArray(ts: typeof TS, sf: TS.SourceFile): TS.ArrayLiteralExpression | undefined {
	let found: TS.ArrayLiteralExpression | undefined;
	const visit = (node: TS.Node): void => {
		if (found) return;
		if (ts.isPropertyAssignment(node)) {
			const name = node.name;
			const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
			if (key === "nodes" && ts.isArrayLiteralExpression(node.initializer)) {
				found = node.initializer;
				return;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return found;
}

/**
 * 这个元素是哪个节点：kit.node("kind", { id: "x" }) 看对象里的 id，kit.custom("x", …) 看第一个参数。
 * 不许用"文本里包含这个字面量"——那会把别人的 next: "x" 也算成它（踩过：插错位置）。
 */
function nodeIdOf(ts: typeof TS, element: TS.Expression): string | undefined {
	if (ts.isObjectLiteralExpression(element)) {
		for (const prop of element.properties) {
			if (!ts.isPropertyAssignment(prop)) continue;
			const name = prop.name;
			const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
			if (key === "id" && ts.isStringLiteral(prop.initializer)) return prop.initializer.text;
		}
		return undefined;
	}
	if (ts.isCallExpression(element)) {
		const callee = element.expression;
		const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
		// kit.custom("id", impl, opts)：id 是第一个参数
		if (name === "custom") {
			const first = element.arguments[0];
			return first && ts.isStringLiteral(first) ? first.text : undefined;
		}
		// kit.node("kind", { id }): id 在第二个参数那个对象里，别把 kind 当成 id
		const options = element.arguments[1];
		if (options && ts.isObjectLiteralExpression(options)) return nodeIdOf(ts, options);
	}
	return undefined;
}

/** 新节点那个表达式（不含结尾逗号，由插入方按数组情况决定）。custom 给一段能跑通的 stub：拿不准就交给人，永不默默放行 */
function stubFor(kind: string, id: string, indent: string): string {
	const name = JSON.stringify(id);
	if (kind === "custom") {
		return [
			"kit.custom(" + name + ", async (ctx) => {",
			indent + "\t// TODO: 在这里写你的拦截逻辑；ctx.upstream 里有上游节点的产物",
			indent + "\treturn { status: \"abstain\", reason: \"还没写，交给人\" };",
			indent + "}, { onEmpty: \"deny\" })",
		].join("\n" + indent);
	}
	return "kit.node(" + JSON.stringify(kind) + ", { id: " + name + " })";
}

/** 往 nodes 数组里插一个节点，可选把一条既有边改接到它 */
export async function addNodeToSource(request: AddNodeRequest): Promise<AddNodeResult> {
	const ts = await typescript();
	const fileName = request.fileName ?? "flow.ts";
	const sf = ts.createSourceFile(fileName, request.source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
	const array = nodesArray(ts, sf);
	if (!array) return { ok: false, error: "找不到 nodes 数组（流程得写成 kit.flow({ nodes: [...] })）" };
	const id = String(request.id ?? "").trim();
	if (id === "") return { ok: false, error: "新节点要有 id" };
	const existing = array.elements.filter((element) => nodeIdOf(ts, element) === id);
	if (existing.length > 0) return { ok: false, error: "已经有 id 为 " + id + " 的节点了" };

	const first = array.elements[0];
	const lineStart = first ? sf.text.lastIndexOf("\n", first.getStart(sf)) + 1 : -1;
	const indent = first && lineStart >= 0 ? sf.text.slice(lineStart, first.getStart(sf)) : "\t\t";
	const stub = stubFor(String(request.kind ?? "custom"), id, indent);

	// 插点：默认在 ] 之前（追加到末尾），给了 before 就插在那个元素所在行的行首
	let insertAt = array.getEnd() - 1;
	if (request.before) {
		const target = array.elements.find((element) => nodeIdOf(ts, element) === request.before);
		if (!target) return { ok: false, error: "找不到要插在它前面的节点：" + request.before };
		insertAt = sf.text.lastIndexOf("\n", target.getStart(sf)) + 1;
	}
	// 数组非空时前面那条已经带逗号了（这是能不能通过的硬前提），新行自己也补一个
	const comma = array.elements.length === 0 ? "" : ",";
	const line = indent + stub + comma + "\n";
	let out = request.source.slice(0, insertAt) + line + request.source.slice(insertAt);

	if (request.connect) {
		const rewired = await editEdgeInSource({
			source: out,
			fileName,
			nodeId: request.connect.nodeId,
			kind: request.connect.edge.kind as never,
			...(request.connect.edge.label ? { label: request.connect.edge.label } : {}),
			to: id,
		});
		if (!rewired.ok) return { ok: false, error: "新节点插进去了，但接边失败：" + String(rewired.error) };
		out = rewired.source ?? out;
	}
	return { ok: true, source: out };
}
