// jobs-panel.ts — /jobs 的 TUI 面板：看全舰队（主进程 + worker 子进程）的后台任务并操作
//
// 数据两路合并：本进程的任务读 registry（实时、权威），别的进程读共享快照（snapshot.ts，
// 每个进程写自己一份，读方扫目录）。
//
// 取消同样分两种：自己的走 registry.kill()，别人的写 kill 请求文件——目标进程轮询后调
// 它自己的 registry.kill()。为什么不直接发信号：pi 拿不到 job 的 pid（registry 只存任务的
// 观察投影，进程句柄在 provider 内部），跨进程只能请对方自己动手，走正规取消路径状态才不会
// 两边说法不一致。
//
// 键位走公共的 Vim 引擎（lib/vim-select.ts 的 parseVimKey / applyVimKey）：j/k 与方向键移动，
// 支持计数前缀（3j 往下三行），/ 模糊过滤，行头是相对行号——照 nvim 的习惯来，不看提示也能用。
// 因此「取消」不占 k（k 是上移），改用 x。刷新靠面板自带节拍：跨进程状态变化没有事件可订阅。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { applyVimKey, parseVimKey, relativeLineGutter, relativeLineGutterWidth, type VimState } from "../../lib/vim-select.ts";
import { watchJobUpdates } from "../../lib/hub-jobs.ts";
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

/** 列表模式键位提示（详情模式另有一份） */
const LIST_HINT = "[num]j/[num]k 移动 · Enter 详情 · x 取消 · r 刷新 · / 过滤 · Esc 退出";
const DETAIL_HINT = "[num]j/[num]k 换任务 · Enter/Esc 返回列表 · x 取消 · r 刷新 · q 退出";

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

/** 移动光标并夹在合法范围内（空列表返回 0）；面板与测试共用同一份语义 */
export function moveSelection(selected: number, delta: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(length - 1, selected + delta));
}

/** 模糊过滤用的文本：任务 id、命令/描述、来源进程都能命中 */
export function rowSearchText(row: PanelRow): string {
	return [row.record.id, row.record.label, row.owner.label, row.owner.taskId].filter(Boolean).join(" ");
}

/** 按查询词过滤任务行；空查询保持原顺序 */
export function filterRows(rows: PanelRow[], query: string): PanelRow[] {
	if (!query.trim()) return rows.slice();
	return fuzzyFilter(rows, query, rowSearchText);
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

/** 行摘要：`[主] bash-1 running 12s  命令…` */
export function rowText(row: PanelRow, width: number, theme: { fg: (token: string, text: string) => string }): string {
	const ownerTag = row.owner.kind === "main" ? "主" : `w:${row.owner.taskId ?? row.owner.pid}`;
	const head = `${row.record.id} ${row.record.status}${row.record.detail ? `(${row.record.detail})` : ""} ${formatElapsed(row.record.startedAt, row.record.finishedAt)}`;
	const labelRoom = Math.max(12, width - head.length - ownerTag.length - 8);
	return `${theme.fg("muted", `[${ownerTag}]`)} ${theme.fg(statusColor(row.record.status), head)}  ${oneLine(row.record.label, labelRoom)}`;
}

/** 取消结果 → 面板上的一句话 */
function describeCancel(outcome: CancelOutcome, row: PanelRow): string {
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
		let allRows: PanelRow[] = collectRows(registry, owner);
		let state: VimState = { count: null, filterMode: false, query: "" };
		let filtered: PanelRow[] = filterRows(allRows, state.query);
		let selected = 0;
		let detail = false;
		let notice = "";

		let closed = false;
		// hub 加速订阅：在线时收到“快照变了”就立即重读（信号，不是状态）。
		// 取消函数在关闭时调；hub 不在就是 undefined，轮询照旧兜底。
		let unwatch: (() => void) | undefined;
		const close = (): void => {
			if (closed) return;
			closed = true;
			clearInterval(timer);
			unwatch?.();
			finish(undefined);
		};

		/** 重读数据（含过滤）：光标若越界就收到末行，别让它在空列表上悬着 */
		const refreshRows = (): void => {
			if (closed) return;
			allRows = collectRows(registry, owner);
			filtered = filterRows(allRows, state.query);
			selected = moveSelection(selected, 0, filtered.length);
			notice = "";
			tui.requestRender();
		};

		// 节拍刷新：跨进程的状态变化没有廉价的通知通道，先靠轮询保底。
		// 不 unref：面板活着期间正是需要这个定时器（关掉面板会 clearInterval）。
		// hub 在线时下面还会接一条快路，这个节拍降级成兜底（快路漏了也能自己追上）。
		const timer = setInterval(refreshRows, REFRESH_MS);

		// hub 在线时额外接一条快路：收到信号立即重读目录（仍然是读文件，不是拿 payload 当状态）。
		// 订阅失败（hub 没装/没起）就不接，纯轮询——与今天的行为一模一样。
		void watchJobUpdates(() => refreshRows()).then((cancel) => {
			// 面板可能在订阅完成前就关了：关了就直接取消，别留个孤儿订阅
			if (closed) cancel?.();
			else unwatch = cancel;
		});

		const current = (): PanelRow | undefined => filtered[selected];

		/** 计数前缀提示（与 vim-select 一致的呈现：让人看清 3j 会走多远） */
		const countPrefix = (): string => (state.count === null ? "" : `计数 ${state.count} · `);

		const renderList = (width: number): string[] => {
			const lines: string[] = [];
			const activeCount = allRows.filter((r) => !isTerminal(r.record.status)).length;
			const foreignCount = new Set(allRows.filter((r) => !r.live).map((r) => r.owner.pid)).size;
			lines.push(
				theme.fg("accent", theme.bold(`后台任务 · ${allRows.length} 项`))
					+ theme.fg("dim", `（活跃 ${activeCount}${foreignCount > 0 ? ` · 另有 ${foreignCount} 个 worker 进程` : ""}）`),
			);
			if (state.filterMode || state.query !== "") {
				const cursor = state.filterMode ? "▌" : "";
				lines.push(theme.fg("dim", `/ ${state.query}${cursor}`) + theme.fg("dim", state.filterMode ? "（Enter 保留 · Esc 清空）" : ""));
			}
			if (filtered.length === 0) {
				lines.push("");
				lines.push(theme.fg("muted", allRows.length === 0 ? "当前没有后台任务。bash_background 起的任务会出现在这里。" : "（无匹配，退格或 Ctrl-U 改过滤词）"));
				return lines;
			}
			const gutterWidth = relativeLineGutterWidth(filtered.length);
			// 选中行始终在窗口内：窗口跟着光标滚动
			const start = Math.max(0, Math.min(selected - Math.floor(MAX_VISIBLE / 2), filtered.length - MAX_VISIBLE));
			const end = Math.min(filtered.length, start + MAX_VISIBLE);
			for (let i = start; i < end; i++) {
				const row = filtered[i];
				const gutterText = relativeLineGutter(i, selected, gutterWidth);
				// 光标行的行号交给选中色，其余暗一档（nvim 的 LineNr 观感）
				const gutter = i === selected ? theme.fg("accent", gutterText) : theme.fg("dim", gutterText);
				const marker = i === selected ? theme.fg("accent", "❯ ") : "  ";
				const body = rowText(row, Math.max(20, width - gutterWidth - 4), theme);
				lines.push(truncateToWidth(`${gutter} ${marker}${body}`, width));
			}
			if (filtered.length > MAX_VISIBLE) {
				lines.push(theme.fg("dim", `  … ${filtered.length} 项中显示第 ${start + 1}-${end} 项`));
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

		const cancelCurrent = (): void => {
			const row = current();
			if (!row) return;
			if (isTerminal(row.record.status)) {
				notice = `${row.record.id} 已经结束（${row.record.status}），不用取消`;
			} else {
				notice = describeCancel(cancelRow(registry, owner, row), row);
			}
			refreshRows();
		};

		const handle = (data: string): void => {
			const key = parseVimKey(data);
			if (key.type === "ignore") return;
			const result = applyVimKey(state, key);
			state = result.state;

			switch (result.effect.type) {
				case "move": {
					selected = moveSelection(selected, result.effect.delta, filtered.length);
					tui.requestRender();
					return;
				}
				case "confirm": {
					if (filtered.length > 0) detail = !detail;
					tui.requestRender();
					return;
				}
				case "cancel": {
					// 过滤中 Esc 是「清空过滤」（引擎已处理）；详情里 Esc 回列表；列表里才退出
					if (detail) {
						detail = false;
						tui.requestRender();
						return;
					}
					close();
					return;
				}
				case "refilter": {
					filtered = filterRows(allRows, state.query);
					selected = 0;
					tui.requestRender();
					return;
				}
				default:
					break;
			}

			// 引擎不认的单字符键（x / r / q）：只在正常模式下生效，
			// 过滤模式里它们是普通字符，会进查询词（引擎已处理）
			if (key.type === "char" && !state.filterMode && !/^[0-9]$/.test(key.value)) {
				switch (key.value) {
					case "x":
						cancelCurrent();
						return;
					case "r":
						refreshRows();
						return;
					case "q":
						if (detail) detail = false;
						else close();
						tui.requestRender();
						return;
					default:
						// 不认识的字母：清掉计数前缀，免得下次 j 按老计数跳
						state = { ...state, count: null };
						tui.requestRender();
						return;
				}
			}
			tui.requestRender();
		};

		return {
			render(width: number): string[] {
				const container = new Container();
				container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
				const body = detail ? renderDetail(width) : renderList(width);
				// 列表模式的标题行已经带了强调色，不再叠加
				for (const line of body) container.addChild(new Text(line, 1, 0));
				if (notice !== "") container.addChild(new Text(theme.fg("warning", notice), 1, 0));
				const hint = detail ? DETAIL_HINT : LIST_HINT;
				container.addChild(new Text(theme.fg("dim", countPrefix() + hint), 1, 0));
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
