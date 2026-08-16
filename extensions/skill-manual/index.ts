// skill-manual — 手动注入技能：已安装但不可自动注入的清单 + /skill-read 注入命令
//
// 背景（用户决策 2026-08-16）：系统提示词里的技能目录（<available_skills>）与
// skill-kit 的 trigger 预检表给模型加认知负担。改为「自动识别范围缩小、手动注入为主」：
//   - 大部分技能 SKILL.md frontmatter 标 disable-model-invocation: true（或 repo.toml
//     标 disable_model_invocation）→ 不出现在 <available_skills>，模型不会自动读
//   - 需要时由人主动注入：本扩展的 /skill-read <name> 把 SKILL.md 全文注入会话上下文
//   - TUI 常驻区域（setWidget）展示「已安装但不可自动注入」的候选清单，提示可注入
//
// 数据源：
//   - ~/.pi/agent/skills/**/SKILL.md 的 frontmatter（name/description/disable-model-invocation）
//   - ~/.pi/agent/skill-repo/repo.toml 的 [[skills]]（name/description/disable_model_invocation）

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";

const AGENT_DIR = getAgentDir();
const SKILLS_DIR = join(AGENT_DIR, "skills");
/** 跨 agent 通用技能位置（git-commit/data-name 等已移入） */
const AGENTS_SKILLS_DIR = join(homedir(), ".agents", "skills");
const REPO_TOML_PATH = join(AGENT_DIR, "skill-repo", "repo.toml");

// ---------------------------------------------------------------------------
// frontmatter 解析（YAML 头：--- 之间的 key: value；支持块标量 >/ >-/ |/ |-
// 的 description 折叠块——第三方技能大量使用，简单正则会把块标记 `>-` 解析成
// 字面 ">-" 导致摘要显示成「大于号+减号」）
// ---------------------------------------------------------------------------

interface Frontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
}

/** YAML 折叠块标量标记（`>` 折叠 / `|` 字面，`-` strip / `+` keep） */
const BLOCK_SCALAR_RE = /^([a-zA-Z0-9_-]+):\s*(>|\||>\||>-|\|\+|\|-)\s*$/;

/** 拼接折叠块内容（简化 YAML 语义：`>` 换行折叠为空格、`|` 保留换行，`-` strip 尾换行） */
function joinBlockScalar(lines: string[], kind: string): string {
	let start = 0;
	while (start < lines.length && lines[start].trim() === "") start++;
	const content = lines.slice(start);
	if (content.length === 0) return "";
	const baseIndent = content[0].match(/^\s*/)?.[0].length ?? 0;
	const body = content
		.map((line) => (line.trim() === "" ? "" : line.slice(baseIndent)))
		.join("\n");
	const isLiteral = kind.startsWith("|");
	const strip = kind.endsWith("-");
	if (isLiteral) {
		return strip ? body.replace(/\n+$/, "") : body.replace(/\n+$/, "\n");
	}
	// 折叠块：非空行间换行 → 空格，空行保留为换行
	const folded = body
		.split("\n")
		.map((line, i, arr) => {
			if (line === "") return "\n";
			if (i > 0 && arr[i - 1] !== "" && !line.endsWith(" ")) return " " + line;
			return line;
		})
		.join("");
	return (strip ? folded.replace(/\s+$/, "") : folded.replace(/\s+$/, "") + "\n");
}

export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
	const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
	if (!m) return { frontmatter: {}, body: content };
	const fm: Frontmatter = {};
	const lines = m[1].split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const block = BLOCK_SCALAR_RE.exec(line.trim());
		if (block) {
			const collected: string[] = [];
			let j = i + 1;
			while (j < lines.length && (lines[j].startsWith(" ") || lines[j].startsWith("\t") || lines[j].trim() === "")) {
				collected.push(lines[j]);
				j++;
			}
			fm[block[1] as keyof Frontmatter] = joinBlockScalar(collected, block[2]) as never;
			i = j;
			continue;
		}
		const kv = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line.trim());
		if (kv) {
			const value = kv[2].trim();
			if (value === "true") fm[kv[1] as keyof Frontmatter] = true as never;
			else if (value === "false") fm[kv[1] as keyof Frontmatter] = false as never;
			else fm[kv[1] as keyof Frontmatter] = value.replace(/^["']|["']$/g, "") as never;
		}
		i++;
	}
	return { frontmatter: fm, body: m[2] };
}

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

export interface ManualSkill {
	name: string;
	description: string;
	path: string;
	/** 不可自动注入（frontmatter 或 repo.toml 标记）→ 手动注入候选 */
	manualOnly: boolean;
}

/** 递归扫描 skills/ 与 ~/.agents/skills/ 下所有 SKILL.md（含软链接；自写技能在二级目录） */
function scanSkillDirs(): ManualSkill[] {
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
				// 该目录是技能根
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
	walk(SKILLS_DIR, 0);
	walk(AGENTS_SKILLS_DIR, 0);
	return out;
}

/** 从 repo.toml 读 disable_model_invocation（第三方技能，frontmatter 会被 pull 覆盖）；bundle 子技能一并展开 */
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

/** 完整清单：frontmatter 标记 + repo.toml 标记合并 */
export function buildManualSkillList(): ManualSkill[] {
	const list = scanSkillDirs();
	const repoDisabled = repoTomlDisableSet();
	return list.map((s) => ({
		...s,
		manualOnly: s.manualOnly || repoDisabled.has(s.name),
	}));
}

/** 按名字（或路径子串）找技能；子串命中时优先最短名（更贴近用户意图） */
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

// ---------------------------------------------------------------------------
// 扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let list: ManualSkill[] = [];

	const refresh = (): void => {
		list = buildManualSkillList();
	};

	pi.on("session_start", (_event, ctx) => {
		refresh();
		// TUI 常驻区域：一行提示（完整清单按需查询：/skill-read 无参数 或 /skill-manual-status）
		const manual = list.filter((s) => s.manualOnly);
		if (manual.length === 0) {
			ctx.ui.setWidget("skill-manual", undefined);
			return;
		}
		ctx.ui.setWidget("skill-manual", [`🧩 ${manual.length} 个技能待手动注入 · /skill-read <名>`]);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget("skill-manual", undefined);
	});

	// /skill-read <name>：手动注入 SKILL.md 全文到会话上下文
	pi.registerCommand("skill-read", {
		description: "手动注入技能：把指定 SKILL.md 全文加入会话上下文（用于不可自动注入的技能）",
		getArgumentCompletions: (prefix) => {
			if (list.length === 0) refresh();
			return list
				.filter((s) => s.name.includes(prefix))
				.map((s) => ({ value: s.name, label: s.name, description: s.description }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (list.length === 0) refresh();
			const name = (args ?? "").trim();
			if (!name) {
				const manual = list.filter((s) => s.manualOnly);
				const all = list.map((s) => s.name);
				ctx.ui.notify(
					`可用技能（${all.length}）: ${all.join(", ")}\n手动注入候选（${manual.length}）: ${manual.map((s) => s.name).join(", ")}\n用法: /skill-read <名>`,
					"info",
				);
				return;
			}
			const skill = findSkill(list, name);
			if (!skill) {
				ctx.ui.notify(`技能不存在: ${name}`, "error");
				return;
			}
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
		},
	});

	// /skill-manual-status：刷新并列出当前手动注入候选（无 UI 时的查询面）
	pi.registerCommand("skill-manual-status", {
		description: "刷新并显示手动注入技能候选清单",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			refresh();
			const manual = list.filter((s) => s.manualOnly);
			if (manual.length === 0) {
				ctx.ui.notify("当前无「不可自动注入」技能（全部自动可见）", "info");
				return;
			}
			ctx.ui.notify(`手动注入候选（${manual.length}）:\n${manual.map((s) => s.name).join("\n")}`, "info");
		},
	});
}
