// sandbox-allow — DSH sandbox_permissions 升权移植（单一指令、一次授权）
//
// 背景：pi 的 bash 工具是内建的，无法直接加 sandbox_permissions 参数；
// 本扩展注册独立工具 sandbox-allow，等价于 DSH bash 工具的
//   sandbox_permissions: "danger-full-access" | 额外写路径 + justification。
//
// 语义照抄 DSH（dsh-tool-bash + dsh-sandbox-policy + dsh-user-approval）：
//   - 升权仅对「本次单条命令」生效（allowed-once），绝不持久化
//   - 每次调用都必须经用户显式同意（审批提示本身就是征求同意；拒绝/取消/无 UI = 不执行）
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
	readShellPath,
	resolveWritePaths,
} from "./helpers.ts";
import { findGuiBinary, runGuiWindow } from "../../lib/gui-runner";
import { addAllowDir, addBlockDir, collectCandidateDirs, isDirInside, loadSandboxPaths } from "./paths";

const MAX_OUTPUT_BYTES = 1_000_000;
const GUI_TIMEOUT_MS = 3_600_000; // 1 小时兜底（窗口内不自动超时；仅防窗口进程卡死）
const APPROVE = "✅ 允许执行（仅此一次）";
const DENY = "❌ 拒绝";

interface GuiDecision {
	action: "allow" | "deny";
	/** 用户在 GUI 上点选的目录白/黑名单操作 */
	pathActions?: { path: string; list: "allow" | "block" }[];
}

/** 通过 GUI 审批（合并进现有权限闸门 gate 窗口，kind=sandbox-allow） */
async function tryGuiApproval(
	command: string,
	permission: "full-access" | "write-paths",
	writePaths: string[],
	justification: string,
	signal: AbortSignal | undefined,
): Promise<GuiDecision | "gui-unavailable"> {
	if (!findGuiBinary()) return "gui-unavailable";
	const result = await runGuiWindow(
		"gate",
		{
			kind: "sandbox-allow",
			command,
			permission,
			writePaths,
			justification,
			// GUI 候选目录：请求的可写目录 + 命令中提取的路径（供白/黑名单按钮）
			candidatePaths: collectCandidateDirs(command, writePaths),
		},
		{ timeoutMs: GUI_TIMEOUT_MS, signal },
	);
	// 仅采纳用户明确的选择（允许/拒绝）；窗口异常关闭/超时/中止 → 回退 TUI
	if (result.ok && result.data && (result.data.action === "allow" || result.data.action === "deny")) {
		return { action: result.data.action, pathActions: result.data.pathActions };
	}
	return "gui-unavailable";
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "sandbox-allow",
		label: "Sandbox Allow (one-shot)",
		description: [
			"Run ONE bash command with temporarily elevated sandbox permissions.",
			"Use only when the sandbox has actually denied a write the task legitimately needs (the default sandbox is read-only outside the workspace).",
			"Every call requires the user's explicit one-shot consent and is scoped to that single command only — nothing is remembered.",
			"Prefer permission=write-paths (least privilege: keep the read-only sandbox and only add the listed writable paths) over permission=full-access (no sandbox).",
			"Always supply a one-sentence justification, shown to the user for consent.",
		].join(" "),
		promptSnippet: "Run one bash command with user-approved, one-shot elevated sandbox permissions",
		promptGuidelines: [
			"sandbox-allow 是升权工具：仅当沙箱确实拒绝了任务必需的写入时才用，绝不预先推测",
			"优先 permission=write-paths（最小权限：保持只读沙箱、只额外开放指定目录），确需全局改动才用 full-access",
			"每次调用都会弹给用户确认，授权只对这一次生效；被拒绝后可用更窄的模式+理由重试一次",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The single bash command to run with elevated permissions." }),
			permission: Type.Union(
				[Type.Literal("full-access"), Type.Literal("write-paths")],
				{
					description:
						"full-access = run with no sandbox at all; write-paths = keep the read-only sandbox but allow writing to the listed paths (least privilege).",
				},
			),
			justification: Type.String({
				description: "One sentence explaining why this command needs the wider permission (shown to the user for consent).",
			}),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Writable paths to grant (absolute, or relative to cwd). Required when permission=write-paths.",
				}),
			),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { command, permission, justification, timeout } = params;
			const cwd = ctx.cwd;

			// 1. 校验：命令非空
			if (!command || !command.trim()) {
				return { content: [{ type: "text", text: "sandbox-allow: command 不能为空，未执行。" }], details: undefined };
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

			// 3. 同意门（对齐 DSH allowed-once）：GUI 优先，回退 TUI；拒绝/取消/无 UI = 不执行
			//    前置：目录白名单豁免——请求的可写目录全部在 allow_dirs 内 → 免弹窗直接执行
			let decision: "allow" | "deny" = "deny";
			const { allowDirs } = loadSandboxPaths();
			const whitelisted =
				permission === "write-paths" &&
				writePaths.length > 0 &&
				writePaths.every((p) => allowDirs.some((d) => isDirInside(p, d)));
			if (whitelisted) {
				decision = "allow";
			} else {
				const gui = await tryGuiApproval(command, permission, writePaths, justification, signal);
				if (gui !== "gui-unavailable") {
					// 用户在 GUI 上点选的目录白/黑名单操作（无论 allow/deny 都先落名单）
					for (const pa of gui.pathActions ?? []) {
						if (pa?.list === "allow" && typeof pa.path === "string") addAllowDir(pa.path);
						else if (pa?.list === "block" && typeof pa.path === "string") addBlockDir(pa.path);
					}
					decision = gui.action;
				} else if (ctx.hasUI) {
					const title = buildApprovalTitle(command, permission, writePaths, justification);
					const choice = await ctx.ui.select(title, [APPROVE, DENY]);
					decision = choice?.includes("允许") ? "allow" : "deny";
				}
			}

			if (decision !== "allow") {
				pi.appendEntry("sandbox-allow", {
					command,
					permission,
					paths: writePaths,
					justification,
					outcome: "denied",
					ts: Date.now(),
				});
				return {
					content: [
						{ type: "text", text: "sandbox-allow: 升权请求未被同意（拒绝/取消/无 UI），命令未执行。如需继续，可用更窄的权限模式（如 write-paths）重试一次。" },
					],
					details: undefined,
				};
			}
			pi.appendEntry("sandbox-allow", {
				command,
				permission,
				paths: writePaths,
				justification,
				outcome: whitelisted ? "approved-whitelist" : "approved",
				ts: Date.now(),
			});

			// 4. 执行：单次 spawn，升权 env 只进该子进程
			const shellPath = readShellPath();
			const env = buildEscalationEnv(process.env, permission, writePaths);
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
			if (truncated) output += `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
			if (exitCode !== null && exitCode !== 0) output += `\n[exit code: ${exitCode}]`;
			if (statusLine) output += statusLine;

			return {
				content: [{ type: "text", text: output || "(no output)" }],
				details: { exitCode, permission, writePaths },
			};
		},
	});
}
