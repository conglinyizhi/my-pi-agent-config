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
import { homedir } from "node:os";
import { Type } from "typebox";
import {
	buildEscalationEnv,
	MAX_MEMORY_MB,
	readShellPath,
	resolveWritePaths,
	validateMemoryMb,
} from "./helpers.ts";
import {
	normalizeApprovalComment,
	resolveApprovalChannel,
	type ApprovalChannel,
	type ApprovalRunGui,
	type ApprovalSelect,
} from "../../lib/approval-channel.ts";
import { checkCommand, type SandboxCheckResult } from "../../lib/sandbox-check.ts";
import { addAllowDir, addBlockDir, isDirInside, loadSandboxPaths, removeAllowDir } from "./paths.ts";
import {
	addSessionTrustedDirs,
	addSessionWriteDirs,
	addSessionWriteDirsToEnv,
	beginSandboxSession,
	getSessionAccessSnapshot,
	normalizeSandboxRoot,
	normalizeSandboxRoots,
	removeSessionDirs,
	pathsCoveredByRoots,
} from "./session-access.ts";
import { yoloEnabled } from "./yolo.ts";

const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_COMMAND_TIMEOUT_SECONDS = 2_147_483.647; // 与 pi 内建 bash 的 setTimeout 上限一致

export const SANDBOX_ALLOW_PARAMETERS = Type.Object({
	command: Type.String({ minLength: 1, description: "The complete shell command string to run once approved." }),
	permission: Type.Union(
		[Type.Literal("full-access"), Type.Literal("write-paths")],
		{ description: "write-paths = sandbox plus listed paths (paths required); full-access = cancel file-system sandbox (paths forbidden)." },
	),
	justification: Type.String({ minLength: 1, description: "Non-empty one-sentence reason shown to the user for consent." }),
	paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Required for write-paths: directories you declare, not files parsed from command. Root `/` (including `/.` and `/..`) rejects the whole request." })),
	timeout: Type.Optional(Type.Number({ minimum: 0.001, maximum: MAX_COMMAND_TIMEOUT_SECONDS, description: "Maximum execution time after approval, in seconds." })),
	memoryMb: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_MEMORY_MB, description: "Memory limit (MB) for this command's process tree. Default 1 GiB (1024). Specify a concrete MB value only when the command needs more than the default; larger values raise the cap, subject to approval." })),
}, { additionalProperties: false });

type PathActionList = "allow" | "block" | "session-write" | "session-trust" | "revoke" | "workspace";

export interface PathAction {
	path: string;
	list: PathActionList;
}

export interface ApplyPathActionsResult {
	writePaths: string[];
}

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


/** 沙箱默认已可写的根：工作区、/tmp、/dev/null。请求只落在这些根内时不必再弹窗。 */
export function builtinWritableRoots(cwd = process.cwd()): string[] {
	return normalizeSandboxRoots([cwd, "/tmp", "/dev/null"], cwd);
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
	const builtin = builtinWritableRoots(cwd);
	return pathsCoveredByRoots(writePaths, [...builtin, ...roots.allowDirs, ...roots.sessionTrustedDirs, ...roots.sessionWriteDirs], cwd);
}

/** 编辑后的执行范围是否互为祖先/后代（同路径也算） */
function isRelatedPath(a: string, b: string): boolean {
	return a === b || isDirInside(a, b) || isDirInside(b, a);
}

/** 家目录根本身（子目录合法）。"/" 由 normalizeSandboxRoot 先挡掉。 */
function isHomeRootPath(path: string, homeDir: string | undefined, cwd: string): boolean {
	const home = normalizeSandboxRoot(homeDir ?? homedir(), cwd);
	return home !== undefined && path === home;
}

/**
 * 响应里编辑后的执行范围（完整列表，覆盖申请值）。
 *
 * 护栅在后端自己算，不依赖 GUI 先拦：每一项必须与某个原始候选路径互为祖先或后代
 * （同路径也算）。不满足的项丢弃，对应原候选路径保留，让本次执行范围仍可用；
 * 一个有效项都没有时退回申请值。"/" 之类的根路径在这里就 normalize 掉了。
 */
export function resolveEditedWritePaths(edited: unknown, candidates: string[], cwd = process.cwd()): string[] {
	const base = [...new Set(candidates)];
	if (!Array.isArray(edited)) return base;
	const accepted = normalizeSandboxRoots(
		edited.filter((path): path is string => typeof path === "string"),
		cwd,
	).filter((path) => base.some((candidate) => isRelatedPath(path, candidate)));
	// 闸门窗提交的是完整列表（含没动过的原候选），所以以它为准：删掉的行就该消失。
	// 只有一项有效项都没有时才退回申请值——那多半是误传，或整列被护栅刷掉，
	// 这时把范围清空会让审计 entry 与所见不一致
	return accepted.length === 0 ? base : accepted;
}

export interface ApplyPathActionsOptions {
	/** 响应里编辑后的执行范围（完整列表，覆盖申请值）；不给则沿用申请值。 */
	editedWritePaths?: unknown;
	/** os.homedir()：workspace 护栅拒绝家目录根，缺省取本机 homedir。 */
	homeDir?: string;
}

/**
 * 一次审批里的多条目录操作。授权候选只认本次声明的 writePaths；
 * workspace（副工作区）例外——它是「任意目录」的持久信任根，不受候选集限制。
 * 信任类动作在命令审计未通过时跳过，revoke/block 始终生效。
 */
export function applyPathActions(
	actions: PathAction[] | undefined,
	writePaths: string[],
	cwd: string,
	audit?: SandboxCheckResult,
	options: ApplyPathActionsOptions = {},
): ApplyPathActionsResult {
	// 候选仍是申请里声明的路径：编辑只改本次执行范围，不改授权判定的基准。
	const candidates = new Set(writePaths);
	const scope = resolveEditedWritePaths(options.editedWritePaths, [...candidates], cwd);
	const extraRoots: string[] = [];
	const builtin = new Set(builtinWritableRoots(cwd));
	const grantSafe = !audit || (audit.allow && (audit.rules?.length ?? 0) === 0);
	for (const pa of actions ?? []) {
		if (!pa || typeof pa.path !== "string") continue;
		const path = normalizeSandboxRoot(pa.path, cwd);
		if (!path || (pa.list !== "workspace" && !candidates.has(path))) continue;
		if (pathsCoveredByRoots([path], builtin, cwd) && pa.list !== "block") continue;
		if (pa.list === "workspace") {
			// 任意目录都可设为副工作区，但 "/"（上面 normalize 已挡）与家目录根本身不授予，也不改写本次范围
			if (!grantSafe || isHomeRootPath(path, options.homeDir, cwd)) continue;
			addAllowDir(path);
			extraRoots.push(path);
		} else if (pa.list === "allow") {
			if (!grantSafe) continue;
			addAllowDir(path);
			extraRoots.push(path);
		} else if (pa.list === "block") {
			addBlockDir(path);
		} else if (pa.list === "session-write") {
			// 兼容旧 GUI 响应：三档信任都免审批后，session-write 与 session-trust 行为等价。
			if (!grantSafe) continue;
			addSessionWriteDirs([path], cwd);
			extraRoots.push(path);
		} else if (pa.list === "session-trust") {
			if (!grantSafe) continue;
			addSessionTrustedDirs([path], cwd);
			extraRoots.push(path);
		} else if (pa.list === "revoke") {
			removeAllowDir(path);
			removeSessionDirs([path], cwd);
		}
	}
	return { writePaths: [...new Set([...scope, ...extraRoots])] };
}

/**
 * 目录授权护栅看到的审计结果。
 *
 * 只命中敏感路径时把 allow 折回 true：`checkCommand` 为把控制权交给审批窗会报 allow=false，
 * 但风险在「目标路径敏感」而不在命令写法，不该连带否掉用户对某个可写目录的长期/本次授权。
 * 命令写法真有问题（命中规则）时原样传下去，信任类动作照旧跳过。
 */
export function auditForPathGrants(audit: SandboxCheckResult | undefined): SandboxCheckResult | undefined {
	if (!audit) return undefined;
	if ((audit.sensitive?.length ?? 0) > 0 && (audit.rules?.length ?? 0) === 0) return { ...audit, allow: true };
	return audit;
}

/** 通过审批通道问人（默认 GUI→TUI，kind=sandbox-allow） */
export interface SandboxAllowDependencies {
	/** 测试或 IM 注入整条通道；优先于 runGui / selectApproval。 */
	channel?: ApprovalChannel;
	/** 测试注入；默认使用真实 wails-gui runner。 */
	runGui?: ApprovalRunGui;
	/** 测试注入；默认使用 ctx.ui.select。 */
	selectApproval?: ApprovalSelect;
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
			"Prefer write-paths with the smallest necessary writable roots, declared in paths. The tool does not parse directories from command. Never use full-access merely because a write failed if a directory can be named.",
			"A command that references a sensitive path (e.g. .env, ~/.ssh) is not auto-rejected: it goes to the user for explicit approval, and the approval window highlights the matched fragment. Still worth asking when the task legitimately needs that file.",
			"Always supply a non-empty one-sentence justification, shown to the user for consent.",
			"timeout is the maximum execution time after approval, in seconds; it does not limit the user's approval time."
		].join(" "),
		promptSnippet: "Run one bash command with user-approved, one-shot elevated sandbox permissions",
		promptGuidelines: [
			"sandbox-allow 是升权工具：仅当普通 bash 确实因沙箱拒绝而无法完成任务时才用，绝不预先调用",
			"优先 permission=write-paths，paths 由模型自己声明最小可写目录（不是命令里的文件参数）；工具不从 command 拆目录。paths 里出现 `/` （含 `/.` `/..`）整次拒绝",
			"full-access 会完全取消文件系统沙箱，只在无法合理限定写入根时使用；它仍不改变当前用户的操作系统身份",
			"所有 bash 命令默认有 1GiB 内存上限；若命令可能超过（如重型构建/测试），必须用 memoryMb 给出**具体 MB 数值**，上限 32768 MB，更大会被拒绝",
			"长期 allowDirs / 本 session 信任根 / 本 session 可写根命中时都可免重复审批；请求的多个路径可分别命中不同档位（混合覆盖即免审）",
			"命令引用敏感路径（如 .env / ~/.ssh）时不会被硬拒：会转成人工审批并在窗口里标出命中的那一段。正当需要就照常申请，但别用改写变量、拼路径这类手法去躲审批窗",
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
			// sensitivePaths="ask"：命令引用敏感路径（.env 等）时不在判定层硬拒，
			// 而是走下面的审批门问人。普通 bash 仍硬拒（那边没有同意出口）。
			const audit = yolo ? undefined : checkCommand(command as string, { cwd, sensitivePaths: "ask" });
			const sensitive = audit?.sensitive ?? [];
			if (!yolo && audit && !audit.allow && audit.rules && audit.rules.length > 0 && audit.rules.every((rule) => rule.autoReject)) {
				return { content: [{ type: "text", text: audit.reason ?? "sandbox-allow: 命令被安全策略拒绝。" }], details: undefined };
			}
			// 无规则且无敏感命中：内联脚本这类判定层拦截不归审批管（审了也没法安全执行）
			if (!yolo && audit && !audit.allow && !audit.rules?.length && sensitive.length === 0) {
				return { content: [{ type: "text", text: audit.reason ?? "sandbox-allow: 命令被安全策略拒绝。" }], details: undefined };
			}
			/**
			 * 交给目录授权护栅的审计结果。
			 * 只命中敏感路径时把 allow 折回 true：风险在「目标路径敏感」，不在命令写法，
			 * 不该连带否掉用户对某个可写目录的长期/本次授权。
			 */
			const auditForGrants = auditForPathGrants(audit);

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
			// 3. 同意门：默认可写根（cwd /tmp）与用户信任根都可免审批。

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
				const asked = await resolveApprovalChannel(options.approvalDependencies ?? {})({
					kind: "sandbox-allow",
					command,
					permission,
					writePaths,
					justification,
					timeout,
					memoryMb: memoryMb as number | undefined,
					candidatePaths: writePaths,
					persistentRoots: allowDirs,
					sessionWriteRoots: sessionAccess.writeDirs,
					sessionTrustedRoots: sessionAccess.trustedDirs,
					builtinRoots: builtinWritableRoots(cwd),
					workspaceRoot: cwd ?? process.cwd(),
					homeDir: homedir(),
					rules: audit?.rules ?? [],
					sensitive,
					signal,
				}, ctx);
				// 目录草稿与「编辑后的执行范围」都在后端重新过一遍护栅：GUI 拦过不算数。
				// 只命中敏感路径时，命令写法本身没风险：允许用户把目录授权给这一段。
				writePaths = applyPathActions(asked.pathActions as PathAction[] | undefined, writePaths, cwd, auditForGrants, {
					editedWritePaths: asked.writePaths,
					homeDir: homedir(),
				}).writePaths;
				decision = asked.action;
				userComment = normalizeApprovalComment(asked.comment);
			}

			// 目录草稿随允许/拒绝一并提交；信任类动作只减少后续审批，不代替本次决定。

			if (decision !== "allow") {
				const userNote = userComment ? `用户理由：${userComment}。` : "";
				pi.appendEntry("sandbox-allow", {
					command,
					permission,
					paths: writePaths,
					justification,
					...(sensitive.length > 0 ? { sensitivePaths: sensitive.map((hit) => hit.pattern) } : {}),
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
				...(sensitive.length > 0 ? { sensitivePaths: sensitive.map((hit) => hit.pattern) } : {}),
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
