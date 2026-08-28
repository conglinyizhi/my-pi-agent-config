// external-skills — skillful-local 管理 skills/external 的默认隐藏状态

import { existsSync, readFileSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { basename, join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	readSkillfulSettings,
	writeHiddenSkills,
	globalSettingsPath,
} from "./config.ts";
import { parseFrontmatter } from "../../skill-boot/frontmatter.ts";

const AGENT_DIR = getAgentDir();
export const EXTERNAL_SKILLS_DIR = join(AGENT_DIR, "skills", "external");
const STATE_PATH = join(AGENT_DIR, "skillful-discovery-state.json");

interface DiscoveryState {
	version: 1;
	seen: string[];
}

export interface ExternalSkillDiscovery {
	/** Pi 应该额外发现的正式入口。 */
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

/** 递归扫描 skills/external；SKILL.md 所在目录是发现边界。 */
export function scanExternalSkillNames(root = EXTERNAL_SKILLS_DIR): string[] {
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
	walk(root);
	return [...new Set(names)].sort();
}

/**
 * 登记外部技能并把首次发现项加入全局 hiddenSkills。
 * 返回值供扩展向用户打印“发现但未启用”的文本提示。
 */
export async function registerExternalSkills(cwd: string, projectTrusted: boolean): Promise<ExternalSkillDiscovery> {
	void cwd;
	void projectTrusted;
	const names = scanExternalSkillNames();
	const previous = readState();
	const newNames = names.filter((name) => !previous.seen.has(name));
	const settings = await readSkillfulSettings(globalSettingsPath());
	const hidden = new Set(settings.hiddenSkills);
	for (const identity of newNames) hidden.add(identity.split(":").at(-1)!);
	if (newNames.length > 0) await writeHiddenSkills("global", AGENT_DIR, hidden);
	writeState(names);
	return {
		path: EXTERNAL_SKILLS_DIR,
		names: names.map((identity) => identity.split(":").at(-1)!),
		newNames: newNames.map((identity) => identity.split(":").at(-1)!),
		initialized: previous.initialized,
	};
}
