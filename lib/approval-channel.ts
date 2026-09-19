// lib/approval-channel.ts — 人工审批通道
//
// 三条闸（bash audit / sandbox-allow / subagent capability）共用这一层：
// 请求进、allow|deny 出。默认实现仍是本机 wails-gui，窗口异常再回退
// ctx.ui.select。后续 IM / RPC 面板只需 setApprovalChannel，不必改闸门本身。
//
// 通道只负责「问人」。规则硬拒、LLM 预审、信任根免审、/yolo 都在通道外面。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runGuiWindow, type GuiRunOptions, type GuiRunResult } from "./gui-runner.ts";
import { formatReviewNote, type ReviewResult } from "../extensions/sandbox-permissions/llm-review.ts";
import { buildApprovalTitle } from "../extensions/sandbox-permissions/helpers.ts";

const GUI_TIMEOUT_MS = 3_600_000;

export type ApprovalPathActionList = "allow" | "block" | "session-write" | "session-trust" | "revoke";

export interface ApprovalPathAction {
	path: string;
	list: ApprovalPathActionList;
}

export interface ApprovalDecision {
	action: "allow" | "deny";
	comment?: string;
	pathActions?: ApprovalPathAction[];
}

interface ApprovalRequestBase {
	signal?: AbortSignal;
}

export interface AuditApprovalRequest extends ApprovalRequestBase {
	kind: "audit";
	command: string;
	taskId?: string;
	rules?: unknown[];
	review?: unknown;
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
	rules?: unknown[];
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

let overrideChannel: ApprovalChannel | undefined;

/** 换成 IM / 测试桩；传 undefined 恢复默认 GUI→TUI。 */
export function setApprovalChannel(channel: ApprovalChannel | undefined): void {
	overrideChannel = channel;
}

export function getApprovalChannel(): ApprovalChannel | undefined {
	return overrideChannel;
}

export interface ResolveApprovalChannelOptions {
	/** 单次调用优先于全局通道（测试注入）。 */
	channel?: ApprovalChannel;
	runGui?: ApprovalRunGui;
	selectApproval?: ApprovalSelect;
}

/** 单次注入 > 全局通道 > 默认 GUI→TUI。 */
export function resolveApprovalChannel(opts: ResolveApprovalChannelOptions = {}): ApprovalChannel {
	if (opts.channel) return opts.channel;
	if (overrideChannel) return overrideChannel;
	return createGuiTuiApprovalChannel({ runGui: opts.runGui, selectApproval: opts.selectApproval });
}

export function createGuiTuiApprovalChannel(opts: {
	runGui?: ApprovalRunGui;
	selectApproval?: ApprovalSelect;
} = {}): ApprovalChannel {
	const runGui = opts.runGui ?? runGuiWindow;
	return async (request, ctx) => {
		const gui = await runGui("gate", toGuiPayload(request), { timeoutMs: GUI_TIMEOUT_MS, signal: request.signal });
		if (gui.ok && gui.data && (gui.data.action === "allow" || gui.data.action === "deny")) {
			return parseGuiDecision(gui.data);
		}
		return tuiFallback(request, ctx, opts.selectApproval);
	};
}

export function normalizeApprovalComment(comment: unknown): string | undefined {
	if (typeof comment !== "string") return undefined;
	const trimmed = comment.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function toGuiPayload(request: ApprovalRequest): unknown {
	if (request.kind === "audit") {
		return {
			kind: "audit",
			command: request.command,
			taskId: request.taskId,
			rules: request.rules,
			review: request.review,
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
			rules: request.rules,
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

function parseGuiDecision(data: { action: "allow" | "deny"; comment?: unknown; pathActions?: ApprovalPathAction[] }): ApprovalDecision {
	const comment = normalizeApprovalComment(data.comment);
	const pathActions = Array.isArray(data.pathActions) ? data.pathActions : undefined;
	return {
		action: data.action,
		...(comment ? { comment } : {}),
		...(pathActions && pathActions.length > 0 ? { pathActions } : {}),
	};
}

function tuiFallback(request: ApprovalRequest, ctx: ExtensionContext, selectApproval: ApprovalSelect | undefined): Promise<ApprovalDecision> {
	if (!canUseTui(request.kind, ctx, selectApproval)) {
		return Promise.resolve({ action: "deny" });
	}
	const select = selectApproval ?? ((title, choices) => ctx.ui.select(title, choices));
	return select(tuiTitle(request), tuiChoices(request.kind)).then((choice) => ({
		action: choice?.includes("允许") ? "allow" : "deny",
	}));
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

function tuiTitle(request: ApprovalRequest): string {
	if (request.kind === "audit") {
		return `⚠️ 命令需确认：\n\n  ${request.reason ?? "命中风险规则"}${reviewNote(request.review)}\n\n是否允许执行？`;
	}
	if (request.kind === "sandbox-allow") {
		return buildApprovalTitle(
			request.command,
			request.permission,
			request.writePaths,
			request.justification,
			request.timeout,
			request.memoryMb,
		);
	}
	return `⚠️ subagent 请求额外能力：${request.capability}\n\n${request.scope ?? ""}\n${request.requestReason}${reviewNote(request.review)}\n\n命令：${request.command}`;
}

function reviewNote(review: unknown): string {
	if (!review || typeof review !== "object") return "";
	const r = review as ReviewResult;
	if (!(r.reason || r.suggestion || r.opinion)) return "";
	return `\n\n${formatReviewNote(r)}`;
}
