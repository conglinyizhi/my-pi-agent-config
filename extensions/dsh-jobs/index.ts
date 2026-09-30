// dsh-jobs — DSH dsh-jobs/dsh-jobs-local/dsh-tool-jobs 移植（Track B 第三批）
//
// 见 docs/plans/2026-08-15-dsh-architecture-migration.md §7 #4：
//   - registry.ts   进程内内存注册表（start/list/get/read/kill/wait/onJobDone，重启即失）
//   - providers.ts  bash 后台任务提供方（spawn 子进程，输出上限截断）
//   - tools.ts      bash_background + job_output/job_list/job_kill + 指导段
//   - snapshot.ts   共享快照（每个 pi 进程一份，读方扫目录 = 全舰队任务视图）
//   - jobs-panel.ts /jobs 的 TUI 面板（看 + 取消，含别的进程的任务）
//
// 完成通知：任务结算（first-wins）→ ctx.ui.notify 通知用户；delivery=wakeup 且 agent
//   空闲时 sendMessage 开新轮次通知模型（DSH wakeup；quiet 模式下仅 notify 用户）。
//
// 为什么要共享快照：worker 是独立 pi 进程，注册表各自在内存里。主会话想看见（并取消）
// worker 起的后台任务，只能靠一个公共目录交换状态——拿不到对方 job 的 pid，发信号这条路
// 走不通，取消得请对方自己动手（kill 请求文件，见 snapshot.ts）。
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
import { cancelRow, collectRows, showJobsPanel, tailOf, type PanelRow } from "./jobs-panel.ts";
import {
	currentOwner,
	pruneStaleSnapshots,
	readKillRequests,
	removeOwnerSnapshot,
	writeOwnerSnapshot,
	type JobRecord,
	type OwnerInfo,
} from "./snapshot.ts";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");
/** 快照心跳（毫秒）：跨进程观察没有事件通道，靠这个节拍把状态推给别的进程 */
const SNAPSHOT_MS = 1000;
/** 每多少拍清一次死进程留下的残留（快照文件 + 没人消费的取消请求） */
const PRUNE_EVERY = 15;

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

/** 本进程任务列表 → 快照记录（输出只带尾部：完整输出留在 registry 里给 job_output 读） */
function snapshotJobs(registry: JobRegistry, owner: OwnerInfo): JobRecord[] {
	return registry.list().map((snap) => ({
		id: snap.id,
		kind: snap.kind,
		label: snap.label,
		status: snap.status,
		detail: snap.detail,
		startedAt: snap.startedAt,
		finishedAt: snap.finishedAt,
		tail: tailOf(registry.peekOutput(snap.id)),
	}));
}

/** 文本形态（非 TUI 模式与 /dsh-jobs 用）：一行一项，带来源进程标记 */
function textRows(rows: PanelRow[]): string {
	return rows
		.map((row) => {
			const ownerTag = row.owner.kind === "main" ? "主" : `w:${row.owner.taskId ?? row.owner.pid}`;
			return `${row.record.id}\t${row.record.status}${row.record.detail ? ` (${row.record.detail})` : ""}\t[${ownerTag}]\t${row.record.label}`;
		})
		.join("\n");
}

/** 取消结果 → 给用户的一句话（面板与直通命令共用） */
function describeCancel(outcome: ReturnType<typeof cancelRow>, row: PanelRow): string {
	switch (outcome) {
		case "local-requested":
			return `已请求取消 ${row.record.id}`;
		case "local-finished":
			return `${row.record.id} 已结束，不用取消`;
		case "remote-requested":
			return `已向 ${row.owner.label} 发出取消请求（对方下一拍处理）`;
		default:
			return `取消 ${row.record.id} 失败（对象可能已退出）`;
	}
}

export default function (pi: ExtensionAPI) {
	const settings = readSettings();
	if (settings.dshJobs === false) return;

	const registry = new JobRegistry();
	const delivery = settings.dshJobsDelivery === "quiet" ? "quiet" : "wakeup";
	const owner = currentOwner();

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
		// worker 子进程不打扰用户：它的后台任务归它自己收（主会话通过 /jobs 面板观察）
		if (owner.kind !== "main") return;
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

	// ---- 共享快照心跳 ----
	// 三件事挤在一个节拍里：推出自己的状态、消费发给自己的取消请求、偶尔清残留。
	// 只在内容真的变了才写文件（终态任务会一直留在列表里，没必要每秒重写同样的字节）。
	let lastWritten = "";
	let ticks = 0;
	const writeIfChanged = (): void => {
		const jobs = snapshotJobs(registry, owner);
		const payload = JSON.stringify(jobs);
		if (payload === lastWritten) return;
		lastWritten = payload;
		writeOwnerSnapshot(owner, jobs);
	};

	const heartbeat = setInterval(() => {
		ticks++;
		writeIfChanged();
		// 别的进程发来的取消请求：由本进程调自己的 registry.kill()（正规取消路径）
		for (const jobId of readKillRequests(owner)) {
			try {
				registry.kill(jobId, "取消请求（/jobs 面板）");
			} catch {
				/* 任务已结算：忽略 */
			}
		}
		if (ticks % PRUNE_EVERY === 0) pruneStaleSnapshots();
	}, SNAPSHOT_MS);
	// 不阻止进程退出：进程结束时 pi 会走 session_shutdown，残留文件读方按 pid 判死
	heartbeat.unref?.();

	// 启动即写一次 + 清一次残留：新会话不该先看到上一批死进程的作业
	writeIfChanged();
	pruneStaleSnapshots();

	pi.on("session_shutdown", () => {
		clearInterval(heartbeat);
		removeOwnerSnapshot(owner);
	});

	// /jobs：全舰队后台任务面板（TUI）；非交互模式退化成文本列表
	pi.registerCommand("jobs", {
		description: "后台任务面板：看主进程与 worker 的后台任务，可取消（/jobs:kill <id> 直通）",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode === "tui") {
				await showJobsPanel(registry, owner, ctx);
				return;
			}
			const rows = collectRows(registry, owner);
			if (rows.length === 0) {
				ctx.ui.notify("jobs: 无后台任务", "info");
				return;
			}
			ctx.ui.notify(`jobs（${rows.length} 项）:\n${textRows(rows)}`, "info");
		},
	});

	// /jobs:kill <id>：不想开面板时的直通（快速处理/脚本化）
	pi.registerCommand("jobs:kill", {
		description: "取消指定后台任务（含 worker 进程里的）",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const id = args.trim();
			if (id === "") {
				ctx.ui.notify("用法：/jobs:kill <job id>（id 见 /jobs）", "warning");
				return;
			}
			const row = collectRows(registry, owner).find((candidate) => candidate.record.id === id);
			if (!row) {
				ctx.ui.notify(`jobs: 找不到任务 ${id}`, "warning");
				return;
			}
			if (isTerminal(row.record.status)) {
				ctx.ui.notify(`${id} 已经结束（${row.record.status}），不用取消`, "info");
				return;
			}
			ctx.ui.notify(describeCancel(cancelRow(registry, owner, row), row), "info");
		},
	});

	// /dsh-jobs：保留旧命令名（文本列表），数据源换成全舰队视图
	pi.registerCommand("dsh-jobs", {
		description: "显示后台任务列表（含 worker 进程的；等价 /jobs 的文本形态）",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const rows = collectRows(registry, owner);
			if (rows.length === 0) {
				ctx.ui.notify("dsh-jobs: 无后台任务", "info");
				return;
			}
			ctx.ui.notify(`dsh-jobs（${rows.length} 项）:\n${textRows(rows)}`, "info");
		},
	});
}
