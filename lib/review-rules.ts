// review-rules.ts — 审核判定的条件规则（数据，不是代码）
//
// 定位：判定链写死在 lib/pre-review.ts 与 lib/review-steps.ts 里，这里只加**声明式规则**
// ——「当……则……」的表格。两者不并存：规则喂的是同一个判定函数 autoApproveDecision，
// 判据仍然只有一份。
//
// 为什么用命名的条件而不是表达式：表达式要一门方言 + 一个求值器，等于把"两套语义"
// 引进来（这是提督明确不要的）。命名条件集合有限、能被表单勾出来、也审得清。

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { parse as parseToml, stringify } from "smol-toml";

/**
 * 规则能用的动作。
 *
 *   allow / ask / deny  整条判定的处置（配合 verdict、ruleName、commandContains 这些条件）
 *   ignore              只对**某一维**的警报：这一维不算数，其余维度照旧说了算
 *                       （必须配 dimension；这是提督要的"忽略这条警报"）
 */
export type RuleAction = "allow" | "ask" | "deny" | "ignore";

/** 一次判定的事实：判定链在这些东西上做决定 */
export interface RuleFacts {
	/** 合并后的结论（分类器说了算） */
	verdict?: "safe" | "risky" | "dangerous" | "error";
	/** 分类器给的维度行（可能为空：模型没答上话） */
	dimensions?: Array<{
		id?: string;
		label?: string;
		triggered?: boolean;
		risk?: number;
		confidence?: number;
		disabled?: boolean;
	}>;
	/** 命令审计命中的规则名 */
	ruleNames?: string[];
	/** 命令原文（只做子串匹配，不做正则——正则在这里是脚枪） */
	command?: string;
}

/** 一条规则：条件全满足才算命中；命中就按 then 办 */
export interface ReviewRule {
	id: string;
	/** 结论等于其中之一（缺省不看结论） */
	verdict?: Array<"safe" | "risky" | "dangerous" | "error">;
	/** 触发的维度里，置信度全部低于这个值（模型没把握） */
	allTriggeredBelowConfidence?: number;
	/** 没有任何维度越线 */
	noTriggeredDimensions?: boolean;
	/** 命令审计命中了这些规则名中的任意一个 */
	ruleName?: string[];
	/** 命令里含这个子串 */
	commandContains?: string;
	/** 只对这一维生效（写 id 或显示名都认，比如 oddity / 需要用户关注） */
	dimension?: string;
	/** 这一维的风险值**低于**它（0..1）——配合 then = "ignore" */
	riskBelow?: number;
	/** 这一维的置信度**低于**它（0..1）——配合 then = "ignore" */
	confidenceBelow?: number;
	/** 命中之后 */
	then: RuleAction;
	/** 为什么留这条规则（表单里显示，也进流水） */
	note?: string;
}

export interface ReviewRules {
	rules: ReviewRule[];
	/** 解析/校验中发现的问题；有问题时调用方应整组忽略（宁可不生效，也不半生效） */
	problems: string[];
}

const ACTIONS: readonly RuleAction[] = ["allow", "ask", "deny", "ignore"];

/** toml 里允许出现的键。写错一个字母就报错：静默忽略会变成"没有条件的规则"，命中所有情况 */
const ALLOWED_KEYS = [
	"id",
	"then",
	"note",
	"verdict",
	"all_triggered_below_confidence",
	"no_triggered_dimensions",
	"rule_name",
	"command_contains",
	"dimension",
	"risk_below",
	"confidence_below",
];
const VERDICTS = ["safe", "risky", "dangerous", "error"] as const;

function asStringArray(value: unknown): string[] | undefined {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return undefined;
	const list = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
	return list.length > 0 ? list : undefined;
}

/** toml 文本 → 规则表。任何一条不合法就整体作废并说明原因 */
export function parseReviewRules(text: string): ReviewRules {
	const problems: string[] = [];
	let raw: unknown;
	try {
		raw = parseToml(typeof text === "string" ? text : "");
	} catch (error) {
		return { rules: [], problems: [`toml 解析失败：${error instanceof Error ? error.message : String(error)}`] };
	}
	const list = (raw as { rule?: unknown })?.rule;
	if (list === undefined) return { rules: [], problems: [] };
	if (!Array.isArray(list)) return { rules: [], problems: ["rule 必须是数组（[[rule]]）"] };
	const rules: ReviewRule[] = [];
	list.forEach((entry, index) => {
		const at = `第 ${index + 1} 条规则`;
		if (!entry || typeof entry !== "object") {
			problems.push(`${at}：不是一张表`);
			return;
		}
		const row = entry as Record<string, unknown>;
		const id = typeof row.id === "string" && row.id.trim() !== "" ? row.id.trim() : "";
		if (id === "") problems.push(`${at}：缺 id`);
		const then = row.then;
		if (typeof then !== "string" || !ACTIONS.includes(then as RuleAction)) {
			problems.push(`${at}：then 必须是 ${ACTIONS.join(" / ")}`);
		}
		const verdict = asStringArray(row.verdict);
		for (const value of verdict ?? []) {
			if (!(VERDICTS as readonly string[]).includes(value)) problems.push(`${at}：不认得的 verdict：${value}`);
		}
		const threshold = row.all_triggered_below_confidence;
		if (threshold !== undefined && (typeof threshold !== "number" || threshold < 0 || threshold > 1)) {
			problems.push(`${at}：all_triggered_below_confidence 要是 0..1 的数`);
		}
		// 不认识的键要拦：静默忽略会造出"一条条件都没有的规则"，那是命中一切的规则
		for (const key of Object.keys(row)) {
			if (!ALLOWED_KEYS.includes(key)) {
				problems.push(`${at}：不认识的字段 ${key}。能写的是 ${ALLOWED_KEYS.join(" / ")}`);
			}
		}
		const dimension = typeof row.dimension === "string" && row.dimension.trim() !== "" ? row.dimension.trim() : undefined;
		const riskBelow = row.risk_below;
		if (riskBelow !== undefined && (typeof riskBelow !== "number" || riskBelow < 0 || riskBelow > 1)) {
			problems.push(`${at}：risk_below 要是 0..1 的数`);
		}
		const confidenceBelow = row.confidence_below;
		if (confidenceBelow !== undefined && (typeof confidenceBelow !== "number" || confidenceBelow < 0 || confidenceBelow > 1)) {
			problems.push(`${at}：confidence_below 要是 0..1 的数`);
		}
		if (then === "ignore" && dimension === undefined) {
			problems.push(`${at}：then = "ignore" 要配 dimension，写明忽略哪一维（比如 dimension = "oddity"）`);
		}
		if (dimension !== undefined && then !== "ignore") {
			problems.push(
				`${at}：带 dimension 的规则只能用 then = "ignore"；要整条放行/拒绝就别写 dimension，改用 verdict 或 command_contains`,
			);
		}
		// 一条条件都没有的规则是合法的（"一律问人"这种兜底）；危险的是键写错，
		// 那会被读成"没有条件"，所以未知键在上面已经拦下了。
		rules.push({
			id,
			...(verdict ? { verdict: verdict as ReviewRule["verdict"] } : {}),
			...(typeof threshold === "number" ? { allTriggeredBelowConfidence: threshold } : {}),
			...(row.no_triggered_dimensions === true ? { noTriggeredDimensions: true } : {}),
			...(asStringArray(row.rule_name) ? { ruleName: asStringArray(row.rule_name) } : {}),
			...(typeof row.command_contains === "string" && row.command_contains !== ""
				? { commandContains: row.command_contains }
				: {}),
			...(dimension !== undefined ? { dimension } : {}),
			...(typeof riskBelow === "number" ? { riskBelow } : {}),
			...(typeof confidenceBelow === "number" ? { confidenceBelow } : {}),
			then: (typeof then === "string" ? then : "ask") as RuleAction,
			...(typeof row.note === "string" && row.note !== "" ? { note: row.note } : {}),
		});
	});
	const seen = new Set<string>();
	for (const rule of rules) {
		if (rule.id !== "" && seen.has(rule.id)) problems.push(`id 重复：${rule.id}`);
		seen.add(rule.id);
	}
	return { rules: problems.length > 0 ? [] : rules, problems };
}

/** 这条规则命中了吗（条件之间是「且」） */
export function matchesRule(rule: ReviewRule, facts: RuleFacts): boolean {
	const dims = (facts.dimensions ?? []).filter((dim) => dim.disabled !== true);
	const triggered = dims.filter((dim) => dim.triggered === true);
	if (rule.verdict && (facts.verdict === undefined || !rule.verdict.includes(facts.verdict))) return false;
	if (rule.noTriggeredDimensions === true && triggered.length > 0) return false;
	if (rule.ruleName) {
		const hit = facts.ruleNames ?? [];
		if (!rule.ruleName.some((name) => hit.includes(name))) return false;
	}
	if (rule.commandContains !== undefined && !(facts.command ?? "").includes(rule.commandContains)) return false;
	if (rule.allTriggeredBelowConfidence !== undefined) {
		// 没有任何触发维度时这条不成立：它问的是"触发的那些有没有把握"
		if (triggered.length === 0) return false;
		if (!triggered.every((dim) => (dim.confidence ?? 0) < rule.allTriggeredBelowConfidence!)) return false;
	}
	return true;
}

/**
 * 这一维要不要按规则**忽略**掉（只认 then = "ignore"）。
 *
 * 条件是「且」：dimension 指名哪一维（id 或显示名都认），riskBelow / confidenceBelow 是门槛。
 * 门槛写着但这一维没给这个值（比如 noul 没有置信度）时不算命中——"有值才判"。
 */
export function dimensionIgnoredBy(
	dim: { names?: string[]; risk?: number; confidence?: number },
	rules: readonly ReviewRule[],
): ReviewRule | undefined {
	const names = dim.names ?? [];
	return rules.find((rule) => {
		if (rule.then !== "ignore" || rule.dimension === undefined) return false;
		if (!names.includes(rule.dimension)) return false;
		if (rule.riskBelow !== undefined && (dim.risk === undefined || dim.risk >= rule.riskBelow)) return false;
		if (rule.confidenceBelow !== undefined && (dim.confidence === undefined || dim.confidence >= rule.confidenceBelow)) {
			return false;
		}
		return true;
	});
}

/** 第一条命中的规则说了算（顺序即优先级） */
export function firstMatchingRule(rules: readonly ReviewRule[], facts: RuleFacts): ReviewRule | undefined {
	return rules.find((rule) => matchesRule(rule, facts));
}

/** 规则表放在维度配置旁边：改阈值与改规则是同一件事的两半，别分两个地方找 */
export const RULES_FILE = "extensions/sandbox-permissions/review-rules.toml";

/** 规则表路径：显式给目录就用它（测试与 CLI 用），否则取仓库根下的固定位置 */
export function rulesPath(repoRoot: string): string {
	return repoRoot.replace(/\/+$/, "") + "/" + RULES_FILE;
}

/** 字段名映射：界面用驼峰，toml 用下划线。就这一处，别的地方不许再写一遍 */
const TO_TOML: Array<[keyof ReviewRule, string]> = [
	["verdict", "verdict"],
	["allTriggeredBelowConfidence", "all_triggered_below_confidence"],
	["noTriggeredDimensions", "no_triggered_dimensions"],
	["ruleName", "rule_name"],
	["commandContains", "command_contains"],
	["dimension", "dimension"],
	["riskBelow", "risk_below"],
	["confidenceBelow", "confidence_below"],
	["then", "then"],
	["note", "note"],
];

/** 规则数组 → toml 文本。写出来的东西必须能被 parseReviewRules 原样读回来 */
export function stringifyReviewRules(rules: readonly ReviewRule[]): string {
	const rows = rules.map((rule) => {
		const row: Record<string, unknown> = { id: rule.id };
		for (const key of Object.keys(rule) as Array<keyof ReviewRule>) {
			if (key === "id") continue;
			const value = rule[key];
			if (value === undefined) continue;
			const name = TO_TOML.find(([from]) => from === key)?.[1];
			if (name === undefined) continue;
			row[name] = value;
		}
		return row;
	});
	return rows.length === 0 ? "" : stringify({ rule: rows });
}


/**
 * 默认判定与规则的合议结果。
 *
 * 规矩：规则只**修正**内置判据，不另起一套。放行永远受总开关管着——
 * 档位不是 auto 时，规则写 allow 也不放行（否则表单就成了绕过总开关的后门）。
 */
export interface RuleDecision {
	approve: boolean;
	/** builtin = 内置判据说放行；rule = 规则改写了结论 */
	by: "builtin" | "rule";
	rule?: ReviewRule;
	reason: string;
}

export function decideWithRules(input: {
	builtinApprove: boolean;
	masterSwitchOn: boolean;
	facts: RuleFacts;
	rules: readonly ReviewRule[];
}): RuleDecision {
	const rule = firstMatchingRule(input.rules, input.facts);
	if (rule === undefined) {
		return { approve: input.builtinApprove, by: "builtin", reason: "内置判据" };
	}
	const label = rule.note ? "规则 " + rule.id + "（" + rule.note + "）" : "规则 " + rule.id;
	if (rule.then === "allow") {
		if (!input.masterSwitchOn) {
			return { approve: false, by: "rule", rule, reason: label + " 想放行，但档位不是 auto，仍然问人" };
		}
		return { approve: true, by: "rule", rule, reason: label + " 判为可放行" };
	}
	if (rule.then === "deny") {
		return { approve: false, by: "rule", rule, reason: label + " 直接拒" };
	}
	return { approve: false, by: "rule", rule, reason: label + " 要求问人" };
}

/** 规则表的读取缓存：审核链每次判定都要用，文件没变就不重读 */
let cachedRules: { path: string; mtimeMs: number; rules: ReviewRule[] } | undefined;

export interface LoadRulesDeps {
	read?: (path: string) => string | undefined;
	mtime?: (path: string) => number;
}

export function loadReviewRules(path: string, deps: LoadRulesDeps = {}): ReviewRule[] {
	const read = deps.read ?? ((p: string) => {
		try {
			return readFileSync(p, "utf8");
		} catch {
			return undefined;
		}
	});
	const mtime = deps.mtime ?? ((p: string) => {
		try {
			return statSync(p).mtimeMs;
		} catch {
			return -1;
		}
	});
	const stamp = mtime(path);
	if (cachedRules && cachedRules.path === path && cachedRules.mtimeMs === stamp) return cachedRules.rules;
	const text = read(path);
	// 读不到、解析不过：一律当没有规则（照旧走内置判据）。这里绝不抛——
	// 规则表坏了不该让整条审核链停摆，也不该悄悄变成「什么都放行」
	const rules = text === undefined ? [] : parseReviewRules(text).rules;
	cachedRules = { path, mtimeMs: stamp, rules };
	return rules;
}


/** 默认规则表位置：PI_AGENT_DIR 优先，其次 ~/.pi/agent。CLI 与判定链共用这一处 */
export function defaultRulesPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
	const root = env.PI_AGENT_DIR && env.PI_AGENT_DIR.trim() !== "" ? env.PI_AGENT_DIR : home + "/.pi/agent";
	return rulesPath(root);
}

