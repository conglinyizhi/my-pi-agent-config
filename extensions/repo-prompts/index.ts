// repo-prompts — 按目录（仓库）注入提示词段，规则集中放在 ~/.pi/agent/repo-prompts/
//
// 问题：有些提示词只在某个仓库里成立（如「preshell 升级走 A/B 流程」）。AGENTS.md 能做的事
// 要求每个仓库里放一份，改起来散、分发也散。
//
// 做法：集中存储 + 前缀匹配 + 注册成 prompt-sections 的段
//   ~/.pi/agent/repo-prompts/*.toml     规则表：name / paths / file|text / order
//   ~/.pi/agent/repo-prompts/<name>.md  每条规则一份正文
// 规则表不止一个文件：目录下所有 *.toml 按文件名序合并，同名规则后者覆盖前者（报告里可见）。
// 文件名不做特殊判断，所以「共享 / 私有」靠 git 而非扩展区分：
//   index.toml + preshell.md                共享（跟 agent 仓一起提交、可分发）
//   *.local.toml + *.local.md               私有（agent 仓 .gitignore 排除，只留本地）
// 想切换共享性就改文件名，不用动扩展。这个目录本身可以 git init + push 当分发单元（扩展不管 git）。
//
// 匹配：只看本地路径前缀（cwd === paths[i] 或其子目录）；不做 glob、不递归、不读远端。
// 注入：factory 期为**每条规则**注册一个段 `repo:<name>`（order 缺省 200），
//   段的 text 在装配时按 ctx.cwd 判定：命中读 md（按 mtime 缓存），不命中返回空串。
//   cwd 在同一次会话内不动 → 同一目录重复装配结果稳定，KV 前缀缓存不抖。
//
// 配置：extensions.toml 的 [repo-prompts]（enabled / dir），缺省开启 + 默认目录。
//   规则表改动要 /reload 才重注册段；md 正文改动下一轮装配即生效（mtime 缓存）。
// 命令：/repo-prompts 列出规则（含来自哪个 toml）、路径、当前 cwd 命中、文件可读性与已注册段。
// 告知：会话开始时会说一声注入了什么 —— notify 一次（醒目）+ 编辑器上方 widget 常驻（不会
//   像 toast 那样闪一下就没，见 widget.ts）。没命中规则时把 widget 清掉，保持零打扰。
//
// 与 pi 原生 AGENTS.md 的关系：共存，不替代。AGENTS.md 是仓库自带、面向任意 agent 的说明；
// 本扩展是提督侧的、面向 pi 的集中规则，两者会同时进上下文。

import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadRules, loadSettings } from "./config.ts";
import { buildReport } from "./report.ts";
import { injectedRules, registerRuleSections } from "./sections.ts";
import { noteWarning, takeWarnings } from "./warnings.ts";
import { buildWidgetLines, WIDGET_ID } from "./widget.ts";

const EXTENSIONS_TOML = join(getAgentDir(), "extensions.toml");

export default function (pi: ExtensionAPI) {
	const settings = loadSettings(EXTENSIONS_TOML);
	if (!settings.enabled) return;

	const loaded = loadRules(settings.dir);
	if (!loaded.found) {
		noteWarning(`还没有 ${loaded.configPath}（扩展在运行，但没配规则）`);
	}
	for (const error of loaded.errors) {
		noteWarning(error);
	}
	for (const note of loaded.notes) {
		noteWarning(note);
	}

	// 无条件注册（prompt-sections 关闭时装配不跑，注册本身无害）
	const { sections } = registerRuleSections(loaded.rules);

	// factory 期没有 ctx：告警先攒着，会话起来再交给 ui 发
	// （不要在扩展里用 console：pi 的 TUI 下 stderr 是它的地皮，用户也看不见）
	pi.on("session_start", (_event, ctx) => {
		const warnings = takeWarnings();
		for (const message of warnings) {
			try {
				ctx.ui.notify(`[repo-prompts] ${message}`, "warning");
			} catch {
				// 没有可用 UI 就算了，问题仍在 /repo-prompts 里看得到
			}
		}

		// 本目录的规则被注入了就说一声：让人知道上下文里多了什么、来自哪个文件
		const injected = injectedRules(loaded.rules, settings.dir, ctx.cwd);
		if (injected.length > 0) {
			try {
				ctx.ui.notify(`[repo-prompts] 本目录注入了 ${injected.length} 条规则`, "info");
			} catch {
				// 没有可用 UI：/repo-prompts 里仍能看到命中情况
			}
		}

		// notify 是 toast，几秒就没了（没看到就错过）。同样的话在编辑器上方常驻一份，
		// 想回看随时能看。没内容可说时传 undefined，不占地方。
		const lines = buildWidgetLines({ warnings, injected });
		try {
			ctx.ui.setWidget(WIDGET_ID, lines.length > 0 ? lines : undefined);
		} catch {
			// 没有可用 UI（json / print 模式）：跳过，报告仍在 /repo-prompts
		}
	});

	pi.registerCommand("repo-prompts", {
		description: "列出 repo-prompts 规则、当前 cwd 命中与本扩展注册的段",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			// 命令里重新读一遍规则表：改完配置立刻能在报告里看到差异
			const fresh = loadRules(settings.dir);
			ctx.ui.notify(
				buildReport({
					dir: settings.dir,
					loaded: fresh,
					registered: sections,
					cwd: ctx.cwd,
					enabled: true,
				}),
				"info",
			);
		},
	});
}
