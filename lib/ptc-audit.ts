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
import { resolveApprovalChannel, type ApprovalChannel, type ScriptEffectsPayload } from "./approval-channel.ts";
import type { ScriptScan } from "./ptc-analyze.ts";
import { compareCalls, compareLine, type DryRunResult } from "./ptc-dryrun.ts";
import {
	createReviewCache,
	loadLlmReviewConfig,
	reviewCommand as defaultReviewCommand,
	type ReviewCache,
	type ReviewResult,
} from "../extensions/sandbox-permissions/llm-review.ts";

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

/** 静态扫描那一段：用到的工具、字面量路径与命令、以及"看不清"的地方 */
export function scanSummary(scan: ScriptScan | undefined): string {
	if (scan === undefined) return "";
	const lines: string[] = ["【静态扫描（只认字面量）】"];
	if (scan.parseError) lines.push(`脚本没解析干净：${scan.parseError}`);
	lines.push(`字面上调用的工具：${scan.tools.length > 0 ? scan.tools.join("、") : "（没有直接写出来的调用）"}`);
	if (scan.paths.length > 0) lines.push(`路径字面量：${scan.paths.join("、")}`);
	if (scan.commands.length > 0) lines.push(`命令字面量：${scan.commands.map((cmd) => JSON.stringify(cmd)).join("、")}`);
	if (scan.opaque.length > 0) {
		lines.push("看不清的地方（值由运行时决定，可能比上面列的多）：");
		for (const item of scan.opaque) lines.push(`  ${item}`);
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
		scanSummary(input.scan),
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
	channel?: ApprovalChannel;
}

let reviewCacheForPtc: ReviewCache | undefined;
function ptcReviewCache(): ReviewCache {
	reviewCacheForPtc ??= createReviewCache();
	return reviewCacheForPtc;
}

/** 从扫描与干跑结果整理出给审批窗的结构化影响面 */
export function scriptEffectsOf(input: PtcAuditInput): ScriptEffectsPayload {
	const scan = input.scan;
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
		opaque: scan?.opaque ?? [],
		...(scan?.parseError ? { parseError: scan.parseError } : {}),
		digestShort: ptcScriptDigest(input.script).slice(0, 12),
		...(input.dry ? { dryRunStatus: input.dry.status, dryRunCalls } : {}),
	};
}

/**
 * 事前审核一段脚本。判定口径与 bash 那条链一致：
 * 预审判 safe 且档位是 auto 就直接放行；其余交人工闸门。
 *
 * 送审时标明场景为 ptc：分类器不再问 scripted_edit（审的就是脚本，问了没信息量），
 * 也不拿它计入判定；审批窗里该行以禁用态展示。见 review-dimensions 的 SCENARIOS。
 */
export async function approvePtcScript(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	input: PtcAuditInput;
	signal?: AbortSignal;
	deps?: PtcAuditDependencies;
}): Promise<PtcAuditOutcome> {
	const { pi, ctx, input, signal } = options;
	const deps = options.deps ?? {};
	const subject = buildPtcAuditSubject(input);
	const digest = ptcScriptDigest(input.script);
	const config = loadLlmReviewConfig();
	let review: ReviewResult | undefined;

	if (config.enabled) {
		try {
			review = await (deps.reviewCommand ?? defaultReviewCommand)(
				pi,
				ctx,
				subject,
				[],
				signal,
				ptcReviewCache(),
				config,
				// 场景交给审核链：审的本来就是脚本，「这条命令是否用脚本改写文件」不提问、不判定
				{ scenario: "ptc" },
			);
		} catch {
			review = undefined;
		}
		if (review?.verdict === "safe" && config.mode === "auto") {
			appendPtcAudit(pi, { digest, outcome: "approved", via: "preflight", reason: input.reason, review });
			return { approved: true, review };
		}
	}

	const channel = deps.channel ?? resolveApprovalChannel();
	// 给审批窗的是**结构化**的一份：command 放脚本原文（窗口当代码块渲染），
	// 理由与影响面各走各的字段；送审给模型的仍是上面那段带解释的 subject。
	const decision = await channel(
		{
			kind: "audit",
			command: input.script,
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
