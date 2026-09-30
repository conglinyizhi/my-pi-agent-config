// jobs-panel.ts — /jobs 的 TUI 面板：看全舰队（主进程 + worker 子进程）的后台任务，按 k 取消
//
// 数据两路合并：本进程的任务读 registry（实时、权威），别的进程读共享快照（snapshot.ts，
// 每个进程写自己一份，读方扫目录）。
//
// 取消同样分两种：自己的走 registry.kill()，别人的写 kill 请求文件——目标进程轮询后调
// 它自己的 registry.kill()。为什么不直接发信号：pi 拿不到 job 的 pid（registry 只存任务的
// 观察投影，进程句柄在 provider 内部），跨进程只能请对方自己动手，走正规取消路径状态才不会
// 两边说法不一致。
//
// 刷新靠面板自带节拍：跨进程状态变化没有事件可订阅，只能轮询（REFRESH_MS）。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { JobRegistry } from "./registry.ts";
import { readAllSnapshots, writeKillRequest, type JobRecord, type OwnerInfo } from "./snapshot.ts";

/** 面板刷新节拍（毫秒）：跨进程状态没有事件通道，只能轮询 */
export const REFRESH_MS = 1000;
/** 输出预览保留的尾部字符数（快照写方同样按这个量级截断） */
export const TAIL_CHARS = 4000;
/** 列表窗口一次显示多少行（超出的靠滚动） */
const MAX_VISIBLE = 12;
/** 详情模式显示输出尾部多少行 */
const DETAIL_LINES = 14;

/** 面板里的一行 = 某个进程的一条任务 */
export interface PanelRow {
	owner: OwnerInfo;
	record: JobRecord;
	/** true = 本进程 registry 的实时数据；false = 共享快照（可能滞后一个节拍） */
	live: boolean;
}

export type CancelOutcome = "local-requested" | "local-finished" | "remote-requested" | "failed";

function isTerminal(status: string): boolean {
	return status === "completed" || status === "killed" || status === "failed";
}

/** 取尾部字符（快照与详情都只要尾部：完整输出在 agent 那边用 job_output 读） */
export function tailOf(text: string): string {
	return text.length > TAIL_CHARS ? text.slice(text.length - TAIL_CHARS) : text;
}

/** 本进程的任务行：状态取 registry 实时值，输出尾部走 peekOutput（不偷 agent 的增量） */
export function localRows(registry: JobRegistry, owner: OwnerInfo): PanelRow[] {
	return registry.list().map((snap) => ({
		owner,
		live: true,
		record: {
			id: snap.id,
			kind: snap.kind,
			label: snap.label,
			status: snap.status,
			detail: snap.detail,
			startedAt: snap.startedAt,
			finishedAt: snap.finishedAt,
			tail: tailOf(registry.peekOutput(snap.id)),
		},
	}));
}

/**
 * 合并全舰队的任务行。
 * 同一个 pid 以本地 registry 为准：自己那份快照是给自己看的，没必要读回来。
 * 排序：活跃任务在前（先起的在前，符合启动顺序的直觉），终态在后（新结束的在前）。
 */
export function collectRows(registry: JobRegistry, owner: OwnerInfo): PanelRow[] {
	const rows = localRows(registry, owner);
	for (const snapshot of readAllSnapshots().owners) {
		if (snapshot.owner.pid === owner.pid) continue;
		for (const record of snapshot.jobs) rows.push({ owner: snapshot.owner, record, live: false });
	}
	return rows.sort((a, b) => {
		const aActive = !isTerminal(a.record.status);
		const bActive = !isTerminal(b.record.status);
		if (aActive !== bActive) return aActive ? -1 : 1;
		if (aActive) return a.record.startedAt - b.record.startedAt;
		return (b.record.finishedAt ?? b.record.startedAt) - (a.record.finishedAt ?? a.record.startedAt);
	});
}

/** 取消一行：自己的走 registry，别人的投 kill 请求 */
export function cancelRow(registry: JobRegistry, owner: OwnerInfo, row: PanelRow): CancelOutcome {
	if (row.owner.pid === owner.pid) {
		try {
			return registry.kill(row.record.id) === "requested" ? "local-requested" : "local-finished";
		} catch {
			return "failed"; // 任务在两次刷新之间结算了：不算错误，下一拍就消失
		}
	}
	try {
		writeKillRequest(row.owner, row.record.id);
		return "remote-requested";
	} catch {
		return "failed";
	}
}

/** 状态 → 主题色（running 用 accent，终态按成败分色） */
function statusColor(status: string): "accent" | "success" | "error" | "muted" | "warning" {
	if (status === "running") return "accent";
	if (status === "stopping") return "warning";
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	return "muted"; // killed
}

function formatElapsed(startedAt: number, finishedAt?: number): string {
	const end = finishedAt ?? Date.now();
	const total = Math.max(0, Math.round((end - startedAt) / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes === 0) return `${seconds}s`;
	const hours = Math.floor(minutes / 60);
	return hours === 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** 单行标签：命令/描述可能很长，压成一行（换行会破坏列表的逐行布局） */
function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 行摘要：`[主进程] bash-1  running 12s  命令…` */
export function rowText(row: PanelRow, width: number, theme: { fg: (token: string, text: string) => string }): string {
	const ownerTag = row.owner.kind === "main" ? "主" : `w:${row.owner.taskId ?? row.owner.pid}`;
	const head = `${row.record.id} ${row.record.status}${row.record.detail ? `(${row.record.detail})` : ""} ${formatElapsed(row.record.startedAt, row.record.finishedAt)}`;
	const labelRoom = Math.max(12, width - head.length - ownerTag.length - 8);
	return `${theme.fg("muted", `[${ownerTag}]`)} ${theme.fg(statusColor(row.record.status), head)}  ${oneLine(row.record.label, labelRoom)}`;
}

/**
 * 打开面板。调用前应先确认 ctx.mode === "tui"：custom() 在非交互模式没有终端可画。
 * 面板每次刷新都重读 registry 与快照目录，所以它能同时看到「我正在跑的任务」与
 * 「worker 那边刚起/刚结束的任务」。
 */
export async function showJobsPanel(
	registry: JobRegistry,
	owner: OwnerInfo,
	ctx: ExtensionCommandContext,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, finish) => {
		let rows: PanelRow[] = collectRows(registry, owner);
		let selected = 0;
		let detail = false;
		let notice = "";

		let closed = false;
		const close = (): void => {
			if (closed) return;
			closed = true;
			clearInterval(timer);
			finish(undefined);
		};

		const refresh = (): void => {
			if (closed) return;
			rows = collectRows(registry, owner);
			if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
			notice = "";
			tui.requestRender();
		};

		// 节拍刷新：跨进程的状态变化没有事件可订阅，只能轮询。
		// unref 不设：面板活着期间正是需要这个定时器（关掉面板会 clearInterval）。
		const timer = setInterval(refresh, REFRESH_MS);

		const current = (): PanelRow | undefined => rows[selected];

		const renderList = (width: number): string[] => {
			const lines: string[] = [];
			const activeCount = rows.filter((r) => !isTerminal(r.record.status)).length;
			const foreignCount = new Set(rows.filter((r) => !r.live).map((r) => r.owner.pid)).size;
			lines.push(
				theme.fg("accent", theme.bold(`后台任务 · ${rows.length} 项`))
					+ theme.fg("dim", `（活跃 ${activeCount}${foreignCount > 0 ? ` · 另有 ${foreignCount} 个 worker 进程` : ""}）`),
			);
			if (rows.length === 0) {
				lines.push("");
				lines.push(theme.fg("muted", "当前没有后台任务。bash_background 起的任务会出现在这里。"));
			} else {
				// 选中行始终在窗口内：窗口跟着光标滚动
				const start = Math.max(0, Math.min(selected - Math.floor(MAX_VISIBLE / 2), rows.length - MAX_VISIBLE));
				const end = Math.min(rows.length, start + MAX_VISIBLE);
				for (let i = start; i < end; i++) {
					const row = rows[i];
					const marker = i === selected ? theme.fg("accent", "❯ ") : "  ";
					const body = rowText(row, width - 2, theme);
					lines.push(i === selected ? theme.bold(marker + body) : marker + body);
				}
				if (rows.length > MAX_VISIBLE) {
					lines.push(theme.fg("dim", `  … ${rows.length} 项中显示第 ${start + 1}-${end} 项`));
				}
			}
			return lines;
		};

		const renderDetail = (width: number): string[] => {
			const row = current();
			if (!row) return [theme.fg("muted", "任务已消失（刷新后返回列表）")];
			const lines: string[] = [];
			lines.push(theme.fg("accent", theme.bold(row.record.id)) + theme.fg("dim", ` · ${row.owner.label} · pid ${row.owner.pid}`));
			lines.push(theme.fg(statusColor(row.record.status), `${row.record.status}${row.record.detail ? ` (${row.record.detail})` : ""} · ${formatElapsed(row.record.startedAt, row.record.finishedAt)}`));
			lines.push(theme.fg("dim", oneLine(row.record.label, width)));
			lines.push("");
			const tail = (row.record.tail ?? "").replace(/\n+$/, "");
			const tailLines = tail === "" ? [] : tail.split("\n");
			const shown = tailLines.slice(-DETAIL_LINES);
			if (shown.length === 0) {
				lines.push(theme.fg("muted", "（暂无输出）"));
			} else {
				if (tailLines.length > shown.length) lines.push(theme.fg("dim", `… 只显示最后 ${shown.length} 行（完整输出用 job_output 读）`));
				for (const line of shown) lines.push(theme.fg("toolOutput", line));
			}
			return lines.map((line) => truncateToWidth(line, width));
		};

		const handle = (data: string): void => {
			if (matchesKey(data, Key.escape) || data === "q") {
				if (detail) {
					detail = false;
					tui.requestRender();
					return;
				}
				close();
				return;
			}
			if (matchesKey(data, Key.up)) {
				if (detail) return;
				selected = Math.max(0, selected - 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (detail) return;
				selected = Math.min(rows.length - 1, selected + 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (rows.length === 0) return;
				detail = !detail;
				tui.requestRender();
				return;
			}
			if (data === "k") {
				const row = current();
				if (!row) return;
				if (isTerminal(row.record.status)) {
					notice = `${row.record.id} 已经结束（${row.record.status}），不用取消`;
				} else {
					const outcome = cancelRow(registry, owner, row);
					notice =
						outcome === "local-requested" ? `已请求取消 ${row.record.id}`
							: outcome === "local-finished" ? `${row.record.id} 已结束，不用取消`
								: outcome === "remote-requested" ? `已向 ${row.owner.label} 发出取消请求（对方下一拍处理）`
									: `取消 ${row.record.id} 失败（对象可能已退出）`;
				}
				refresh();
				return;
			}
			if (data === "r") {
				refresh();
			}
		};

		return {
			render(width: number): string[] {
				const container = new Container();
				container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
				const body = detail ? renderDetail(width) : renderList(width);
				for (const line of body) {
					container.addChild(new Text(line, 1, 0));
				}
				if (notice !== "") container.addChild(new Text(theme.fg("warning", notice), 1, 0));
				const footer = detail
					? "Esc/Q 返回列表 · r 刷新"
					: "↑↓ 选择 · Enter 详情 · k 取消 · r 刷新 · Esc/Q 退出";
				container.addChild(new Text(theme.fg("dim", footer), 1, 0));
				container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
				return container.render(width);
			},
			invalidate(): void {
				/* 无缓存：每帧现算（任务数少，成本可忽略） */
			},
			handleInput(data: string): void {
				handle(data);
			},
		};
	});
}
