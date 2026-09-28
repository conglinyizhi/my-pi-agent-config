// paths-command.ts — /sandbox:paths（别名 /sandbox:trusted）：三类沙箱路径配置的列出 / 添加 / 移除
//
// 三类配置 = sandbox-paths.json 的 trustedProgramDirs / allowDirs / blockDirs（见 paths-config.ts）。
//
// 两个入口，同一个 handler：
//   1 GUI（yad + DISPLAY）：开窗口表单，列表 / 输入 / 确认都走 yad
//   2 TUI 回退：yad 不存在、没有 DISPLAY、或者窗口拉不起来时，改用 ctx.ui 的
//     notify / select / input / confirm 逐项提问（少一次成型的表单，功能不缺）
//
// 纯逻辑（解析子命令、格式化、目标解析）与 handler 分离，便于单测；yad runner 与 ctx.ui 都可注入。
// 落盘一律走 paths.ts / trusted.ts 的现成函数，本文件不直接写 JSON。
//
// trustedProgramDirs 是**人类的权限**：add 前必定弹一次确认，措辞里写明「会放宽对 AI 命令的审核」。
// 本文件不做任何预填，也不替人调 add。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	PATH_LISTS,
	addEntry,
	confirmBody,
	confirmTitle,
	formatPathsList,
	listKeyWords,
	listMeta,
	loadAllLists,
	loadList,
	parseListKey,
	removeEntry,
	sandboxPathsFile,
	validateEntry,
	type PathListKey,
} from "./paths-config.ts";
import { resolveRemoveTarget } from "./workspace-command.ts";
import {
	findYadBinary,
	hasDisplay,
	realYadRunner,
	yadInputValue,
	yadPickRow,
	yadText,
	type YadRunner,
	type YadSession,
} from "./yad-paths.ts";

/** 命令只用得到的 UI 子集（no-UI 环境下 pi 注入全 no-op stub，confirm 恒 false） */
export interface PathsCommandContext {
	ui: Pick<ExtensionCommandContext["ui"], "notify" | "select" | "input" | "confirm">;
	hasUI: boolean;
	signal?: AbortSignal;
}

/** 可注入的依赖：测试用假 runner（绝不真拉 yad 窗口） */
export interface PathsCommandDeps {
	/** yad 进程 runner（默认 realYadRunner） */
	runner?: YadRunner;
	/** yad 二进制查找（默认扫 PATH） */
	findYad?: (env: NodeJS.ProcessEnv) => string | null;
	/** 图形环境判定（默认看 DISPLAY / WAYLAND_DISPLAY） */
	hasDisplay?: (env: NodeJS.ProcessEnv) => boolean;
	env?: NodeJS.ProcessEnv;
}

const CANCEL = "❌ 取消";

/** 用法文案（/sandbox:paths help、参数错误、无参数时使用） */
export const PATHS_USAGE = [
	"用法：",
	"  /sandbox:paths                                     列出三类配置（有图形时开 yad 窗口）",
	"  /sandbox:paths list                                只列，不进入问答",
	"  /sandbox:paths add trusted <目录>                  加入可信程序目录（人类的权限，写盘前确认后果）",
	"  /sandbox:paths add allow <目录>                    加入副工作区（长期可写根）",
	"  /sandbox:paths add block <目录>                    加入黑名单",
	"  /sandbox:paths remove <trusted|allow|block> <目录|序号>  移除",
	"  /sandbox:paths help                                本帮助",
	"",
	`类型词：${listKeyWords().join(" | ")}（也可写全名 trustedProgramDirs / allowDirs / blockDirs）`,
	"图形：有 yad 且有 DISPLAY 时用窗口；否则回退逐项提问，功能一致。",
].join("\n");

export type PathsActionKind = "list" | "add" | "remove" | "help";

export interface PathsAction {
	kind: PathsActionKind;
	/** 配置类型；缺省表示走交互选择 */
	key?: PathListKey;
	/** add / remove 的目标（目录或序号）；为空表示走交互提问 */
	target: string;
	/** 无参数进入：列出 + help + 交互菜单 */
	withHelp?: boolean;
	/** 无法识别的词（子命令或类型词） */
	unknown?: string;
	/** 裸路径：缺配置类型 */
	needKind?: string;
}

/** 类型词 + 目标 的解析（目标可含空格，不切分） */
function parseTyped(kind: "add" | "remove", rest: string): PathsAction {
	if (!rest) return { kind, target: "" };
	const m = /^(\S+)\s*([\s\S]*)$/.exec(rest);
	const word = m?.[1] ?? "";
	const target = (m?.[2] ?? "").trim();
	const key = parseListKey(word);
	// 类型词必须显式给出：裸路径不猜（误加到 trusted 会放宽审核，代价不对称）
	if (!key) return { kind, target: "", unknown: word };
	return { kind, key, target };
}

/** 解析子命令。裸路径不视作 add：类型不明确时一律要求写清楚 */
export function parsePathsArgs(args: string): PathsAction {
	const raw = (args ?? "").trim();
	if (!raw) return { kind: "list", target: "", withHelp: true };

	const m = /^(\S+)\s*([\s\S]*)$/.exec(raw);
	const word = (m?.[1] ?? raw).toLowerCase();
	const rest = (m?.[2] ?? "").trim();

	switch (word) {
		case "list":
		case "ls":
		case "l":
		case "show":
			return { kind: "list", target: "" };
		case "help":
		case "-h":
		case "--help":
		case "?":
			return { kind: "help", target: "" };
		case "add":
		case "a":
		case "put":
			return parseTyped("add", rest);
		case "remove":
		case "rm":
		case "del":
		case "delete":
		case "pop":
			return parseTyped("remove", rest);
		default:
			if (word.startsWith("/") || word.startsWith("~") || word.startsWith(".")) {
				return { kind: "help", target: "", needKind: raw };
			}
			return { kind: "help", target: "", unknown: word };
	}
}

// ═══════════════════════════════════════════════════
// 文案
// ═══════════════════════════════════════════════════

/** 列表 + 用法（TUI notify 与 yad 窗口共用） */
export function overviewText(): string {
	return `${formatPathsList(loadAllLists(), sandboxPathsFile())}\n\n${PATHS_USAGE}`;
}

function addDone(key: PathListKey, dir: string): string {
	const meta = listMeta(key);
	return `已添加${meta.label}：${dir}（当前 ${loadList(key).length} 个）\n${meta.afterAdd}`;
}

function removeDone(key: PathListKey, dir: string): string {
	const meta = listMeta(key);
	return `已移除${meta.label}：${dir}（剩余 ${loadList(key).length} 个）\n${meta.afterRemove}`;
}

function notifyHelp(ctx: PathsCommandContext, action: PathsAction): void {
	let prefix = "";
	if (action.unknown) {
		prefix = `无法识别「${action.unknown}」：类型词要显式写出来（${listKeyWords().join(" | ")}）\n`;
	} else if (action.needKind) {
		prefix = `「${action.needKind}」缺少配置类型：请写成 /sandbox:paths add <${listKeyWords().join("|")}> <目录>\n`;
	}
	ctx.ui.notify(prefix ? `${prefix}\n${PATHS_USAGE}` : PATHS_USAGE, prefix ? "warning" : "info");
}

// ═══════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════

/** /sandbox:paths 处理器：列出 / 添加 / 移除三类配置（yad → TUI 回退） */
export async function pathsCommandHandler(
	args: string,
	ctx: PathsCommandContext,
	deps: PathsCommandDeps = {},
): Promise<void> {
	const action = parsePathsArgs(args);
	if (action.kind === "help") {
		notifyHelp(ctx, action);
		return;
	}

	const session = resolveYad(ctx, deps);
	if (session) {
		const result = await runYadFlow(action, ctx, session);
		if (result.kind !== "unavailable") return;
		ctx.ui.notify(`yad 窗口拉不起来（${result.detail}），改用逐项提问`, "warning");
	} else if (ctx.hasUI && action.kind !== "list") {
		// 有界面但没有图形：说明一句为什么没开窗，避免以为是命令坏了
		const why = !(deps.findYad ?? findYadBinary)(deps.env ?? process.env)
			? "未找到 yad"
			: "当前会话没有 DISPLAY / WAYLAND_DISPLAY";
		ctx.ui.notify(`图形界面不可用（${why}），改用逐项提问`, "info");
	}

	await runTuiFlow(action, ctx);
}

/** 图形通道是否可用：有界面 + 找到 yad + 有 DISPLAY 才开窗 */
function resolveYad(ctx: PathsCommandContext, deps: PathsCommandDeps): YadSession | null {
	if (!ctx.hasUI) return null;
	const env = deps.env ?? process.env;
	const bin = (deps.findYad ?? findYadBinary)(env);
	if (!bin) return null;
	if (!(deps.hasDisplay ?? hasDisplay)(env)) return null;
	return { bin, env, runner: deps.runner ?? realYadRunner, signal: ctx.signal };
}

// ── yad（图形）通道 ─────────────────────────────────

/** 菜单行：cli + 动作 → 说明（第一列是稳定 token，用来认选中行） */
function menuRows(): { rows: string[][]; actions: PathsAction[] } {
	const rows: string[][] = [];
	const actions: PathsAction[] = [];
	for (const meta of PATH_LISTS) {
		rows.push([`${meta.cli}-add`, `把目录加入${meta.label}${meta.humanOnly ? "（会放宽对 AI 命令的审核）" : ""}`]);
		actions.push({ kind: "add", key: meta.key, target: "" });
		rows.push([`${meta.cli}-remove`, `从${meta.label}移除`]);
		actions.push({ kind: "remove", key: meta.key, target: "" });
	}
	return { rows, actions };
}

type YadFlowResult = { kind: "done" } | { kind: "unavailable"; detail: string };

async function runYadFlow(
	action: PathsAction,
	ctx: PathsCommandContext,
	session: YadSession,
): Promise<YadFlowResult> {
	const file = sandboxPathsFile();
	let act = action;

	// 无参数：菜单（三类现状 + 六个动作）
	if (act.kind === "list" && act.withHelp) {
		const menu = menuRows();
		const picked = await yadPickRow(session, {
			title: "沙箱路径配置 · pi",
			text: `${formatPathsList(loadAllLists(), file)}\n\n存储：${file}\n选一行按「执行」。`,
			headers: ["操作", "说明"],
			rows: menu.rows,
			okLabel: "执行",
			cancelLabel: "关闭",
		});
		if (picked.kind === "unavailable") return picked;
		if (picked.kind === "cancel") {
			ctx.ui.notify("已取消", "info");
			return { kind: "done" };
		}
		const next = menu.actions[picked.index];
		if (!next) {
			ctx.ui.notify("选择无效", "error");
			return { kind: "done" };
		}
		act = next;
	} else if (act.kind === "list") {
		// 显式 list：只展示
		const shown = await yadText(session, {
			title: "沙箱路径配置 · pi",
			text: overviewText(),
			okLabel: "关闭",
		});
		return shown.kind === "unavailable" ? shown : { kind: "done" };
	}

	const key = act.key;
	if (!key) {
		// 参数里没给类型：菜单里选一个（与 TUI 的逐项提问等价）
		const menu = menuRows();
		const kind = act.kind;
		const rows = menu.rows
			.map((r, i) => ({ r, a: menu.actions[i] }))
			.filter((x) => x.a?.kind === kind);
		const picked = await yadPickRow(session, {
			title: `${kind === "add" ? "添加" : "移除"} · 选配置类型`,
			text: `${formatPathsList(loadAllLists(), file)}`,
			headers: ["操作", "说明"],
			rows: rows.map((x) => x.r),
			okLabel: "继续",
			cancelLabel: "取消",
		});
		if (picked.kind === "unavailable") return picked;
		if (picked.kind === "cancel") {
			ctx.ui.notify("已取消", "info");
			return { kind: "done" };
		}
		const chosen = rows[picked.index]?.a.key;
		if (!chosen) {
			ctx.ui.notify("选择无效", "error");
			return { kind: "done" };
		}
		return act.kind === "add"
			? yadAdd(act.target, chosen, ctx, session)
			: yadRemove(act.target, chosen, ctx, session);
	}

	return act.kind === "add"
		? yadAdd(act.target, key, ctx, session)
		: yadRemove(act.target, key, ctx, session);
}

async function yadAdd(
	target: string,
	key: PathListKey,
	ctx: PathsCommandContext,
	session: YadSession,
): Promise<YadFlowResult> {
	const meta = listMeta(key);
	const file = sandboxPathsFile();

	let raw = target.trim();
	if (!raw) {
		const typed = await yadInputValue(session, {
			title: `加入${meta.label}`,
			text: `${meta.label} · ${meta.summary}\n${meta.points.join("\n")}`,
			label: "目录（支持 ~ 开头）",
			value: "~/",
			okLabel: "下一步",
		});
		if (typed.kind === "unavailable") return typed;
		if (typed.kind === "cancel") {
			ctx.ui.notify("已取消", "info");
			return { kind: "done" };
		}
		raw = typed.value;
	}

	const check = validateEntry(key, raw);
	if (!check.ok) {
		ctx.ui.notify(`不能添加：${check.reason}`, "error");
		await infoWindow(session, `不能添加${meta.label}`, check.reason);
		return { kind: "done" };
	}
	const dir = check.dir;

	const current = loadList(key);
	if (current.includes(dir)) {
		ctx.ui.notify(`已在${meta.label}列表里：${dir}（当前 ${current.length} 个）`, "info");
		await infoWindow(session, `已在${meta.label}列表里`, `${dir}\n当前 ${current.length} 个，没有重复写入。`);
		return { kind: "done" };
	}

	// 人类的权限：写盘前必须有一句写明后果的确认
	const agreed = await yadText(session, {
		title: confirmTitle(key, dir),
		text: confirmBody(key, dir, file),
		okLabel: "确认添加",
		cancelLabel: "取消",
	});
	if (agreed.kind === "unavailable") return agreed;
	if (agreed.kind === "cancel") {
		ctx.ui.notify("已取消，未写入", "info");
		return { kind: "done" };
	}

	try {
		if (!addEntry(key, dir)) {
			ctx.ui.notify(`写入失败（已存在或目录无效）：${dir}`, "warning");
			return { kind: "done" };
		}
	} catch (err) {
		ctx.ui.notify(`写入失败：${err instanceof Error ? err.message : String(err)}`, "error");
		return { kind: "done" };
	}
	ctx.ui.notify(addDone(key, dir), "info");
	return { kind: "done" };
}

async function yadRemove(
	target: string,
	key: PathListKey,
	ctx: PathsCommandContext,
	session: YadSession,
): Promise<YadFlowResult> {
	const meta = listMeta(key);
	const dirs = loadList(key);
	if (dirs.length === 0) {
		ctx.ui.notify(`${meta.label}为空，无需移除`, "info");
		await infoWindow(session, `${meta.label}为空`, "当前没有条目可以移除。");
		return { kind: "done" };
	}

	let arg = target.trim();
	if (!arg) {
		const picked = await yadPickRow(session, {
			title: `移除${meta.label}`,
			text: `${meta.summary}\n${meta.points.join("\n")}`,
			headers: ["#", "目录"],
			rows: dirs.map((d, i) => [String(i + 1), d]),
			okLabel: "移除",
			cancelLabel: "取消",
		});
		if (picked.kind === "unavailable") return picked;
		if (picked.kind === "cancel") {
			ctx.ui.notify("已取消", "info");
			return { kind: "done" };
		}
		arg = dirs[picked.index] ?? "";
		if (!arg) {
			ctx.ui.notify("选择无效", "error");
			return { kind: "done" };
		}
	}

	const resolved = resolveRemoveTarget(arg, dirs);
	if (!resolved.ok) {
		ctx.ui.notify(`不能移除：${resolved.reason}`, "error");
		await infoWindow(session, `不能移除${meta.label}`, resolved.reason);
		return { kind: "done" };
	}

	try {
		if (!removeEntry(key, resolved.dir)) {
			ctx.ui.notify(`移除失败（不在列表里）：${resolved.dir}`, "warning");
			return { kind: "done" };
		}
	} catch (err) {
		ctx.ui.notify(`写入失败：${err instanceof Error ? err.message : String(err)}`, "error");
		return { kind: "done" };
	}
	ctx.ui.notify(removeDone(key, resolved.dir), "info");
	return { kind: "done" };
}

/** 出错 / 无事可做时在窗口里也说一句（跑 yad 的路子里人未必看 TUI 通知） */
async function infoWindow(session: YadSession, title: string, text: string): Promise<void> {
	await yadText(session, { title, text, okLabel: "知道了" });
}

// ── TUI（回退）通道 ─────────────────────────────────

async function runTuiFlow(action: PathsAction, ctx: PathsCommandContext): Promise<void> {
	const opts = ctx.signal ? { signal: ctx.signal } : undefined;
	const file = sandboxPathsFile();
	let act = action;

	if (act.kind === "list") {
		ctx.ui.notify(overviewText(), "info");
		if (!act.withHelp) return; // 显式 list：只看
		if (!ctx.hasUI) return; // 无交互界面：这份文案就是全部（现状 + 用法）
		const pickedKey = await pickKey(ctx, opts);
		if (!pickedKey) {
			ctx.ui.notify("已取消", "info");
			return;
		}
		const op = await ctx.ui.select(`对「${listMeta(pickedKey).label}」做什么？`, ["添加", "移除", CANCEL], opts);
		if (!op || op.startsWith("❌")) {
			ctx.ui.notify("已取消", "info");
			return;
		}
		act = { kind: op === "添加" ? "add" : "remove", key: pickedKey, target: "" };
	}

	let key = act.key;
	if (!key) {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`无交互界面，请带参数：/sandbox:paths ${act.kind} <${listKeyWords().join("|")}> <目录>\n${PATHS_USAGE}`,
				"error",
			);
			return;
		}
		key = await pickKey(ctx, opts);
		if (!key) {
			ctx.ui.notify("已取消", "info");
			return;
		}
	}

	if (act.kind === "add") {
		await tuiAdd(act.target, key, ctx, opts);
		return;
	}
	await tuiRemove(act.target, key, ctx, opts);
}

/** 逐项提问里的类型选择 */
async function pickKey(
	ctx: PathsCommandContext,
	opts: { signal?: AbortSignal } | undefined,
): Promise<PathListKey | undefined> {
	const options = PATH_LISTS.map((m) => `${m.cli} — ${m.label}（当前 ${loadList(m.key).length} 个）`);
	const choice = await ctx.ui.select("改哪一类配置？", [...options, CANCEL], opts);
	if (!choice || choice.startsWith("❌")) return undefined;
	return PATH_LISTS[options.indexOf(choice)]?.key;
}

async function tuiAdd(
	target: string,
	key: PathListKey,
	ctx: PathsCommandContext,
	opts: { signal?: AbortSignal } | undefined,
): Promise<void> {
	const meta = listMeta(key);
	let raw = target.trim();
	if (!raw) {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`无交互界面，请带参数：/sandbox:paths add ${meta.cli} <目录>\n${PATHS_USAGE}`,
				"error",
			);
			return;
		}
		const typed = await ctx.ui.input(
			`${meta.label} · 要加入的目录（支持 ~ 开头）`,
			meta.key === "allowDirs" ? "~/work/scratch" : "~/.pi/runtime",
			opts,
		);
		raw = (typed ?? "").trim();
		if (!raw) {
			ctx.ui.notify("已取消", "info");
			return;
		}
	}

	const check = validateEntry(key, raw);
	if (!check.ok) {
		ctx.ui.notify(`不能添加：${check.reason}`, "error");
		return;
	}
	const dir = check.dir;

	const current = loadList(key);
	if (current.includes(dir)) {
		ctx.ui.notify(`已在${meta.label}列表里：${dir}（当前 ${current.length} 个）`, "info");
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(
			`无交互界面，无法二次确认，未写入：${dir}\n请改用带界面的会话，或手改 ${sandboxPathsFile()}`,
			"error",
		);
		return;
	}

	// trustedProgramDirs 是人类的权限：确认框标题与正文都写明「会放宽对 AI 命令的审核」
	const agreed = await ctx.ui.confirm(confirmTitle(key, dir), confirmBody(key, dir, sandboxPathsFile()), opts);
	if (!agreed) {
		ctx.ui.notify("已取消，未写入", "info");
		return;
	}

	try {
		if (!addEntry(key, dir)) {
			ctx.ui.notify(`写入失败（已存在或目录无效）：${dir}`, "warning");
			return;
		}
	} catch (err) {
		ctx.ui.notify(`写入失败：${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	ctx.ui.notify(addDone(key, dir), "info");
}

async function tuiRemove(
	target: string,
	key: PathListKey,
	ctx: PathsCommandContext,
	opts: { signal?: AbortSignal } | undefined,
): Promise<void> {
	const meta = listMeta(key);
	const dirs = loadList(key);
	if (dirs.length === 0) {
		ctx.ui.notify(`${meta.label}为空，无需移除`, "info");
		return;
	}

	let arg = target.trim();
	if (!arg) {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`无交互界面，请带参数：/sandbox:paths remove ${meta.cli} <目录|序号>\n${PATHS_USAGE}`,
				"error",
			);
			return;
		}
		const options = dirs.map((d, i) => `${i + 1}. ${d}`);
		const choice = await ctx.ui.select(`当前${meta.label}（${dirs.length} 个），选一个移除：`, [...options, CANCEL], opts);
		if (!choice || choice.startsWith("❌")) {
			ctx.ui.notify("已取消", "info");
			return;
		}
		const picked = dirs[options.indexOf(choice)];
		if (!picked) {
			ctx.ui.notify("选择无效", "error");
			return;
		}
		arg = picked;
	}

	const resolved = resolveRemoveTarget(arg, dirs);
	if (!resolved.ok) {
		ctx.ui.notify(`不能移除：${resolved.reason}`, "error");
		return;
	}

	try {
		if (!removeEntry(key, resolved.dir)) {
			ctx.ui.notify(`移除失败（不在列表里）：${resolved.dir}`, "warning");
			return;
		}
	} catch (err) {
		ctx.ui.notify(`写入失败：${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	ctx.ui.notify(removeDone(key, resolved.dir), "info");
}

/** TUI 参数补全：子命令 / 类型词 / 现有条目 */
export function pathsArgumentCompletions(prefix: string): { value: string; label: string }[] {
	const p = (prefix ?? "").trimStart();
	const spaceAt = p.search(/\s/);
	if (spaceAt < 0) {
		return ["list", "add", "remove", "help"]
			.filter((c) => c.startsWith(p.toLowerCase()))
			.map((c) => ({ value: c, label: c }));
	}
	const word = p.slice(0, spaceAt).toLowerCase();
	if (!["add", "a", "put", "remove", "rm", "del", "delete", "pop"].includes(word)) return [];
	const rest = p.slice(spaceAt + 1);
	const head = rest.split(/\s+/)[0] ?? "";
	if (!/\s/.test(rest)) {
		return listKeyWords()
			.filter((c) => c.startsWith(head.toLowerCase()))
			.map((c) => ({ value: `${p.slice(0, spaceAt)} ${c}`, label: c }));
	}
	const key = parseListKey(head);
	if (!key) return [];
	const tail = rest.slice(head.length).trimStart();
	return loadList(key)
		.filter((d) => d.startsWith(tail))
		.map((d) => ({ value: `${p.slice(0, spaceAt)} ${head} ${d}`, label: d }));
}
