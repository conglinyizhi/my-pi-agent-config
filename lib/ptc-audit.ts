// lib/ptc-audit.ts — run_code 的事前审核：接现成的审核链，加一个批准作用域
//
// 第 0 步（接入）只做四件事：
//   1. 把这段脚本端到审核链前：llm-review 的 chain（classifier 快筛 + chat 慢审）→ 必要时人工闸门
//   2. 送审材料带上理由、脚本原文，以及「这次可能用到的工具各是干什么的」——
//      pi 自带的与 subagent/goal 系列免描述，其余一律附（SELF_EVIDENT_TOOLS）
//   3. 批了之后登记一个作用域，让内层调用别再逐条弹人工闸门（硬拦与自动判定照旧）
//   4. 拒了整段不执行，返回编译失败式的错误（规划 §6.2）
//
// 还没做（后续生态）：字面量级影响面扫描、干跑、批准表与 hash 绑定、折叠、GUI 调整。
// 因此第 2 点现在是"把可调用工具的全集报一遍"，不是"这次真正用到的那些"——
// 等静态扫描进来再收紧。

import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { processSingleton } from "./process-singleton.ts";
import {
	resolveApprovalChannel,
	type ApprovalChannel,
	type FoldCallPayload,
	type MergedFilePayload,
	type ScriptEffectsPayload,
} from "./approval-channel.ts";
import { mergeFileChanges } from "./script-changes.ts";
import { patchPathsOf } from "./patch-paths.ts";
import type { LiteralCall, ScriptScan } from "./ptc-analyze.ts";
import { displayPath } from "./path-display.ts";
import { compareCalls, compareLine, type DryRunResult } from "./ptc-dryrun.ts";
import {
	createReviewCache,
	loadLlmReviewConfig,
	reviewCommand as defaultReviewCommand,
	runClassifierReview,
	type LlmReviewConfig,
	type ReviewCache,
	type ReviewResult,
} from "../extensions/sandbox-permissions/llm-review.ts";
import { preReview } from "./pre-review.ts";

/**
 * 审核模型本来就认识的工具：只给名字，不占送审额度。
 * 判据是"pi 自带 / subagent 与 goal 系列"；不在名单里的（本仓自定义的、MCP 挂上来的）
 * 一律附上它的描述——审核模型不认识它们，看到名字只会猜。
 */
export const SELF_EVIDENT_TOOLS: ReadonlySet<string> = new Set([
	"read", "bash", "bash_background", "edit", "write", "grep", "find", "ls",
	"apply_patch", "patch", "todo_write", "str_replace_editor",
	"subagent", "subagent_resume", "create_goal", "update_goal", "get_goal", "todo_write",
	"ask_question", "web_search",
]);

/** 送审时最多附几个工具的描述：再多是噪音，也不该拿它撑爆一次请求 */
const MAX_DESCRIBED_TOOLS = 20;

export interface PtcToolInfo {
	name: string;
	description?: string;
	annotations?: Record<string, unknown>;
}

/** 脚本摘要：批准作用域与审计都按它对齐 */
export function ptcScriptDigest(script: string): string {
	return createHash("sha256").update(script, "utf8").digest("hex");
}

/** 这段脚本要审的东西：理由 + 原文 + 工具面 */
export interface PtcAuditInput {
	script: string;
	reason: string;
	tools: PtcToolInfo[];
	/** 字面量扫描结果；没扫（或扫失败）时不带，送审材料就退回"工具全集" */
	scan?: ScriptScan;
	/** 干跑预演结果；没跑或没跑成时不带 */
	dry?: DryRunResult;
	/**
	 * 展示用文本（重排过缩进与换行的脚本）。只给审核窗看：送审与批准绑定走的
	 * 仍是 script（原文），所以展示排版不会影响批的是哪一段。
	 */
	display?: string;
	/** 展示文本的扫描结果：折叠芯片的区间要落在被显示的那份文本上 */
	displayScan?: ScriptScan;
	/** 当前工作目录：算折叠芯片的显示路径用（$PWD 那条）。缺省就不缩 */
	cwd?: string;
	/** 家目录：同上（~ 那条）。缺省就不缩 */
	home?: string;
}

/**
 * 折叠白名单：只有这两类调用折成芯片。
 *
 * 折叠的收益是省审核注意力，代价是原文看不见——所以白名单只收"意图已明确"的常见动作。
 * 白名单外的调用（自定义工具、MCP 挂上来的、subagent……）一律亮原文：
 * 不认识的动作不折，否则折叠就成了藏风险。
 */
const FOLD_FILE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "apply_patch", "patch", "str_replace_editor"]);
const FOLD_SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "bash_background"]);

/** 文件工具的路径字段（apply_patch 交的是补丁正文，没有单一路径，就没有 displayPath） */
const FILE_PATH_FIELDS: readonly string[] = ["path", "file", "to"];

/** 正文预览上限：显示层，够看清意图即可，别把浮层塞爆 */
const PREVIEW_MAX = 4000;

/** 补丁正文上限：比正文宽一些（补丁自带上下文行，截太狠就看不出改了哪几处） */
const PATCH_MAX = 8000;

/** 补丁正文里认文件：实现放在中立模块，合并视图那边也要用同一套 */
export { patchPathsOf } from "./patch-paths.ts";

function clipPreview(text: string): { text: string; truncated: boolean } {
	return text.length <= PREVIEW_MAX
		? { text, truncated: false }
		: { text: text.slice(0, PREVIEW_MAX), truncated: true };
}

/**
 * 正文预览。只给"脚本原文里看不回来"的东西：write 的 content、edit 的 old/new
 * 都是转义过的字符串字面量，前端拿源码切片只会得到一屏 \n。
 * 命令与路径不进预览——前端按区间切原文就行，没必要在载荷里再存一份。
 */
function previewFieldsOf(call: LiteralCall): Partial<FoldCallPayload> {
	const args: Record<string, string> = call.args ?? {};
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = args[key];
			if (typeof value === "string") return value;
		}
		return undefined;
	};
	// 局部替换：edit 用 old/new，str_replace_editor 用 old_str/new_str
	const oldText = pick("old", "old_str", "oldText");
	const newText = pick("new", "new_str", "newText");
	if (oldText !== undefined && newText !== undefined) {
		const old = clipPreview(oldText);
		const next = clipPreview(newText);
		return { replacement: { old: old.text, new: next.text, truncated: old.truncated || next.truncated } };
	}
	// 整份写入：write 的 content，str_replace_editor 的 file_text
	const content = pick("content", "file_text");
	if (content !== undefined) {
		const clipped = clipPreview(content);
		return { contentPreview: clipped.text, ...(clipped.truncated ? { truncated: true } : {}) };
	}
	// 补丁正文：原样带给浮层，按 +/- 摆出来（不在这里重造 patch）
	const patchText = pick("patch", "input", "diff");
	if (patchText !== undefined) {
		const clipped = patchText.length <= PATCH_MAX
			? { text: patchText, truncated: false }
			: { text: patchText.slice(0, PATCH_MAX), truncated: true };
		return { patchText: clipped.text, ...(clipped.truncated ? { truncated: true } : {}) };
	}
	return {};
}

/** 把扫描到的调用整理成折叠芯片（白名单外的丢掉：它们照旧亮原文） */
const READ_CMDS = new Set(["cat", "less", "more", "head", "tail", "grep", "rg", "find", "ls", "stat", "wc", "file", "awk", "cut", "sort", "uniq", "diff", "du", "df", "tree", "bat", "sed", "md5sum", "sha256sum", "readlink"]);
const WRITE_CMDS = new Set(["cp", "mv", "touch", "mkdir", "chmod", "chown", "tee", "dd", "ln", "install", "rsync", "truncate", "patch", "npm", "pnpm", "yarn", "make", "git"]);
const DELETE_CMDS = new Set(["rm", "rmdir", "shred", "unlink"]);

/**
 * PreShell：这条 shell 命令自己会读 / 写 / 删什么。
 * 在 PTC 里命令是脚本文本里的字符串，用 JS 那套分析它分析不明白——只能按 shell 的
 * 词法粗粒度看一眼：认命令名与字面量路径，认不出来的就不写进列表。
 */
export function shellPreShell(command: string): { read: string[]; write: string[]; delete: string[] } {
	const read = new Set<string>();
	const write = new Set<string>();
	const del = new Set<string>();
	for (const segment of String(command ?? "").split(/;|&&|\|\||\||\n/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) continue;
		// 重定向先算：> 与 >> 的目标是写
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			if (word === ">" || word === ">>") {
				const target = words[i + 1];
				if (target && !target.startsWith("-")) write.add(target);
			} else if (/^>>?[^>]/.test(word)) {
				write.add(word.replace(/^>>?/, ""));
			}
		}
		let at = 0;
		while (["sudo", "env", "time", "command", "nohup"].includes(words[at])) at++;
		const name = (words[at] ?? "").split("/").pop() ?? "";
		if (name === "") continue;
		const args = words.slice(at + 1).filter((word) => !word.startsWith("-") && !word.startsWith(">"));
		const paths = args.filter((word) => word.includes("/") || word.startsWith("~") || word === "." || word === "..");
		if (DELETE_CMDS.has(name)) for (const path of paths) del.add(path);
		else if (name === "cp" || name === "mv" || name === "ln" || name === "install") {
			// 源是读、目标是写：最后一个参数才是目标
			paths.slice(0, -1).forEach((path) => read.add(path));
			if (paths.length > 0) write.add(paths[paths.length - 1]);
		} else if (WRITE_CMDS.has(name)) for (const path of paths) write.add(path);
		else if (READ_CMDS.has(name)) {
			const writing = name === "sed" && words.includes("-i");
			for (const path of paths) (writing ? write : read).add(path);
		}
	}
	return { read: [...read], write: [...write], delete: [...del] };
}

/**
 * 长字面量的折叠范围：超过 160 字符的字符串，或跨 5 行以上的数组/对象。
 * 为什么折：模型写的常量与数组动辄几十行，把审核窗和人的注意力全吃掉了。
 * 折起来只是"先不看"——送审文本一个字都不改。
 */
export function longLiteralSpans(text: string): Array<{ startOffset: number; endOffset: number }> {
	const source = typeof text === "string" ? text : "";
	const spans: Array<{ startOffset: number; endOffset: number }> = [];
	const brackets: Array<{ at: number }> = [];
	// 代码里真出现的 tools.xxx( —— 字符串里的不算（字符串在上面的分支里已跳过）
	const toolCalls: number[] = [];
	let quote = "";
	let quoteAt = 0;
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (quote !== "") {
			if (ch === "\\") { i += 2; continue; }
			if (ch === quote) {
				if (i + 1 - quoteAt >= 160) spans.push({ startOffset: quoteAt, endOffset: i + 1 });
				quote = "";
			}
			i++;
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			const nl = source.indexOf("\n", i);
			i = nl < 0 ? source.length : nl;
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end < 0 ? source.length : end + 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") { quote = ch; quoteAt = i; i++; continue; }
		if (/[A-Za-z_$]/.test(ch)) {
			if (source.startsWith("tools", i) && /^\s*\.\s*[A-Za-z_$][\w$]*\s*\(/.test(source.slice(i + 5))) {
				toolCalls.push(i);
			}
			let k = i;
			while (k < source.length && /[A-Za-z0-9_$.]/.test(source[k])) k++;
			i = k;
			continue;
		}
		if (ch === "[" || ch === "{" || ch === "(") { brackets.push({ at: i }); i++; continue; }
		if (ch === "]" || ch === "}" || ch === ")") {
			const open = brackets.pop();
			// 只折数组与对象：圆括号是调用的实参，那块由调用芯片负责
			if (open && ch !== ")") {
				const body = source.slice(open.at, i + 1);
				// 块里真有工具调用的豁免：折了就是把主要逻辑藏起来（提督定的规则）。
				// if/for 这类块也不算"大数组"，它们的长相是代码，不是数据。
				const hasCall = toolCalls.some((at) => at > open.at && at < i);
				const head = source.slice(Math.max(0, open.at - 40), open.at);
				const looksLikeLogic = /\b(if|for|while|switch|try|function|=>)\b[^;]*$/.test(head);
				if (body.split("\n").length >= 5 && !hasCall && !looksLikeLogic) {
					spans.push({ startOffset: open.at, endOffset: i + 1 });
				}
			}
			i++;
			continue;
		}
		i++;
	}
	// 只留最外层：套在别人里面的丢掉
	spans.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
	const kept: Array<{ startOffset: number; endOffset: number }> = [];
	for (const span of spans) {
		const last = kept[kept.length - 1];
		if (last && span.endOffset <= last.endOffset) continue;
		kept.push(span);
	}
	return kept;
}

export function foldCallsOf(input: PtcAuditInput): FoldCallPayload[] {
	const out: FoldCallPayload[] = [];
	// 区间必须落在被显示的那份文本上：有展示文本就按它的扫描结果来
	for (const call of (input.displayScan ?? input.scan)?.calls ?? []) {
		const kind: FoldCallPayload["kind"] | undefined = FOLD_FILE_TOOLS.has(call.tool)
			? "file"
			: FOLD_SHELL_TOOLS.has(call.tool) ? "shell" : undefined;
		if (kind === undefined) continue;
		const patchText = call.args.patch ?? call.args.input ?? call.args.diff;
		const patchPaths = patchText !== undefined ? patchPathsOf(patchText) : [];
		const raw = kind === "file"
			? FILE_PATH_FIELDS.map((field) => call.args[field]).find((value) => value !== undefined)
				?? patchPaths[0]
			: call.args.cwd;
		const body = kind === "file" ? call.args.content : call.args.command;
		// 芯片只盖实参：函数名与括号照旧在代码里。拿不到实参区间就不折——
		// 折整个调用会把函数名也吃掉，那与"只包变量部分"不是一回事。
		const startOffset = call.argsStartOffset;
		const endOffset = call.argsEndOffset;
		if (startOffset === undefined || endOffset === undefined || endOffset <= startOffset) continue;
		out.push({
			tool: call.tool,
			kind,
			...(raw !== undefined ? { displayPath: displayPath(raw, { home: input.home, cwd: input.cwd }), absPath: raw } : {}),
			literal: call.unresolvedArgs !== true,
			startOffset,
			endOffset,
			line: call.line,
			endLine: call.endLine,
			...(body !== undefined
				? {
					bytes: Buffer.byteLength(body, "utf8"),
					lines: body.split("\n").length,
					// shell 芯片的弹窗要摆命令本身，不是 { command: '…' } 那截实参
					...(kind === "shell"
						? { contentPreview: body, preshell: shellPreShell(body) }
						: {}),
				}
				: {}),
			...(() => {
				const mode = call.args.command;
				return typeof mode === "string" && mode !== "" ? { mode } : {};
			})(),
			...(patchPaths.length > 0
				? {
					absPaths: patchPaths.slice(0, 8),
					paths: patchPaths.slice(0, 8).map((path) => displayPath(path, { home: input.home, cwd: input.cwd })),
				}
				: {}),
			...previewFieldsOf(call),
		});
	}

	// 长常量与大数组：跟调用芯片同一份载荷，只是没有工具名。
	// 区间同样落在显示文本上，前端照原样折，不自己猜。
	const shown = input.display ?? input.script ?? "";
	for (const span of longLiteralSpans(shown)) {
		if (out.some((item) => span.startOffset >= item.startOffset && span.endOffset <= item.endOffset)) continue;
		const body = shown.slice(span.startOffset, span.endOffset);
		out.push({
			tool: "literal",
			kind: "literal",
			literal: true,
			startOffset: span.startOffset,
			endOffset: span.endOffset,
			line: shown.slice(0, span.startOffset).split("\n").length,
			endLine: shown.slice(0, span.endOffset).split("\n").length,
			bytes: Buffer.byteLength(body, "utf8"),
			lines: body.split("\n").length,
		});
	}
	return out;
}

/**
 * 工具面那一段：自明的只列名字，其余附一句描述与 MCP 注解
 * （注解带 readOnly / destructive / openWorld 提示，判风险时最有用）。
 */
export function describeTools(tools: PtcToolInfo[], used?: string[]): string {
	const selfEvident: string[] = [];
	const described: string[] = [];
	// 扫描给得出"这次真正用到哪几个"时，只描述那几个；其余只报个数（省额度也更准）
	const narrowed = used !== undefined && used.length > 0 ? new Set(used) : undefined;
	const pool = narrowed ? tools.filter((tool) => narrowed.has(tool.name)) : tools;
	for (const tool of pool) {
		if (SELF_EVIDENT_TOOLS.has(tool.name)) {
			selfEvident.push(tool.name);
			continue;
		}
		const hints: string[] = [];
		const annotations = tool.annotations ?? {};
		if (annotations.readOnlyHint === true) hints.push("只读");
		if (annotations.destructiveHint === true) hints.push("可破坏");
		if (annotations.openWorldHint === true) hints.push("触达外部");
		const summary = (tool.description ?? "").split("\n")[0]?.trim() ?? "";
		const line = `- ${tool.name}${hints.length > 0 ? `（${hints.join("、")}）` : ""}: ${summary.slice(0, 160)}`;
		described.push(line);
		if (described.length >= MAX_DESCRIBED_TOOLS) break;
	}
	const sections: string[] = [];
	if (described.length > 0) sections.push(`脚本用到的工具（需要说明的）：\n${described.join("\n")}`);
	if (selfEvident.length > 0) sections.push(`另可调用：${selfEvident.join("、")}`);
	if (narrowed) sections.push(`（脚本还能调用注册表里的其它工具，共 ${tools.length} 个）`);
	return sections.join("\n\n");
}

/**
 * 把一条"看不清"对到具体那一行：附上该行的代码片段。
 * 光给行号没法定位——代码区是按重排后的文本渲染的，用户手里没有行号可数。
 * 行号按显示文本算（与 displayScan 同源），所以片段取 display 的第 N 行。
 */
/** 去掉开头的 行:列 —— 保留原文其余部分 */
function withoutPosition(item: string): string {
	return item.replace(/^\s*\d+:\d+\s*/, "");
}

function snippetOf(item: string, display: string | undefined): string {
	if (!display) return "";
	const match = /^\s*(\d+):\d+\s/.exec(item);
	if (!match) return "";
	const source = display.split("\n")[Number(match[1]) - 1];
	const trimmed = source?.trim() ?? "";
	if (!trimmed) return "";
	return `\n      ↳ ${trimmed.length > 90 ? `${trimmed.slice(0, 90)}…` : trimmed}`;
}

/** 静态扫描那一段：用到的工具、字面量路径与命令、以及"看不清"的地方 */
export function scanSummary(scan: ScriptScan | undefined, display?: string): string {
	if (scan === undefined) return "";
	const lines: string[] = ["【静态扫描（只认字面量）】"];
	if (scan.parseError) lines.push(`脚本没解析干净：${scan.parseError}`);
	lines.push(`字面上调用的工具：${scan.tools.length > 0 ? scan.tools.join("、") : "（没有直接写出来的调用）"}`);
	if (scan.paths.length > 0) lines.push(`路径字面量：${scan.paths.join("、")}`);
	if (scan.commands.length > 0) lines.push(`命令字面量：${scan.commands.map((cmd) => JSON.stringify(cmd)).join("、")}`);
	if (scan.opaque.length > 0) {
		lines.push("看不清的地方（值由运行时决定，可能比上面列的多）：");
		// 不带行号：扫描那份文本与代码区显示的那份不是同一份，行号摆在一起只会互相拆台
		// （踩过：写着 37:7，用户看到的第 37 行是空的）。只留能对号入座的代码片段。
		for (const item of scan.opaque) lines.push(`  ${withoutPosition(item)}${snippetOf(item, display)}`);
	}
	return lines.join("\n");
}

/** 送审文本：审核模型与审批卡看到的是同一份 */
/** 干跑那一段：预演到会调用什么，或者为什么没预演成 */
export function dryRunSummary(dry: DryRunResult | undefined): string {
	if (dry === undefined) return "";
	const head =
		dry.status === "ok"
			? `干跑预演（假数据走了一遍控制流，${dry.ms}ms）会执行：`
			: dry.status === "timeout"
				? `干跑预演超时（${dry.ms}ms），已预演到：`
				: `干跑预演失败（${dry.error ?? "原因不明"}），已预演到：`;
	const counts = new Map<string, number>();
	for (const call of dry.calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
	const rendered = [...counts.entries()].map(([tool, count]) => (count > 1 ? `${tool}×${count}` : tool));
	return `${head}${rendered.length > 0 ? rendered.join("、") : "（没有派发任何调用）"}`;
}

export function buildPtcAuditSubject(input: PtcAuditInput): string {
	return [
		"【run_code 事前审核】下面这段 JavaScript 会在沙箱里执行，并可以调用工具。",
		"",
		`执行理由（模型自述）：${input.reason}`,
		"",
		describeTools(input.tools, input.scan?.tools),
		"",
		scanSummary(input.scan, input.display),
		dryRunSummary(input.dry),
		"",
		"脚本原文：",
		input.script,
	].filter((part) => part !== "").join("\n");
}

/**
 * 拒绝时的返回：照编译器报错的样子（位置 + 错误码 + 可行动作），
 * 让模型自己改再发——这是它最熟的失败形态。整段没有执行，零副作用。
 */
export function ptcRejectedText(reason: string, comment?: string): string {
	const lines = [
		"run_code: 本段未执行（安全审核未通过）",
		`  E-DENIED  ${reason}`,
		"为防止副作用，整段脚本被丢弃：没有产生任何读写。",
		"",
		"改完这一处再发一次；确实需要这段能力，就把需求报给主 agent。",
	];
	if (comment) lines.push("", `审批附言：${comment}`);
	return lines.join("\n");
}

export interface PtcAuditOutcome {
	approved: boolean;
	/** 人拒绝时填的附言 */
	comment?: string;
	/** 预审结论（没跑预审时为 undefined） */
	review?: ReviewResult;
}

/**
 * 可注入的两个接点（给测试用）：
 *  - reviewCommand：预审链（分类器 + chat）。注进来才能断言「送下去的是 PTC 场景」，
 *    否则这条调用会读真配置、发真请求。
 *  - channel：人工闸门。注进来才能在不弹窗的前提下走完「预审不过 → 回退人审」。
 */
export interface PtcAuditDependencies {
	reviewCommand?: typeof defaultReviewCommand;
	/** 测试注入；默认走审核流里分类器那个节点（带 advisor 的支路）。 */
	classifierReview?: typeof runClassifierReview;
	/** 测试注入；默认读 extensions.toml 的审核档位。 */
	loadReviewConfig?: () => LlmReviewConfig;
	channel?: ApprovalChannel;
}

let reviewCacheForPtc: ReviewCache | undefined;
function ptcReviewCache(): ReviewCache {
	reviewCacheForPtc ??= createReviewCache();
	return reviewCacheForPtc;
}

/**
 * 同一文件多处改动的合并视图。
 *
 * 只喂显示层：它是对字面量的推演，不是磁盘上的文件（基准可能本来就是空的），
 * 状态与原因照实带给窗口，别让人把推演当成事实。
 */
export function mergedChangesOf(input: PtcAuditInput): MergedFilePayload[] {
	const calls = (input.displayScan ?? input.scan)?.calls ?? [];
	return mergeFileChanges(calls).map((entry) => ({
		...entry,
		path: displayPath(entry.path, { home: input.home, cwd: input.cwd }),
		absPath: entry.path,
	}));
}

/** 从扫描与干跑结果整理出给审批窗的结构化影响面 */
export function scriptEffectsOf(input: PtcAuditInput): ScriptEffectsPayload {
	const scan = input.scan;
	// 带行号的东西（"看不清"那些）要按显示文本那份扫描算：代码区显示的是重排后的文本，
	// 拿源码行号去标会标到另一行（踩过：12 行空白被标黄）
	const located = input.displayScan ?? input.scan;
	const editCalls = foldCallsOf(input);
	// 合并视图与折叠芯片看同一份调用（区间都落在被显示的那份文本上）
	const mergedChanges = mergedChangesOf(input);
	const dryRunCalls: string[] = [];
	if (input.dry) {
		const counts = new Map<string, number>();
		for (const call of input.dry.calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
		for (const [tool, count] of counts) dryRunCalls.push(count > 1 ? `${tool}×${count}` : tool);
	}
	return {
		tools: scan?.tools ?? [],
		paths: scan?.paths ?? [],
		commands: scan?.commands ?? [],
		// 每条"看不清"附上那一行的代码片段：窗口里只有重排后的文本，光给行号定位不了
		opaque: (located?.opaque ?? []).map((item) => `${item}${snippetOf(item, input.display)}`),
		...(scan?.parseError ? { parseError: scan.parseError } : {}),
		digestShort: ptcScriptDigest(input.script).slice(0, 12),
		...(input.dry ? { dryRunStatus: input.dry.status, dryRunCalls } : {}),
		// 折叠芯片与合并视图：显示层字段，送审文本（subject）一个字节都不动
		...(editCalls.length > 0 ? { editCalls } : {}),
		...(mergedChanges.length > 0 ? { mergedChanges } : {}),
	};
}

/**
 * 事前审核一段脚本。判定口径与 bash 那条链一致：
 * 预审判 safe 且档位是 auto 就直接放行；其余交人工闸门。
 *
 * 送审时标明场景为 ptc：分类器不再问 scripted_edit（审的就是脚本，问了没信息量），
 * 也不拿它计入判定；审批窗里该行以禁用态展示。见 review-dimensions 的 SCENARIOS。
 */
export interface PtcPreReviewResult {
	config: LlmReviewConfig;
	subject: string;
	digest: string;
	review?: ReviewResult;
	/** 判据与主链同款：判 safe 且档位 auto 才算放行 */
	autoApproved: boolean;
}

/**
 * 只跑预审、不碰人工闸门的因子化。
 *
 * 与 lib/bash-approval.ts 的 preReviewBashCommand 对称：给「自己决定要不要惊动用户」
 * 的调用方用（worker 里的 run_code 没有窗口可弹）。判据只有这一处表达式，
 * approvePtcScript 与 worker 侧都调它。
 */
export async function preReviewPtcScript(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	input: PtcAuditInput;
	signal?: AbortSignal;
	deps?: PtcAuditDependencies;
}): Promise<PtcPreReviewResult> {
	const { pi, ctx, input, signal } = options;
	const deps = options.deps ?? {};
	const subject = buildPtcAuditSubject(input);
	const digest = ptcScriptDigest(input.script);
	const config = (deps.loadReviewConfig ?? loadLlmReviewConfig)();

	// 预审走审核流：与 bash 那条是同一条链、同一处判据，只是场景是 ptc
	// （分类器据此不再问「这条命令是否用脚本改写文件」这种没信息量的维度）。
	// 以前这里另抄了一份 autoApproved 的表达式，现在没有了。
	try {
		const result = await preReview({
			input: { pi, ctx, command: subject, rules: [], scenario: "ptc", ...(signal ? { signal } : {}) },
			config,
			cache: ptcReviewCache(),
			nodes: {
				...(deps.reviewCommand ? { reviewCommand: deps.reviewCommand } : {}),
				...(deps.classifierReview ? { classifierReview: deps.classifierReview } : {}),
				...(deps.loadReviewConfig ? { loadConfig: deps.loadReviewConfig } : {}),
			},
		});
		return { config, subject, digest, review: result.review, autoApproved: result.autoApproved };
	} catch {
		return { config, subject, digest, review: undefined, autoApproved: false };
	}
}

export async function approvePtcScript(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	input: PtcAuditInput;
	signal?: AbortSignal;
	deps?: PtcAuditDependencies;
}): Promise<PtcAuditOutcome> {
	const { pi, ctx, input, signal } = options;
	const deps = options.deps ?? {};

	// 预审走同一处因子化：判据只有一份
	const { digest, review, autoApproved } = await preReviewPtcScript(options);
	if (autoApproved) {
		appendPtcAudit(pi, { digest, outcome: "approved", via: "preflight", reason: input.reason, review });
		return { approved: true, review };
	}

	const channel = deps.channel ?? resolveApprovalChannel();
	// 给审批窗的是**结构化**的一份：command 放脚本原文（窗口当代码块渲染），
	// 理由与影响面各走各的字段；送审给模型的仍是上面那段带解释的 subject。
	const decision = await channel(
		{
			kind: "audit",
			// 审核窗显示重排后的文本；送审材料与 digest 都是另一条路（原文）
			command: input.display ?? input.script,
			reason: input.reason,
			subject: "script",
			scriptEffects: scriptEffectsOf(input),
			review,
			signal,
		},
		ctx,
	);
	const approved = decision.action === "allow";
	appendPtcAudit(pi, {
		digest,
		outcome: approved ? "approved" : "denied",
		via: "human",
		reason: input.reason,
		review,
		...(decision.comment ? { comment: decision.comment } : {}),
	});
	return { approved, comment: decision.comment, review };
}

/**
 * 审计条目：只在会话里留判定所需的那点东西。
 * 脚本全文不进会话记录（与 bash-audit 同一口径），留 digest 与理由。
 */
function appendPtcAudit(pi: ExtensionAPI, entry: Record<string, unknown>): void {
	const full = { ...entry, ts: Date.now() };
	try {
		pi.appendEntry("ptc-audit", full);
	} catch {
		/* 审计失败不该挡住执行 */
	}
	notePtcAudit(full as unknown as PtcAuditEntry);
}

/**
 * 脚本跑完之后的审计条目：这次真的派发了哪些调用、有没有越出批准范围。
 * 越界不等于被拦下——它只是"不享受这次的免问"，仍旧照原路走自己的审批链。
 */
export function recordPtcExecution(
	pi: ExtensionAPI,
	input: { callId: string; digest: string; reason?: string; dry?: DryRunResult },
): { calls: PtcNestedCallRecord[]; outOfScope: string[]; comparison?: ReturnType<typeof compareCalls> } {
	const log = takeNestedCalls(input.callId);
	// 干跑是预演，真跑是事实：对不上不是错误，但必须留痕——究竟是"假数据把控制流带偏"
	// 还是"只有真数据才走到那条路"，只有这里能回答。
	const comparison = input.dry ? compareCalls(input.dry.calls, log.calls) : undefined;
	appendPtcAudit(pi, {
		digest: input.digest,
		outcome: "executed",
		via: "script",
		...(input.reason ? { reason: input.reason } : {}),
		calls: log.calls,
		outOfScope: log.outOfScope,
		...(input.dry
			? {
					dryRun: {
						status: input.dry.status,
						calls: input.dry.calls.map((call) => call.tool),
						...(input.dry.error ? { error: input.dry.error } : {}),
						...(input.dry.output ? { output: input.dry.output } : {}),
					},
					...(comparison ? { comparison, compareLine: compareLine(comparison) } : {}),
				}
			: {}),
	});
	return { ...log, ...(comparison ? { comparison } : {}) };
}

// ── 批准作用域 ──
//
// 批过的是一段脚本，内层调用不该再逐条弹人工闸门（否则等于双层询问）。
// 作用域按 run_code 的 callId 存：内层调用的 toolCallId 是 `<父 id>/<n>`，
// 由它反查父级即可，并行跑两段脚本也不会互相蹭到批准。

export interface PtcScope {
	callId: string;
	scriptDigest: string;
	/** 字面上用到的工具名：内层调用只在这个集合里才免于逐条问人 */
	tools: string[];
	/** 脚本里有推不出来的地方（opaque / 解析失败）：整段退回逐条审批 */
	opaque: boolean;
	since: number;
}

function scopes(): Map<string, PtcScope> {
	return processSingleton("ptc-approved-scopes", () => new Map<string, PtcScope>());
}

export function beginPtcScope(
	callId: string,
	scriptDigest: string,
	scope: { tools?: string[]; opaque?: boolean } = {},
): void {
	scopes().set(callId, {
		callId,
		scriptDigest,
		tools: scope.tools ?? [],
		opaque: scope.opaque === true,
		since: Date.now(),
	});
}

/**
 * 这段脚本批过的范围里，能不能免掉 `tools` 里某次调用的"再问一次人"。
 * 判据故意保守：脚本写不出这次调用（扫描没看见）或整段有看不清的地方，都不免。
 */
export function ptcScopeCoversTool(scope: PtcScope, toolName: string): boolean {
	if (scope.opaque) return false;
	return scope.tools.includes(toolName);
}

export function endPtcScope(callId: string): void {
	scopes().delete(callId);
}

/** 由内层调用的 id 反查它所属脚本的批准作用域；没有就返回 undefined */
export function ptcScopeForNestedCall(toolCallId: string | undefined): PtcScope | undefined {
	if (!toolCallId) return undefined;
	const store = scopes();
	let id = toolCallId;
	for (let depth = 0; depth < 3; depth++) {
		const hit = store.get(id);
		if (hit) return hit;
		const cut = id.lastIndexOf("/");
		if (cut <= 0) return undefined;
		id = id.slice(0, cut);
	}
	return undefined;
}

/** 仅供测试：清空作用域 */
export function clearPtcScopes(): void {
	scopes().clear();
}

// ── 内层调用的归集（P0 观测） ──
//
// 事前的扫描是"它可能干什么"，这里记的是"它真的干了什么"：脚本里派发的每次调用
// 都在 tool_call 钩子里经过，按 parentToolCallId 归到所属脚本。
// 只留一行摘要（工具名 + 参数截断 + 是否在批准范围内），全文不落。

export interface PtcNestedCallRecord {
	tool: string;
	/** 参数摘要（单行、截断、已消毒） */
	args: string;
	/** 是否落在这次的批准范围内 */
	covered: boolean;
	ts: number;
}

const MAX_NESTED_CALLS = 64;

interface PtcCallLog {
	calls: PtcNestedCallRecord[];
	outOfScope: string[];
}

function callLogs(): Map<string, PtcCallLog> {
	return processSingleton("ptc-nested-calls", () => new Map<string, PtcCallLog>());
}

/** 参数摘要：单行 + 截断，够人判断"它在干什么"就行 */
export function summarizeArgs(input: unknown, maxChars = 120): string {
	let rendered: string;
	try {
		rendered = typeof input === "string" ? input : JSON.stringify(input ?? {});
	} catch {
		rendered = "<参数无法序列化>";
	}
	const flattened = rendered
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flattened.length > maxChars ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
}

/** 记一次脚本里派发的调用 */
export function recordNestedCall(callId: string, record: Omit<PtcNestedCallRecord, "ts">): void {
	const logs = callLogs();
	const log = logs.get(callId) ?? { calls: [], outOfScope: [] };
	if (log.calls.length < MAX_NESTED_CALLS) log.calls.push({ ...record, ts: Date.now() });
	if (!record.covered && !log.outOfScope.includes(record.tool)) log.outOfScope.push(record.tool);
	logs.set(callId, log);
}

/** 取走并清掉这次脚本的调用记录（脚本结束时调用） */
export function takeNestedCalls(callId: string): PtcCallLog {
	const logs = callLogs();
	const log = logs.get(callId) ?? { calls: [], outOfScope: [] };
	logs.delete(callId);
	return log;
}

/** 仅供测试 */
export function clearNestedCalls(): void {
	callLogs().clear();
}

export interface PtcAuditEntry {
	ts: number;
	digest: string;
	outcome: "approved" | "denied" | "executed";
	via: "preflight" | "human" | "script";
	reason?: string;
	review?: { verdict?: string; reason?: string };
	comment?: string;
	/** 脚本执行完才有：真实派发过的调用 */
	calls?: PtcNestedCallRecord[];
	/** 脚本执行完才有：不在批准范围内、因此照旧走原链的工具名 */
	outOfScope?: string[];
	/** 脚本执行完才有：干跑预演的结果，以及它与真跑对不上的地方 */
	dryRun?: { status: string; calls: string[]; error?: string; output?: string };
	comparison?: { unfulfilled: string[]; unpredicted: string[] };
	compareLine?: string;
}

/** 审计条目的内存滚动窗口（不落盘，见规划 §8.1） */
const MAX_AUDIT_ENTRIES = 50;

function auditLog(): PtcAuditEntry[] {
	return processSingleton("ptc-audit-log", () => [] as PtcAuditEntry[]);
}

export function notePtcAudit(entry: PtcAuditEntry): void {
	const log = auditLog();
	log.push(entry);
	while (log.length > MAX_AUDIT_ENTRIES) log.shift();
}

/** 最近若干条审计（新在前）：给探针与 /ptc-audit 用 */
export function recentPtcAudits(limit = 10): PtcAuditEntry[] {
	return auditLog().slice(-limit).reverse();
}

/** 仅供测试 */
export function clearPtcAudits(): void {
	auditLog().length = 0;
}
