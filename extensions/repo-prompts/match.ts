// match.ts — 路径归一化与前缀匹配（纯函数，无 fs、无 pi 依赖）
//
// 匹配规则只有一条：**本地路径前缀**。
//   cwd === prefix            → 命中
//   cwd 以 prefix + "/" 开头  → 命中
// 两边都先归一化（~ 展开、去掉 `.`/`..`/重复斜线、去尾斜线）。
//
// 刻意不做：glob、递归推断、读 git 远端、realpath（软链不追，符号链只是目录项）。
// 副作用是「前缀相似但不包含」不会误命中：/a/bc 不在 /a/b 下，/a 也不在 /a/b 下。

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Rule } from "./config.ts";

/** 展开 `~` / `~/…`；其余原样返回（`~user` 不处理） */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

/**
 * 归一化一个绝对路径：展开 `~` → resolve（去 `.`/`..`/重复斜线/尾斜线）。
 * 非绝对路径（含空串）返回 ""，调用方按「不匹配」处理——
 * 相对路径的解释权不明（相对 cwd 会随会话漂移），宁可不匹配，也不要猜。
 */
export function normalizePath(path: string): string {
	const trimmed = (path ?? "").trim();
	if (!trimmed) return "";
	const expanded = expandHome(trimmed);
	if (!isAbsolute(expanded)) return "";
	return resolve(expanded);
}

/** cwd 是否落在 prefix 之下（含相等）。两边须已归一化。 */
export function isUnder(cwd: string, prefix: string): boolean {
	if (!cwd || !prefix) return false;
	if (cwd === prefix) return true;
	// 根前缀特判：prefix + "/" 会变成 "//"，反而匹配不上
	if (prefix === "/") return cwd.startsWith("/");
	return cwd.startsWith(prefix + "/");
}

/** 规则是否命中该 cwd */
export function ruleMatches(rule: Rule, cwd: string): boolean {
	const normalized = normalizePath(cwd);
	if (!normalized) return false;
	return rule.paths.some((prefix) => isUnder(normalized, prefix));
}

/** 命中该 cwd 的规则，保持配置顺序（段顺序由 order 决定，同 order 时即此顺序） */
export function matchingRules(rules: Rule[], cwd: string): Rule[] {
	return rules.filter((rule) => ruleMatches(rule, cwd));
}
