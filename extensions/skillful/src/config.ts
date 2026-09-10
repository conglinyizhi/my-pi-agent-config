// skillful-local config — hidden skill visibility only
// Migrated from pi-skillful 0.4.0 (MIT; see ../LICENSE-MIT).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type SkillfulScope = "global" | "project";

// ── 独立存储：写进专属 toml，不碰 settings.json / settings.tracked.json ──
// 原实现把 hiddenSkills 写进 settings.json，触发 settings-sync 插件将非黑名单
// 字段回写到 git 追踪的 settings.tracked.json，导致每次技能显隐都产生仓库 diff。
// 改为专属 toml 后，skillful 显隐不再扰动 settings 文件；该 toml 已被 gitignore。
export function globalSkillfulPath(): string {
	return join(homedir(), ".pi", "agent", "skillful-settings.toml");
}
export function projectSkillfulPath(cwd: string): string {
	return join(cwd, ".pi", "skillful-settings.toml");
}

/** 扩展集中配置：来源组规则写在 [skillful] section，不硬编码在源码里。 */
export function extensionsConfigPath(): string {
	return join(getAgentDir(), "extensions.toml");
}

// 旧存储路径：仅读兼容/迁移回退用，写入不再使用。
function globalLegacySettingsPath(): string {
	return join(homedir(), ".pi", "agent", "settings.json");
}
function projectLegacySettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

export function normalizeSkillName(name: string): string {
	return name.trim().replace(/^skill:/, "");
}

export function normalizeSkillNames(names: Iterable<string>): string[] {
	return Array.from(new Set(Array.from(names).map(normalizeSkillName).filter(Boolean))).sort();
}

// ── 底层读写：专属 toml（新）+ 旧 settings.json（迁移回退） ──

interface TomlDocument {
	skillful?: { hiddenSkills?: unknown; skillGroups?: unknown };
}

interface PiSettingsDocument {
	skillful?: { hiddenSkills?: unknown };
	[key: string]: unknown;
}

/** 新 toml 路径 → 同目录下的旧 settings.json 路径（迁移回退用）。 */
function legacyPathFor(tomlPath: string): string {
	return join(dirname(tomlPath), "settings.json");
}

async function readToml(path: string): Promise<TomlDocument> {
	try {
		const parsed = parseToml(await readFile(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as TomlDocument : {};
	} catch {
		return {};
	}
}

async function readSettings(path: string): Promise<PiSettingsDocument> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PiSettingsDocument : {};
	} catch {
		return {};
	}
}

/** 从 { skillful: { hiddenSkills } } 结构提取规范化隐藏列表。 */
function toHiddenSkills(value: unknown): { hiddenSkills: string[]; defined: boolean } {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as { hiddenSkills?: unknown } : undefined;
	const raw = record?.hiddenSkills;
	return {
		hiddenSkills: normalizeSkillNames(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []),
		defined: !!record && Object.hasOwn(record, "hiddenSkills"),
	};
}

export async function readSkillfulSettings(path: string): Promise<{ hiddenSkills: string[]; defined: boolean }> {
	// 新到 toml：定义则优先；未定义则回退旧 settings.json（同目录）。
	if (path.endsWith(".toml")) {
		const toml = await readToml(path);
		if (toml.skillful && Object.hasOwn(toml.skillful, "hiddenSkills")) {
			return toHiddenSkills(toml.skillful);
		}
		return toHiddenSkills((await readSettings(legacyPathFor(path))).skillful);
	}
	// 兼容：直接传入 settings.json 路径。
	return toHiddenSkills((await readSettings(path)).skillful);
}

export async function readEffectiveHiddenSkills(cwd: string, projectTrusted: boolean): Promise<Set<string>> {
	const global = await readSkillfulSettings(globalSkillfulPath());
	if (!projectTrusted) return new Set(global.hiddenSkills);
	const project = await readSkillfulSettings(projectSkillfulPath(cwd));
	return new Set(project.defined ? project.hiddenSkills : global.hiddenSkills);
}

export async function readScopedHiddenSkills(cwd: string, projectTrusted: boolean): Promise<{
	global: { hiddenSkills: string[]; defined: boolean };
	project: { hiddenSkills: string[]; defined: boolean };
}> {
	const global = await readSkillfulSettings(globalSkillfulPath());
	const project = projectTrusted
		? await readSkillfulSettings(projectSkillfulPath(cwd))
		: { hiddenSkills: [], defined: false };
	return { global, project };
}

export async function writeHiddenSkills(
	scope: SkillfulScope,
	cwd: string,
	hiddenSkills: Iterable<string>,
	projectTrusted = false,
): Promise<void> {
	if (scope === "project" && !projectTrusted) throw new Error("Project skillful settings require a trusted project.");
	const path = scope === "global" ? globalSkillfulPath() : projectSkillfulPath(cwd);
	const content = stringifyToml({ skillful: { hiddenSkills: normalizeSkillNames(hiddenSkills) } });
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

// ── 来源组规则：[skillful.skillGroups]（extensions.toml） ──
// 规则是数据不是代码：新增/调整分组只改配置，不动这个文件。

export interface SkillGroupRule {
	/** 组标识；同 id 的技能合并为一行。 */
	id: string;
	/** 组显示名。 */
	label: string;
	/** canonical path 片段，命中任意一条即归入该组。 */
	match: string[];
}

/** 单条配置 → 规则；字段缺失或类型不对就丢弃，坏配置不影响其它组。 */
function toSkillGroupRule(value: unknown): SkillGroupRule | undefined {
	const entry = value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
	if (!entry) return undefined;
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	const label = typeof entry.label === "string" ? entry.label.trim() : "";
	const match = Array.isArray(entry.match)
		? entry.match.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
		: [];
	if (!id || !label || match.length === 0) return undefined;
	return { id, label, match };
}

/** 读 extensions.toml 的 [skillful.skillGroups]；未配置返回空数组（退回按来源/包名分组）。 */
export async function readSkillGroupRules(path = extensionsConfigPath()): Promise<SkillGroupRule[]> {
	const toml = await readToml(path);
	const raw = toml.skillful?.skillGroups;
	if (!Array.isArray(raw)) return [];
	return raw.map(toSkillGroupRule).filter((rule): rule is SkillGroupRule => !!rule);
}
