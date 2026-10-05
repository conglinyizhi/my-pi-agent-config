// review-rules.ts — 审核判定的条件规则（数据，不是代码）
//
// 和流程（review-flows/*.ts）的分工：流程是**写代码**改整条判定链，这里只写**规则**
// ——「当……则……」的表格。两者不并存：规则喂的是同一个判定函数 autoApproveDecision，
// 判据仍然只有一份。
//
// 为什么用命名的条件而不是表达式：表达式要一门方言 + 一个求值器，等于把"两套语义"
// 引进来（这是提督明确不要的）。命名条件集合有限、能被表单勾出来、也审得清。

import { parse as parseToml } from "smol-toml";

/** 规则能用的动作 */
export type RuleAction = "allow" | "ask" | "deny";

/** 一次判定的事实：判定链在这些东西上做决定 */
export interface RuleFacts {
	/** 合并后的结论（分类器说了算） */
	verdict?: "safe" | "risky" | "dangerous" | "error";
	/** 分类器给的维度行（可能为空：模型没答上话） */
	dimensions?: Array<{ id?: string; triggered?: boolean; confidence?: number; disabled?: boolean }>;
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

const ACTIONS: readonly RuleAction[] = ["allow", "ask", "deny"];
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
		rules.push({
			id,
			...(verdict ? { verdict: verdict as ReviewRule["verdict"] } : {}),
			...(typeof threshold === "number" ? { allTriggeredBelowConfidence: threshold } : {}),
			...(row.no_triggered_dimensions === true ? { noTriggeredDimensions: true } : {}),
			...(asStringArray(row.rule_name) ? { ruleName: asStringArray(row.rule_name) } : {}),
			...(typeof row.command_contains === "string" && row.command_contains !== ""
				? { commandContains: row.command_contains }
				: {}),
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

/** 第一条命中的规则说了算（顺序即优先级） */
export function firstMatchingRule(rules: readonly ReviewRule[], facts: RuleFacts): ReviewRule | undefined {
	return rules.find((rule) => matchesRule(rule, facts));
}
