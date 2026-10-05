// lib/approval-channel.ts — 人工审批通道
//
// 三条闸（bash audit / sandbox-allow / subagent capability）共用这一层：
// 请求进、allow|deny 出。默认先连本机 hub；挂了回退 wails-gui，窗口异常再
// ctx.ui.select。测试注入 channel / runGui / selectApproval 仍可用。
//
// 通道只负责「问人」。规则硬拒、LLM 预审、信任根免审、/yolo 都在通道外面。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { runGuiWindow, type GuiRunOptions, type GuiRunResult } from "./gui-runner.ts";
import { formatReviewNote, type ReviewResult } from "../extensions/sandbox-permissions/llm-review.ts";
import { buildApprovalTitle } from "../extensions/sandbox-permissions/helpers.ts";
import { createHubThenLocalChannel } from "./hub-channel.ts";
import {
	announceGuiFallback,
	classifyGuiFailure,
	guiFallbackTitleHint,
	type GuiDiagnosis,
	type GuiFallbackReason,
} from "./gui-diagnosis.ts";
import { collectEnvAssignments, type EnvNote } from "./env-notes.ts";
import { varRendersForApproval, type VarRender } from "./var-render.ts";
import { processSingleton } from "./process-singleton.ts";

const GUI_TIMEOUT_MS = 3_600_000;

export type ApprovalPathActionList = "allow" | "block" | "session-write" | "session-trust" | "revoke" | "workspace";

export interface ApprovalPathAction {
	path: string;
	list: ApprovalPathActionList;
}

export interface ApprovalDecision {
	action: "allow" | "deny";
	comment?: string;
	pathActions?: ApprovalPathAction[];
	/** 响应里编辑后的执行范围（完整列表，覆盖申请值）。护栅在 applyPathActions 里再算一遍。 */
	writePaths?: string[];
}

interface ApprovalRequestBase {
	signal?: AbortSignal;
	/**
	 * 立刻推到远程（IM 卡）不走适配器的默认延迟。
	 * 默认延迟是为了「人就在屏幕前，本地已经答了」的情形省一次推送；
	 * 当发起方知道本地没人能答（或这件事本来就要人马上到场）时，延迟只会担误事。
	 */
	urgent?: boolean;
}

/**
 * 受审对象的形态。`script` = run_code 的脚本事前审核，
 * 审批窗据此换标题、并把 command 当脚本原文渲染（不再跑 shell 命令那套解析）。
 */
export type AuditSubject = "script";

/**
 * 折叠芯片的一颗：脚本里一次"会改状态"的调用。
 *
 * 纯显示层事实——审核窗据此把调用折成一行、点击看细节。不进送审材料：
 * 送审文本（subject）与这里无关，模型看到的东西一个字都不变。
 */
export interface FoldCallPayload {
	tool: string;
	/** file = 改文件（灰芯片）；shell = 可执行命令（橙芯片） */
	kind: "file" | "shell";
	/** file：目标路径；shell：cwd。都按 ~ / $PWD 缩过；没有就是 undefined */
	displayPath?: string;
	/** 目标文件的真实路径（不缩短）："在编辑器打开"要用它，缩短过的打不开 */
	absPath?: string;
	/** 补丁类工具：补丁正文里认出来的真实路径（可能不止一个） */
	absPaths?: string[];
	/** 关键字段是不是字面量；false 时芯片上要标"看不清" */
	literal: boolean;
	/** 芯片盖住的区间（0 起，半开）：实参括号那一截，函数名留在代码里 */
	startOffset: number;
	endOffset: number;
	/** 起始行 / 结束行（1 起） */
	line: number;
	endLine: number;
	/** write：正文规模；shell：命令规模 */
	bytes?: number;
	lines?: number;
	/** write：被写入的正文预览（有界） */
	contentPreview?: string;
	/** edit / str_replace_editor：旧文与新文预览 */
	replacement?: { old: string; new: string; truncated: boolean };
	/** apply_patch / patch：补丁正文（原样带给浮层按 +/- 摆，不重造 patch） */
	patchText?: string;
	/** 工具自己的动作名：str_replace_editor 的 command、edit 的模式等 */
	mode?: string;
	/** 补丁正文里认出来的目标文件（缩短后） */
	paths?: string[];
	/** 预览被截断过 */
	truncated?: boolean;
}

/** 脚本事前审核的结构化影响面（pi 侧算好，GUI 只负责摆） */
export interface ScriptEffectsPayload {
	/** 字面上调用过的工具 */
	tools: string[];
	/** 参数里的路径字面量 */
	paths: string[];
	/** 命令字面量（bash 那条） */
	commands: string[];
	/** 值由运行时决定、因此看不清的地方（一句话一条） */
	opaque: string[];
	/** 语法层面就不干净时的原因 */
	parseError?: string;
	/** 脚本摘要（前 12 位足够人眼对齐） */
	digestShort: string;
	/** 干跑预演到的调用（工具名×次数）：这是"确定会做什么" */
	dryRunCalls?: string[];
	/** 干跑的状态；没跑或没跑成时缺省 */
	dryRunStatus?: string;
	/** 折叠芯片：只收会改状态的调用（白名单外的调用亮原文，折叠不用来藏风险） */
	editCalls?: FoldCallPayload[];
	/** 同一文件多处改动合并出来的净变化（推演，不是磁盘上的真身） */
	mergedChanges?: MergedFilePayload[];
}

/** 合并视图里的一行：与 lib/text-diff.ts 的 DiffRow 同形（那边是 pi 侧的实现） */
export interface MergedDiffRow {
	kind: "same" | "add" | "del";
	text: string;
	oldLine?: number;
	newLine?: number;
	/** 行内改动区间（字符坐标，半开） */
	intra?: Array<{ s: number; e: number }>;
}

export type MergedDiffBlock =
	| { type: "rows"; rows: MergedDiffRow[] }
	| { type: "gap"; count: number };

/** 一个文件的合并结果：改前改后差在哪、以及这次推演可信到什么程度 */
export interface MergedFilePayload {
	/** 显示用路径（已缩短） */
	path: string;
	/** 真实路径："在编辑器打开"要用它 */
	absPath: string;
	ops: number;
	/** merged = 推演得通；chain-broken = 中途断了；unknown-base = 基准内容不知道 */
	status: "merged" | "chain-broken" | "unknown-base";
	reason?: string;
	added: number;
	removed: number;
	blocks: MergedDiffBlock[];
	truncated?: boolean;
	/** 改前按空文件算（文件此前可能本来就有内容） */
	baseAssumedEmpty?: boolean;
}

export interface AuditApprovalRequest extends ApprovalRequestBase {
	kind: "audit";
	command: string;
	taskId?: string;
	rules?: unknown[];
	review?: unknown;
	/** 受审对象形态；缺省是 bash 命令 */
	subject?: AuditSubject;
	/** subject = script 时的影响面 */
	scriptEffects?: ScriptEffectsPayload;
	/**
	 * 事实层摘要（lib/preshell.ts 的 formatFacts 输出）：这条命令碰了哪些路径、
	 * 跑了什么程序、解释器里那段源码是什么、清单完不完整。
	 * 审核模型看的已经是这一段，看审批的人不该少看一份（TUI 标题里直接列出；
	 * GUI / IM 走 payload 里的同名字段）。
	 */
	factsText?: string;
	/** TUI 回退标题用；不进 GUI payload */
	reason?: string;
}

export interface SandboxAllowApprovalRequest extends ApprovalRequestBase {
	kind: "sandbox-allow";
	command: string;
	permission: "full-access" | "write-paths";
	writePaths: string[];
	justification: string;
	timeout?: number;
	memoryMb?: number;
	candidatePaths: string[];
	persistentRoots: string[];
	sessionWriteRoots: string[];
	sessionTrustedRoots: string[];
	builtinRoots: string[];
	workspaceRoot: string;
	/** GUI 用它挡家目录根；缺省由 toGuiPayload 填本机 homedir()。 */
	homeDir?: string;
	rules?: unknown[];
	/**
	 * 事实层摘要（同 AuditApprovalRequest.factsText）：升权审批时人最该先看清楚
	 * 「这条命令到底要跑什么」，而不只是「申请了哪个目录」
	 */
	factsText?: string;
	/**
	 * 敏感路径黑名单命中项（.env 之类的“要人点头”而非“直接拒”）。
	 * 与 rules 分开：rules 是「命令写法有风险」的语义，会连带影响目录长期授权；
	 * 这里是「目标路径敏感」。（展示上仍合入 GUI 的 rules 列表，不另开一栏。）
	 */
	sensitive?: Array<{ pattern: string; token: string }>;
}

export interface CapabilityApprovalRequest extends ApprovalRequestBase {
	kind: "capability";
	command: string;
	taskId?: string;
	capability: string;
	scope?: string;
	requestReason: string;
	rules?: unknown[];
	review?: unknown;
}

export type ApprovalRequest = AuditApprovalRequest | SandboxAllowApprovalRequest | CapabilityApprovalRequest;

export type ApprovalChannel = (request: ApprovalRequest, ctx: ExtensionContext) => Promise<ApprovalDecision>;

export type ApprovalSelect = (title: string, choices: string[]) => Promise<string | undefined>;
export type ApprovalRunGui = (windowName: string, request: unknown, options?: GuiRunOptions) => Promise<GuiRunResult>;

/**
 * 全局通道覆盖（IM / 测试桩）。
 *
 * 挂 globalThis（见 lib/process-singleton.ts）：审批通道是三条闸共用的「问人」出口，
 * 装上 IM 通道的扩展与真正发起审批的扩展不是同一个，模块级变量会让覆盖只对本扩展生效，
 * 其余扩展照旧走本机 GUI。holder 包一层是因为 set 之后要换值——清空要改 holder 的字段，
 * 不能换 holder 引用（换了别的扩展手里那份就成孤儿了）。
 */
const overrideState = processSingleton<{ channel: ApprovalChannel | undefined }>("approval-channel", () => ({
	channel: undefined,
}));

/** 换成 IM / 测试桩；传 undefined 恢复默认 GUI→TUI。 */
export function setApprovalChannel(channel: ApprovalChannel | undefined): void {
	overrideState.channel = channel;
}

export function getApprovalChannel(): ApprovalChannel | undefined {
	return overrideState.channel;
}

export interface ResolveApprovalChannelOptions {
	/** 单次调用优先于全局通道（测试注入）。 */
	channel?: ApprovalChannel;
	runGui?: ApprovalRunGui;
	selectApproval?: ApprovalSelect;
}

/** 单次注入 > 全局通道 > 测试注入的 GUI/TUI > hub（挂了回退 GUI→TUI）。 */
export function resolveApprovalChannel(opts: ResolveApprovalChannelOptions = {}): ApprovalChannel {
	if (opts.channel) return opts.channel;
	if (overrideState.channel) return overrideState.channel;
	if (opts.runGui || opts.selectApproval) {
		return createGuiTuiApprovalChannel({ runGui: opts.runGui, selectApproval: opts.selectApproval });
	}
	return createHubThenLocalChannel();
}

export interface GuiTuiApprovalOptions {
	runGui?: ApprovalRunGui;
	selectApproval?: ApprovalSelect;
	/**
	 * 上游已经知道的原因。这一跳常常是「hub 连不上」之后才走的，只报
	 * 本跳工位上的 no-binary 会把真正的病因盖掉，用户照着提示也修不好。
	 */
	upstreamReason?: GuiFallbackReason;
	/** 诊断存根：不传才真去查二进制位 / systemctl / pkg-config */
	diagnosis?: GuiDiagnosis;
}

export function createGuiTuiApprovalChannel(opts: GuiTuiApprovalOptions = {}): ApprovalChannel {
	const runGui = opts.runGui ?? runGuiWindow;
	return async (request, ctx) => {
		const gui = await runGui("gate", toGuiPayload(request), { timeoutMs: GUI_TIMEOUT_MS, signal: request.signal });
		if (gui.ok && gui.data && (gui.data.action === "allow" || gui.data.action === "deny")) {
			return parseGuiDecision(gui.data);
		}
		// 撤单不是故障：这时候既不该报修复步骤，也不该在标题里挂原因，
		// 否则用户每按一次取消都要先读一遍「图形界面坏了」
		const aborted = gui.reason === "aborted" || request.signal?.aborted === true;
		const reason = aborted ? undefined : opts.upstreamReason ?? classifyGuiFailure(gui.reason);
		return tuiFallback(request, ctx, opts.selectApproval, reason, opts.diagnosis);
	};
}

export function normalizeApprovalComment(comment: unknown): string | undefined {
	if (typeof comment !== "string") return undefined;
	const trimmed = comment.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function toGuiPayload(request: ApprovalRequest): Record<string, unknown> {
	const payload = buildKindPayload(request);
	// shell 命令那套解析（赋值解析、变量渲染）只对命令有意义：
	// 脚本事前审核的 command 是 JS 原文，跑它只会给出一堆无意义的标注。
	if (request.kind !== "audit" || request.subject !== "script") {
		// 命令里写死的赋值（export / 前置赋值）解析结果：审批窗标绿、悬停看值。
		// 只在 Linux 给（这条功能是 Linux 闸门窗的）；拿不到环境变量的场合也不给，宁可没有
		const envNotes = envNotesFor(request.command);
		if (envNotes) payload.envNotes = envNotes;
		// 命令里变量**使用处**的渲染值：审批窗标蓝（悬停看值）/标灰（悬停看原因）并列出变量表。
		// 与 envNotes 分工：那边是「这条命令自己声明的赋值解析成什么」，这边是「用到的地方渲成什么」
		const varRenders = varRendersFor(request.command);
		if (varRenders) payload.varRenders = varRenders;
	}
	// urgent 随 payload 下发：适配器据此跳过度延迟（见 hub/adapters/feishu/main.go 的 onAskEvent）
	return request.urgent ? { ...payload, urgent: true } : payload;
}

function envNotesFor(command: unknown): EnvNote[] | undefined {
	if (process.platform !== "linux") return undefined;
	if (typeof command !== "string" || command === "") return undefined;
	const notes = collectEnvAssignments(command);
	return notes.length > 0 ? notes : undefined;
}

/** 变量渲染值（与 envNotes 同平台条件：这条展示能力属于 Linux 闸门窗） */
function varRendersFor(command: unknown): VarRender[] | undefined {
	if (process.platform !== "linux") return undefined;
	if (typeof command !== "string" || command === "") return undefined;
	const renders = varRendersForApproval(command);
	return renders.length > 0 ? renders : undefined;
}

function buildKindPayload(request: ApprovalRequest): Record<string, unknown> {
	if (request.kind === "audit") {
		return {
			kind: "audit",
			command: request.command,
			taskId: request.taskId,
			rules: request.rules,
			review: request.review,
			...(request.factsText ? { factsText: request.factsText } : {}),
			...(request.subject ? { subject: request.subject } : {}),
			...(request.scriptEffects ? { scriptEffects: request.scriptEffects } : {}),
		};
	}
	if (request.kind === "sandbox-allow") {
		return {
			kind: "sandbox-allow",
			command: request.command,
			permission: request.permission,
			writePaths: request.writePaths,
			timeout: request.timeout,
			memoryMb: request.memoryMb,
			candidatePaths: request.candidatePaths,
			persistentRoots: request.persistentRoots,
			sessionWriteRoots: request.sessionWriteRoots,
			sessionTrustedRoots: request.sessionTrustedRoots,
			builtinRoots: request.builtinRoots,
			workspaceRoot: request.workspaceRoot,
			...(request.factsText ? { factsText: request.factsText } : {}),
			// 家目录根（GUI 护栅用）：请求没带就填本机值，payload 里始终是 string
			homeDir: request.homeDir ?? homedir(),
			// 敏感路径合成一条规则条目：审批窗已经有「命中 N 项 + 高亮命中片段」的渲染，
			// 不为了这件事在前端另开一栏（也省一次 GUI 重编）。
			rules: [...((request.rules as unknown[]) ?? []), ...sensitiveRules(request.sensitive)],
		};
	}
	return {
		kind: "capability",
		command: request.command,
		taskId: request.taskId,
		capability: request.capability,
		scope: request.scope,
		requestReason: request.requestReason,
		rules: request.rules,
		review: request.review,
	};
}

export function parseGuiDecision(data: {
	action: "allow" | "deny";
	comment?: unknown;
	pathActions?: ApprovalPathAction[];
	writePaths?: unknown;
}): ApprovalDecision {
	const comment = normalizeApprovalComment(data.comment);
	const pathActions = Array.isArray(data.pathActions) ? data.pathActions : undefined;
	// 只做「是字符串且非空」这一层清洗；祖先/后代护栅在 applyPathActions 里算
	const writePaths = Array.isArray(data.writePaths)
		? [...new Set(data.writePaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim()))]
		: undefined;
	return {
		action: data.action,
		...(comment ? { comment } : {}),
		...(pathActions && pathActions.length > 0 ? { pathActions } : {}),
		...(writePaths && writePaths.length > 0 ? { writePaths } : {}),
	};
}

/** 敏感路径命中 → 审批窗的规则条目（name/tip/matched 三项是前端已经在读的字段） */
export function sensitiveRules(
	sensitive: Array<{ pattern: string; token: string }> | undefined,
): Array<{ name: string; tip: string; matched: string[]; autoReject: boolean }> {
	return (sensitive ?? []).map((hit) => ({
		name: "sensitive-path",
		tip: `命令引用了敏感路径黑名单（${hit.pattern}）：默认拒绝，升权需要人工确认`,
		matched: [hit.token],
		autoReject: false,
	}));
}

function tuiFallback(
	request: ApprovalRequest,
	ctx: ExtensionContext,
	selectApproval: ApprovalSelect | undefined,
	reason: GuiFallbackReason | undefined,
	diagnosis: GuiDiagnosis | undefined,
): Promise<ApprovalDecision> {
	// 提示分两处：notify 里给完整修复步骤（长），标题里给一行短原因。
	// 只在这个理由说给人听的时候才去诊断：既弹不出 TUI 也没有通知出口时，
	// 查一遍系统白花时间，还会把去重位占掉，让下一次真能看到的提示被吞
	const canTui = canUseTui(request.kind, ctx, selectApproval);
	const hint = reason && (canTui || ctx?.ui) ? explainFallback(ctx, reason, diagnosis) : "";
	if (!canTui) {
		return Promise.resolve({ action: "deny" });
	}
	const select = selectApproval ?? ((title, choices) => ctx.ui.select(title, choices));
	return select(tuiTitle(request, hint), tuiChoices(request.kind)).then((choice) => ({
		action: choice?.includes("允许") ? "allow" : "deny",
	}));
}

/**
 * announceGuiFallback 自带进程内去重：同一个原因在一个进程里只弹一次通知，
 * 审批回退会连着发生，每次重弹同一条会把真正要看的那条命令淹掉。
 * 标题那一行不做去重——它跟着这次审批走，用户看的不是同一条消息。
 */
function explainFallback(ctx: ExtensionContext, reason: GuiFallbackReason, diagnosis: GuiDiagnosis | undefined): string {
	announceGuiFallback(ctx, reason, diagnosis ? { diagnosis } : {});
	return guiFallbackTitleHint(reason, diagnosis);
}

function canUseTui(kind: ApprovalRequest["kind"], ctx: ExtensionContext, selectApproval: ApprovalSelect | undefined): boolean {
	if (kind === "audit") return Boolean(ctx?.ui || selectApproval);
	if (kind === "sandbox-allow") return Boolean(ctx?.hasUI || selectApproval);
	return Boolean(ctx?.hasUI);
}

function tuiChoices(kind: ApprovalRequest["kind"]): string[] {
	if (kind === "sandbox-allow") return ["✅ 允许执行（仅此一次）", "❌ 拒绝"];
	if (kind === "capability") return ["✅ 允许本次命令", "❌ 拒绝"];
	return ["✅ 允许执行", "❌ 拒绝"];
}

function tuiTitle(request: ApprovalRequest, hint = ""): string {
	// 提示一律靠前：用户先要知道「为什么在终端里问」，再读这次要批什么
	const head = hint ? `${hint}\n\n` : "";
	// 紧跟标题行时用单换行：中间空一行会把「为什么在终端里问」和事件本身分开
	const under = hint ? `\n${hint}` : "";
	// 事实层摘要：审核模型看到的那份影响面（含解释器载荷原文），人也照看一份。
	// 放在裁决前面：先说事实，再说机器/规则的判断。capability 那档没有这个字段
	const facts = factsBlock(request.kind === "capability" ? undefined : request.factsText);
	if (request.kind === "audit") {
		return `⚠️ 命令需确认：${under}\n\n  ${request.reason ?? "命中风险规则"}${facts}${reviewNote(request.review)}\n\n是否允许执行？`;
	}
	if (request.kind === "sandbox-allow") {
		const sensitiveNote = request.sensitive?.length
			? `\n\n⚠️ 命令引用了敏感路径：${[...new Set(request.sensitive.map((h) => h.pattern))].join("、")}\n（默认拒绝，本次是人工放行口子）`
			: "";
		return `${head}${buildApprovalTitle(
			request.command,
			request.permission,
			request.writePaths,
			request.justification,
			request.timeout,
			request.memoryMb,
		)}${facts}${sensitiveNote}`;
	}
	return `⚠️ subagent 请求额外能力：${request.capability}${under}\n\n${request.scope ?? ""}\n${request.requestReason}${reviewNote(request.review)}\n\n命令：${request.command}`;
}

/** 事实层摘要块（空就不出）：措辞与 llm-review.ts 里那段保持一致 */
function factsBlock(text: string | undefined): string {
	return text ? `\n\n命令影响面（静态分析事实，不是裁决）：\n${text}` : "";
}

function reviewNote(review: unknown): string {
	if (!review || typeof review !== "object") return "";
	const r = review as ReviewResult;
	if (!(r.reason || r.suggestion || r.opinion)) return "";
	return `\n\n${formatReviewNote(r)}`;
}
