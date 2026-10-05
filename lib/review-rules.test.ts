// lib/review-rules.test.ts
// 跑法：node --test --experimental-strip-types lib/review-rules.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideWithRules, dimensionIgnoredBy, firstMatchingRule, parseReviewRules } from "./review-rules.ts";

const TOML = [
	'[[rule]]',
	'id = "low-confidence"',
	'verdict = "risky"',
	"all_triggered_below_confidence = 0.5",
	'then = "allow"',
	'note = "模型没把握的越线不算数"',
	"",
	'[[rule]]',
	'id = "catch-all"',
	'then = "ask"',
].join("\n");

describe("规则表解析", () => {
	it("合法 toml 解出规则，顺序即优先级", () => {
		const { rules, problems } = parseReviewRules(TOML);
		assert.deepEqual(problems, []);
		assert.equal(rules.length, 2);
		assert.equal(rules[0].id, "low-confidence");
		assert.equal(rules[0].allTriggeredBelowConfidence, 0.5);
		assert.equal(rules[1].then, "ask");
	});

	it("空文件就是没有规则，不算错", () => {
		assert.deepEqual(parseReviewRules("").problems, []);
		assert.equal(parseReviewRules("").rules.length, 0);
	});

	it("一条不合法就整组作废（宁可不生效，也不半生效）", () => {
		const bad = [
			'[[rule]]',
			'id = "a"',
			'then = "maybe"',
		].join("\n");
		const parsed = parseReviewRules(bad);
		assert.equal(parsed.rules.length, 0);
		assert.match(parsed.problems.join(" "), /then 必须是/);
	});

	it("置信度阈值必须在 0..1，id 不许重名", () => {
		const out = parseReviewRules([
			'[[rule]]',
			'id = "a"',
			"all_triggered_below_confidence = 2",
			'then = "allow"',
		].join("\n"));
		assert.match(out.problems.join(" "), /0\.\.1/);
		const dup = parseReviewRules([
			'[[rule]]',
			'id = "a"',
			'then = "allow"',
			'[[rule]]',
			'id = "a"',
			'then = "ask"',
		].join("\n"));
		assert.match(dup.problems.join(" "), /id 重复/);
	});
});

describe("命中与取第一条", () => {
	const { rules } = parseReviewRules(TOML);

	it("触发维度全没把握时命中：这就是省弹窗那条", () => {
		const rule = firstMatchingRule(rules, {
			verdict: "risky",
			dimensions: [
				{ id: "整体可疑", triggered: true, confidence: 0 },
				{ id: "越界", triggered: true, confidence: 0 },
			],
		});
		assert.equal(rule?.id, "low-confidence");
	});

	it("有一个维度有把握就不命中，照旧问人", () => {
		const rule = firstMatchingRule(rules, {
			verdict: "risky",
			dimensions: [
				{ id: "整体可疑", triggered: true, confidence: 0 },
				{ id: "越界", triggered: true, confidence: 0.9 },
			],
		});
		assert.equal(rule?.id, "catch-all");
	});

	it("没有任何触发维度时，低置信那条不成立（它问的是触发的那些）", () => {
		const rule = firstMatchingRule(rules, { verdict: "risky", dimensions: [] });
		assert.equal(rule?.id, "catch-all");
	});

	it("禁用的维度不参与判断", () => {
		const rule = firstMatchingRule(rules, {
			verdict: "risky",
			dimensions: [
				{ id: "整体可疑", triggered: true, confidence: 0 },
				{ id: "脚本改写", triggered: true, confidence: 0.9, disabled: true },
			],
		});
		assert.equal(rule?.id, "low-confidence");
	});
});

describe("规则与内置判据的合议", () => {
	const { rules } = parseReviewRules([
		'[[rule]]',
		'id = "low-confidence"',
		'verdict = "risky"',
		"all_triggered_below_confidence = 0.5",
		'then = "allow"',
		"",
		'[[rule]]',
		'id = "never"',
		'command_contains = "rm -rf /"',
		'then = "deny"',
	].join("\n"));

	it("没有规则命中时，结论就是内置判据", () => {
		const decision = decideWithRules({ builtinApprove: true, masterSwitchOn: true, facts: { verdict: "safe" }, rules: [] });
		assert.equal(decision.by, "builtin");
		assert.equal(decision.approve, true);
	});

	it("规则说放行、档位也是 auto，才真放行", () => {
		const facts = { verdict: "risky" as const, dimensions: [{ triggered: true, confidence: 0 }] };
		const decision = decideWithRules({ builtinApprove: false, masterSwitchOn: true, facts, rules });
		assert.equal(decision.approve, true);
		assert.equal(decision.by, "rule");
		assert.match(decision.reason, /low-confidence/);
	});

	it("档位不是 auto 时，规则也放行不了（表单不是后门）", () => {
		const facts = { verdict: "risky" as const, dimensions: [{ triggered: true, confidence: 0 }] };
		const decision = decideWithRules({ builtinApprove: false, masterSwitchOn: false, facts, rules });
		assert.equal(decision.approve, false);
		assert.match(decision.reason, /档位不是 auto/);
	});

	it("规则说拒就拒，理由写明是哪一条", () => {
		const decision = decideWithRules({ builtinApprove: true, masterSwitchOn: true, facts: { command: "sudo rm -rf /" }, rules });
		assert.equal(decision.approve, false);
		assert.equal(decision.rule?.id, "never");
	});
});


describe("规则表的字段校验（口语写歪时要说话）", () => {
	it("不认识的字段：整组作废，并列出能写的字段", () => {
		const text = ['[[rule]]', 'id = "x"', 'when_risk_is_low = 0.5', 'then = "ignore"'].join("\n");
		const parsed = parseReviewRules(text);
		assert.equal(parsed.rules.length, 0);
		const message = parsed.problems.join(" ");
		assert.match(message, /不认识的字段 when_risk_is_low/);
		assert.match(message, /dimension/);
		assert.match(message, /risk_below/);
	});

	it("ignore 必须指名维度；指名了维度就不能用整条处置", () => {
		const noDim = parseReviewRules(['[[rule]]', 'id = "a"', 'risk_below = 0.5', 'then = "ignore"'].join("\n"));
		assert.match(noDim.problems.join(" "), /要配 dimension/);
		const wrongThen = parseReviewRules(['[[rule]]', 'id = "b"', 'dimension = "oddity"', 'then = "allow"'].join("\n"));
		assert.match(wrongThen.problems.join(" "), /只能用 then = "ignore"/);
	});

	it("门槛要写在 0..1；写对了就把两个字面量读回来", () => {
		const bad = parseReviewRules(['[[rule]]', 'id = "c"', 'dimension = "oddity"', 'confidence_below = 2', 'then = "ignore"'].join("\n"));
		assert.match(bad.problems.join(" "), /0\.\.1/);
		const good = parseReviewRules(
			['[[rule]]', 'id = "d"', 'dimension = "需要用户关注"', 'risk_below = 0.5', 'confidence_below = 0.2', 'then = "ignore"'].join("\n"),
		);
		assert.deepEqual(good.problems, []);
		assert.equal(good.rules[0].riskBelow, 0.5);
		assert.equal(good.rules[0].confidenceBelow, 0.2);
		assert.equal(good.rules[0].dimension, "需要用户关注");
	});

	it("dimensionIgnoredBy：门槛缺值时不命中（有值才判）", () => {
		const rules = [{ id: "r", dimension: "oddity", confidenceBelow: 0.2, then: "ignore" }] as never;
		assert.equal(dimensionIgnoredBy({ names: ["oddity"], risk: 0.9 }, rules), undefined, "没有置信度就轮不到这条规则");
		assert.equal(dimensionIgnoredBy({ names: ["oddity"], risk: 0.9, confidence: 0.05 }, rules)?.id, "r");
		assert.equal(dimensionIgnoredBy({ names: ["network"], risk: 0.9, confidence: 0.05 }, rules), undefined);
	});
});
