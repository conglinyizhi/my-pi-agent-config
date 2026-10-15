// sync.ts — 技能来源同步（repo.toml → 技能统一根）
//
// 2026-10-15 起技能只有一个落点：SKILLS_ROOT_DIR（`~/.agents/skills`，pi 的发现根之一）。
// 第三方仓库直接 clone 成该根下的同名目录：以前是「clone 到 skill-repo/ + skills/external
// 软链暴露」两层，现在没有软链这一层。
//
// 旧结构（skills/external 软链、skill-vault、skills/_repo）只保留一次性清理，
// 不再写入任何东西，也不会重建已迁移走的技能。
// 技能显隐由 skillful-local 管理，本文件不参与。

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	rmdirSync,
	unlinkSync,
	type Dirent,
} from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
	AGENT_DIR,
	LEGACY_SKILL_EXTERNAL_DIR,
	LEGACY_SKILL_VAULT_DIR,
	REPO_TOML_PATH,
	SKILLS_ROOT_DIR,
} from "./vault.ts";

const execAsync = promisify(exec);
const CLONE_TIMEOUT = 15_000;

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
	migrated?: boolean;
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

/** 技能统一根下该包的目录。 */
function packagePath(packageName: string): string {
	return join(SKILLS_ROOT_DIR, packageName);
}

/** 一个包在旧架构里可能留下的入口名：包名本身 + bundle 子技能名。 */
function legacyEntryNames(entry: SkillEntry): string[] {
	const targets = entry.bundle && entry.link_targets && entry.link_targets.length > 0
		? entry.link_targets.map((target) => basename(target))
		: [];
	return [...new Set([entry.name, ...targets])];
}

/** 旧架构清理：删掉指向 skill-repo 的历史软链（新架构里技能是实体目录，不再建链）。 */
function removeLegacyEntryLink(name: string): boolean {
	let removed = false;
	const legacyLinks = [join(LEGACY_SKILL_EXTERNAL_DIR, name), join(LEGACY_SKILL_VAULT_DIR, name)];
	for (const link of legacyLinks) {
		try {
			if (!lstatSync(link).isSymbolicLink()) continue;
			const target = readlinkSync(link);
			if (!target.includes("skill-repo")) continue;
			unlinkSync(link);
			removed = true;
		} catch {
			// 不存在
		}
	}
	return removed;
}

/** 旧根空了就顺手收掉，免得空目录让人以为还在用。 */
function pruneLegacyDirs(): void {
	for (const dir of [LEGACY_SKILL_EXTERNAL_DIR, LEGACY_SKILL_VAULT_DIR]) {
		try {
			rmdirSync(dir);
		} catch {
			// 不存在或非空
		}
	}
}

/** 旧架构清理：skills/_repo 残留迁入技能统一根。 */
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
		const targetPath = packagePath(name);
		try {
			if (!existsSync(targetPath)) {
				renameSync(oldPath, targetPath);
			} else {
				rmSync(oldPath, { recursive: true, force: true });
			}
			results.push({ name, action: "linked", migrated: true });
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

/** 后台同步：clone 到技能统一根 + 旧结构清理。 */
export async function syncSkillsAsync(tick: () => void): Promise<SyncResult[]> {
	const entries = loadRepoConfig();
	if (!entries || entries.length === 0) return [];

	mkdirSync(SKILLS_ROOT_DIR, { recursive: true });
	const results = resolveCollisions(entries);

	for (const entry of entries) {
		const target = packagePath(entry.name);

		if (!existsSync(target)) {
			try {
				await cloneRepoAsync(entry.source, target);
				results.push({ name: entry.name, action: "cloned" });
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

		const migrated = legacyEntryNames(entry).some((name) => removeLegacyEntryLink(name));
		if (migrated) results.push({ name: entry.name, action: "linked", migrated });
		tick();
	}

	pruneLegacyDirs();
	return results;
}
