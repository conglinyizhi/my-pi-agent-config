// paths-config.ts — 三类沙箱路径配置的统一视图（trustedProgramDirs / allowDirs / blockDirs）
//
// 三类配置同住在 sandbox-paths.json，但语义不同，过去各自散布在 paths.ts（allow/block）
// 与 trusted.ts（trusted）里。这里只做「数据层的统一视图」：一张元数据表（叫法、来源、
// 效果、是否人类权限）、列表读取、增删分发、文案渲染。读写本身复用现成实现：
//   allowDirs / blockDirs → paths.ts 的 addAllowDir / removeAllowDir / addBlockDir / removeBlockDir
//   trustedProgramDirs    → trusted.ts 的 addTrustedProgramDir / removeTrustedProgramDir
// 目录规范化与护栏复用 workspace-command.ts 的 validateWorkspaceDir，不另造一套。
//
// UI 层（TUI / yad）在 paths-command.ts；本文件不碰 ctx.ui，也不碰 child_process。

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	addAllowDir,
	addBlockDir,
	loadSandboxPaths,
	removeAllowDir,
	removeBlockDir,
} from "./paths.ts";
import {
	addTrustedProgramDir,
	loadTrustedProgramDirs,
	removeTrustedProgramDir,
} from "./trusted.ts";
import { validateWorkspaceDir } from "./workspace-command.ts";

export type PathListKey = "trustedProgramDirs" | "allowDirs" | "blockDirs";

export interface PathListMeta {
	/** JSON 字段名（也就是类型键） */
	key: PathListKey;
	/** 命令行里的短类型词 */
	cli: string;
	/** 接受的其他写法（含全名与单个字母） */
	aliases: string[];
	/** 展示用中文名 */
	label: string;
	/** 一句话效果 */
	summary: string;
	/** 来源与生效时机（列表里逐条带上） */
	source: string;
	/** 来源短写法（表格式展示用） */
	sourceShort: string;
	/** 展开的要点：列表与确认框共用，措辞即后果 */
	points: string[];
	/** 是否「人类的权限」：改动前要一句明确写出后果的确认，且模型不得代填 */
	humanOnly?: boolean;
	/** 写入成功后的一句后果/生效说明 */
	afterAdd: string;
	/** 移除成功后的一句生效说明 */
	afterRemove: string;
}

export const PATH_LISTS: PathListMeta[] = [
	{
		key: "trustedProgramDirs",
		cli: "trusted",
		aliases: ["trusted", "t", "trustedprogramdirs", "trusted-program-dirs"],
		label: "可信程序目录",
		summary: "这里的目录下的可执行文件按「已知程序」对待",
		source: "sandbox-paths.json · 即时生效（按文件 mtime 失效，无需 /reload）",
		sourceShort: "文件 · 即时生效",
		points: [
			"效果：只影响「程序是谁编译的」这一条 —— 程序名能静态确定时不再落回 dynamic-construct 预审",
			"不改其它：不放宽参数、不放宽要读写的路径，也不动 autoReject 硬拒绝规则",
			"⚠️ 后果：这会放宽对 AI 命令的审核。所以它是人类的权限，模型不得代填",
			"⚠️ 只填你自己确认过、或你自己编译出来的产物；让模型代跑编译同样等于给自己发通行证",
		],
		humanOnly: true,
		afterAdd: "后果：这会放宽对 AI 命令的审核，只填自己确认过或自己编译出来的产物。即时生效，不用 /reload。",
		afterRemove: "移除后这些程序重新按「未知程序」处理（收紧审核）。即时生效，不用 /reload。",
	},
	{
		key: "allowDirs",
		cli: "allow",
		aliases: ["allow", "a", "allowdirs", "workspace", "workspaces"],
		label: "副工作区（长期可写根）",
		summary: "长期可写根 + sandbox-allow 信任根",
		source: "sandbox-paths.json · 即时生效（下一条 bash 即按新名单）",
		sourceShort: "文件 · 即时生效",
		points: [
			"效果：普通 bash 常驻 --rw；sandbox-allow 的 write-paths 完全落在其中时可免重复审批",
			"范围：不绕过硬拒绝规则（autoReject），也不提升系统身份",
			"注意：已批准的一次性 sandbox-allow 与 session 内授权不受影响，已运行的进程不会回收权限",
		],
		afterAdd: "即时生效：下一条 bash 即按新名单（不需要 /reload）。",
		afterRemove: "即时生效。注意：已批准的一次性 sandbox-allow 与 session 内授权不受影响；已运行的进程不会回收权限。",
	},
	{
		key: "blockDirs",
		cli: "block",
		aliases: ["block", "b", "blockdirs", "blacklist"],
		label: "黑名单",
		summary: "该目录整体视为敏感",
		source: "sandbox-paths.json · guard 在 session_start 加载，改完需 /reload",
		sourceShort: "文件 · 需 /reload",
		points: [
			"效果：guard 拦截对该目录的任何 read/write/bash 引用（命中即拒，不给人工放行口子）",
			"注意：普通 bash 与 worker bash 都是硬拒；只有 sandbox-allow 会把敏感路径降级为「问人」",
			"注意：生效时机是 guard 的 session_start，写完要 /reload",
		],
		afterAdd: "注意：guard 在 session_start 加载，要 /reload 才按新名单拦截。",
		afterRemove: "注意：guard 在 session_start 加载，要 /reload 才取消拦截。",
	},
];

/** 类型词 → 元数据（未知返回 undefined） */
export function listMeta(key: PathListKey): PathListMeta {
	const meta = PATH_LISTS.find((m) => m.key === key);
	if (!meta) throw new Error(`未知配置类型：${key}`);
	return meta;
}

/** 解析类型词（cli / 全名 / 别名；大小写不敏感） */
export function parseListKey(word: string): PathListKey | undefined {
	const w = (word ?? "").trim().toLowerCase();
	if (!w) return undefined;
	return PATH_LISTS.find((m) => m.cli === w || m.key.toLowerCase() === w || m.aliases.includes(w))?.key;
}

/** 三类类型词列表（提示文案用）：trusted | allow | block */
export function listKeyWords(): string[] {
	return PATH_LISTS.map((m) => m.cli);
}

/** sandbox-paths.json 的绝对路径（展示用；实际读写由 paths.ts / trusted.ts 负责） */
export function sandboxPathsFile(): string {
	return join(getAgentDir(), "extensions", "sandbox-permissions", "sandbox-paths.json");
}

export type PathLists = Record<PathListKey, string[]>;

/** 读某一类 */
export function loadList(key: PathListKey): string[] {
	return key === "trustedProgramDirs" ? loadTrustedProgramDirs() : loadSandboxPaths()[key];
}

/** 读三类 */
export function loadAllLists(): PathLists {
	return {
		trustedProgramDirs: loadTrustedProgramDirs(),
		allowDirs: loadSandboxPaths().allowDirs,
		blockDirs: loadSandboxPaths().blockDirs,
	};
}

/**
 * 条目校验。规范化与两条护栏复用 workspace-command 的 validateWorkspaceDir：
 *   - 拒绝根目录 "/"（等于把整个文件系统一次全放开/全拦下）
 *   - 拒绝家目录本身（会连带 ~/.ssh、~/.pi；子目录合法）
 * 三类共用同一口径：宁可要求写具体一点，也不允许一条把整台机器覆盖掉。
 */
export function validateEntry(
	key: PathListKey,
	raw: string,
	home?: string,
): { ok: true; dir: string } | { ok: false; reason: string } {
	const meta = listMeta(key);
	const check = home === undefined ? validateWorkspaceDir(raw) : validateWorkspaceDir(raw, home);
	if (check.ok) return check;
	return { ok: false, reason: `${meta.label}：${check.reason}` };
}

/** 增：分发到各类的实现（allow/block → paths.ts，trusted → trusted.ts） */
export function addEntry(key: PathListKey, dir: string): boolean {
	switch (key) {
		case "trustedProgramDirs":
			return addTrustedProgramDir(dir);
		case "allowDirs":
			return addAllowDir(dir);
		case "blockDirs":
			return addBlockDir(dir);
	}
}

/** 删：分发到各类的实现 */
export function removeEntry(key: PathListKey, dir: string): boolean {
	switch (key) {
		case "trustedProgramDirs":
			return removeTrustedProgramDir(dir);
		case "allowDirs":
			return removeAllowDir(dir);
		case "blockDirs":
			return removeBlockDir(dir);
	}
}

/**
 * 改动确认框的正文（标题另行给）。措辞里必须出现后果：
 * trustedProgramDirs 是人类的权限，write 前要人看清「这会放宽对 AI 命令的审核」。
 */
export function confirmBody(key: PathListKey, dir: string, file: string): string {
	const meta = listMeta(key);
	const action = meta.humanOnly ? `这一条会放宽对 AI 命令的审核` : `${meta.summary}（写入后即生效）`;
	return [
		`目标：${dir}`,
		action,
		...meta.points,
		`写入：${file} 的 ${meta.key}`,
	].join("\n");
}

/** 确认框标题 */
export function confirmTitle(key: PathListKey, dir: string): string {
	const meta = listMeta(key);
	return meta.humanOnly
		? `把 ${dir} 加入${meta.label}？（会放宽对 AI 命令的审核）`
		: `把 ${dir} 加入${meta.label}？`;
}

/** 三类配置的完整文本视图（TUI notify 与 yad 窗口共用同一份文案） */
export function formatPathsList(lists: PathLists, file: string): string {
	const out = [`沙箱路径配置（三类）：${file}`];
	for (const meta of PATH_LISTS) {
		const dirs = lists[meta.key];
		out.push("", `▸ ${meta.key} — ${meta.label}：${dirs.length} 个${meta.humanOnly ? "（人类的权限）" : ""}`, `    来源：${meta.source}`);
		for (const p of meta.points) out.push(`    ${p}`);
		if (dirs.length === 0) {
			out.push(`    （空）`);
		} else {
			dirs.forEach((d, i) => out.push(`    ${i + 1}. ${d}`));
		}
	}
	return out.join("\n");
}

/** 表格式行（yad 列表用）：类型 | 目录 | 来源/生效 */
export function tableRows(lists: PathLists): string[][] {
	const rows: string[][] = [];
	for (const meta of PATH_LISTS) {
		for (const d of lists[meta.key]) rows.push([meta.cli, d, meta.sourceShort]);
	}
	return rows;
}
