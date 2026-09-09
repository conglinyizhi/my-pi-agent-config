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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, getAgentDir, type BashSpawnContext, type BashToolDetails } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { checkCommand, buildSandboxEnv, type SandboxCheckResult } from "../lib/sandbox-check.ts";
import { appendApprovalComment, approveBashCommand, bashApprovalDeniedText, isHardRejected, rethrowWithApprovalComment } from "../lib/bash-approval.ts";
import { addSessionWriteDirsToEnv, beginSandboxSession } from "../extensions/sandbox-permissions/session-access.ts";
import { yoloEnabled } from "./sandbox-permissions/yolo.ts";

// ── KV 缓存稳定：静态常量，一次性注册，不动态拼接 ──
const PROMPT_SNIPPET = "Execute a bash command in the current working directory. Returns stdout and stderr.";
const PROMPT_GUIDELINES = [
	"Use bash to inspect files, run commands, and check tool availability.",
	"bash 命令经沙箱通道执行（Landlock 写保护），危险命令会在执行前被拦截。",
	"所有 bash 命令默认有 1GiB 内存上限（进程树匿名内存），超出会以退出码 137 终止；需要更大内存时用 sandbox-allow 的 memoryMb 参数给出具体 MB 数值（上限 32768 MB）。",
] as const;


let currentSessionId: string | undefined;

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
		// yolo 开启：连同 Landlock 写保护一并关闭（PI_SANDBOX_DISABLE=1），bash 可写任意路径；
		// 内存墙是正交维度，也一并关闭（PI_SANDBOX_MEMORY_DISABLE=1），保证「全降零」语义一致。
		const base = yoloEnabled()
			? { ...buildSandboxEnv(env), PI_SANDBOX_DISABLE: "1", PI_SANDBOX_MEMORY_DISABLE: "1" }
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
				// 黑名单/内联脚本/全 autoReject（以及无规则的硬拒）不进入审批器。
				if (isHardRejected(verdict)) {
					return { content: [{ type: "text", text: verdict.reason ?? "已拦截" }], details: {} as BashToolDetails };
				}

				// 需确认类：共享 LLM 预审 + GUI/TUI 人工闸门。
				const decision = await approveBashCommand({
					pi,
					ctx,
					command,
					verdict,
					taskId: toolCallId,
					signal,
					origin: "bash",
				});
				if (!decision.approved) {
					return { content: [{ type: "text", text: bashApprovalDeniedText(verdict.reason, decision.comment) }], details: {} as BashToolDetails };
				}
				// 审批链已记录 bash-audit；附言同时回传给模型可见的工具结果。
				// 官方 execute 在非零退出时是 throw，失败路径也要把附言带上。
				const result = await bashDef
					.execute(toolCallId, params, signal, onUpdate, ctx)
					.catch((err) =>
						rethrowWithApprovalComment(err, decision.comment ? `[审批附言：${decision.comment}]` : undefined),
					);
				return appendApprovalComment(result, decision.comment);
			}

			// ── 5. 通过 → 走官方原版 execute（内部已应用 spawnHook 的沙箱 env）──
			return bashDef.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
