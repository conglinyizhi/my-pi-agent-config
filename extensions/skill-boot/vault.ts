// vault.ts — 技能清单与手动注入（合并自 skill-manual）
//
// 技能存放：
//   - skill-vault/          手动注入技能（pi 不扫描；第三方软链接 + clyzhi 自写目录）
//   - ~/.agents/skills/     跨 agent 通用（data-name/git-commit，pi 扫描 → 自动注入）
//   - skills/clyzhi/        自动注入（which-pi-docs，pi 扫描）
// 清单合并三个来源；manualOnly 判定：frontmatter 或 repo.toml 的 disable 标记。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { join, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { parseFrontmatter } from "./frontmatter.ts";

export const AGENT_DIR = getAgentDir();
/** 手动注入技能仓库（pi 不扫描，仅本扩展读取） */
export const SKILL_VAULT_DIR = join(AGENT_DIR, "skill-vault");
/** pi 扫描的通用技能位置（自动注入） */
export const AGENTS_SKILLS_DIR = join(homedir(), ".agents", "skills");
/** pi 扫描的自写技能位置（自动注入） */
export const AUTO_SKILLS_DIR = join(AGENT_DIR, "skills");
export const REPO_TOML_PATH = join(AGENT_DIR, "skill-repo", "repo.toml");

export interface ManualSkill {
	name: string;
	description: string;
	path: string;
	/** 不可自动注入（frontmatter 或 repo.toml 标记）→ 手动注入候选 */
	manualOnly: boolean;
}

/** 递归扫描一个根目录下所有 SKILL.md（含软链接） */
function scanRoot(root: string): ManualSkill[] {
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
			if (depth < 2 && existsSync(join(skillRoot, "SKILL.md"))) {
				try {
					const content = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
					const { frontmatter } = parseFrontmatter(content);
					out.push({
						name: frontmatter.name ?? entry.name,
						description: frontmatter.description ?? "",
						path: join(skillRoot, "SKILL.md"),
						manualOnly: frontmatter["disable-model-invocation"] === true,
					});
				} catch {
					// 跳过不可读技能
				}
			} else if (depth < 2) {
				walk(skillRoot, depth + 1);
			}
		}
	};
	walk(root, 0);
	return out;
}

/** 从 repo.toml 读 disable_model_invocation（第三方技能 frontmatter 会被 pull 覆盖）；bundle 子技能展开 */
function repoTomlDisableSet(): Set<string> {
	const disabled = new Set<string>();
	try {
		const doc = parseToml(readFileSync(REPO_TOML_PATH, "utf8")) as {
			skills?: Array<{ name?: string; disable_model_invocation?: boolean; link_targets?: string[] }>;
		};
		for (const s of doc.skills ?? []) {
			if (!s.name || !s.disable_model_invocation) continue;
			disabled.add(s.name);
			for (const target of s.link_targets ?? []) {
				disabled.add(target.split("/").pop() ?? target);
			}
		}
	} catch {
		// repo.toml 缺失/损坏 → 空集合
	}
	return disabled;
}

/** 完整清单：skill-vault（手动）+ ~/.agents/skills + skills/（自动） */
export function buildManualSkillList(): ManualSkill[] {
	const repoDisabled = repoTomlDisableSet();
	const sources = [SKILL_VAULT_DIR, AGENTS_SKILLS_DIR, AUTO_SKILLS_DIR];
	const list: ManualSkill[] = [];
	for (const root of sources) {
		for (const s of scanRoot(root)) {
			list.push({ ...s, manualOnly: s.manualOnly || repoDisabled.has(s.name) });
		}
	}
	return list;
}

/** 按名字（或路径子串）找技能；子串命中时优先最短名 */
export function findSkill(list: ManualSkill[], name: string): ManualSkill | undefined {
	const target = name.trim().toLowerCase();
	const exact = list.find((s) => s.name.toLowerCase() === target) ?? list.find((s) => s.name === target);
	if (exact) return exact;
	const bySubstring = list
		.filter((s) => s.name.toLowerCase().includes(target))
		.sort((a, b) => a.name.length - b.name.length)[0];
	if (bySubstring) return bySubstring;
	return list.find((s) => s.path.toLowerCase().includes(target));
}

/** 读取 SKILL.md 正文（frontmatter 剥离），附加说明头 */
export function readSkillBody(skill: ManualSkill): string {
	const content = readFileSync(skill.path, "utf8");
	const { body } = parseFrontmatter(content);
	const baseDir = dirname(skill.path);
	const rel = relative(AGENT_DIR, baseDir);
	return `[手动注入 skill: ${skill.name}]\n技能目录（相对引用/脚本以此为准）: ${AGENT_DIR}/${rel}\n\n${body.trim()}`;
}

/** 注入技能：读 SKILL.md 全文 → sendMessage 进会话上下文 */
export function injectSkill(pi: ExtensionAPI, skill: ManualSkill, ctx: ExtensionCommandContext): void {
	try {
		const body = readSkillBody(skill);
		pi.sendMessage(
			{
				customType: "dsh-skill-read",
				content: body,
				display: false,
				details: { skill: skill.name, manualOnly: skill.manualOnly },
			},
			{ triggerTurn: true },
		);
		ctx.ui.notify(
			`已注入技能 ${skill.name}（${body.length} 字符）→ 模型下一轮读取。${skill.manualOnly ? "" : "（该技能本可自动注入）"}`,
			"info",
		);
	} catch (err) {
		ctx.ui.notify(`注入失败: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

/** TUI 技能列表选择器：输入过滤 + ↑↓/jk 滚动 + Enter 注入 + Esc 取消 */
export function skillPickerFactory(
	list: ManualSkill[],
	tui: TUI,
	theme: Theme,
	done: (skill: ManualSkill | undefined) => void,
): { render: () => string[]; invalidate: () => void; handleInput: (data: string) => void } {
	let query = "";
	let selected = 0;
	const WINDOW = 18;

	const filtered = (): ManualSkill[] => {
		const q = query.trim().toLowerCase();
		if (!q) return list;
		return list.filter(
			(s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
		);
	};

	const render = (): string[] => {
		const lines: string[] = [];
		lines.push(theme.fg("accent", `技能列表（${list.length}）· 过滤 ${filtered().length}`));
		lines.push(theme.fg("dim", `搜索: ${query}▌`));
		lines.push("");
		const items = filtered();
		if (items.length === 0) {
			lines.push(theme.fg("warning", "(无匹配，按 Backspace 清空搜索)"));
		} else {
			const total = items.length;
			let start = Math.max(0, Math.min(selected - Math.floor(WINDOW / 2), total - WINDOW));
			if (start < 0) start = 0;
			const end = Math.min(total, start + WINDOW);
			for (let i = start; i < end; i++) {
				const s = items[i];
				const prefix = i === selected ? theme.fg("accent", "▸ ") : "  ";
				const name = i === selected ? theme.fg("text", s.name) : s.name;
				const marker = s.manualOnly ? "" : theme.fg("success", " ★");
				const desc = s.description
					? theme.fg("dim", ` — ${truncateToWidth(s.description, 36)}`)
					: "";
				lines.push(`${prefix}${name}${marker}${desc}`);
			}
			if (total > end) lines.push(theme.fg("dim", `… 还有 ${total - end} 项`));
		}
		lines.push("");
		lines.push(theme.fg("dim", "输入过滤 · Backspace 清除 · ↑↓/jk 选择 · Enter 注入 · Esc 取消（★ = 自动注入）"));
		return lines;
	};

	const handleInput = (data: string): void => {
		if (data.length > 0 && !data.startsWith("\x1b") && data !== "\n" && data !== "\r" && data !== "\t" && data !== "\b") {
			query += data;
			selected = 0;
			tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			query = query.slice(0, -1);
			selected = 0;
			tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			selected = Math.max(0, selected - 1);
			tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			const items = filtered();
			selected = Math.min(items.length - 1, selected + 1);
			tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const items = filtered();
			done(items[selected]);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			done(undefined);
			return;
		}
	};

	return { render, invalidate: () => undefined, handleInput };
}
