// dsh-jobs — DSH dsh-jobs/dsh-jobs-local/dsh-tool-jobs 移植（Track B 第三批）
//
// 见 docs/plans/2026-08-15-dsh-architecture-migration.md §7 #4：
//   - registry.ts   进程内内存注册表（start/list/get/read/kill/wait/onJobDone，重启即失）
//   - providers.ts  bash 后台任务提供方（spawn 子进程，输出上限截断）
//   - tools.ts      bash_background + job_output/job_list/job_kill + 指导段
//
// 完成通知：任务结算（first-wins）→ ctx.ui.notify 通知用户；delivery=wakeup 且 agent
//   空闲时 sendMessage 开新轮次通知模型（DSH wakeup；quiet 模式下仅 notify 用户）。
//
// 开关（settings.json，/reload 生效）：
//   "dshJobs": true          — 注册 jobs 工具集（默认 true，不与现有扩展冲突）
//   "dshJobsDelivery": "wakeup" | "quiet" — 完成通知投递（默认 wakeup）

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JobRegistry, type JobSnapshot } from "./registry.ts";
import { registerJobsTools } from "./tools.ts";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function readSettings(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function isTerminal(status: string): boolean {
	return status === "completed" || status === "killed" || status === "failed";
}

export default function (pi: ExtensionAPI) {
	const settings = readSettings();
	if (settings.dshJobs === false) return;

	const registry = new JobRegistry();
	const delivery = settings.dshJobsDelivery === "quiet" ? "quiet" : "wakeup";

	registerJobsTools(pi, registry);

	// ---- 完成通知 ----
	// 当前 session 的 ui 与 agent 空闲标志（事件回调里没有 ctx，用模块级缓存）
	let currentUi: ExtensionUIContext | undefined;
	let agentIdle = true;
	pi.on("session_start", (_event, ctx) => {
		currentUi = ctx.ui;
	});
	pi.on("session_shutdown", () => {
		currentUi = undefined;
	});
	pi.on("agent_start", () => {
		agentIdle = false;
	});
	pi.on("agent_settled", () => {
		agentIdle = true;
	});

	registry.onJobDone((snapshot: JobSnapshot) => {
		// 用户可见通知（一次，first-wins）
		currentUi?.notify(
			`⚙️ 后台任务 ${snapshot.id} 完成: ${snapshot.status}${snapshot.detail ? ` (${snapshot.detail})` : ""}`,
			"info",
		);
		// wakeup：agent 空闲时开新轮次通知模型读取
		if (delivery === "wakeup" && agentIdle) {
			pi.sendMessage(
				{
					customType: "dsh-job-notice",
					content: `Background job ${snapshot.id} finished with status ${snapshot.status}${snapshot.detail ? ` (${snapshot.detail})` : ""}. Collect it with job_output or stop caring with job_kill.`,
					display: false,
					details: { jobId: snapshot.id, status: snapshot.status },
				},
				{ triggerTurn: true },
			);
		}
	});

	// /dsh-jobs：人看的任务列表
	pi.registerCommand("dsh-jobs", {
		description: "显示后台任务列表（bash_background 启动的任务）",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const jobs = registry.list();
			if (jobs.length === 0) {
				ctx.ui.notify("dsh-jobs: 无后台任务", "info");
				return;
			}
			const lines = jobs.map((j) => `${j.id}\t${j.status}${j.detail ? ` (${j.detail})` : ""}\t${j.label}`);
			ctx.ui.notify(`dsh-jobs（${jobs.length} 项）:\n${lines.join("\n")}`, "info");
		},
	});
}
