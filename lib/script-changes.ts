// lib/script-changes.ts — 把同一文件上的多次改动合并成一份净变化
//
// 审核一段脚本时，"这个文件被改了三次"最好合成一屏：一次写入打底，后面几次替换
// 依次应用，最后给一份前后对比。合并的边界必须说清楚：
//
//   1. **基准不是磁盘上的文件**。脚本可能先 read 再处理，那种改动合并视图推不出来，
//      只能按"从某次写入开始"算净变化，状态标 unknown-base。
//   2. 只合并字面量能确定的操作。正文是变量、old 在当前内容里找不到、或者用了
//      apply_patch（补丁要按上下文匹配才能应用，不在这里重造 patch），都算断链，
//      带上原因停下——往后继续推演只会给出看着像全量的假对比。
//
// 断链不是失败：每处调用照旧能单独点开看原文，合并视图只是额外一屏。

import { collapseContext, lineDiff, type DiffBlock } from "./text-diff.ts";
import type { LiteralCall } from "./ptc-analyze.ts";

export type MergedStatus = "merged" | "chain-broken" | "unknown-base";

export interface MergedFileChange {
	/** 原始路径 */
	path: string;
	/** 真正参与推演的操作数 */
	ops: number;
	status: MergedStatus;
	/** 断链或基准不明的原因（一句话） */
	reason?: string;
	added: number;
	removed: number;
	/** 折过上下文的 diff 块 */
	blocks: DiffBlock[];
	/** 块被截断过（太长，只摆前一段） */
	truncated?: boolean;
	/**
	 * "改前"是按空文件算的：这次推演从一份写入开始，而那个文件此前的内容不知道
	 * （可能本来就有）。界面要照实说，别让人以为改前真的是空的。
	 */
	baseAssumedEmpty?: boolean;
}

/** 一次操作：工具名 + 行号（断链报错要指得出是哪儿） */
interface ChangeOp {
	tool: string;
	line: number;
	/** 整份写入的正文（write 的 content / str_replace_editor 的 file_text） */
	content?: string;
	/** 局部替换的旧文与新文（edit 的 old/new 等） */
	old?: string;
	new?: string;
	/** 补丁正文（apply_patch 那类）：这里不应用，只用于判定断链 */
	patch?: string;
	/** 关键字段是不是字面量 */
	literal: boolean;
}

/** 认得出"改文件"意图的工具 */
export const CHANGE_TOOLS: ReadonlySet<string> = new Set([
	"write", "edit", "str_replace_editor", "apply_patch", "patch",
]);

/** 这些工具会改文件，但补丁要按上下文匹配才能应用 */
const PATCH_TOOLS: ReadonlySet<string> = new Set(["apply_patch", "patch"]);

/**
 * 按工具名把入参摆成统一形状。字段名取候选集合：edit 用 old/new，
 * str_replace_editor 用 old_str/new_str 与 file_text，认不出来就当没有值。
 */
function opOf(call: LiteralCall): ChangeOp | undefined {
	const args: Record<string, string> = call.args ?? {};
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = args[key];
			if (typeof value === "string") return value;
		}
		return undefined;
	};
	const base = { tool: call.tool, line: call.line, literal: call.unresolvedArgs !== true };
	if (call.tool === "write") return { ...base, content: pick("content") };
	if (call.tool === "edit") {
		return { ...base, old: pick("old", "old_str", "oldText"), new: pick("new", "new_str", "newText") };
	}
	if (call.tool === "str_replace_editor") {
		return {
			...base,
			content: pick("file_text", "content"),
			old: pick("old_str", "old", "oldText"),
			new: pick("new_str", "new", "newText"),
		};
	}
	if (PATCH_TOOLS.has(call.tool)) {
		return { ...base, patch: pick("patch", "input", "diff", "text") };
	}
	return undefined;
}

/**
 * 合并同一文件上的改动。
 *
 * 只处理有路径字面量的文件工具：路径推不出来时，根本不知道"同一个文件"是谁。
 */
export function mergeFileChanges(calls: LiteralCall[], maxFiles = 20): MergedFileChange[] {
	const groups = new Map<string, ChangeOp[]>();
	// 补丁没有 path 参数（路径写在补丁正文里），单独收着，回头靠正文认领文件
	const patches: ChangeOp[] = [];
	for (const call of calls) {
		if (!CHANGE_TOOLS.has(call.tool)) continue;
		const op = opOf(call);
		if (!op) continue;
		if (PATCH_TOOLS.has(call.tool)) {
			patches.push(op);
			continue;
		}
		const path = call.args?.path ?? call.args?.file;
		if (typeof path !== "string" || path === "") continue;
		const bucket = groups.get(path);
		if (bucket) bucket.push(op);
		else groups.set(path, [op]);
	}

	/** 补丁正文里出现了这个路径，就认它改的是这个文件 */
	const patchFor = (path: string): ChangeOp | undefined =>
		patches.find((patch) => typeof patch.patch === "string" && patch.patch.includes(path));

	const out: MergedFileChange[] = [];
	for (const [path, ops] of groups) {
		const hit = patchFor(path);
		// 认不出补丁改的是哪个文件时，凡是合并了文件的地方都要存疑：
		// 合并视图自称"净变化"，就不能漏掉一处没并进来的改动
		const reason = hit
			? `第 ${hit.line} 行 ${hit.tool}：补丁也改这个文件，合并视图不重造 patch`
			: patches.length > 0
				? `脚本里还有 ${patches.length} 处 apply_patch，认不出它改的是哪些文件，这份净变化可能不全`
				: undefined;
		out.push(mergeOne(path, ops, reason));
		if (out.length >= maxFiles) break;
	}
	return out;
}

function mergeOne(path: string, ops: ChangeOp[], patchReason?: string): MergedFileChange {
	let base: string | undefined;
	let initial: string | undefined;
	let assumedEmpty = false;
	let applied = 0;
	let status: MergedStatus = "merged";
	let reason: string | undefined;

	for (const op of ops) {
		if (PATCH_TOOLS.has(op.tool)) {
			status = "chain-broken";
			reason = `第 ${op.line} 行 ${op.tool}：补丁要按上下文匹配才能应用，合并视图不重造 patch`;
			break;
		}
		if (op.content !== undefined) {
			if (initial === undefined) {
				initial = base;
				if (base === undefined) assumedEmpty = true; // 文件此前的内容不知道
			}
			base = op.content;
			applied += 1;
			continue;
		}
		if (op.old !== undefined && op.new !== undefined) {
			if (base === undefined) {
				status = "unknown-base";
				reason = `第 ${op.line} 行 ${op.tool}：前面没有可推演的全文，基准内容不知道`;
				break;
			}
			initial ??= base;
			const at = base.indexOf(op.old);
			if (at < 0) {
				status = "chain-broken";
				reason = `第 ${op.line} 行 ${op.tool}：要替换的内容在推演出的文本里找不到`;
				break;
			}
			base = base.slice(0, at) + op.new + base.slice(at + op.old.length);
			applied += 1;
			continue;
		}
		status = "chain-broken";
		const why = op.literal ? "入参里没有可推演的正文" : "入参不是字面量，值只能运行时才知道";
		reason = `第 ${op.line} 行 ${op.tool}：${why}`;
		break;
	}

	const before = initial ?? "";
	const after = base;
	if (after === undefined || applied === 0) {
		return {
			path,
			ops: applied,
			status: status === "merged" ? "unknown-base" : status,
			reason: reason ?? `${path}：只看到局部替换，推不出改动前后的全文`,
			added: 0,
			removed: 0,
			blocks: [],
		};
	}

	const diff = lineDiff(before, after);
	if (diff.status === "too-large") {
		return {
			path, ops: applied, status: "chain-broken",
			reason: reason ?? `${path}：改动太大，不逐行对比`,
			added: diff.added, removed: diff.removed, blocks: [],
		};
	}
	const ROW_LIMIT = 400;
	let total = 0;
	let truncated = false;
	const kept: DiffBlock[] = [];
	for (const block of collapseContext(diff.rows, 3)) {
		if (total >= ROW_LIMIT) { truncated = true; break; }
		if (block.type === "gap") { kept.push(block); continue; }
		const room = ROW_LIMIT - total;
		if (block.rows.length > room) {
			kept.push({ type: "rows", rows: block.rows.slice(0, room) });
			truncated = true;
			break;
		}
		total += block.rows.length;
		kept.push(block);
	}
	if (patchReason !== undefined) {
		// 推演出的这部分仍然摆出来（它确实会发生），但状态与原因以补丁那条为准
		return {
			path,
			ops: applied,
			status: "chain-broken",
			reason: patchReason,
			added: diff.added,
			removed: diff.removed,
			blocks: kept,
			...(truncated ? { truncated: true } : {}),
			...(assumedEmpty ? { baseAssumedEmpty: true } : {}),
		};
	}
	return {
		path,
		ops: applied,
		status,
		...(reason ? { reason } : {}),
		added: diff.added,
		removed: diff.removed,
		blocks: kept,
		...(truncated ? { truncated: true } : {}),
		...(assumedEmpty ? { baseAssumedEmpty: true } : {}),
	};
}
