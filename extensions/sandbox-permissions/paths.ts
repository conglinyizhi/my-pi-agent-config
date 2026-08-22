// paths.ts — 目录白/黑名单（gate 审核 GUI 动态维护）
//
// 背景：gate 审核弹窗（危险命令 / sandbox-allow 升权）时，模型会给出它想操作的
// 目录（sandbox-allow 的 writePaths、命令中的目标路径）。用户可在界面上把单个
// 目录加入名单：
//   - 白名单 allowDirs：gate 审核时命令涉及的所有目标路径都在该目录内 → 直接放行
//   - 黑名单 blockDirs：guard 拦截对该目录的任何 read/write/bash 引用
//
// 存储：extensions/sandbox-permissions/sandbox-paths.json。
// 与手写静态配置（extensions.toml）分离：本文件由 GUI 高频程序写入，
// 用 JSON 避免破坏 extensions.toml 的注释（smol-toml stringify 不保留注释）。
//
// 结构：纯函数（可单测）与副作用（读/写文件）分离。

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { splitCommands, hasDynamicConstructs } from "./rule-engine.ts";

export interface SandboxPaths {
	allowDirs: string[];
	blockDirs: string[];
}

let pathsFile = join(getAgentDir(), "extensions", "sandbox-permissions", "sandbox-paths.json");

const EMPTY: SandboxPaths = { allowDirs: [], blockDirs: [] };

// ═══════════════════════════════════════════════════
// 纯函数
// ═══════════════════════════════════════════════════

/** 目录规范化：trim、展开 ~、去尾部斜杠（"/" 根目录保留） */
export function normalizeDir(dir: string): string {
	let d = (dir ?? "").trim();
	if (!d) return "";
	if (d === "~") return homedir();
	if (d.startsWith("~/")) d = join(homedir(), d.slice(2));
	while (d.length > 1 && d.endsWith("/")) d = d.slice(0, -1);
	return d;
}

/** 从命令中提取路径 token（绝对路径 / ~ 路径；排除含 shell 元字符的动态 token） */
export function extractPathTokens(command: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const seg of splitCommands(command)) {
		for (const t of seg) {
			if (!t) continue;
			if (!t.startsWith("/") && !t.startsWith("~/") && t !== "~") continue;
			// 排除动态构造残留：含 $() ` & | ; < > * ? {} [] 引号 的路径无法静态确认
			if (/[$()`;&|<>*?{}\[\]"']/.test(t)) continue;
			const d = normalizeDir(t);
			if (!d || seen.has(d)) continue;
			seen.add(d);
			out.push(d);
		}
	}
	return out;
}

/** target 是否在 dir 内（等于 dir，或以 dir/ 开头） */
export function isDirInside(target: string, dir: string): boolean {
	if (!target || !dir) return false;
	if (dir === "/") return target.startsWith("/");
	return target === dir || target.startsWith(dir + "/");
}

/**
 * 白名单豁免判定：命令所有目标路径都落在 allowDirs 内才放行。
 * 保守规则：
 *   - allowDirs 为空 → false
 *   - 命令含动态构造（$()/反引号/变量作命令等）→ false（路径无法静态确认）
 *   - 提取不到目标路径 → false（无法证明都在白名单内）
 */
export function isWhitelisted(command: string, allowDirs: string[]): boolean {
	if (!command || allowDirs.length === 0) return false;
	if (hasDynamicConstructs(command)) return false;
	// 变量引用（如 $dir）作参数路径无法静态确认——即使 hasDynamicConstructs 未命中
	// （它只认变量作命令），含 $ 的命令也不豁免，避免 cd /tmp/build && rm -rf $dir 误放行
	if (/\$/.test(command)) return false;
	const targets = extractPathTokens(command);
	if (targets.length === 0) return false;
	return targets.every((t) => allowDirs.some((d) => isDirInside(t, d)));
}

/** 候选目录（GUI 展示）：sandbox-allow 的 writePaths + 命令中提取的路径，去重 */
export function collectCandidateDirs(command: string, writePaths: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (d: string) => {
		const n = normalizeDir(d);
		if (n && !seen.has(n)) {
			seen.add(n);
			out.push(n);
		}
	};
	for (const p of writePaths ?? []) push(p);
	for (const t of extractPathTokens(command)) push(t);
	return out;
}

// ═══════════════════════════════════════════════════
// 文件读写（副作用，容错）
// ═══════════════════════════════════════════════════

function parsePaths(raw: string): SandboxPaths {
	const doc = JSON.parse(raw) as Partial<SandboxPaths>;
	const pick = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
	return { allowDirs: pick(doc.allowDirs), blockDirs: pick(doc.blockDirs) };
}

export function loadSandboxPaths(): SandboxPaths {
	try {
		return parsePaths(readFileSync(pathsFile, "utf8"));
	} catch {
		return { allowDirs: [], blockDirs: [] };
	}
}

export function saveSandboxPaths(paths: SandboxPaths): void {
	const out = { allowDirs: [...new Set(paths.allowDirs)], blockDirs: [...new Set(paths.blockDirs)] };
	writeFileSync(pathsFile, JSON.stringify(out, null, 2) + "\n", "utf8");
}

/** 追加一个白名单目录（去重、规范化后写回）；返回实际新增与否 */
export function addAllowDir(dir: string): boolean {
	const d = normalizeDir(dir);
	if (!d) return false;
	const paths = loadSandboxPaths();
	if (paths.allowDirs.includes(d)) return false;
	paths.allowDirs.push(d);
	saveSandboxPaths(paths);
	return true;
}

/** 追加一个黑名单目录（去重、规范化后写回）；返回实际新增与否 */
export function addBlockDir(dir: string): boolean {
	const d = normalizeDir(dir);
	if (!d) return false;
	const paths = loadSandboxPaths();
	if (paths.blockDirs.includes(d)) return false;
	paths.blockDirs.push(d);
	saveSandboxPaths(paths);
	return true;
}

/** 测试注入：重设文件路径（避免测试读写真实用户文件） */
export function setPathsFileForTest(filePath: string): void {
	pathsFile = filePath;
}
