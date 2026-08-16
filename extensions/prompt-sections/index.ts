// prompt-sections — DSH 风格的有序段系统提示词组装（A/B 测试扩展）
//
// 做什么（详见 docs/plans/2026-08-15-dsh-architecture-migration.md §6）：
//   - 把 DSH system-prompt 的「有序段注册表 + 严格变量插值 + complete 段」移植到 pi
//   - before_agent_start 时按 order 升序装配：[-100 身份] [0 pi:default 默认提示词]
//     [50 策略] [100-199 工具指导] [200+ 动态]，渲染后作为本轮 systemPrompt
//   - 其他扩展在 factory 里用 lib/prompt-sections.ts 的 registerSection/registerVariable
//     无条件注册段（禁用时不会被装配，无需感知加载顺序）
//
// A/B 开关（对照 v0.1.0 tag）：
//   - settings.json 的 promptSections: true（持久，推荐）
//   - CLI: pi --prompt-sections（flag，会话内有效）
//   - 运行时: /prompt-sections on|off|status（写回 settings.json）
//   关闭 = 完全不改动系统提示词，保持 v0.1.0 行为。
//
// 装配失败安全回退：抛错只记录一次 warn，本轮保持链上现有提示词不动。
//
// 链式说明：扩展加载顺序是文件系统序（不可依赖）。本扩展的装配在链上任一位置都安全：
//   装配产出包含完整默认文本，skill-kit/tool-checker 等下游文本变换（占位符/技能过滤/追加）
//   无论在其前其后都能工作；母港模式（trident-routing）整体替换的意图保持优先。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	assemble,
	isPromptSectionsEnabled,
	registerVariable,
	renderPrompt,
	setPromptSectionsEnabled,
} from "../../lib/prompt-sections.ts";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

// ---------------------------------------------------------------------------
// settings.json 读写（风格对齐 settings-sync.ts；新字段会被 settings-sync 同步进 tracked）
// ---------------------------------------------------------------------------

function readSettings(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function writeSettings(patch: Record<string, unknown>): boolean {
	try {
		const data = readSettings();
		let changed = false;
		for (const [key, value] of Object.entries(patch)) {
			if (data[key] !== value) {
				data[key] = value;
				changed = true;
			}
		}
		if (!changed) return false;
		writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n");
		return true;
	} catch {
		return false; // 调用方（命令上下文）负责通知用户
	}
}

function settingsEnabled(): boolean {
	return readSettings().promptSections === true;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function fmtDate(): string {
	const d = new Date();
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtTime(): string {
	const d = new Date();
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// 启动时按 settings.json 初始化（flag 在运行时按次叠加判断）
	setPromptSectionsEnabled(settingsEnabled());

	pi.registerFlag("prompt-sections", {
		description: "启用 DSH 风格有序段系统提示词组装（A/B 测试；settings.json promptSections 亦可）",
		type: "boolean",
	});

	// 内建变量：{{model}} / {{cwd}} / {{date}} / {{time}}
	registerVariable("model", (ctx) => ctx.model);
	registerVariable("cwd", (ctx) => ctx.cwd);
	registerVariable("date", (ctx) => ctx.date);
	registerVariable("time", (ctx) => ctx.time);

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isPromptSectionsEnabled() && pi.getFlag("prompt-sections") !== true) return;

		const assembleContext = {
			cwd: ctx.cwd,
			model: ctx.model?.id,
			date: fmtDate(),
			time: fmtTime(),
			prompt: event.prompt,
			defaultSystemPrompt: event.systemPrompt,
		};
		try {
			const assembly = await assemble(assembleContext);
			const prompt = renderPrompt(assembly);
			if (!prompt) return; // 全部段为空 → 保持链上现状
			return { systemPrompt: prompt };
		} catch {
			return; // 装配失败静默回退：保持链上默认提示词；/prompt-sections-preview 可复现并显示错误
		}
	});

	// /prompt-sections on|off|status — 运行时开关（写回 settings.json 持久化）
	pi.registerCommand("prompt-sections", {
		description: "切换 DSH 风格系统提示词组装：on | off | status",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on") {
				setPromptSectionsEnabled(true);
				if (!writeSettings({ promptSections: true })) {
					ctx.ui.notify("prompt-sections: 已启用（本会话生效），但写回 settings.json 失败", "warning");
					return;
				}
				ctx.ui.notify("prompt-sections: 已启用（本会话立即生效）", "info");
			} else if (arg === "off") {
				setPromptSectionsEnabled(false);
				if (!writeSettings({ promptSections: false })) {
					ctx.ui.notify("prompt-sections: 已关闭（本会话生效），但写回 settings.json 失败", "warning");
					return;
				}
				ctx.ui.notify("prompt-sections: 已关闭，恢复 v0.1.0 提示词行为", "info");
			} else {
				const on = isPromptSectionsEnabled() || pi.getFlag("prompt-sections") === true;
				ctx.ui.notify(
					`prompt-sections: ${on ? "on" : "off"}（settings.json promptSections / --prompt-sections）`,
					"info",
				);
			}
		},
	});

	// 注册一个 /prompt-sections preview 预览命令（调试/验收用）：打印当前装配后的提示词前 60 行
	pi.registerCommand("prompt-sections-preview", {
		description: "预览 DSH 风格装配后的系统提示词（不改动当前会话）",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const base = ctx.getSystemPrompt?.();
			if (!isPromptSectionsEnabled() && pi.getFlag("prompt-sections") !== true) {
				ctx.ui.notify("prompt-sections 未启用（/prompt-sections on 或 settings.json）", "warning");
				return;
			}
			try {
				const assembly = await assemble({
					cwd: ctx.cwd,
					model: ctx.model?.id,
					date: fmtDate(),
					time: fmtTime(),
					prompt: "(preview)",
					defaultSystemPrompt: base ?? "(默认提示词不可用)",
				});
				const prompt = renderPrompt(assembly);
				const lines = prompt.split("\n").slice(0, 60);
				ctx.ui.notify(`[prompt-sections 预览 · ${prompt.length} 字符]\n${lines.join("\n")}`, "info");
			} catch (err) {
				ctx.ui.notify(
					`[prompt-sections] 装配失败: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}