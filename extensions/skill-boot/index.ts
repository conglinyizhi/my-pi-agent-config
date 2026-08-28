// skill-boot — 技能来源同步 + 过渡期手动注入
//
// 职责边界：
//   - sync.ts 负责 repo.toml 中外部技能仓库的 clone 与 skill-vault 软链接
//   - 本文件只保留按名称读取 vault 技能并注入当前会话
//   - 技能发现、可见性、会话开关和列表管理交给 Pi / skillful
//
// 命令：
//   /skill-boot            — 显示用法
//   /skill-boot <名>       — 注入指定 SKILL.md 全文
//
// 迁移完成后，手动注入也可以移除；在此之前保留作为兼容入口。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { findSkill, injectSkill, loadManualSkills } from "./vault.ts";
import { loadRepoConfig, syncSkillsAsync } from "./sync.ts";

const STATUS_KEY = "skill-boot";

export default function (pi: ExtensionAPI) {
	// ---- session_start：只做来源同步，不扫描/过滤/管理技能 ----
	pi.on("session_start", (_event, ctx) => {
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
					ctx.ui.notify(`skill-boot: ${failed.length} 个仓库同步失败 — ${failed.map((r) => `${r.name}: ${r.error}`).join("; ")}`, "error");
				} else {
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", "skill-boot: ✓"));
				}
				const changed = [...cloned, ...linked];
				if (changed.length > 0) {
					ctx.ui.notify(`skill-boot: ${changed.length} 个技能来源已更新`, "info");
				}
			})
			.catch((err) => {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "skill-boot: !"));
				ctx.ui.notify(`skill-boot: 同步异常 — ${String(err instanceof Error ? err.message : err).slice(0, 200)}`, "error");
			});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// ---- /skill-boot [name]：过渡期手动注入 ----
	pi.registerCommand("skill-boot", {
		description: "过渡期手动注入 vault 技能：/skill-boot <名>；技能列表与开关由 Pi/skillful 管理",
		getArgumentCompletions: (prefix) => loadManualSkills()
			.filter((skill) => skill.name.toLowerCase().includes(prefix.toLowerCase()))
			.map((skill) => ({ value: skill.name, label: skill.name, description: skill.description })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const name = (args ?? "").trim();
			if (!name) {
				ctx.ui.notify(
					"skill-boot 现在只负责技能来源同步与过渡期手动注入。用 /skill-boot <名> 注入；技能发现、隐藏和会话开关交给 Pi/skillful。",
					"info",
				);
				return;
			}

			const skill = findSkill(loadManualSkills(), name);
			if (!skill) {
				ctx.ui.notify(`vault 中不存在技能：${name}`, "error");
				return;
			}
			injectSkill(pi, skill, ctx);
		},
	});
}
