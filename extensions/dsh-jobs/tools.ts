// tools.ts — DSH dsh-tool-jobs 移植：bash_background + job_output / job_list / job_kill
//
// 语义照抄 @deepseek-ai/dsh-tool-jobs：
//   - job_output：非阻塞读（wait:false 返回增量/终态输出 + [status: ...]）；
//     wait:true 阻塞到终态或超时（默认 30s，上限 600s，超时返回 [status: running] 且任务存活）
//   - job_list：注册序快照（id/kind/status）
//   - job_kill：请求取消（返回 requested | already-finished），reason 转发给生产者
//   - 完成通知（wakeup/quiet）在 index.ts 接线；指导段 order 116

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerSection } from "../../lib/prompt-sections.ts";
import { JobRegistry, type JobSnapshot } from "./registry.ts";
import { bashBackground } from "./providers.ts";

export interface JobsToolOptions {
	/** wait 默认超时（ms，默认 30s） */
	waitTimeoutMs?: number;
	/** wait 上限（ms，默认 600s） */
	maxWaitTimeoutMs?: number;
}

function snapshotStatusText(snapshot: JobSnapshot): string {
	const detail = snapshot.detail ? ` (${snapshot.detail})` : "";
	return `[status: ${snapshot.status}${detail}]`;
}

/** 注册四个工具 + 指导段 */
export function registerJobsTools(pi: ExtensionAPI, registry: JobRegistry, options: JobsToolOptions = {}): void {
	const waitDefault = options.waitTimeoutMs ?? 30_000;
	const waitCap = options.maxWaitTimeoutMs ?? 600_000;

	registerSection({
		name: "tool:jobs",
		order: 116,
		text: () =>
			"Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.",
	});

	// bash_background：启动后台 shell 任务
	pi.registerTool({
		name: "bash_background",
		label: "Bash Background",
		description:
			"Start a shell command as a background job and return its job id. The turn continues without waiting; collect the result later with job_output (optionally wait: true), or stop it with job_kill. Use for long-running commands that should not block the current turn.",
		promptSnippet: "Start a shell command as a background job",
		promptGuidelines: [
			"bash_background 立即返回 job_id，不阻塞当前轮次",
			"长任务用 bash_background 启动后继续其他工作，最后用 job_output 收集",
			"不需要的任务用 job_kill 停止，避免僵尸进程",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The full shell command to run in the background." }),
		}),
		async execute(_toolCallId, params: { command: string }, _signal, _onUpdate, ctx) {
			const id = registry.start(bashBackground(params.command, { cwd: ctx.cwd }));
			const snapshot = registry.get(id);
			return {
				content: [{ type: "text", text: `Started background job ${id}: ${snapshot.label}\n${snapshotStatusText(snapshot)}` }],
				details: { job_id: id, label: snapshot.label },
			};
		},
	});

	// job_output：读取输出（可等待）
	pi.registerTool({
		name: "job_output",
		label: "Job Output",
		description:
			"Read a background job. Stream jobs return only output since the previous read; final-output jobs return their result after settlement. Every response ends with `[status: ...]`. Reads are non-blocking unless `wait: true`, which waits up to the configured cap.",
		promptSnippet: "Read output of a background job (optionally wait for it)",
		parameters: Type.Object({
			job_id: Type.String({ description: "Job id returned by the tool that started the background work." }),
			wait: Type.Optional(
				Type.Boolean({
					description: "Block until the job reaches a terminal status or the timeout expires. A timed-out wait returns [status: running] and leaves the job alive.",
				}),
			),
			timeout_ms: Type.Optional(
				Type.Number({
					description: "Max wait in milliseconds (only meaningful with wait: true). Defaults to the configured wait timeout; capped by the configured maximum.",
				}),
			),
		}),
		async execute(_toolCallId, params: { job_id: string; wait?: boolean; timeout_ms?: number }, _signal, _onUpdate) {
			if (params.wait === true) {
				const timeout = Math.min(params.timeout_ms ?? waitDefault, waitCap);
				await registry.wait(params.job_id, timeout);
			}
			const { text, snapshot } = registry.read(params.job_id);
			const body = text.length > 0 ? text : "(no output)";
			return {
				content: [{ type: "text", text: `${body}\n${snapshotStatusText(snapshot)}` }],
				details: { job_id: params.job_id, snapshot },
			};
		},
	});

	// job_list：列出任务
	pi.registerTool({
		name: "job_list",
		label: "Job List",
		description: "List your background jobs (running and finished) with their ids, kinds, and statuses.",
		promptSnippet: "List background jobs",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate) {
			const jobs = registry.list();
			if (jobs.length === 0) {
				return { content: [{ type: "text", text: "(no background jobs)" }], details: { jobs: [] } };
			}
			const lines = jobs.map((j) => `${j.id}\t${j.kind}\t${j.status}${j.detail ? `\t(${j.detail})` : ""}\t${j.label}`);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, label: j.label })) },
			};
		},
	});

	// job_kill：取消任务
	pi.registerTool({
		name: "job_kill",
		label: "Job Kill",
		description:
			"Request cancellation of a running background job by job id. Returns immediately; the job settles as killed once its work actually stops.",
		promptSnippet: "Cancel a background job",
		parameters: Type.Object({
			job_id: Type.String({ description: "Job id returned by the tool that started the background work." }),
			reason: Type.Optional(Type.String({ description: "Optional short reason, recorded and forwarded to the job." })),
		}),
		async execute(_toolCallId, params: { job_id: string; reason?: string }, _signal, _onUpdate) {
			const result = registry.kill(params.job_id, params.reason);
			const snapshot = registry.get(params.job_id);
			return {
				content: [{ type: "text", text: `${result === "requested" ? "Kill requested" : "Already finished"}: ${params.job_id} ${snapshotStatusText(snapshot)}` }],
				details: { job_id: params.job_id, result, snapshot },
			};
		},
	});
}
