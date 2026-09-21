// workspace-command.ts — /sandbox:workspaces：副工作区（持久 allowDirs）的列出 / 添加 / 移除
//
// 副工作区 = sandbox-paths.json 的 allowDirs：长期可写根（普通 bash 常驻 --rw），
// 同时是 sandbox-allow 的信任根（write-paths 完全落在其中可免审批）。
//
// GUI 侧的目录授权是另一路实现；本命令是 TUI 回退时唯一能管理副工作区的手段，
// 因此只依赖 ctx.ui 的 notify / select / input / confirm（TUI 与 RPC 都有），
// 不碰 GUI 窗口，也不需要网络能力。
//
// 纯逻辑（解析子命令、目录校验、列表格式化、序号解析）与 handler 分离，便于单测。
// 落盘一律走 paths.ts 的 addAllowDir / removeAllowDir，本文件不直接写 JSON。

import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { addAllowDir, loadSandboxPaths, normalizeDir, removeAllowDir } from "./paths.ts";

/** 命令只用得到的 UI 子集（no-UI 环境下 pi 会注入全 no-op 的 stub，confirm 返回 false） */
export interface WorkspaceCommandContext {
	ui: Pick<ExtensionCommandContext["ui"], "notify" | "select" | "input" | "confirm">;
	hasUI: boolean;
	signal?: AbortSignal;
}

export type WorkspaceActionKind = "list" | "add" | "remove" | "help";

export interface WorkspaceAction {
	kind: WorkspaceActionKind;
	/** add / remove 的目标参数；为空表示走交互选择 */
	target: string;
	/** 无法识别的子命令（仅 help 时有值，用于提示） */
	unknown?: string;
}

/** 用法文案（/sandbox:workspaces help 与参数错误时使用） */
export const WORKSPACE_USAGE = [
	"用法：",
	"  /sandbox:workspaces                    列出副工作区",
	"  /sandbox:workspaces add <目录>          添加（写盘前二次确认）",
	"  /sandbox:workspaces remove <目录|序号>  移除",
	"  /sandbox:workspaces help               本帮助",
].join("\n");

/** 解析子命令；裸路径（/、~、. 开头）视作 add，便于直接粘贴路径 */
export function parseWorkspaceArgs(args: string): WorkspaceAction {
	const raw = (args ?? "").trim();
	if (!raw) return { kind: "list", target: "" };

	const m = /^(\S+)\s*([\s\S]*)$/.exec(raw);
	const word = m?.[1] ?? raw;
	const rest = (m?.[2] ?? "").trim();
	const w = word.toLowerCase();

	switch (w) {
		case "list":
		case "ls":
		case "l":
		case "show":
			return { kind: "list", target: "" };
		case "add":
		case "a":
		case "put":
			return { kind: "add", target: rest };
		case "remove":
		case "rm":
		case "del":
		case "delete":
		case "pop":
			return { kind: "remove", target: rest };
		case "help":
		case "-h":
		case "--help":
		case "?":
			return { kind: "help", target: "" };
		default:
			// 裸路径直接当 add：/sandbox:workspaces /tmp/build
			if (word.startsWith("/") || word.startsWith("~") || word.startsWith(".")) {
				return { kind: "add", target: raw };
			}
			return { kind: "help", target: "", unknown: word };
	}
}

/**
 * 副工作区参数校验。规范化复用 paths.ts 的 normalizeDir（trim / 展开 ~ / 消 .. / 绝对化 / 去尾斜杠）。
 * 两条护栏与 paths.ts 的 addAllowDir 一致并补上家目录：
 *   - 拒绝根目录 "/"（等于把整个文件系统设为长期可写根）
 *   - 拒绝家目录本身（会连带 ~/.ssh、~/.pi 等敏感目录；家目录下的子目录合法）
 */
export function validateWorkspaceDir(
	raw: string,
	home: string = homedir(),
): { ok: true; dir: string } | { ok: false; reason: string } {
	const dir = normalizeDir(raw);
	if (!dir) return { ok: false, reason: "目录为空（用法：/sandbox:workspaces add <目录>）" };
	if (dir === "/") return { ok: false, reason: "拒绝根目录 /：它等于整个文件系统的长期可写根" };
	const homeDir = normalizeDir(home);
	if (homeDir && dir === homeDir) {
		return { ok: false, reason: `拒绝家目录本身 ${homeDir}（会连带 ~/.ssh、~/.pi 等敏感目录）：请指定它下面的子目录` };
	}
	return { ok: true, dir };
}

/** 列表文案：逐条编号，方便 remove 按序号选 */
export function formatWorkspaceList(dirs: string[], filePath: string): string {
	const header = `副工作区（allowDirs：长期可写根 + sandbox-allow 信任根）：${dirs.length} 个`;
	const body = dirs.length === 0 ? ["  （空）"] : dirs.map((d, i) => `  ${i + 1}. ${d}`);
	return [
		header,
		...body,
		`存储：${filePath}（即时生效，下一条 bash 即按新名单）`,
		"用法：/sandbox:workspaces add <目录> | remove <目录|序号>",
	].join("\n");
}

/** 把 remove 的参数解析成实际目录：数字按 1 起的序号，其余按路径（须已在列表中） */
export function resolveRemoveTarget(
	target: string,
	dirs: string[],
): { ok: true; dir: string } | { ok: false; reason: string } {
	const t = target.trim();
	if (!t) return { ok: false, reason: "未指定目录" };
	if (/^\d+$/.test(t)) {
		const idx = Number(t);
		if (idx < 1 || idx > dirs.length) {
			return { ok: false, reason: `序号 ${idx} 超出范围（当前 1-${dirs.length}）` };
		}
		return { ok: true, dir: dirs[idx - 1] };
	}
	const dir = normalizeDir(t);
	if (!dir || dir === "/") return { ok: false, reason: `目录无效：${t}` };
	if (!dirs.includes(dir)) return { ok: false, reason: `不在副工作区列表里：${dir}` };
	return { ok: true, dir };
}

/** sandbox-paths.json 的绝对路径（仅用于展示；实际读写由 paths.ts 负责） */
export function sandboxPathsFile(): string {
	return join(getAgentDir(), "extensions", "sandbox-permissions", "sandbox-paths.json");
}

/** /sandbox:workspaces 处理器：列出 / 添加 / 移除副工作区（TUI 内可用，不依赖 GUI 窗口） */
export async function workspaceCommandHandler(args: string, ctx: WorkspaceCommandContext): Promise<void> {
	const action = parseWorkspaceArgs(args);
	const opts = ctx.signal ? { signal: ctx.signal } : undefined;

	if (action.kind === "help") {
		ctx.ui.notify(
			action.unknown ? `未知子命令「${action.unknown}」\n${WORKSPACE_USAGE}` : WORKSPACE_USAGE,
			action.unknown ? "warning" : "info",
		);
		return;
	}

	if (action.kind === "list") {
		const { allowDirs } = loadSandboxPaths();
		ctx.ui.notify(formatWorkspaceList(allowDirs, sandboxPathsFile()), "info");
		return;
	}

	if (action.kind === "add") {
		await addWorkspace(action.target, ctx, opts);
		return;
	}

	await removeWorkspace(action.target, ctx, opts);
}

async function addWorkspace(
	target: string,
	ctx: WorkspaceCommandContext,
	opts: { signal?: AbortSignal } | undefined,
): Promise<void> {
	let raw = target.trim();
	if (!raw) {
		if (!ctx.hasUI) {
			ctx.ui.notify(`无交互界面，请带参数：/sandbox:workspaces add <目录>\n${WORKSPACE_USAGE}`, "error");
			return;
		}
		const typed = await ctx.ui.input("副工作区目录（持久可写根，支持 ~ 开头）", "~/work/scratch", opts);
		raw = (typed ?? "").trim();
		if (!raw) {
			ctx.ui.notify("已取消", "info");
			return;
		}
	}

	const check = validateWorkspaceDir(raw);
	if (!check.ok) {
		ctx.ui.notify(`不能添加：${check.reason}`, "error");
		return;
	}
	const dir = check.dir;

	const before = loadSandboxPaths().allowDirs;
	if (before.includes(dir)) {
		ctx.ui.notify(`已在副工作区列表中：${dir}（当前 ${before.length} 个）`, "info");
		return;
	}

	// 二次确认：allowDirs 是长期可写根，落盘后下一条 bash 即生效
	if (!ctx.hasUI) {
		ctx.ui.notify(`无交互界面，无法二次确认，未写入：${dir}\n请改用 GUI 目录授权或带界面的会话`, "error");
		return;
	}
	const agreed = await ctx.ui.confirm(
		`添加副工作区：${dir}？`,
		[
			"作用：长期可写根（普通 bash 常驻 --rw），同时作为 sandbox-allow 信任根",
			"      请求的 writePaths 完全落在其中时可免重复审批",
			`写入：${sandboxPathsFile()}`,
			"范围：不绕过硬拒绝规则（autoReject），也不提升系统身份",
		].join("\n"),
		opts,
	);
	if (!agreed) {
		ctx.ui.notify("已取消，未写入", "info");
		return;
	}

	try {
		if (!addAllowDir(dir)) {
			ctx.ui.notify(`写入失败（已存在或目录无效）：${dir}`, "warning");
			return;
		}
	} catch (err) {
		ctx.ui.notify(`写入失败：${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	ctx.ui.notify(`已添加副工作区：${dir}（当前 ${loadSandboxPaths().allowDirs.length} 个，即时生效）`, "info");
}

async function removeWorkspace(
	target: string,
	ctx: WorkspaceCommandContext,
	opts: { signal?: AbortSignal } | undefined,
): Promise<void> {
	const dirs = loadSandboxPaths().allowDirs;
	if (dirs.length === 0) {
		ctx.ui.notify("副工作区为空，无需移除", "info");
		return;
	}

	let arg = target.trim();
	// 无参数：TUI 列表里挑一个（不必手抄长路径）
	if (!arg) {
		if (!ctx.hasUI) {
			ctx.ui.notify(`无交互界面，请带参数：/sandbox:workspaces remove <目录|序号>\n${WORKSPACE_USAGE}`, "error");
			return;
		}
		const options = dirs.map((d, i) => `${i + 1}. ${d}`);
		const choice = await ctx.ui.select(`当前副工作区（${dirs.length} 个），选一个移除：`, [...options, "❌ 取消"], opts);
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
		if (!removeAllowDir(resolved.dir)) {
			ctx.ui.notify(`移除失败（不在列表中）：${resolved.dir}`, "warning");
			return;
		}
	} catch (err) {
		ctx.ui.notify(`写入失败：${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	ctx.ui.notify(
		`已移除副工作区：${resolved.dir}（剩余 ${loadSandboxPaths().allowDirs.length} 个，即时生效）\n` +
			"注意：已批准的一次性 sandbox-allow 与 session 内授权不受影响；已运行的进程不会回收权限。",
		"info",
	);
}

/** TUI 参数补全：子命令 + 现有副工作区（供 pi.registerCommand 的 getArgumentCompletions） */
export function workspaceArgumentCompletions(prefix: string): { value: string; label: string }[] {
	const p = (prefix ?? "").trimStart();
	const spaceAt = p.search(/\s/);
	if (spaceAt < 0) {
		return ["list", "add", "remove", "help"]
			.filter((c) => c.startsWith(p.toLowerCase()))
			.map((c) => ({ value: c, label: c }));
	}
	const word = p.slice(0, spaceAt).toLowerCase();
	if (word !== "remove" && word !== "rm" && word !== "del" && word !== "delete" && word !== "pop") return [];
	const rest = p.slice(spaceAt + 1);
	const { allowDirs } = loadSandboxPaths();
	return allowDirs
		.filter((d) => d.startsWith(rest))
		.map((d) => ({ value: `${p.slice(0, spaceAt)} ${d}`, label: d }));
}
