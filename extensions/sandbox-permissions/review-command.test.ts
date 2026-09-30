// review-command.test.ts — 阈值面板的纯逻辑（TOML 往返 / 步进 / 动作轮转）
//
// 跑法：node --test --experimental-strip-types extensions/sandbox-permissions/review-command.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import { adjustThreshold, cycleAction, dimensionsAsText, formatDimensionsToml, rowText } from "./review-command.ts";
import { defaultDimensionConfigs } from "./review-dimensions.ts";
import { normalizeDimensions } from "./review-classifier.ts";

describe("adjustThreshold", () => {
	it("按步长增减并保留两位小数", () => {
		assert.equal(adjustThreshold(0.5, 0.05), 0.55);
		assert.equal(adjustThreshold(0.5, -0.05), 0.45);
	});

	it("夹在 [0.05, 0.99]：0 会让阈值永远触发，没有意义", () => {
		assert.equal(adjustThreshold(0.05, -0.05), 0.05);
		assert.equal(adjustThreshold(0.99, 0.05), 0.99);
	});

	it("浮点误差不累积（0.1 + 0.2 那类）", () => {
		assert.equal(adjustThreshold(0.3, 0.05), 0.35);
		assert.equal(adjustThreshold(0.35, -0.05), 0.3);
	});
});

describe("cycleAction", () => {
	it("只在 review / ignore 之间轮转，没有 block 出口", () => {
		assert.equal(cycleAction("review"), "ignore");
		assert.equal(cycleAction("ignore"), "review");
	});
});

describe("formatDimensionsToml", () => {
	it("写出的文本能被解析回同样的配置（面板写盘的可信度）", () => {
		const dims = defaultDimensionConfigs();
		dims[0].above = 0.65;
		dims[2].action = "ignore";
		dims[1].below = 0.3;

		const text = formatDimensionsToml(dims);
		const parsed = parseToml(text) as { dimension?: unknown };
		const roundTrip = normalizeDimensions(parsed.dimension);

		assert.equal(roundTrip.length, dims.length);
		for (const original of dims) {
			const back = roundTrip.find((d) => d.id === original.id)!;
			assert.equal(back.enabled, original.enabled, `${original.id} enabled`);
			assert.equal(back.above, original.above, `${original.id} above`);
			assert.equal(back.action, original.action, `${original.id} action`);
			assert.equal(back.below, original.below, `${original.id} below`);
		}
	});

	it("noul 维度不写 below 行", () => {
		const text = formatDimensionsToml(defaultDimensionConfigs());
		const block = text.split("[[dimension]]").find((b) => b.includes('id = "scripted_edit"'))!;
		assert.ok(!block.includes("below ="), "scripted_edit 不该有 below");
	});

	it("文件头带用法说明（手改的人看得到语义）", () => {
		const text = formatDimensionsToml(defaultDimensionConfigs());
		assert.ok(text.startsWith("# 指令审核维度阈值"));
		assert.ok(text.includes("没有 block"));
	});
});

describe("rowText", () => {
	it("启用状态、两条阈值、动作都在一行里", () => {
		const config = { id: "elevation", enabled: true, above: 0.5, below: 0.4, action: "review" as const };
		const text = rowText(config, { label: "提权", type: "choice", supportsBelow: true }, 80);
		assert.ok(text.startsWith("[x]"));
		assert.ok(text.includes("above 0.50"));
		assert.ok(text.includes("below 0.40"));
		assert.ok(text.includes("提示"));
	});

	it("没有置信度的维度 below 显示为 -", () => {
		const config = { id: "scripted_edit", enabled: false, above: 0.5, below: null, action: "ignore" as const };
		const text = rowText(config, { label: "脚本改写", type: "noul", supportsBelow: false }, 80);
		assert.ok(text.startsWith("[ ]"));
		assert.ok(text.includes("below   - "));
		assert.ok(text.includes("忽略"));
	});
});

describe("dimensionsAsText", () => {
	it("非 TUI 环境下能看到全部维度", () => {
		const text = dimensionsAsText(defaultDimensionConfigs());
		assert.equal(text.split("\n").length, 8);
		assert.ok(text.includes("elevation"));
		assert.ok(text.includes("oddity"));
	});
});
