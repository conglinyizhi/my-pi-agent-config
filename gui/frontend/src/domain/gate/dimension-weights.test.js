// dimension-weights.test.js — 权重表展示逻辑（node --test）
//
// 跑法：cd gui/frontend && node --test src/domain/gate/dimension-weights.test.js

import assert from "node:assert";
import { describe, it } from "node:test";
import { flaggedCount, fmt, fmtConfidence, riskWidth, thresholdLabel, weightRows } from "./dimension-weights.js";

function row(over = {}) {
	return {
		id: "elevation",
		label: "提权",
		type: "choice",
		risk: 0.95,
		confidence: 0.9,
		raw: "privileged-change（直接改系统级权限）",
		triggered: true,
		reason: "风险 0.95 > 0.5",
		above: 0.5,
		below: 0.5,
		...over,
	};
}

describe("riskWidth", () => {
	it("0-1 映射到 0-100", () => {
		assert.equal(riskWidth(0.5), 50);
		assert.equal(riskWidth(1), 100);
		assert.equal(riskWidth(0), 0);
	});

	it("越界与坏值夹紧/归零", () => {
		assert.equal(riskWidth(1.7), 100);
		assert.equal(riskWidth(-3), 0);
		assert.equal(riskWidth(undefined), 0);
		assert.equal(riskWidth("x"), 0);
	});
});

describe("fmt / fmtConfidence", () => {
	it("两位小数，缺值给占位", () => {
		assert.equal(fmt(0.9), "0.90");
		assert.equal(fmt(undefined), "—");
		assert.equal(fmtConfidence(0.55), "55%");
	});

	it("没有置信度的维度（noul）显示「无」", () => {
		assert.equal(fmtConfidence(undefined), "无");
		assert.equal(fmtConfidence(null), "无");
	});
});

describe("thresholdLabel", () => {
	it("below 为 null 时只显示 above", () => {
		assert.equal(thresholdLabel({ above: 0.5, below: null }), "> 0.50");
	});

	it("两条线都在时两条都显示", () => {
		assert.equal(thresholdLabel({ above: 0.5, below: 0.4 }), "> 0.50 / < 0.40");
	});
});

describe("weightRows", () => {
	it("按输入顺序产出渲染模型，不重排（后端已按风险降序）", () => {
		const rows = weightRows([row({ id: "a", label: "A" }), row({ id: "b", label: "B" })]);
		assert.deepEqual(rows.map((r) => r.key), ["a", "b"]);
	});

	it("条宽取自 risk，命中给 flagged", () => {
		const [r] = weightRows([row()]);
		assert.equal(r.riskWidth, 95);
		assert.equal(r.risk, "0.95");
		assert.equal(r.flagged, true);
	});

	it("未命中不给 flagged（颜色只表示越线，不表示风险方向）", () => {
		const [r] = weightRows([row({ triggered: false, reason: "" })]);
		assert.equal(r.flagged, false);
	});

	it("noul 维度没有置信度 → 显示「无」，below 为 null → 只显示 above", () => {
		const [r] = weightRows([row({ id: "scripted_edit", label: "脚本改写", type: "noul", confidence: undefined, below: null })]);
		assert.equal(r.confidence, "无");
		assert.equal(r.threshold, "> 0.50");
	});

	it("非数组输入 → 空表（旧 payload 没有这个字段）", () => {
		assert.deepEqual(weightRows(undefined), []);
		assert.deepEqual(weightRows(null), []);
	});

	it("缺 id/label 时兜底，不让 key 变 undefined", () => {
		const [r] = weightRows([{ risk: 0.1 }]);
		assert.equal(r.key, "dim-0");
		assert.equal(r.label, "?");
	});
});

describe("场景禁用行（PTC 下的 scripted_edit）", () => {
	const disabledRow = (over = {}) =>
		row({
			id: "scripted_edit",
			label: "脚本改写",
			type: "noul",
			risk: 0,
			confidence: undefined,
			below: null,
			triggered: false,
			reason: "",
			raw: "",
			disabled: true,
			disabledNote: "PTC 场景不适用（本次审的就是脚本）",
			...over,
		});

	it("不摆数字：风险/置信给破折号，条宽归零", () => {
		const [r] = weightRows([disabledRow()]);
		assert.equal(r.disabled, true);
		// 0.00 会被读成「问过、无风险」，那不是事实
		assert.equal(r.risk, "—");
		assert.equal(r.confidence, "—");
		assert.equal(r.riskWidth, 0);
		assert.equal(r.raw, "");
	});

	it("带出禁用说明，供行尾与悬停用", () => {
		const [r] = weightRows([disabledRow()]);
		assert.equal(r.disabledNote, "PTC 场景不适用（本次审的就是脚本）");
		assert.equal(r.label, "脚本改写");
	});

	it("禁用行不给 flagged（底色只表示越线，没问过就谈不上越线）", () => {
		const [r] = weightRows([disabledRow({ triggered: true, reason: "脏数据" })]);
		assert.equal(r.flagged, false);
	});

	it("缺 disabledNote 时兜底一句，不让行看起来像坏数据", () => {
		const [r] = weightRows([disabledRow({ disabledNote: undefined })]);
		assert.equal(r.disabledNote, "本场景不适用");
	});

	it("正常行不带禁用信息（不影响既有渲染）", () => {
		const [r] = weightRows([row()]);
		assert.equal(r.disabled, false);
		assert.equal(r.disabledNote, "");
		assert.equal(r.risk, "0.95");
	});

	it("flaggedCount 不把禁用行算进越线数", () => {
		assert.equal(flaggedCount([disabledRow({ triggered: true }), row()]), 1);
	});
});

describe("flaggedCount", () => {
	it("只数 triggered=true 的", () => {
		assert.equal(flaggedCount([row(), row({ triggered: false })]), 1);
		assert.equal(flaggedCount(undefined), 0);
	});
});
