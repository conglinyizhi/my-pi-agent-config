// sandbox-allow — DSH sandbox_permissions 升权移植（单一指令、一次授权）
//
// 背景：pi 的 bash 工具是内建的，无法直接加 sandbox_permissions 参数；
// 本扩展注册独立工具 sandbox-allow，等价于 DSH bash 工具的
//   sandbox_permissions: "danger-full-access" | 额外写路径 + justification。
//
// 语义照抄 DSH（dsh-tool-bash + dsh-sandbox-policy + dsh-user-approval）：
//   - 未被长期/session 信任根覆盖的升权仅对「本次单条命令」生效（allowed-once）
//   - 非信任请求经用户显式同意；拒绝/取消/无 UI = 不执行
//   - 优先 write-paths（最小权限：保持只读沙箱，只额外开放指定可写根）而非 full-access
//   - justification 必填：一句话向用户解释为何这条命令需要更宽权限
//
// 执行：通过 pi 导出的 createLocalBashOperations 走同一 shellPath（sandbox-shell.mjs），
// 把升权编码进单次 spawn 的 env（PI_SANDBOX_DISABLE=1 / PI_SANDBOX_RW_EXTRA=<paths>），
// 仅影响该子进程，不碰 process.env。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildApprovalTitle,
	buildEscalationEnv,
	MAX_MEMORY_MB,
	readShellPath,
	resolveWritePaths,
	validateMemoryMb,
} from "./helpers.ts";
import { runGuiWindow } from "../../lib/gui-runner.ts";
import { normalizeApprovalComment } from "../../lib/bash-approval.ts";
import { checkCommand, type SandboxCheckResult } from "../../lib/sandbox-check.ts";
import { addAllowDir, addBlockDir, collectCandidateDirs, loadSandboxPaths } from "./paths.ts";
import {
	addSessionTrustedDirs,
	addSessionWriteDirs,
	addSessionWriteDirsToEnv,
	beginSandboxSession,
	getSessionAccessSnapshot,
	normalizeSandboxRoot,
	pathsCoveredByRoots,
} from "./session-access.ts";
import { yoloEnabled } from "./yolo.ts";

const MAX_OUTPUT_BYTES = 1_000_000;
const GUI_TIMEOUT_MS = 3_600_000; // 1 小时兜底（窗口内不自动超时；仅防窗口进程卡死）
const MAX_COMMAND_TIMEOUT_SECONDS = 2_147_483.647; // 与 pi 内建 bash 的 setTimeout 上限一致
const APPROVE = "✅ 允许执行（仅此一次）";
const DENY = "❌ 拒绝";

export const SANDBOX_ALLOW_PARAMETERS = Type.Object({
	command: Type.String({ minLength: 1, description: "The complete shell command string to run once approved." }),
	permission: Type.Union(
		[Type.Literal("full-access"), Type.Literal("write-paths")],
		{ description: "write-paths = sandbox plus listed paths (paths required); full-access = cancel file-system sandbox (paths forbidden)." },
	),
	justification: Type.String({ minLength: 1, description: "Non-empty one-sentence reason shown to the user for consent." }),
	paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Required for write-paths; smallest necessary writable roots; root `/` is forbidden." })),
	timeout: Type.Optional(Type.Number({ minimum: 0.001, maximum: MAX_COMMAND_TIMEOUT_SECONDS, description: "Maximum execution time after approval, in seconds." })),
	memoryMb: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_MEMORY_MB, description: "Memory limit (MB) for this command's process tree. Default 1 GiB (1024). Specify a concrete MB value only when the command needs more than the default; larger values raise the cap, subject to approval." })),
}, { additionalProperties: false });

type PathActionList = "allow" | "block" | "session-write" | "session-trust";

export interface SandboxAllowInput {
	command?: unknown;
	permission?: unknown;
	justification?: unknown;
	paths?: unknown;
	timeout?: unknown;
	memoryMb?: unknown;
}

/** 根 schema 不能表达 permission 与 paths 的条件关系，运行时在执行前补齐。 */
export function validateSandboxAllowInput(input: SandboxAllowInput, cwd = process.cwd()): string | undefined {
	if (typeof input.command !== "string" || input.command.trim().length === 0) return "command 不能为空";
	if (input.permission !== "write-paths" && input.permission !== "full-access") return "permission 必须是 write-paths 或 full-access";
	if (typeof input.justification !== "string" || input.justification.trim().length === 0) return "justification 不能为空";
	if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || (input.timeout as number) <= 0 || (input.timeout as number) > MAX_COMMAND_TIMEOUT_SECONDS)) {
		return `timeout 必须在 0 到 ${MAX_COMMAND_TIMEOUT_SECONDS} 秒之间`;
	}
	const memErr = validateMemoryMb(input.memoryMb);
	if (memErr) return memErr;
	if (input.permission === "full-access" && input.paths !== undefined) return "full-access 不接受 paths";
	if (input.permission === "write-paths") {
		if (!Array.isArray(input.paths) || input.paths.length === 0) return "write-paths 需要至少一个 paths";
		if (input.paths.some((path) => typeof path !== "string" || normalizeSandboxRoot(path, cwd) === undefined)) return "paths 必须是非根目录路径";
	}
	return undefined;
}

/**
 * sandbox-allow 免审批判定：请求的每个 writePath 都被任一信任根覆盖即可。
 * 三档信任可混合——长期 allowDirs / 本 session 信任根 / 本 session 可写根，
 * 各路径分别命中不同档位也算满足（例如 A 长期 + B session 信任 + C session 可写）。
 */
export function writePathsFullyTrusted(
	writePaths: string[],
	roots: { allowDirs: string[]; sessionTrustedDirs: string[]; sessionWriteDirs: string[] },
	cwd = process.cwd(),
): boolean {
	if (writePaths.length === 0) return false;
	return pathsCoveredByRoots(writePaths, [...roots.allowDirs, ...roots.sessionTrustedDirs, ...roots.sessionWriteDirs], cwd);
}

interface GuiDecision {
	action: "allow" | "deny";
	/** 用户在 GUI 上点选的目录授权操作 */
	pathActions?: { path: string; list: PathActionList }[];
	/** GUI 审批窗口填写的用户附言/条件说明，允许与拒绝都可回传 */
	comment?: string;
}

/** 通过 GUI 审批（合并进现有权限闸门 gate 窗口，kind=sandbox-allow） */
export interface SandboxAllowDependencies {
	/** 测试注入；默认使用真实 wails-gui runner。 */
	runGui?: typeof runGuiWindow;
	/** 测试注入；默认使用 ctx.ui.select。 */
	selectApproval?: (title: string, choices: string[]) => Promise<string | undefined>;
}

async function tryGuiApproval(
	command: string,
	permission: "full-access" | "write-paths",
	writePaths: string[],
	justification: string,
	timeout: number | undefined,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	audit?: SandboxCheckResult,
	memoryMb?: number,
	runGui: typeof runGuiWindow = runGuiWindow,
): Promise<GuiDecision | "gui-unavailable"> {
	const result = await runGui(
		"gate",
		{
			kind: "sandbox-allow",
			command,
			permission,
			writePaths,
			timeout,
			memoryMb,
			candidatePaths: permission === "write-paths" ? collectCandidateDirs(command, writePaths) : [],
			persistentRoots: loadSandboxPaths().allowDirs,
			sessionWriteRoots: getSessionAccessSnapshot(sessionId).writeDirs,
			sessionTrustedRoots: getSessionAccessSnapshot(sessionId).trustedDirs,
			rules: audit?.rules ?? [],
		},
		{ timeoutMs: GUI_TIMEOUT_MS, signal },
	);
	// 仅采纳用户明确的选择（允许/拒绝）；窗口异常关闭/超时/中止 → 回退 TUI
	if (result.ok && result.data && (result.data.action === "allow" || result.data.action === "deny")) {
		return {
			action: result.data.action,
			pathActions: result.data.pathActions,
			comment: typeof result.data.comment === "string" ? result.data.comment : undefined,
		};
	}
	return "gui-unavailable";
}

export default function (pi: ExtensionAPI, options: { approvalDependencies?: SandboxAllowDependencies } = {}) {
	pi.registerTool({
		name: "sandbox-allow",
		label: "Sandbox Allow (one-shot)",
		description: [
			"Run ONE bash command with temporarily elevated sandbox permissions.",
			"Use only when the sandbox has actually denied a write the task legitimately needs (the default sandbox is read-only outside the workspace).",
			"A full-access request cancels the file-system sandbox for this command; write-paths keeps the sandbox and adds only the listed writable roots.",
			"Non-trusted requests require approval and apply only to this command. A request skips approval when every requested write path is covered by any trust root (persistent allowDirs, session-trusted roots, or session-write roots); the roots may be mixed.",
			"Prefer write-paths with the smallest necessary writable roots. Never use full-access merely because a write failed if a directory can be named.",
			"Always supply a non-empty one-sentence justification, shown to the user for consent.",
			"timeout is the maximum execution time after approval, in seconds; it does not limit the user's approval time."
		].join(" "),
		promptSnippet: "Run one bash command with user-approved, one-shot elevated sandbox permissions",
		promptGuidelines: [
			"sandbox-allow 是升权工具：仅当普通 bash 确实因沙箱拒绝而无法完成任务时才用，绝不预先调用",
			"优先 permission=write-paths，并只列出完成命令所需的最小 writable roots；paths 不能是根目录 `/`",
			"full-access 会完全取消文件系统沙箱，只在无法合理限定写入根时使用；它仍不改变当前用户的操作系统身份",
			"所有 bash 命令默认有 1GiB 内存上限；若命令可能超过（如重型构建/测试），必须用 memoryMb 给出**具体 MB 数值**，上限 32768 MB，更大会被拒绝",
			"长期 allowDirs / 本 session 信任根 / 本 session 可写根命中时都可免重复审批；请求的多个路径可分别命中不同档位（混合覆盖即免审）",
			"timeout 是获批后整条 shell 命令链的最长执行时间（秒），不限制用户审批等待时间"
		],
		// OpenAI function schema 要求根节点是 object；条件字段由描述与运行时校验约束。
		parameters: SANDBOX_ALLOW_PARAMETERS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { command, permission, justification, timeout, memoryMb } = params;
			const cwd = ctx.cwd;
			const sessionId = ctx.sessionManager.getSessionId();
			beginSandboxSession(sessionId);

			const validationError = validateSandboxAllowInput(params, cwd);
			if (validationError) {
				return { content: [{ type: "text", text: `sandbox-allow: ${validationError}，未执行。` }], details: undefined };
			}

			// sandbox-allow 只改变文件系统沙箱范围，不绕过命令安全检查。
			// yolo：整面墙已降零，跳过审计（不重复拦截）与同意门（直接放行）。
			const yolo = yoloEnabled();
			const audit = yolo ? undefined : checkCommand(command as string, { cwd });
			if (!yolo && audit && !audit.allow && audit.rules && audit.rules.length > 0 && audit.rules.every((rule) => rule.autoReject)) {
				return { content: [{ type: "text", text: audit.reason ?? "sandbox-allow: 命令被安全策略拒绝。" }], details: undefined };
			}
			if (!yolo && audit && !audit.allow && !audit.rules?.length) {
				return { content: [{ type: "text", text: audit.reason ?? "sandbox-allow: 命令被安全策略拒绝。" }], details: undefined };
			}

			// 2. write-paths 必须给出至少一个可写根
			let writePaths: string[] = [];
			if (permission === "write-paths") {
				writePaths = resolveWritePaths(params.paths, cwd);
				if (writePaths.length === 0) {
					return {
						content: [
							{ type: "text", text: "sandbox-allow: permission=write-paths 需要至少一个 paths（要额外写入的目录），未执行。" },
						],
						details: undefined,
					};
				}
			}

			// 3. 同意门：长期 allowDirs 与 session 信任根可免重复审批；session 可写根不免审批。
			let decision: "allow" | "deny" = "deny";
			let userComment: string | undefined;

			const { allowDirs } = loadSandboxPaths();
			const sessionAccess = getSessionAccessSnapshot(sessionId);
			const hasAuditRisk = audit ? !audit.allow || (audit.rules?.length ?? 0) > 0 : false;
			const whitelisted =
				permission === "write-paths" &&
				!hasAuditRisk &&
				writePathsFullyTrusted(
					writePaths,
					{
						allowDirs,
						sessionTrustedDirs: sessionAccess.trustedDirs,
						sessionWriteDirs: sessionAccess.writeDirs,
					},
					cwd,
				);
			if (yolo) {
				decision = "allow";
			} else if (whitelisted) {
				decision = "allow";
			} else {
				const gui = await tryGuiApproval(
					command,
					permission,
					writePaths,
					justification,
					timeout,
					sessionId,
					signal,
					audit,
					memoryMb as number | undefined,
					options.approvalDependencies?.runGui,
				);
				if (gui !== "gui-unavailable") {
					// 只接受本次窗口展示过的候选目录，防止响应文件扩大授权范围。
					const candidates = new Set(
						(permission === "write-paths" ? collectCandidateDirs(command, writePaths) : [])
							.map((path) => normalizeSandboxRoot(path, cwd))
							.filter((path): path is string => path !== undefined),
					);
					const currentCommandRoots: string[] = [];
					// 走到 GUI 分支说明非 yolo，audit 必已计算（非空）
					const auditResolved = audit!;
					for (const pa of gui.pathActions ?? []) {
						if (!pa || typeof pa.path !== "string") continue;
						const path = normalizeSandboxRoot(pa.path, cwd);
						if (!path || !candidates.has(path)) continue;
						if (pa.list === "allow") {
							// 目录信任只能减少安全命令的重复审批，不能批准风险命令。
							if (!auditResolved.allow || (auditResolved.rules?.length ?? 0) > 0) continue;
							addAllowDir(path);
							currentCommandRoots.push(path);
						} else if (pa.list === "block") {
							addBlockDir(path);
						} else if (pa.list === "session-write") {
							// 兼容旧 GUI 响应：三档信任都免审批后，session-write 与 session-trust 行为等价。
							if (!auditResolved.allow || (auditResolved.rules?.length ?? 0) > 0) continue;
							addSessionWriteDirs([path], cwd);
							currentCommandRoots.push(path);
						} else if (pa.list === "session-trust") {
							if (!auditResolved.allow || (auditResolved.rules?.length ?? 0) > 0) continue;
							addSessionTrustedDirs([path], cwd);
							currentCommandRoots.push(path);
						}
					}
					writePaths = [...new Set([...writePaths, ...currentCommandRoots])];
					decision = gui.action;
					userComment = normalizeApprovalComment(gui.comment);
				} else if (ctx.hasUI || options.approvalDependencies?.selectApproval) {
					const title = buildApprovalTitle(command, permission, writePaths, justification, timeout, memoryMb as number | undefined);
					const selectApproval = options.approvalDependencies?.selectApproval ?? ((prompt, choices) => ctx.ui.select(prompt, choices));
					const choice = await selectApproval(title, [APPROVE, DENY]);
					decision = choice?.includes("允许") ? "allow" : "deny";
				}
			}

			// session-write/session-trust 的路径动作已同时批准当前命令；
			// writePaths 已并入本次执行环境，后续命令通过 session 状态继续继承。

			if (decision !== "allow") {
				const userNote = userComment ? `用户理由：${userComment}。` : "";
				pi.appendEntry("sandbox-allow", {
					command,
					permission,
					paths: writePaths,
					justification,
					...(memoryMb !== undefined ? { memoryMb: memoryMb as number } : {}),
					outcome: "denied",
					...(userComment ? { comment: userComment } : {}),
					ts: Date.now(),
				});
				return {
					content: [
						{ type: "text", text: `sandbox-allow: 升权请求未被同意（拒绝/取消/无 UI），命令未执行。${userNote}如需继续，可用更窄的权限模式（如 write-paths）重试一次。` },
					],
					details: undefined,
				};
			}
			pi.appendEntry("sandbox-allow", {
				command,
				permission,
				paths: writePaths,
				justification,
				...(memoryMb !== undefined ? { memoryMb: memoryMb as number } : {}),
				outcome: whitelisted ? "approved-whitelist" : "approved",
				...(userComment ? { comment: userComment } : {}),
				ts: Date.now(),
			});

			// 4. 执行：单次 spawn，升权 env 只进该子进程。yolo 下按 full-access 降零。
			// 内存墙与文件系统沙箱正交：memoryMb 注入 PI_SANDBOX_MEMORY_MB；yolo 全降零时同时关闭内存墙。
			const shellPath = readShellPath();
			const env = addSessionWriteDirsToEnv(
				buildEscalationEnv(process.env, yolo ? "full-access" : permission, yolo ? [] : writePaths, memoryMb as number | undefined),
				sessionId,
			);
			if (yolo) env.PI_SANDBOX_MEMORY_DISABLE = "1";
			const ops = createLocalBashOperations({ shellPath });

			const chunks: Buffer[] = [];
			let total = 0;
			let truncated = false;
			let lastEmit = 0;
			let emitTimer: ReturnType<typeof setTimeout> | undefined;

			const emitPartial = () => {
				if (!onUpdate) return;
				lastEmit = Date.now();
				onUpdate({ content: [{ type: "text", text: Buffer.concat(chunks).toString("utf8") }], details: undefined });
			};

			const onData = (data: Buffer) => {
				if (total >= MAX_OUTPUT_BYTES) {
					truncated = true;
					return;
				}
				const room = MAX_OUTPUT_BYTES - total;
				const part = data.length > room ? data.subarray(0, room) : data;
				chunks.push(part);
				total += part.length;
				if (data.length > room) truncated = true;
				if (onUpdate) {
					const now = Date.now();
					const delay = 100 - (now - lastEmit);
					if (delay <= 0) emitPartial();
					else if (!emitTimer)
						emitTimer = setTimeout(() => {
							emitTimer = undefined;
							emitPartial();
						}, delay);
				}
			};

			let exitCode: number | null = null;
			let statusLine = "";
			try {
				const result = await ops.exec(command, cwd, { onData, signal, timeout, env });
				exitCode = result.exitCode;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg === "aborted") statusLine = "\n[aborted]";
				else if (msg.startsWith("timeout:")) statusLine = `\n[timed out after ${msg.split(":")[1]}s]`;
				else statusLine = `\n[error: ${msg}]`;
			} finally {
				if (emitTimer) clearTimeout(emitTimer);
			}

			let output = Buffer.concat(chunks).toString("utf8");
			if (userComment) output += `\n[审批附言：${userComment}]`;
			if (truncated) output += `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
			if (exitCode !== null && exitCode !== 0) output += `\n[exit code: ${exitCode}]`;
			if (statusLine) output += statusLine;

			return {
				content: [{ type: "text", text: output || "(no output)" }],
				details: { exitCode, permission, writePaths, memoryMb: memoryMb as number | undefined },
			};
		},
	});
}
