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
	disabledDimensionIds,
	disabledReportRows,
	evaluateAll,
	evaluateDimension,
	isDimensionDisabledInScenario,
	normalizeAnswer,
	scenarioSpec,
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

describe("场景禁用维度", () => {
	it("bash 场景不禁用任何维度（现有链行为不变）", () => {
		assert.deepEqual(disabledDimensionIds("bash"), []);
		assert.equal(isDimensionDisabledInScenario("scripted_edit", "bash"), false);
	});

	it("ptc 场景只禁用 scripted_edit，维度定义仍在（不是删了它）", () => {
		assert.deepEqual(disabledDimensionIds("ptc"), ["scripted_edit"]);
		assert.equal(isDimensionDisabledInScenario("scripted_edit", "ptc"), true);
		assert.equal(isDimensionDisabledInScenario("oddity", "ptc"), false);
		// 定义保留：label / type / instructions 一个没少
		assert.equal(scriptedEdit.label, "脚本改写");
		assert.equal(scriptedEdit.type, "noul");
		assert.ok(scriptedEdit.instructions.length > 0);
		assert.ok(DIMENSIONS.some((d) => d.id === "scripted_edit"));
	});

	it("scenarioSpec：缺省/未知场景都按 bash 处理（宁可多问，不要少问）", () => {
		assert.equal(scenarioSpec().id, "bash");
		assert.equal(scenarioSpec("ptc").label, "PTC 脚本");
		assert.equal(scenarioSpec("no-such-scene" as never).id, "bash");
	});

	it("disabledReportRows：带禁用标记与说明，且不谎报风险值/命中", () => {
		const rows = disabledReportRows(defaultDimensionConfigs(), "ptc");
		assert.equal(rows.length, 1);
		const row = rows[0];
		assert.equal(row.id, "scripted_edit");
		assert.equal(row.label, "脚本改写");
		assert.equal(row.disabled, true);
		assert.ok(row.disabledNote?.includes("PTC"), row.disabledNote);
		// 没问过：不假装触发过，也不给概率/原始取值
		assert.equal(row.triggered, false);
		assert.equal(row.reason, "");
		assert.equal(row.raw, "");
		assert.equal(row.probabilities, undefined);
		assert.equal(row.noul, undefined);
		// 阈值来自配置原值（面板上怎么配的就怎么显示），不影响判定
		assert.equal(row.above, DEFAULT_THRESHOLD);
		assert.equal(row.below, null);
	});

	it("disabledReportRows：bash 场景不出行；配置里已关的维度也不出行", () => {
		assert.deepEqual(disabledReportRows(defaultDimensionConfigs(), "bash"), []);
		const off = defaultDimensionConfigs().map((d) =>
			d.id === "scripted_edit" ? { ...d, enabled: false } : d,
		);
		assert.deepEqual(disabledReportRows(off, "ptc"), []);
		const ignored = defaultDimensionConfigs().map((d) =>
			d.id === "scripted_edit" ? { ...d, action: "ignore" as const } : d,
		);
		assert.deepEqual(disabledReportRows(ignored, "ptc"), []);
	});
});

describe("规则按维忽略（/sandbox 规则表的 then = \"ignore\"）", () => {
	// oddity 是 score 型：risk = score / 4（五档），置信度由模型给
	const oddityAnswer = (score: number, confidence: number): RawAnswer => ({ type: "score", score, confidence });
	const configs = defaultDimensionConfigs();
	const verdictOf = (verdicts: ReturnType<typeof evaluateAll>) => verdicts.find((v) => v.id === "oddity")!;

	it("没有规则时，风险 0.75 照旧报警", () => {
		const verdicts = evaluateAll({ oddity: oddityAnswer(3, 0.9) }, configs);
		assert.equal(verdictOf(verdicts).triggered, true);
	});

	it("风险低于门槛就忽略（risk_below）", () => {
		const rules = [{ id: "r1", dimension: "oddity", riskBelow: 0.8, then: "ignore", note: "太低" }] as never;
		const verdicts = evaluateAll({ oddity: oddityAnswer(3, 0.9) }, configs, rules);
		const oddity = verdictOf(verdicts);
		assert.equal(oddity.triggered, false);
		assert.equal(oddity.ignoredBy, "太低");
	});

	it("置信低于 0.2 直接作废；0.4 的警报留着（这才是这条规则的意义）", () => {
		const rules = [{ id: "r2", dimension: "oddity", confidenceBelow: 0.2, then: "ignore" }] as never;
		const low = verdictOf(evaluateAll({ oddity: oddityAnswer(3, 0.1) }, configs, rules));
		assert.equal(low.triggered, false, "置信 0.1 该被忽略");
		const mid = verdictOf(evaluateAll({ oddity: oddityAnswer(3, 0.4) }, configs, rules));
		assert.equal(mid.triggered, true, "置信 0.4 仍要提醒（宁可信其有）");
	});

	it("口语别名也认：需要用户关注", () => {
		const rules = [{ id: "r3", dimension: "需要用户关注", confidenceBelow: 0.2, then: "ignore" }] as never;
		assert.equal(verdictOf(evaluateAll({ oddity: oddityAnswer(3, 0.1) }, configs, rules)).triggered, false);
	});

	it("只影响指名的维度：别的高风险维度照旧把请求送去人工", () => {
		const rules = [{ id: "r4", dimension: "oddity", confidenceBelow: 0.2, then: "ignore" }] as never;
		const answers: Record<string, RawAnswer> = {
			oddity: oddityAnswer(3, 0.1),
			elevation: {
				type: "choice",
				choice: "privileged-change",
				probabilities: { none: 0.05, "user-elevation": 0.15, "privileged-change": 0.8 },
				confidence: 0.9,
			},
		};
		const verdicts = evaluateAll(answers, configs, rules);
		assert.equal(verdictOf(verdicts).triggered, false);
		assert.equal(synthesize(verdicts).outcome, "review");
	});
});
