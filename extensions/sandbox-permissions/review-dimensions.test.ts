// review-dimensions.test.ts — 问题卡归一化与阈值合成（纯逻辑）
//
// 跑法：node --test --experimental-strip-types extensions/sandbox-permissions/review-dimensions.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	DEFAULT_THRESHOLD,
	DIMENSIONS,
	defaultDimensionConfigs,
	dimensionById,
	dimensionReport,
	dimensionReportDetailed,
	evaluateAll,
	evaluateDimension,
	normalizeAnswer,
	synthesize,
	type RawAnswer,
} from "./review-dimensions.ts";

const elevation = dimensionById("elevation")!;
const oddity = dimensionById("oddity")!;
const scriptedEdit = dimensionById("scripted_edit")!;

describe("normalizeAnswer", () => {
	it("choice：风险值取高风险档概率之和，不是只看 selected", () => {
		const answer = normalizeAnswer(elevation, {
			type: "choice",
			choice: "user-elevation",
			probabilities: { none: 0.2, "user-elevation": 0.5, "privileged-change": 0.3 },
			confidence: 0.62,
		});
		assert.equal(answer.risk, 0.8); // 0.5 + 0.3
		assert.equal(answer.confidence, 0.62);
		assert.ok(answer.raw.includes("user-elevation"));
	});

	it("choice：概率缺失时风险为 0，不抛错", () => {
		const answer = normalizeAnswer(elevation, { type: "choice", choice: "none" });
		assert.equal(answer.risk, 0);
	});

	it("score：按档位数线性归一化，并带回档位文字", () => {
		// oddity 有 5 档 → max = 4
		const answer = normalizeAnswer(oddity, { type: "score", score: 3, confidence: 0.9 });
		assert.equal(answer.risk, 0.75);
		assert.ok(answer.raw.includes("明显异常"));
	});

	it("score：越界分值被夹回 0-1", () => {
		assert.equal(normalizeAnswer(oddity, { type: "score", score: 99 }).risk, 1);
		assert.equal(normalizeAnswer(oddity, { type: "score", score: -5 }).risk, 0);
	});

	it("noul：只取「是」的概率，不带 confidence", () => {
		const answer = normalizeAnswer(scriptedEdit, { type: "noul", noul: 0.83 });
		assert.equal(answer.risk, 0.83);
		assert.equal(answer.confidence, undefined);
		assert.equal(answer.raw, "83%");
	});
});

describe("evaluateDimension", () => {
	const config = { id: "elevation", enabled: true, above: 0.5, below: 0.5, action: "review" as const };

	it("风险高于阈值 → 触发，理由里带数字", () => {
		const answer = normalizeAnswer(elevation, {
			type: "choice",
			choice: "privileged-change",
			probabilities: { none: 0.1, "user-elevation": 0.2, "privileged-change": 0.7 },
			confidence: 0.95,
		});
		const verdict = evaluateDimension(elevation, answer, config);
		assert.equal(verdict.triggered, true);
		assert.ok(verdict.reason.includes("风险 0.90"));
	});

	it("风险不高但置信度低于 below → 也触发（宁可信其有）", () => {
		const answer = normalizeAnswer(elevation, {
			type: "choice",
			choice: "none",
			probabilities: { none: 0.55, "user-elevation": 0.25, "privileged-change": 0.2 },
			confidence: 0.3,
		});
		const verdict = evaluateDimension(elevation, answer, config);
		assert.equal(verdict.triggered, true);
		assert.ok(verdict.reason.includes("置信度"));
	});

	it("两条线都没过 → 不触发", () => {
		const answer = normalizeAnswer(elevation, {
			type: "choice",
			choice: "none",
			probabilities: { none: 0.9, "user-elevation": 0.05, "privileged-change": 0.05 },
			confidence: 0.95,
		});
		assert.equal(evaluateDimension(elevation, answer, config).triggered, false);
	});

	it("noul 维度忽略 below（它没有置信度）", () => {
		const noulConfig = { id: "scripted_edit", enabled: true, above: 0.5, below: 0.5, action: "review" as const };
		const answer = normalizeAnswer(scriptedEdit, { type: "noul", noul: 0.1 });
		assert.equal(evaluateDimension(scriptedEdit, answer, noulConfig).triggered, false);
	});

	it("禁用或 action=ignore 的维度永不触发", () => {
		const answer = normalizeAnswer(elevation, {
			type: "choice",
			choice: "privileged-change",
			probabilities: { none: 0, "user-elevation": 0, "privileged-change": 1 },
			confidence: 1,
		});
		assert.equal(evaluateDimension(elevation, answer, { ...config, enabled: false }).triggered, false);
		assert.equal(evaluateDimension(elevation, answer, { ...config, action: "ignore" }).triggered, false);
	});
});

describe("synthesize", () => {
	it("全不触发 → safe", () => {
		const verdicts = [
			evaluateDimension(scriptedEdit, normalizeAnswer(scriptedEdit, { type: "noul", noul: 0.1 }), {
				id: "scripted_edit",
				enabled: true,
				above: 0.5,
				below: null,
				action: "review",
			}),
		];
		const result = synthesize(verdicts);
		assert.equal(result.outcome, "safe");
		assert.equal(result.hit.length, 0);
	});

	it("任一触发 → review，且没有 block 这个出口", () => {
		const answers: Record<string, RawAnswer> = {
			elevation: { type: "choice", choice: "privileged-change", probabilities: { "privileged-change": 1 }, confidence: 1 },
		};
		const verdicts = evaluateAll(answers, defaultDimensionConfigs());
		const result = synthesize(verdicts);
		assert.equal(result.outcome, "review");
		assert.equal(result.hit.length, 1);
		assert.ok(result.summary.includes("提权"));
	});

	it("命中项按风险值降序，摘要最多列三项", () => {
		const answers: Record<string, RawAnswer> = {
			elevation: { type: "choice", choice: "privileged-change", probabilities: { none: 0.1, "user-elevation": 0.3, "privileged-change": 0.6 }, confidence: 1 },
			network: { type: "choice", choice: "upload", probabilities: { none: 0.05, "fetch-only": 0.25, upload: 0.7 }, confidence: 1 },
			wallet_access: { type: "choice", choice: "direct-key-access", probabilities: { none: 0.02, "wallet-adjacent": 0.18, "direct-key-access": 0.8 }, confidence: 1 },
			oddity: { type: "score", score: 4, confidence: 0.9 },
		};
		const result = synthesize(evaluateAll(answers, defaultDimensionConfigs()));
		assert.equal(result.outcome, "review");
		assert.ok(result.hit.length >= 3);
		for (let i = 1; i < result.hit.length; i++) {
			assert.ok(result.hit[i - 1].answer.risk >= result.hit[i].answer.risk, "应按风险降序");
		}
		assert.ok(result.summary.includes("等"));
	});
});

describe("evaluateAll", () => {
	it("服务端漏答的维度跳过，不当成触发", () => {
		const verdicts = evaluateAll({}, defaultDimensionConfigs());
		assert.deepEqual(verdicts, []);
		assert.equal(synthesize(verdicts).outcome, "safe");
	});
});

describe("默认配置", () => {
	it("八个维度、默认阈值 0.5、动作只有 review", () => {
		const configs = defaultDimensionConfigs();
		assert.equal(configs.length, DIMENSIONS.length);
		for (const c of configs) {
			assert.equal(c.above, DEFAULT_THRESHOLD);
			assert.equal(c.action, "review");
			assert.ok(["review", "ignore"].includes(c.action));
		}
	});

	it("noul 维度的 below 为 null（没有置信度可用）", () => {
		const scripted = defaultDimensionConfigs().find((c) => c.id === "scripted_edit")!;
		assert.equal(scripted.below, null);
	});
});

describe("dimensionReport", () => {
	// 两条素材：一条高风险命中、一条低风险不命中、一条 noul（无置信度）
	const answers: Record<string, RawAnswer> = {
		elevation: {
			type: "choice",
			choice: "privileged-change",
			probabilities: { none: 0.05, "user-elevation": 0.15, "privileged-change": 0.8 },
			confidence: 0.72,
		},
		network: {
			type: "choice",
			choice: "none",
			probabilities: { none: 0.95, "fetch-only": 0.04, upload: 0.01 },
			confidence: 0.9,
		},
		scripted_edit: { type: "noul", noul: 0.08 },
	};

	it("按风险降序，带齐展示字段", () => {
		const verdicts = evaluateAll(answers, defaultDimensionConfigs());
		const rows = dimensionReport(verdicts);
		assert.equal(rows.length, 3);
		assert.equal(rows[0].id, "elevation");
		assert.ok(Math.abs(rows[0].risk - 0.95) < 1e-9, `risk=${rows[0].risk}`);
		assert.equal(rows[0].triggered, true);
		assert.equal(rows[0].above, DEFAULT_THRESHOLD);
		assert.equal(rows[0].below, DEFAULT_THRESHOLD);
		assert.ok(rows[0].reason.includes("0.95"));
		// 降序：后面的风险值不大于前面的
		for (let i = 1; i < rows.length; i++) {
			assert.ok(rows[i].risk <= rows[i - 1].risk);
		}
	});

	it("noul 维度没有 confidence，below 为 null", () => {
		const verdicts = evaluateAll(answers, defaultDimensionConfigs());
		const scripted = dimensionReport(verdicts).find((r) => r.id === "scripted_edit")!;
		assert.equal(scripted.confidence, undefined);
		assert.equal(scripted.below, null);
		assert.equal(scripted.triggered, false);
	});

	it("默认报告不带概率分布（窗口只要表窄）", () => {
		const verdicts = evaluateAll(answers, defaultDimensionConfigs());
		assert.equal(dimensionReport(verdicts)[0].probabilities, undefined);
	});

	it("detailed 版带上概率、choice、score、noul 原始值", () => {
		const verdicts = evaluateAll(answers, defaultDimensionConfigs());
		const rows = dimensionReportDetailed(answers, verdicts);
		assert.deepEqual(rows[0].probabilities, { none: 0.05, "user-elevation": 0.15, "privileged-change": 0.8 });
		assert.equal(rows[0].choice, "privileged-change");
		const scripted = rows.find((r) => r.id === "scripted_edit")!;
		assert.equal(scripted.noul, 0.08);
	});

	it("所有维度都未超阈值时也产出完整表（safe 分支也要能看数）", () => {
		const calm: Record<string, RawAnswer> = {
			elevation: { type: "choice", choice: "none", probabilities: { none: 0.97, "user-elevation": 0.02, "privileged-change": 0.01 }, confidence: 0.95 },
		};
		const rows = dimensionReport(evaluateAll(calm, defaultDimensionConfigs()));
		assert.equal(rows.length, 1);
		assert.equal(rows[0].triggered, false);
		assert.equal(rows[0].reason, "");
	});

	it("空判定集 → 空表（不崩，前端按不渲染处理）", () => {
		assert.deepEqual(dimensionReport([]), []);
		assert.deepEqual(dimensionReportDetailed({}, []), []);
	});
});
