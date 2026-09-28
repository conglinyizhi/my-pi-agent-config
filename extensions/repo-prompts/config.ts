// config.ts — repo-prompts 的两层配置读取
//
//   1) extensions.toml 的 [repo-prompts]：本扩展自己的开关与存储目录
//   2) <dir>/*.toml：规则表（[[prompt]] 一段一条），每条规则一个 md
//
// 规则表是 dir 下**所有** *.toml（不递归子目录）：按文件名序依次合并，同名规则后者覆盖前者。
// 文件名不做任何特殊判断——`*.local.toml` 在扩展眼里就是一个普通文件，
// 私有与否是 git 的事（agent 仓的 .gitignore 排除它），不是扩展的事。
//
// 全部读取都「失败即回落默认值」：extensions.toml 缺失/坏掉 → 默认开启 + 默认目录；
// 目录读不到 → 零规则；单个 toml 坏掉 → 只丢这个文件的规则；任何一条规则写错只丢它自己，
// 不影响同一文件里其它规则、不影响其它文件，更不影响会话。

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { expandHome, normalizePath } from "./match.ts";

/** order 缺省值：200+ 是「动态」档（段在系统前缀尾部，对 KV 缓存友好） */
export const DEFAULT_ORDER = 200;

/** 默认存储目录：~/.pi/agent/repo-prompts/（本身可作为 git 仓库分发） */
export function defaultDir(): string {
	return join(homedir(), ".pi", "agent", "repo-prompts");
}

export interface RepoPromptsSettings {
	enabled: boolean;
	/** 存储目录（已归一化的绝对路径） */
	dir: string;
}

/** 一条规则（归一化后的成品） */
export interface Rule {
	name: string;
	/** 段名 = `repo:<name>` */
	order: number;
	/** 归一化后的绝对路径前缀，至少一条 */
	paths: string[];
	/** 原始 paths 文案（/repo-prompts 展示用，保留 ~ 写法） */
	rawPaths: string[];
	/** md 文件绝对路径；内联规则为 undefined */
	file?: string;
	/** 原始 file 文案（展示用） */
	rawFile?: string;
	/** 内联文本；file 规则为 undefined */
	text?: string;
	/** 定义这条规则的 toml（绝对路径；/repo-prompts 展示用） */
	source?: string;
}

export interface LoadedRules {
	dir: string;
	/** 约定入口文件（一个都没扫到时，报告里指路用） */
	configPath: string;
	/** 实际读到的规则表（绝对路径，按文件名序） */
	configFiles: string[];
	/** 是否扫到至少一个 toml（解析失败也算扫到） */
	found: boolean;
	rules: Rule[];
	/** 问题：读不动 / 解析失败 / 规则写错（报告里列在「问题」下） */
	errors: string[];
	/** 提示：正常但值得说一句的事（如跨文件同名覆盖），不算问题 */
	notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTomlFile(path: string): { ok: true; value: Record<string, unknown> } | { ok: false; missing: boolean; reason?: string } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		return code === "ENOENT"
			? { ok: false, missing: true }
			: { ok: false, missing: false, reason: err instanceof Error ? err.message : String(err) };
	}
	try {
		const parsed = parseToml(raw);
		return { ok: true, value: isRecord(parsed) ? parsed : {} };
	} catch (err) {
		return { ok: false, missing: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

/** 读 extensions.toml 的 [repo-prompts]；文件缺失/坏掉 → 默认（开启 + 默认目录） */
export function loadSettings(tomlPath: string, fallbackDir: string = defaultDir()): RepoPromptsSettings {
	const read = readTomlFile(tomlPath);
	if (!read.ok) return { enabled: true, dir: fallbackDir };
	const section = read.value["repo-prompts"];
	if (!isRecord(section)) return { enabled: true, dir: fallbackDir };
	const enabled = section.enabled !== false;
	const rawDir = typeof section.dir === "string" ? section.dir.trim() : "";
	const dir = rawDir ? normalizePath(rawDir) || fallbackDir : fallbackDir;
	return { enabled, dir };
}

/**
 * 规则表清单：dir 下的 *.toml，不递归。
 * 排序用默认 `sort()`（码位序）：与 locale 无关，同一台机器上结果稳定可预期，
 * 「谁覆盖谁」就只看文件名字节序。目录读不到 → 空清单（安静回落，不算错误）。
 */
export function listRuleTables(dir: string): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".toml"))
		.map((entry) => entry.name)
		.sort()
		.map((name) => join(dir, name));
}

/** 解析 <dir>/*.toml 的 [[prompt]] 段；按文件名序合并，同名后者覆盖；单条规则写错只丢它自己 */
export function loadRules(dir: string = defaultDir()): LoadedRules {
	const normalizedDir = normalizePath(dir) || dir;
	const loaded: LoadedRules = {
		dir: normalizedDir,
		configPath: join(normalizedDir, "index.toml"),
		configFiles: [],
		found: false,
		rules: [],
		errors: [],
		notes: [],
	};

	const tables = listRuleTables(normalizedDir);
	loaded.configFiles = tables;
	// 一个 toml 都没有是正常状态（扩展装了、规则还没写），不算错误
	loaded.found = tables.length > 0;

	const byName = new Map<string, Rule>();
	// 规则名 → 定义它的 toml（跨文件覆盖时用来报「前一条来自哪」）
	const origin = new Map<string, string>();

	for (const tablePath of tables) {
		const table = basename(tablePath);
		const read = readTomlFile(tablePath);
		if (!read.ok) {
			// 单个 toml 读不动/解析不了：只丢这个文件的规则，其它文件照常
			loaded.errors.push(`读不了 ${table}: ${read.reason ?? "文件不存在"}`);
			continue;
		}

		const rawEntries = read.value.prompt;
		if (rawEntries === undefined) continue;
		if (!Array.isArray(rawEntries)) {
			loaded.errors.push(`${table}: prompt 必须是 [[prompt]] 数组`);
			continue;
		}

		rawEntries.forEach((entry, index) => {
			const label = `${table} [[prompt]] #${index + 1}`;
			if (!isRecord(entry)) {
				loaded.errors.push(`${label}: 不是一个表`);
				return;
			}

			const name = typeof entry.name === "string" ? entry.name.trim() : "";
			if (!name) {
				loaded.errors.push(`${label}: 缺 name`);
				return;
			}
			if (!/^[A-Za-z0-9._-]+$/.test(name)) {
				loaded.errors.push(`规则 "${name}": name 只能用字母数字与 . _ -（段名 repo:<name>）`);
				return;
			}

			const rawPaths = Array.isArray(entry.paths)
				? (entry.paths as unknown[]).filter((p): p is string => typeof p === "string" && p.trim() !== "")
				: [];
			if (rawPaths.length === 0) {
				loaded.errors.push(`规则 "${name}": 缺 paths（至少一条绝对路径或 ~/…）`);
				return;
			}
			const paths: string[] = [];
			for (const raw of rawPaths) {
				const normalized = normalizePath(raw);
				if (!normalized) {
					loaded.errors.push(`规则 "${name}": 路径 "${raw}" 不是绝对路径（支持 ~/… 写法）`);
					continue;
				}
				if (!paths.includes(normalized)) paths.push(normalized);
			}
			if (paths.length === 0) return;

			let order = DEFAULT_ORDER;
			if (entry.order !== undefined) {
				if (typeof entry.order === "number" && Number.isFinite(entry.order)) {
					order = Math.trunc(entry.order);
				} else {
					loaded.errors.push(`规则 "${name}": order 不是数字，回落 ${DEFAULT_ORDER}`);
				}
			}

			const inline = typeof entry.text === "string" && entry.text.trim() !== "" ? (entry.text as string) : undefined;
			const rawFile = typeof entry.file === "string" && entry.file.trim() !== "" ? entry.file.trim() : undefined;
			if (inline !== undefined && rawFile !== undefined) {
				loaded.errors.push(`规则 "${name}": file 与 text 同时给了，用 text（内联）`);
			}
			if (inline === undefined && rawFile === undefined) {
				loaded.errors.push(`规则 "${name}": 需要 file 或 text 之一`);
				return;
			}

			const rule: Rule = {
				name,
				order,
				paths,
				rawPaths: rawPaths.slice(),
				text: inline,
				source: tablePath,
			};
			if (inline === undefined && rawFile !== undefined) {
				// file 相对 repo-prompts 目录；写成绝对路径也收
				const expanded = expandHome(rawFile);
				const abs = normalizePath(isAbsolute(expanded) ? expanded : join(normalizedDir, expanded));
				if (!abs) {
					loaded.errors.push(`规则 "${name}": file "${rawFile}" 解析不出路径`);
					return;
				}
				rule.file = abs;
				rule.rawFile = rawFile;
			}

			// 同名覆盖：跨文件算正常用法（私有/共享两边都写一点，后一个文件说了算），
			// 记进 notes 当提示；同一个文件里重名多半是手滑，仍按问题记。
			const previous = origin.get(name);
			if (previous !== undefined) {
				if (previous === tablePath) {
					loaded.errors.push(`规则 "${name}" 重复，后一条覆盖前一条`);
				} else {
					loaded.notes.push(`规则 "${name}" 被 ${table} 覆盖（前一条来自 ${basename(previous)}）`);
				}
			}
			origin.set(name, tablePath);
			// 覆盖后连着位置一起后移：同 order 时段的先后由此顺序决定
			byName.delete(name);
			byName.set(name, rule);
		});
	}

	loaded.rules = Array.from(byName.values());
	return loaded;
}
