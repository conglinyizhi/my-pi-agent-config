// external-skills — skillful-local 管理第三方技能包的默认隐藏状态
//
// 2026-10-15 起技能只有一个根：SKILLS_ROOT_DIR（`~/.agents/skills`，pi 的发现根之一）。
// 本模块只登记 repo.toml 里那些第三方包目录：本地自写技能不该因为「新出现」被悄悄隐藏，
// 这与搬迁前的边界一致（以前扫的是 skills/external，里面只有第三方 clone）。
// 判定用的 identity 是「相对技能根的路径 + 技能名」，包目录名不变，所以旧状态文件继续有效。

import { existsSync, readFileSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { basename, join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	readSkillfulSettings,
	writeHiddenSkills,
	globalSkillfulPath,
} from "./config.ts";
import { parseFrontmatter } from "../../skill-boot/frontmatter.ts";
import { loadRepoConfig } from "../../skill-boot/sync.ts";
import { SKILLS_ROOT_DIR } from "../../skill-boot/vault.ts";

const AGENT_DIR = getAgentDir();
const STATE_PATH = join(AGENT_DIR, "skillful-discovery-state.json");

interface DiscoveryState {
	version: 1;
	seen: string[];
}

export interface ExternalSkillDiscovery {
	/** 技能根：第三方包与本地技能都在这里。 */
	path: string;
	/** 当前发现到的 skill 名称。 */
	names: string[];
	/** 本次首次发现的名称。 */
	newNames: string[];
	/** 是否是迁移状态首次建立。 */
	initialized: boolean;
}

function readState(): { seen: Set<string>; initialized: boolean } {
	try {
		const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<DiscoveryState>;
		return { seen: new Set(state.seen ?? []), initialized: state.version === 1 };
	} catch {
		return { seen: new Set(), initialized: false };
	}
}

function writeState(names: Iterable<string>): void {
	try {
		writeFileSync(
			STATE_PATH,
			JSON.stringify({ version: 1, seen: [...new Set(names)].sort() } satisfies DiscoveryState, null, 2) + "\n",
			{ encoding: "utf8", mode: 0o600 },
		);
	} catch {
		// 去重提示失败不影响技能发现和隐藏。
	}
}

function skillNameFromDir(dir: string): string | undefined {
	try {
		const { frontmatter } = parseFrontmatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
		return (frontmatter.name ?? basename(dir)).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** repo.toml 登记的第三方包名；读不到就返回空（宁可少管，不乱隐藏）。 */
export function managedPackageNames(): string[] {
	try {
		const entries = loadRepoConfig();
		return (entries ?? []).map((entry) => entry.name).filter((name) => name.length > 0);
	} catch {
		return [];
	}
}

/**
 * 递归扫描技能根；SKILL.md 所在目录是发现边界。
 * 传 packages 时只扫这些顶层包（登记第三方技能用），不传则整根扫描。
 */
export function scanExternalSkillNames(root: string = SKILLS_ROOT_DIR, packages?: Iterable<string>): string[] {
	const names: string[] = [];
	const walk = (dir: string): void => {
		if (!existsSync(dir)) return;
		if (existsSync(join(dir, "SKILL.md"))) {
			const name = skillNameFromDir(dir);
			if (name) names.push(relative(root, dir) + ":" + name);
			return;
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === ".git" || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
			walk(join(dir, entry.name));
		}
	};
	if (packages) {
		for (const pkg of packages) walk(join(root, pkg));
	} else {
		walk(root);
	}
	return [...new Set(names)].sort();
}

/**
 * 登记第三方技能包的技能名，并把首次发现项加入全局 hiddenSkills。
 * 返回值供扩展向用户打印“发现但未启用”的文本提示。
 */
export async function registerExternalSkills(cwd: string, projectTrusted: boolean): Promise<ExternalSkillDiscovery> {
	void cwd;
	void projectTrusted;
	const names = scanExternalSkillNames(SKILLS_ROOT_DIR, managedPackageNames());
	const previous = readState();
	const newNames = names.filter((name) => !previous.seen.has(name));
	const settings = await readSkillfulSettings(globalSkillfulPath());
	const hidden = new Set(settings.hiddenSkills);
	for (const identity of newNames) hidden.add(identity.split(":").at(-1)!);
	if (newNames.length > 0) await writeHiddenSkills("global", AGENT_DIR, hidden);
	writeState(names);
	return {
		path: SKILLS_ROOT_DIR,
		names: names.map((identity) => identity.split(":").at(-1)!),
		newNames: newNames.map((identity) => identity.split(":").at(-1)!),
		initialized: previous.initialized,
	};
}
