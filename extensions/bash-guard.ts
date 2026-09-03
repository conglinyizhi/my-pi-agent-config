// extensions/bash-guard.ts — 接管内建 bash 工具（检查前置 + 沙箱通道 + 审批链）
//
// 背景：内建 bash 的沙箱与审批依赖 gate/guard 的 tool_call hook 拦截。本插件改为
// 「同名覆盖 bash」，把整条「检查 + 沙箱 + 审批」链写进工具 execute 内部（执行前），
// 不依赖事件链。
//
// 审批链（用户确认的编排，一体）：
//   1. spawnHook 注入 PI_SANDBOX_* env → sandbox-shell.mjs Landlock 写保护
//   2. checkCommand 自动判定：黑名单/内联脚本/危险规则 → 大多直接拦
//   3. 命中风险项 → LLM 二次预审（reviewCommand，复用 gate 的 llm-review）
//   4. LLM 不通过 / 无 LLM → ctx.ui 人类兜底确认
//   5. 通过 → 官方原版 execute（行为零异常）
//
// 设计（用户确认方向）：createBashToolDefinition 生成官方原版 definition
// （含 renderCall/renderResult/截断/超时/临时文件）。promptSnippet/promptGuidelines
// 显式定义（官方不继承），静态常量保证 KV 缓存稳定。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, getAgentDir, type BashSpawnContext, type BashToolDetails } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { checkCommand, buildSandboxEnv, type SandboxCheckResult, type TokenRule } from "../lib/sandbox-check.ts";
import { createReviewCache, formatReviewNote, loadLlmReviewConfig, reviewCommand, type ReviewResult } from "../extensions/sandbox-permissions/llm-review.ts";
import { addSessionWriteDirsToEnv, beginSandboxSession } from "../extensions/sandbox-permissions/session-access.ts";
import { runGuiWindow } from "../lib/gui-runner.ts";
import { yoloEnabled } from "./sandbox-permissions/yolo.ts";

// ── KV 缓存稳定：静态常量，一次性注册，不动态拼接 ──
const PROMPT_SNIPPET = "Execute a bash command in the current working directory. Returns stdout and stderr.";
const PROMPT_GUIDELINES = [
	"Use bash to inspect files, run commands, and check tool availability.",
	"bash 命令经沙箱通道执行（Landlock 写保护），危险命令会在执行前被拦截。",
] as const;

/** LLM 预审内存缓存（同命令同规则不重复调 API；gate 同款） */
const reviewCache = createReviewCache();
let currentSessionId: string | undefined;

/** 权限闸门窗口兜底超时（与 allow.ts 一致：窗口内不自动超时，仅防窗口进程卡死） */
const GUI_TIMEOUT_MS = 3_600_000;

/** 人类兜底确认结果：ok=放行/拒绝；comment 为 GUI「拒绝并说明理由」写的用户理由 */
type HumanConfirmResult = { ok: boolean; comment?: string };

/**
 * 人类兜底确认（风险命令）：优先走 wails-gui 权限闸门窗口（kind=audit，与
 * sandbox-allow 升权审批共用 gate 窗口），窗口异常/不可用时回退 TUI select。
 * 返回 { ok, comment? }：ok=放行/拒绝；comment 为 GUI「拒绝并说明理由」对话框
 * 写的用户理由（audit 专属，回退 TUI 或纯拒绝时不产生）。两者皆不可用按
 * fail-closed 拒绝。
 */
async function humanConfirm(
	ctx: ExtensionContext,
	command: string,
	rules: TokenRule[],
	reason: string | undefined,
	review: ReviewResult | undefined,
	taskId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<HumanConfirmResult> {
	// 1. 优先 wails-gui 权限闸门窗口（kind=audit；GUI 侧展示命令/规则/LLM 审核意见）
	const gui = await runGuiWindow(
		"gate",
		{ kind: "audit", command, taskId, rules, review },
		{ timeoutMs: GUI_TIMEOUT_MS, signal },
	);
	// 仅采纳用户明确的选择（allow/deny）；窗口关闭/超时/进程退出 → 回退 TUI
	if (gui.ok && gui.data && (gui.data.action === "allow" || gui.data.action === "deny")) {
		return {
			ok: gui.data.action === "allow",
			comment: typeof gui.data.comment === "string" ? gui.data.comment : undefined,
		};
	}

	// 2. GUI 不可用 → 回退 TUI select
	if (!ctx?.ui) return { ok: false };
	const reviewNote = review && (review.reason || review.suggestion || review.opinion)
		? `\n\n${formatReviewNote(review)}`
		: "";
	const choice = await ctx.ui.select(
		`⚠️ 命令需确认：\n\n  ${reason ?? "命中风险规则"}${reviewNote}\n\n是否允许执行？`,
		["✅ 允许执行", "❌ 拒绝"],
	);
	return { ok: choice?.includes("允许") ?? false };
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	// 沙箱壳路径：插件自算（getAgentDir() + scripts/sandbox-shell.mjs），
	// 不依赖 settings.shellPath——即使 settings 未配 shellPath，bash 仍经 Landlock 沙箱执行。
	const sandboxShellPath = join(getAgentDir(), "scripts", "sandbox-shell.mjs");

	pi.on("session_start", (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		beginSandboxSession(currentSessionId);
	});

	// ── 沙箱指令注入点（spawnHook）：在官方 execute 内部被 resolveSpawnContext 调用，
	//    env 基于 process.env 展开后透传给 ops.exec → sandbox-shell.mjs。
	//    buildSandboxEnv 默认透传：sandbox-shell 默认 Landlock（--ro / + --rw <cwd>/tmp）
	//    已提供沙箱安全环境。需升权/只读时在 buildSandboxEnv 注入 PI_SANDBOX_RW_EXTRA / READONLY。 ──
	const spawnHook = ({ command, cwd, env }: BashSpawnContext): BashSpawnContext => {
		// yolo 开启：连同 Landlock 写保护一并关闭（PI_SANDBOX_DISABLE=1），bash 可写任意路径
		const base = yoloEnabled()
			? { ...buildSandboxEnv(env), PI_SANDBOX_DISABLE: "1" }
			: buildSandboxEnv(env);
		return { command, cwd, env: addSessionWriteDirsToEnv(base, currentSessionId) };
	};

	// 官方原版 bash definition（含 renderCall/renderResult，行为零异常）
	// 显式传 shellPath = 沙箱壳：bash 经 sandbox-shell.mjs 的 Landlock 写保护执行，
	// 不再回退到系统默认 bash（bash_background 同源同一通道）。
	const bashDef = createBashToolDefinition(cwd, { spawnHook, shellPath: sandboxShellPath });

	pi.registerTool({
		...bashDef,
		// 官方不继承 prompt 元数据，必须显式定义（静态常量，保证 KV 缓存稳定）
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: [...PROMPT_GUIDELINES],

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const command: string = params.command as string;
			currentSessionId = ctx.sessionManager.getSessionId();
			beginSandboxSession(currentSessionId);

			// yolo：跳过整条审批链（自动判定/LLM/人工确认），直接执行官方原版。
			// spawnHook 已据此注入 PI_SANDBOX_DISABLE=1，Landlock 写保护也一并关闭。
			if (yoloEnabled()) {
				return bashDef.execute(toolCallId, params, signal, onUpdate, ctx);
			}

			// ── 2. 自动判定层（黑名单/内联脚本/危险规则/白名单）──
			const verdict: SandboxCheckResult = checkCommand(command, { cwd: ctx?.cwd ?? cwd });

			if (!verdict.allow) {
				// 纯自动拒绝（黑名单/内联脚本/全 autoReject）→ 直接拦，不弹窗
				if (verdict.rules && verdict.rules.length > 0 && verdict.rules.every((r) => r.autoReject)) {
					return { content: [{ type: "text", text: verdict.reason ?? "已拦截" }], details: {} as BashToolDetails };
				}

				// 【1】白名单豁免：checkCommand 在 allowDirs 内已返回 allow，此处已是需确认类
				// 【2】需确认类（动态构造/非 autoReject）→ LLM 预审 + 人类兜底
				if (verdict.rules && verdict.rules.length > 0 && !verdict.rules.every((r) => r.autoReject)) {
					// ── 3. LLM 二次预审（gate 同款）──
					let review: ReviewResult | undefined;
					const reviewConfig = loadLlmReviewConfig();
					if (reviewConfig.enabled) {
						// LLM 预审失败/不可用时降级到人类确认（fail-closed）：不因 API 异常放行危险命令
						try {
							review = await reviewCommand(pi, ctx!, command, verdict.rules, signal, reviewCache, reviewConfig);
						} catch {
							review = undefined;
						}
						if (review?.verdict === "safe" && reviewConfig.mode === "auto") {
							// LLM 判定安全且 auto 模式 → 自动放行，不打扰用户
							return bashDef.execute(toolCallId, params, signal, onUpdate, ctx);
						}
					}

					// ── 4. 人类兜底确认（LLM 不通过 / 无 LLM / strict 模式；GUI 优先，TUI 回退）──
					const decision = await humanConfirm(ctx!, command, verdict.rules, verdict.reason, review, toolCallId, signal);
					if (!decision.ok) {
						const userNote = decision.comment ? `（用户理由：${decision.comment}）` : "";
						return { content: [{ type: "text", text: `已拒绝：${verdict.reason}${userNote}` }], details: {} as BashToolDetails };
					}
				} else {
					// 无 rules 但 allow=false（黑名单/内联脚本），直接拦
					return { content: [{ type: "text", text: verdict.reason ?? "已拦截" }], details: {} as BashToolDetails };
				}
			}

			// ── 5. 通过 → 走官方原版 execute（内部已应用 spawnHook 的沙箱 env）──
			return bashDef.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
