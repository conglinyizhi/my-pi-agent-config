// sections.ts — 把规则注册成 prompt-sections 的段
//
// 注册时机：扩展 factory 期，**对配置里的每条规则都注册一个段**，不管当前 cwd。
// 求值时机：before_agent_start 装配时，段的 text 函数按 ctx.cwd 现场判定命中——
//   命中 → 读 md（带缓存）返回内容；不命中 → 返回 ""（prompt-sections 丢空段）。
// 这样做的理由：段注册集合在会话生命周期里是常量，只有文本随 cwd 变；
//   cwd 在同一次会话里是不动的，同一目录重复装配结果稳定，KV 前缀缓存不会抖。
//
// 读文件/读配置失败一律降级成空段 + 一条去重的 warn，绝不抛、不阻断其它段。
//
// 重复注册：pi 的 /reload 会重跑 factory，而 prompt-sections 的注册表是进程内单例
// （lib/prompt-sections.ts 用 processSingleton），旧注册不会自己消失。如果不管，从
// index.toml 删掉的规则仍会以旧路径继续注入。所以每次注册前先把本扩展上一轮的段注销掉，
// 用的是跨 reload 存活的 processSingleton 列表。

import type { AssembleContext } from "../../lib/prompt-sections.ts";
import { noteWarning, resetWarnings } from "./warnings.ts";
import { registerSection } from "../../lib/prompt-sections.ts";
import { processSingleton } from "../../lib/process-singleton.ts";
import type { Rule } from "./config.ts";
import { readTextCached } from "./content.ts";
import { isUnder, normalizePath } from "./match.ts";

/** 本扩展历次注册的段 disposer（跨 /reload 存活） */
const activeDisposers = processSingleton<Array<() => void>>("repo-prompts:sections", () => []);

function disposePrevious(): void {
	while (activeDisposers.length > 0) activeDisposers.pop()?.();
}

/** 段名：`repo:<name>` */
export function ruleSectionName(ruleName: string): string {
	return `repo:${ruleName}`;
}

/** 同一条问题只记一次（段每轮求值，不去重会把队列刷满） */
function warnOnce(message: string): void {
	noteWarning(message);
}

/** 仅供测试：清掉告警队列 */
export function resetWarned(): void {
	resetWarnings();
}

/** 规则的段文本：cwd 不命中 → ""；命中 → 内联文本 / md 内容 */
export function ruleText(rule: Rule, cwd: string): string {
	const normalized = normalizePath(cwd);
	if (!normalized) return "";
	if (!rule.paths.some((prefix) => isUnder(normalized, prefix))) return "";

	if (rule.text !== undefined) return rule.text;
	if (!rule.file) return "";

	const read = readTextCached(rule.file);
	if (!read.ok) {
		warnOnce(`规则 "${rule.name}" 读不了 ${rule.file}（${read.reason}），本轮按空段处理`);
		return "";
	}
	return read.text.trim();
}

export interface RegisteredSection {
	/** 段名（repo:<name>） */
	name: string;
	ruleName: string;
	order: number;
	paths: string[];
	file?: string;
	inline: boolean;
}

/**
 * 为每条规则注册一个段。
 * @returns sections：注册清单（/repo-prompts 展示用）；dispose：全部注销（测试用）
 */
export function registerRuleSections(rules: Rule[]): {
	sections: RegisteredSection[];
	dispose: () => void;
} {
	// /reload 后重跑：先清掉上一轮注册的段（含已从 index.toml 删掉的规则）
	disposePrevious();

	const disposers: Array<() => void> = [];
	const sections: RegisteredSection[] = [];

	for (const rule of rules) {
		const name = ruleSectionName(rule.name);
		const dispose = registerSection({
			name,
			order: rule.order,
			text: (ctx: AssembleContext) => ruleText(rule, ctx.cwd),
		});
		disposers.push(dispose);
		sections.push({
			name,
			ruleName: rule.name,
			order: rule.order,
			paths: rule.paths.slice(),
			file: rule.file,
			inline: rule.text !== undefined,
		});
	}

	activeDisposers.push(...disposers);

	return {
		sections,
		dispose: () => {
			for (const dispose of disposers) dispose();
		},
	};
}
