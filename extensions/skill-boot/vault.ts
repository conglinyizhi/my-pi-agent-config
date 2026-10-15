// vault.ts — 技能统一根的扫描与过渡期手动注入
//
// 技能发现、可见性、会话开关和列表管理交给 Pi / skillful。
// 2026-10-15 起本机所有技能（本地自写 + 第三方 clone）只放一个根：SKILLS_ROOT_DIR。
// 本模块只读取该根下的 SKILL.md，作为 /skill-boot <名> 的过渡期手动注入入口。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export const AGENT_DIR = getAgentDir();
/** 技能统一根：本机所有技能的唯一落点，同时是 pi 的 `~/.agents/skills` 发现根。 */
export const SKILLS_ROOT_DIR = join(homedir(), ".agents", "skills");
/** 旧 skill-vault 根：2026-10-15 起停用，只在迁移清理时引用。 */
export const LEGACY_SKILL_VAULT_DIR = join(AGENT_DIR, "skill-vault");
/** 旧 skills/external 软链入口：2026-10-15 起停用，只在迁移清理时引用。 */
export const LEGACY_SKILL_EXTERNAL_DIR = join(AGENT_DIR, "skills", "external");
/** 仓库清单：留在 AGENT_DIR（被 git 跟踪），技能的实体都在 SKILLS_ROOT_DIR。 */
export const REPO_TOML_PATH = join(AGENT_DIR, "skill-repo", "repo.toml");

export interface ManualSkill {
	name: string;
	description: string;
	path: string;
}

/** 扫描技能统一根，供 /skill-boot <名> 手动注入。 */
function scanVault(): ManualSkill[] {
	const out: ManualSkill[] = [];
	const walk = (dir: string, depth: number): void => {
		if (!existsSync(dir)) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const skillRoot = join(dir, entry.name);
			if (existsSync(join(skillRoot, "SKILL.md"))) {
				try {
					const content = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
					const { frontmatter } = parseFrontmatter(content);
					out.push({
						name: frontmatter.name ?? entry.name,
						description: frontmatter.description ?? "",
						path: join(skillRoot, "SKILL.md"),
					});
				} catch {
					// 跳过不可读技能
				}
			} else if (depth < 2) {
				walk(skillRoot, depth + 1);
			}
		}
	};
	walk(SKILLS_ROOT_DIR, 0);
	return out;
}

/** 读取当前 vault 中的手动注入候选。 */
export function loadManualSkills(): ManualSkill[] {
	return scanVault();
}

/** 按名字或路径查找技能；子串命中时优先最短名称。 */
export function findSkill(list: ManualSkill[], name: string): ManualSkill | undefined {
	const target = name.trim().toLowerCase();
	const exact = list.find((s) => s.name.toLowerCase() === target);
	if (exact) return exact;
	const bySubstring = list
		.filter((s) => s.name.toLowerCase().includes(target))
		.sort((a, b) => a.name.length - b.name.length)[0];
	if (bySubstring) return bySubstring;
	return list.find((s) => s.path.toLowerCase().includes(target));
}

/** 读取 SKILL.md 正文，剥离 frontmatter 并保留相对引用基目录。 */
export function readSkillBody(skill: ManualSkill): string {
	const content = readFileSync(skill.path, "utf8");
	const { body } = parseFrontmatter(content);
	const baseDir = dirname(skill.path);
	return `[手动注入 skill: ${skill.name}]\n技能目录（相对引用/脚本以此为准）: ${baseDir}\n\n${body.trim()}`;
}

/** 注入技能：读取正文并送入当前会话下一轮上下文。 */
export function injectSkill(pi: ExtensionAPI, skill: ManualSkill, ctx: ExtensionCommandContext): void {
	try {
		const body = readSkillBody(skill);
		pi.sendMessage(
			{
				customType: "dsh-skill-read",
				content: body,
				display: false,
				details: { skill: skill.name },
			},
			{ triggerTurn: true },
		);
		ctx.ui.notify(`已注入技能 ${skill.name}（${body.length} 字符）→ 模型下一轮读取。`, "info");
	} catch (err) {
		ctx.ui.notify(`注入失败: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}
