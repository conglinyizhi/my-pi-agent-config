// lib/review-rules.test.ts
// 跑法：node --test --experimental-strip-types lib/review-rules.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firstMatchingRule, parseReviewRules } from "./review-rules.ts";

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
