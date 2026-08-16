// sync.ts — skill-repo 同步（合并自 skill-kit；软链接目标改为 skill-vault）
//
// 功能：读取 repo.toml → clone 缺失仓库 → 在 skill-vault/ 建立软链接 →
// 旧架构（skills/_repo）清理 → 禁用列表清理。skill-vault 不被 pi 扫描，
// 只由本扩展管理（/skill-boot 手动注入、/skill-manager 开关）。

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, basename } from "node:path";
import { parse as parseToml } from "smol-toml";
import { AGENT_DIR, REPO_TOML_PATH, SKILL_VAULT_DIR } from "./vault.ts";

const execAsync = promisify(exec);
const CLONE_TIMEOUT = 15_000;
const SKILL_REPO_DIR = join(AGENT_DIR, "skill-repo");
const STATE_PATH = join(AGENT_DIR, "skill-states.json");

export interface SkillEntry {
	name: string;
	source: string;
	source_dir?: string;
	description?: string;
	tags?: string[];
	aliases?: string[];
	bundle?: boolean;
	link_targets?: string[];
	trigger?: string;
	disable_model_invocation?: boolean;
}

export interface SyncResult {
	name: string;
	action: "skipped" | "cloned" | "linked" | "failed";
	error?: string;
}

export function loadRepoConfig(): SkillEntry[] | null {
	try {
		const raw = readFileSync(REPO_TOML_PATH, "utf8");
		const data = parseToml(raw) as { skills?: SkillEntry[] };
		return data.skills ?? [];
	} catch {
		return null;
	}
}

export function loadState(): { disabled: string[] } {
	try {
		const raw = readFileSync(STATE_PATH, "utf8");
		return JSON.parse(raw);
	} catch {
		return { disabled: [] };
	}
}

export function saveState(state: { disabled: string[] }): void {
	writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

export function loadDisabledList(): string[] {
	return loadState().disabled;
}

async function cloneRepoAsync(source: string, targetDir: string): Promise<void> {
	const repo = source.replace("https://github.com/", "");
	try {
		await execAsync(`gh repo clone "${repo}" "${targetDir}" -- --depth=1`, {
			timeout: CLONE_TIMEOUT,
			killSignal: "SIGKILL",
		});
		return;
	} catch {
		// gh 失败，回退 git
	}
	await execAsync(`git clone --depth=1 "${source}" "${targetDir}"`, {
		timeout: CLONE_TIMEOUT,
		killSignal: "SIGKILL",
	});
}

/** 在 skill-vault 下建软链接 */
function linkSkill(linkName: string, srcAbs: string): "linked" | "skipped" {
	mkdirSync(SKILL_VAULT_DIR, { recursive: true });
	const linkPath = join(SKILL_VAULT_DIR, linkName);
	const relativeTarget = relative(SKILL_VAULT_DIR, srcAbs);
	try {
		const stat = lstatSync(linkPath);
		if (stat.isSymbolicLink()) {
			if (readlinkSync(linkPath) === relativeTarget) return "skipped";
			unlinkSync(linkPath);
		} else {
			return "skipped";
		}
	} catch {
		// 不存在
	}
	symlinkSync(relativeTarget, linkPath);
	return "linked";
}

function toggleEnsureSymlink(linkName: string): boolean {
	const entries = loadRepoConfig();
	if (!entries) return false;
	for (const entry of entries) {
		if (entry.bundle && entry.link_targets) {
			for (const target of entry.link_targets) {
				if (basename(target) === linkName) {
					const repoDirName = entry.source_dir || entry.name;
					const src = join(SKILL_REPO_DIR, repoDirName, target);
					if (!existsSync(src)) return false;
					linkSkill(linkName, src);
					return true;
				}
			}
		} else if (entry.name === linkName) {
			const src = join(SKILL_REPO_DIR, linkName);
			if (!existsSync(src)) return false;
			linkSkill(linkName, src);
			return true;
		}
	}
	return false;
}

function toggleRemoveSymlink(linkName: string): void {
	const linkPath = join(SKILL_VAULT_DIR, linkName);
	try {
		if (lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath);
	} catch {
		// 不存在
	}
}

/** 旧架构清理：skills/_repo 残留 → 迁移到 skill-repo + vault 软链接 */
function resolveCollisions(entries: SkillEntry[]): SyncResult[] {
	const results: SyncResult[] = [];
	const knownSkills = new Set<string>();
	for (const entry of entries) {
		if (entry.bundle && entry.link_targets) {
			for (const target of entry.link_targets) knownSkills.add(basename(target));
		} else {
			knownSkills.add(entry.name);
		}
	}
	const oldRepoDir = join(AGENT_DIR, "skills", "_repo");
	let oldEntries: string[];
	try {
		oldEntries = readdirSync(oldRepoDir);
	} catch {
		return results;
	}
	for (const name of oldEntries) {
		if (!knownSkills.has(name)) continue;
		const oldPath = join(oldRepoDir, name);
		let oldStat;
		try {
			oldStat = lstatSync(oldPath);
		} catch {
			continue;
		}
		if (!oldStat.isDirectory()) continue;
		const skillRepoSrc = join(SKILL_REPO_DIR, name);
		const vaultLinkPath = join(SKILL_VAULT_DIR, name);
		try {
			const linkStat = lstatSync(vaultLinkPath);
			if (linkStat.isSymbolicLink()) {
				rmSync(oldPath, { recursive: true, force: true });
				results.push({ name, action: "linked" });
				continue;
			}
		} catch {
			// 不存在
		}
		try {
			if (!existsSync(skillRepoSrc)) {
				mkdirSync(SKILL_REPO_DIR, { recursive: true });
				renameSync(oldPath, skillRepoSrc);
				linkSkill(name, skillRepoSrc);
				results.push({ name, action: "linked" });
			} else {
				rmSync(oldPath, { recursive: true, force: true });
				linkSkill(name, skillRepoSrc);
				results.push({ name, action: "linked" });
			}
		} catch (e) {
			results.push({
				name,
				action: "failed",
				error: `_repo 清理失败: ${String(e instanceof Error ? e.message : e).slice(0, 100)}`,
			});
		}
	}
	return results;
}

/** 后台同步：clone + 软链接到 vault + 清理 */
export async function syncSkillsAsync(tick: () => void): Promise<SyncResult[]> {
	const entries = loadRepoConfig();
	if (!entries || entries.length === 0) return [];
	mkdirSync(SKILL_REPO_DIR, { recursive: true });
	mkdirSync(SKILL_VAULT_DIR, { recursive: true });
	const results: SyncResult[] = [];

	for (const entry of entries) {
		const repoDirName = entry.source_dir || entry.name;
		const repoDir = join(SKILL_REPO_DIR, repoDirName);

		if (entry.bundle && entry.link_targets && entry.link_targets.length > 0) {
			if (!existsSync(repoDir)) {
				try {
					await cloneRepoAsync(entry.source, repoDir);
					results.push({ name: `${entry.name} (bundle)`, action: "cloned" });
				} catch (e) {
					results.push({
						name: entry.name,
						action: "failed",
						error: String(e instanceof Error && "stderr" in e ? (e as { stderr?: string }).stderr : e instanceof Error ? e.message : "未知错误").slice(0, 200),
					});
					tick();
					continue;
				}
			}
			for (const target of entry.link_targets) {
				const src = join(repoDir, target);
				const linkName = basename(target);
				if (!existsSync(src)) {
					results.push({ name: `${entry.name}/${linkName}`, action: "failed", error: `源路径不存在: ${target}` });
					continue;
				}
				const action = linkSkill(linkName, src);
				if (action === "linked") results.push({ name: `${entry.name}/${linkName}`, action: "linked" });
			}
			tick();
			continue;
		}

		if (existsSync(repoDir)) {
			const linkPath = join(SKILL_VAULT_DIR, entry.name);
			if (!existsSync(linkPath)) {
				linkSkill(entry.name, repoDir);
				results.push({ name: entry.name, action: "linked" });
			} else {
				results.push({ name: entry.name, action: "skipped" });
			}
			tick();
			continue;
		}

		try {
			await cloneRepoAsync(entry.source, repoDir);
			linkSkill(entry.name, repoDir);
			results.push({ name: entry.name, action: "cloned" });
		} catch (e) {
			results.push({
				name: entry.name,
				action: "failed",
				error: String(e instanceof Error && "stderr" in e ? (e as { stderr?: string }).stderr : e instanceof Error ? e.message : "未知错误").slice(0, 200),
			});
		}
		tick();
	}

	for (const r of resolveCollisions(entries)) results.push(r);

	// 禁用列表清理（vault 中移除）
	for (const name of loadDisabledList()) {
		try {
			if (lstatSync(join(SKILL_VAULT_DIR, name)).isSymbolicLink()) {
				unlinkSync(join(SKILL_VAULT_DIR, name));
				results.push({ name, action: "linked" });
			}
		} catch {
			// 不存在
		}
	}
	return results;
}

export { toggleEnsureSymlink, toggleRemoveSymlink };

export interface SkillInfo {
	name: string;
	source: string;
	enabled: boolean;
}

/** 汇总技能列表（bundle 分组 + 禁用状态），供 /skill-manager 展示 */
export function collectSkills(): SkillInfo[] {
	const skills: SkillInfo[] = [];
	const state = loadState();
	const entries = loadRepoConfig();
	if (!entries) return [];
	for (const entry of entries) {
		if (entry.bundle && entry.link_targets && entry.link_targets.length > 0) {
			for (const target of entry.link_targets) {
				const skillName = basename(target);
				skills.push({
					name: skillName,
					source: `bundle:${entry.name}`,
					enabled: !state.disabled.includes(skillName),
				});
			}
		} else {
			skills.push({
				name: entry.name,
				source: `repo:${entry.name}`,
				enabled: !state.disabled.includes(entry.name),
			});
		}
	}
	return skills;
}
