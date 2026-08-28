// skill visibility — migrated from pi-skillful 0.4.0, Copyright (c) 2026 Jose Mocito, MIT.
//
// 本地精简版负责技能显隐管理：
//   - 全局/项目作用域与项目继承
//   - 单个技能、来源组、全部技能的批量切换
//   - Enter 统一保存，Esc 放弃本轮修改
//
// 不迁移 session toggle 和 startup UI patch。

import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Skill, Theme } from "@earendil-works/pi-coding-agent";
import {
	readEffectiveHiddenSkills,
	readScopedHiddenSkills,
	writeHiddenSkills,
	type SkillfulScope,
} from "../config.ts";
import { replaceSkillsSection } from "../skill-prompt.ts";
import { listLoadedSkills } from "../skills.ts";
import {
	buildVisibilityRows,
	rowState,
	setAllVisible,
	toggleVisibleNames,
	type VisibilityRow,
} from "./visibility-model.ts";

interface SelectorResult {
	action: "save" | "cancel";
	hidden: string[];
}

export default function skillVisibility(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const hidden = await readEffectiveHiddenSkills(ctx.cwd, ctx.isProjectTrusted());
		if (hidden.size === 0 || !event.systemPromptOptions.skills?.length) return;

		const filteredSkills: Skill[] = event.systemPromptOptions.skills.map((skill) =>
			hidden.has(skill.name)
				? { ...skill, disableModelInvocation: true }
				: skill,
		);
		const systemPrompt = replaceSkillsSection(event.systemPrompt, filteredSkills);
		if (systemPrompt) return { systemPrompt };
	});

	pi.registerCommand("skillful", {
		description: "批量管理模型可见性：Space 单项/来源组，v 全部可见，h 全部隐藏，Enter 保存，Esc 放弃",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/skillful 需要 TUI 模式", "warning");
				return;
			}

			const requestedScope = (args ?? "").trim().toLowerCase();
			const scope: SkillfulScope = requestedScope === "project" ? "project" : "global";
			const projectTrusted = ctx.isProjectTrusted();
			if (scope === "project" && !projectTrusted) {
				ctx.ui.notify("当前项目未受信，不能修改项目级 skillful 设置", "warning");
				return;
			}

			// 不按 origin 过滤：用户需要能按 Pi skill package/source 批量管理，
			// 且界面中的来源组必须和实际过滤效果一致。
			const loaded = listLoadedSkills(pi.getCommands());
			if (loaded.length === 0) {
				ctx.ui.notify("当前没有已加载的技能", "info");
				return;
			}

			const scoped = await readScopedHiddenSkills(ctx.cwd, projectTrusted);
			const hidden = new Set(
				scope === "project" && !scoped.project.defined
					? scoped.global.hiddenSkills
					: scoped[scope].hiddenSkills,
			);
			const rows = buildVisibilityRows(loaded);
			const result = await ctx.ui.custom<SelectorResult>((tui, theme, _keybindings, done) =>
				new VisibilitySelector({ rows, hidden, tui, theme, done }),
			);

			if (!result || result.action !== "save") return;
			try {
				await writeHiddenSkills(scope, ctx.cwd, result.hidden, projectTrusted);
				ctx.ui.notify(`skillful：已保存 ${result.hidden.length} 个隐藏技能（${scope}）`, "info");
			} catch (error) {
				ctx.ui.notify(`保存 skillful 设置失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

interface VisibilitySelectorOptions {
	rows: VisibilityRow[];
	hidden: Set<string>;
	tui: TUI;
	theme: Pick<Theme, "fg" | "bold">;
	done: (result: SelectorResult) => void;
}

/**
 * 事务式多选组件：组件内部只改 working set，真正写 settings 在 Enter 之后执行一次。
 */
class VisibilitySelector implements Component {
	private readonly rows: VisibilityRow[];
	private readonly hidden: Set<string>;
	private readonly tui: TUI;
	private readonly theme: VisibilitySelectorOptions["theme"];
	private readonly done: VisibilitySelectorOptions["done"];
	private selected = 0;
	private scroll = 0;

	constructor(options: VisibilitySelectorOptions) {
		this.rows = options.rows;
		this.hidden = new Set(options.hidden);
		this.tui = options.tui;
		this.theme = options.theme;
		this.done = options.done;
	}

	render(width: number): string[] {
		const maxRows = 18;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.rows.length - maxRows)));
		const visible = this.rows.slice(this.scroll, this.scroll + maxRows);
		const lines: string[] = [];
		const allNames = this.rows[0]?.skillNames ?? [];
		const visibleCount = allNames.filter((name) => !this.hidden.has(name)).length;

		lines.push(this.theme.fg("accent", this.theme.bold("skillful · 模型可见性")));
		lines.push(this.theme.fg("dim", `可见 ${visibleCount}/${allNames.length} · Space 切换 · v 全部可见 · h 全部隐藏 · Enter 保存 · Esc 放弃`));
		lines.push("");
		for (let i = 0; i < visible.length; i++) {
			const absolute = this.scroll + i;
			const row = visible[i]!;
			const state = rowState(this.hidden, row.skillNames);
			const marker = state === "hidden" ? "[ ]" : state === "partial" ? "[~]" : "[x]";
			const cursor = absolute === this.selected ? this.theme.fg("accent", "▸ ") : "  ";
			const indent = "  ".repeat(row.depth);
			const label = row.kind === "group" ? `来源组：${row.label}` : row.label;
			const coloredMarker = state === "hidden" ? this.theme.fg("dim", marker) : this.theme.fg("success", marker);
			lines.push(truncateToWidth(`${cursor}${indent}${coloredMarker} ${label}`, width));
		}
		if (this.rows.length > maxRows) {
			lines.push(this.theme.fg("dim", `第 ${this.selected + 1}/${this.rows.length} 项`));
		}
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done({ action: "cancel", hidden: [] });
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.done({ action: "save", hidden: [...this.hidden].sort() });
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
			this.keepSelectedVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(this.rows.length - 1, this.selected + 1);
			this.keepSelectedVisible();
			this.tui.requestRender();
			return;
		}
		if (data === " " || data === "v" || data === "V" || data === "h" || data === "H") {
			const row = data === " " ? this.rows[this.selected] : this.rows[0];
			if (row) {
				const next = data === " "
					? toggleVisibleNames(this.hidden, row.skillNames)
					: setAllVisible(this.hidden, row.skillNames, data === "v" || data === "V");
				this.hidden.clear();
				for (const name of next) this.hidden.add(name);
			}
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		// 状态全在组件内，TUI 会在 requestRender 后重新调用 render。
	}

	private keepSelectedVisible(): void {
		const maxRows = 18;
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + maxRows) this.scroll = this.selected - maxRows + 1;
	}
}

