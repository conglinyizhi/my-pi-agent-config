// vault.ts — skill-vault 中技能的过渡期手动注入
//
// 技能发现、可见性、会话开关和列表管理交给 Pi / skillful。
// 本模块只读取 skill-vault 中由 skill-boot 同步层暴露的技能，作为迁移期间的兼容入口。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { join, dirname, relative } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export const AGENT_DIR = getAgentDir();
/** 迁移前的兼容入口；只保留本地过渡技能和手动注入兼容。 */
export const SKILL_VAULT_DIR = join(AGENT_DIR, "skill-vault");
/** 外部技能的正式 Pi 发现入口。 */
export const SKILL_EXTERNAL_DIR = join(AGENT_DIR, "skills", "external");
export const REPO_TOML_PATH = join(AGENT_DIR, "skill-repo", "repo.toml");

export interface ManualSkill {
	name: string;
	description: string;
	path: string;
}

/** 扫描兼容 vault 与正式外部技能入口，供迁移期 /skill-boot 注入兼容。 */
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
	walk(SKILL_VAULT_DIR, 0);
	walk(SKILL_EXTERNAL_DIR, 0);
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
	const rel = relative(AGENT_DIR, baseDir);
	return `[手动注入 skill: ${skill.name}]\n技能目录（相对引用/脚本以此为准）: ${AGENT_DIR}/${rel}\n\n${body.trim()}`;
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
