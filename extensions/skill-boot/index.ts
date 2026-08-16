// skill-boot — 技能引导与管理（skill-kit + skill-manual 合并）
//
// 背景（2026-08-16 用户决策）：
//   - 除 data-name / git-commit / which-pi-docs 三个自动注入外，其余技能移入
//     skill-vault/（pi 不扫描 → 启动更快），需要时手动引导注入
//   - 两个旧扩展（skill-kit / skill-manual）合并为本扩展，命令统一为 skill-boot
//
// 命令：
//   /skill-boot            — 状态/用法
//   /skill-boot <名>       — 注入指定 SKILL.md 全文（原 skill-read）
//   /skill-boot:list       — TUI 技能列表（过滤 + 滚动，Enter 注入；原 skill-read:list）
//   /skill-manager         — 交互式启用/禁用（vault 软链接开关）
//
// 事件：
//   session_start   — 后台同步 skill-repo → vault 软链接 + widget 一行提示
//   before_agent_start — 占位符/日期/self-prompt/禁用过滤（沿用 skill-kit）

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	AGENT_DIR,
	buildManualSkillList,
	findSkill,
	injectSkill,
	skillPickerFactory,
	type ManualSkill,
} from "./vault.ts";
import {
	collectSkills,
	loadRepoConfig,
	loadState,
	saveState,
	syncSkillsAsync,
	toggleEnsureSymlink,
	toggleRemoveSymlink,
} from "./sync.ts";

const STATUS_KEY = "skill-boot";
const SELF_PROMPT_PATH = join(AGENT_DIR, "extensions", "skill-boot", "pi-self.md");

export default function (pi: ExtensionAPI) {
	let list: ManualSkill[] = [];
	const refresh = (): void => {
		list = buildManualSkillList();
	};

	// ---- session_start: 后台同步 + 常驻一行提示 ----
	pi.on("session_start", (_event, ctx) => {
		refresh();
		const manual = list.filter((s) => s.manualOnly);
		if (manual.length > 0) {
			ctx.ui.setWidget("skill-boot", [`🧩 ${manual.length} 个技能待引导 · /skill-boot:list`]);
		}

		const config = loadRepoConfig();
		if (!config || config.length === 0) return;
		const total = config.length;
		let done = 0;
		ctx.ui.setStatus(STATUS_KEY, `skill-syncing... [${done}/${total}]`);
		const tick = (): void => {
			done++;
			if (done < total) ctx.ui.setStatus(STATUS_KEY, `skill-syncing... [${done}/${total}]`);
		};
		syncSkillsAsync(tick)
			.then((results) => {
				const cloned = results.filter((r) => r.action === "cloned");
				const linked = results.filter((r) => r.action === "linked");
				const failed = results.filter((r) => r.action === "failed");
				if (failed.length > 0) {
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "skill-boot: !"));
					ctx.ui.notify(`skill-boot: ${failed.length} 个失败 — ${failed.map((r) => `${r.name}: ${r.error}`).join("; ")}`, "error");
				} else {
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", "skill-boot: ✓"));
				}
				const doneList: string[] = [];
				if (cloned.length > 0) doneList.push(`${cloned.length} 个 clone`);
				if (linked.length > 0) doneList.push(`${linked.length} 个软链接`);
				if (doneList.length > 0) ctx.ui.notify(`skill-boot: ${doneList.join("，")} 已完成`, "info");
			})
			.catch((err) => {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "skill-boot: !"));
				ctx.ui.notify(`skill-boot: 同步异常 — ${String(err instanceof Error ? err.message : err).slice(0, 200)}`, "error");
			});
	});

	// ---- session_shutdown: 清理 ----
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget("skill-boot", undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// ---- before_agent_start: 占位符/日期/self-prompt/禁用过滤 ----
	pi.on("before_agent_start", async (event, ctx) => {
		let prompt = event.systemPrompt;
		prompt = prompt.replaceAll("{{PI_README_PATH}}", getReadmePath());
		prompt = prompt.replaceAll("{{PI_DOCS_PATH}}", getDocsPath());
		prompt = prompt.replaceAll("{{PI_EXAMPLES_PATH}}", getExamplesPath());
		prompt = prompt.replace(/\nCurrent date: \d{4}-\d{2}-\d{2}/, "");
		if (ctx.cwd === AGENT_DIR) {
			try {
				const selfPrompt = readFileSync(SELF_PROMPT_PATH, "utf8");
				prompt += `\n\n${selfPrompt}`;
			} catch {
				/* 文件不存在 */
			}
		}
		// 过滤禁用技能（skill-manager 的 disabled + repo.toml disable_model_invocation）
		const disabled = new Set<string>();
		for (const name of loadState().disabled) disabled.add(name);
		const entries = loadRepoConfig();
		if (entries) {
			for (const e of entries) {
				if (e.disable_model_invocation) {
					disabled.add(e.name);
					for (const target of e.link_targets ?? []) disabled.add(target.split("/").pop() ?? target);
				}
			}
		}
		if (disabled.size > 0) {
			prompt = prompt.replace(/<skill>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<\/skill>/g, (_m, name) =>
				disabled.has(String(name).trim()) ? "" : _m,
			);
		}
		return { systemPrompt: prompt };
	});

	// ---- /skill-boot [name]：状态或注入 ----
	pi.registerCommand("skill-boot", {
		description: "引导技能：/skill-boot <名> 注入 SKILL.md 全文；无参数显示状态与用法",
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
				ctx.ui.notify(
					`技能库（${list.length}）· 手动引导候选（${manual.length}）\n` +
						`用法: /skill-boot <名> 注入 · /skill-boot:list 列表选择 · /skill-manager 开关\n` +
						`自动注入: ${list.filter((s) => !s.manualOnly).map((s) => s.name).join(", ") || "(无)"}`,
					"info",
				);
				return;
			}
			const skill = findSkill(list, name);
			if (!skill) {
				ctx.ui.notify(`技能不存在: ${name}（/skill-boot:list 查看）`, "error");
				return;
			}
			injectSkill(pi, skill, ctx);
		},
	});

	// ---- /skill-boot:list：TUI 技能列表（过滤 + 滚动） ----
	pi.registerCommand("skill-boot:list", {
		description: "TUI 技能列表：输入过滤、↑↓/jk 滚动、Enter 注入、Esc 取消",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/skill-boot:list 仅支持 TUI 模式（RPC 用 /skill-boot <名>）", "warning");
				return;
			}
			if (list.length === 0) refresh();
			const skill = await ctx.ui.custom<ManualSkill | undefined>((tui, theme, _kb, done) =>
				skillPickerFactory(list, tui, theme, done),
			);
			if (skill) {
				injectSkill(pi, skill, ctx);
			} else {
				ctx.ui.notify("已取消技能选择", "info");
			}
		},
	});

	// ---- /skill-manager：交互式启用/禁用（vault 软链接开关） ----
	pi.registerCommand("skill-manager", {
		description: "管理已导入的技能（开启/关闭）",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("skill-manager 仅支持 TUI 模式", "error");
				return;
			}
			const toggled = new Set<string>();
			while (true) {
				const skills = collectSkills();
				if (skills.length === 0) {
					ctx.ui.notify("没有已导入的技能", "info");
					return;
				}
				interface LabelEntry {
					label: string;
					type: "group" | "leaf";
					skillNames: string[];
				}
				const labelEntries: LabelEntry[] = [];
				const seenGroups = new Set<string>();
				for (const skill of skills) {
					if (skill.source.startsWith("bundle:")) {
						const groupName = skill.source.slice(7);
						if (!seenGroups.has(groupName)) {
							seenGroups.add(groupName);
							const groupSkills = skills.filter((s) => s.source === skill.source);
							const enabled = groupSkills.filter((s) => s.enabled).length;
							const total = groupSkills.length;
							const status = enabled === total ? "全部启用" : enabled === 0 ? "全部禁用" : `已启用 ${enabled}/${total}`;
							labelEntries.push({ label: `▸ ${groupName}（${status}）`, type: "group", skillNames: groupSkills.map((s) => s.name) });
						}
						labelEntries.push({
							label: `  ${skill.enabled ? "●" : "○"} ${skill.name}  ${skill.enabled ? "" : "(已禁用)"}`,
							type: "leaf",
							skillNames: [skill.name],
						});
					} else {
						labelEntries.push({
							label: `${skill.enabled ? "●" : "○"} ${skill.name}  ${skill.enabled ? "" : "(已禁用)"}`,
							type: "leaf",
							skillNames: [skill.name],
						});
					}
				}
				const choice = await ctx.ui.select("技能开关 — 选中翻转，Esc 退出", labelEntries.map((e) => e.label));
				if (choice === undefined) break;
				const hit = labelEntries.find((e) => e.label === choice);
				if (!hit) continue;
				const state = loadState();
				if (hit.type === "group") {
					const allEnabled = hit.skillNames.every((n) => !state.disabled.includes(n));
					for (const name of hit.skillNames) {
						if (allEnabled) {
							if (!state.disabled.includes(name)) {
								state.disabled.push(name);
								toggleRemoveSymlink(name);
								toggled.add(name);
							}
						} else {
							state.disabled = state.disabled.filter((n) => n !== name);
							toggleEnsureSymlink(name);
							toggled.add(name);
						}
					}
					saveState(state);
					ctx.ui.notify(`已${allEnabled ? "禁用" : "启用"} ${hit.skillNames.length} 个技能`, "info");
				} else {
					const name = hit.skillNames[0];
					const wasDisabled = state.disabled.includes(name);
					if (wasDisabled) {
						state.disabled = state.disabled.filter((n) => n !== name);
						toggleEnsureSymlink(name);
					} else {
						state.disabled.push(name);
						toggleRemoveSymlink(name);
					}
					saveState(state);
					toggled.add(name);
					ctx.ui.notify(`已${wasDisabled ? "启用" : "禁用"} ${name}`, "info");
				}
			}
			if (toggled.size > 0) {
				ctx.ui.notify(`共切换 ${toggled.size} 个技能：${[...toggled].join(", ")}`, "info");
			}
		},
	});
}
