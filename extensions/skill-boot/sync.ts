// sync.ts — skill-repo 同步与正式 Pi 技能路径暴露
//
// 外部技能本体保存在 skill-repo/，正式发现入口统一暴露到：
//   skills/external/<来源>/<skill>/
//
// skill-vault 里的旧外部软链接只在迁移期间兼容处理；技能显隐由 skillful-local 管理。

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	type Dirent,
} from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, basename, dirname } from "node:path";
import { parse as parseToml } from "smol-toml";
import { AGENT_DIR, REPO_TOML_PATH, SKILL_EXTERNAL_DIR, SKILL_VAULT_DIR } from "./vault.ts";

const execAsync = promisify(exec);
const CLONE_TIMEOUT = 15_000;
const SKILL_REPO_DIR = join(AGENT_DIR, "skill-repo");

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

function formalLinkPath(packageName: string): string {
	return join(SKILL_EXTERNAL_DIR, packageName);
}

function legacyLinkPath(skillName: string): string {
	return join(SKILL_VAULT_DIR, skillName);
}

/** 在正式 Pi 技能目录下建立来源仓库根软链接。 */
function linkFormalPackage(packageName: string, repoDir: string): "linked" | "skipped" {
	const linkPath = formalLinkPath(packageName);
	mkdirSync(dirname(linkPath), { recursive: true });
	const relativeTarget = relative(dirname(linkPath), repoDir);
	try {
		const stat = lstatSync(linkPath);
		if (stat.isSymbolicLink()) {
			if (readlinkSync(linkPath) === relativeTarget) return "skipped";
			unlinkSync(linkPath);
		} else {
			// 该目录是旧版按 skill 分别建立的运行时入口，只清理这一受管路径。
			rmSync(linkPath, { recursive: true, force: true });
		}
	} catch {
		// 不存在
	}
	symlinkSync(relativeTarget, linkPath);
	return "linked";
}

/** 只把指向 skill-repo 的旧链接迁走，不碰 skill-vault 内的本地技能。 */
function removeLegacyLink(skillName: string): boolean {
	try {
		const link = legacyLinkPath(skillName);
		if (!lstatSync(link).isSymbolicLink()) return false;
		const target = readlinkSync(link);
		if (!target.includes("skill-repo") && !target.startsWith("../skill-repo")) return false;
		unlinkSync(link);
		return true;
	} catch {
		return false;
	}
}

/** 旧架构清理：skills/_repo 残留迁入 skill-repo。 */
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
		try {
			if (!existsSync(skillRepoSrc)) {
				mkdirSync(SKILL_REPO_DIR, { recursive: true });
				renameSync(oldPath, skillRepoSrc);
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

/** 后台同步：clone + 正式技能入口软链接 + 旧入口迁移。 */
export async function syncSkillsAsync(tick: () => void): Promise<SyncResult[]> {
	const entries = loadRepoConfig();
	if (!entries || entries.length === 0) return [];

	mkdirSync(SKILL_REPO_DIR, { recursive: true });
	mkdirSync(SKILL_EXTERNAL_DIR, { recursive: true });
	const results = resolveCollisions(entries);

	for (const entry of entries) {
		const repoDirName = entry.source_dir || entry.name;
		const repoDir = join(SKILL_REPO_DIR, repoDirName);

		if (!existsSync(repoDir)) {
			try {
				await cloneRepoAsync(entry.source, repoDir);
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

		const action = linkFormalPackage(entry.name, repoDir);
		const legacyNames = entry.bundle && entry.link_targets && entry.link_targets.length > 0
			? entry.link_targets.map((target) => basename(target))
			: [entry.name];
		const migrated = legacyNames.some((name) => removeLegacyLink(name));
		if (action === "linked" || migrated) results.push({ name: entry.name, action, migrated });
		tick();
	}

	return results;
}
