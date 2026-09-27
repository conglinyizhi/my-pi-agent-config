// thinking-fold/detector.test.ts — 块内复读段检测的单测
//
// 跑法：node --test --experimental-strip-types extensions/thinking-fold/detector.test.ts
//
// 重点：尾段 / 中段 / 首段 / 多段都能圈出来，段外的正常内容一行不吞；
// 正常长块（代码 / 并列清单 / 表格）不碰；边界与行号映射。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_DUP_OPTIONS, findDupSegments } from "./detector.ts";

/** n 行互不相同的正常内容 */
function normalLines(n: number, offset = 0): string[] {
	return Array.from(
		{ length: n },
		(_, i) => `- 第 ${i + offset} 项：核对模块 ${i + offset} 的导出与依赖，确认没有循环引用。`,
	);
}

/** cycles 轮复读，每轮 kinds 里各出一行 */
function repeatLines(cycles: number, kinds: string[]): string[] {
	const out: string[] = [];
	for (let c = 0; c < cycles; c++) for (const k of kinds) out.push(k);
	return out;
}

/** 构造「一段正常内容 + 尾部复读」的块 */
function blockWithRepeat(head: number, cycles: number, kinds: string[]): string {
	return [...normalLines(head), ...repeatLines(cycles, kinds)].join("\n");
}

function countOccurrences(text: string, needle: string): number {
	let n = 0;
	let at = 0;
	while (true) {
		const next = text.indexOf(needle, at);
		if (next === -1) return n;
		n += 1;
		at = next + needle.length;
	}
}

describe("单段（旧行为回归）", () => {
	it("「好。/执行。」反复几十次的块，尾部被判为一段", () => {
		const text = blockWithRepeat(400, 100, ["好。", "执行。", "Output."]);
		const segs = findDupSegments(text);
		assert.equal(segs.length, 1, "尾部只该有一段");
		const [hit] = segs;
		assert.ok(hit.lines >= DEFAULT_DUP_OPTIONS.minLines);
		assert.ok(hit.chars >= DEFAULT_DUP_OPTIONS.minChars);
		assert.ok(hit.kinds >= 1 && hit.kinds <= DEFAULT_DUP_OPTIONS.maxKinds);
		assert.ok(hit.top.length <= 4, "最多列 4 个样例");
		assert.ok(
			hit.top.some((t) => /^好。 ×\d+$/.test(t)),
			`top 里应有「好。 ×次数」，实得 ${JSON.stringify(hit.top)}`,
		);
		assert.ok(hit.startLine > 0, "段从复读处开始");
		assert.equal(hit.endLine, text.split("\n").length, "尾段吃到块尾");
	});

	it("段起点之前的内容不在折叠范围内", () => {
		const text = blockWithRepeat(100, 100, ["好。", "执行。"]);
		const segs = findDupSegments(text);
		assert.equal(segs.length, 1);
		const raw = text.split("\n");
		const head = raw.slice(0, segs[0].startLine);
		// 前 100 行普通内容必须留在保留区里
		assert.ok(head.length >= 100, `普通头部不该被吃掉，实得 ${head.length} 行`);
		assert.equal(segs[0].startLine, 100, "段起点对齐到复读段第一行");
		assert.equal(segs[0].lines, 200);
	});

	it("单种短句刷屏也算（最典型形态）", () => {
		const text = blockWithRepeat(50, 300, ["好。"]);
		const segs = findDupSegments(text);
		assert.equal(segs.length, 1);
		assert.equal(segs[0].kinds, 1);
		assert.match(segs[0].top[0], /^好。 ×/);
	});
});

describe("中段 / 首段 / 多段", () => {
	it("中间复读段：段后有正常内容，段照折、后面的内容照留", () => {
		const mid = repeatLines(150, ["好。", "跑。"]);
		const text = [...normalLines(80), ...mid, ...normalLines(120, 1000)].join("\n");
		const segs = findDupSegments(text);
		assert.equal(segs.length, 1, "中段也该被圈出来");
		assert.equal(segs[0].startLine, 80, "段起点在复读段第一行");
		assert.equal(segs[0].lines, mid.length);
		// 段尾之后还有 120 行正常内容，endLine 不该一路吃到块尾
		const raw = text.split("\n");
		assert.equal(raw.length - segs[0].endLine, 120, "段后的正常内容不在折叠范围内");
		assert.ok(segs[0].top.some((t) => t.startsWith("好。 ×")));
	});

	it("首段：块开头就是复读，后面还有正常内容", () => {
		const text = [...repeatLines(150, ["好。", "执行。"]), ...normalLines(150)].join("\n");
		const segs = findDupSegments(text);
		assert.equal(segs.length, 1);
		assert.equal(segs[0].startLine, 0, "从块首开始");
		assert.equal(segs[0].lines, 300);
		assert.equal(text.split("\n").length - segs[0].endLine, 150);
	});

	it("多段：中间的正常内容不折，两段各自成段", () => {
		const text = [
			...normalLines(60),
			...repeatLines(150, ["好。", "跑。"]),
			...normalLines(90, 5000),
			...repeatLines(130, ["停。", "发。"]),
			...normalLines(40, 9000),
		].join("\n");
		const segs = findDupSegments(text);
		assert.equal(segs.length, 2, `应该两段，实得 ${segs.length}`);
		assert.deepEqual(
			segs.map((s) => s.startLine),
			[60, 60 + 300 + 90],
		);
		assert.ok(segs[0].top.some((t) => t.startsWith("好。 ×")));
		assert.ok(segs[1].top.some((t) => t.startsWith("停。 ×")));
		// 两段之间那 90 行正常内容在两段之外
		assert.equal(segs[1].startLine - segs[0].endLine, 90);
	});

	it("整块都是复读 → 一段，startLine = 0，endLine = 块尾", () => {
		const lines = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? "好。" : "执行。"));
		const text = lines.join("\n");
		const segs = findDupSegments(text);
		assert.equal(segs.length, 1);
		assert.equal(segs[0].startLine, 0);
		assert.equal(segs[0].lines, 200);
		assert.equal(segs[0].endLine, 200);
	});

	it("段内夹 1-2 行变化词仍算同一段（gapMax 容忍）", () => {
		const lines = [
			...normalLines(60),
			...repeatLines(150, ["好。", "跑。"]),
			"换一下。",
			...repeatLines(150, ["好。", "跑。"]),
			...normalLines(40, 8000),
		];
		assert.equal(findDupSegments(lines.join("\n")).length, 1, "夹两行以内不断段");

		lines.splice(
			lines.indexOf("换一下。"),
			1,
			"换一下。",
			"再看一眼。",
			"就这里。",
		);
		const segs = findDupSegments(lines.join("\n"));
		assert.equal(segs.length, 2, "夹 3 行以上断成两段");
		assert.ok(segs[0].lines >= 40 && segs[1].lines >= 40);
	});
});

describe("切段兜底（别把老行为弄丢）", () => {
	it("稀头密尾：整段密度不够时折尾巴那截，稀头一行不吞", () => {
		// 前半是「好。」夹着一行真推理（区间连成一片但密度很低），
		// 后半才是密集复读。整段密度不够，但尾巴那截够 —— 不能因此放过
		const sparse: string[] = [];
		for (let i = 0; i < 200; i++) {
			sparse.push("好。", `- 第 ${i} 步：这是一段只出现一次的推理，跟复读无关。`);
		}
		const text = [...sparse, ...repeatLines(150, ["执行。", "跑。"])].join("\n");
		const segs = findDupSegments(text);
		assert.equal(segs.length, 1, `应命中尾巴那截，实得 ${segs.length} 段`);
		assert.ok(segs[0].lines >= 300, "密尾整段在里面");
		assert.ok(segs[0].startLine < sparse.length, "允许往稀头里多吃几行");
		assert.ok(segs[0].startLine > 100, `稀头不该被吞，实得起点 ${segs[0].startLine}`);
		assert.equal(text.split("\n").length - segs[0].endLine, 0, "段尾到块尾");
	});

	it("两截密集复读各自都太小、被几行变化词隔开 → 合并成一截折", () => {
		const gap = ["换一下。", "再看一眼。", "就这里。", "先记着。"];
		const text = [
			...normalLines(40),
			...repeatLines(100, ["好。"]),
			...gap,
			...repeatLines(100, ["好。"]),
			...normalLines(30, 6000),
		].join("\n");
		// 单截只有 100 行 / 300 字，过不了 minLines / minChars；合并后 204 行 / 621 字
		const segs = findDupSegments(text);
		assert.equal(segs.length, 1);
		assert.equal(segs[0].startLine, 40);
		assert.equal(segs[0].endLine, 244, "两截 + 中间 4 行都在段里");
		assert.equal(segs[0].lines, 204);
		assert.equal(text.split("\n").length - segs[0].endLine, 30, "后面的正常内容照留");
	});
});

describe("正常块绝不碰", () => {
	it("长推理：行行不同", () => {
		const lines: string[] = [];
		for (let i = 0; i < 200; i++) {
			lines.push(`第 ${i} 步：检查 ${i} 号文件的类型标注与调用点，评估改动面。`);
		}
		assert.deepEqual(findDupSegments(lines.join("\n")), []);
	});

	it("含代码块与并列清单的长块", () => {
		const lines: string[] = [];
		lines.push("先看实现：", "", "```ts");
		lines.push("export function applyFold(markdown: string): string {");
		lines.push("  return markdown;");
		lines.push("}");
		lines.push("```", "");
		lines.push("待办：");
		for (let i = 0; i < 120; i++) {
			lines.push(`- [ ] 处理第 ${i} 个边界：空文本、超短、整块复读。`);
		}
		lines.push("", "| 项 | 值 |", "| --- | --- |", "| a | 1 |", "| b | 2 |");
		assert.deepEqual(findDupSegments(lines.join("\n")), []);
	});

	it("散落的重复行不算复读（没到 maxTopCount / 段不到 minLines）", () => {
		const lines: string[] = [];
		for (let i = 0; i < 120; i++) {
			lines.push(`第 ${i} 步：继续检查。`);
			if (i % 40 === 0) lines.push("好。");
		}
		assert.deepEqual(findDupSegments(lines.join("\n")), []);
	});

	it("重复行太长不算复读行（日志回显形态）", () => {
		const lines: string[] = [];
		for (let i = 0; i < 80; i++) {
			lines.push(`第 ${i} 步：继续。`);
			for (let j = 0; j < 3; j++) lines.push(`warning: module not found while resolving dependency chain ${i}-${j}`);
		}
		assert.deepEqual(findDupSegments(lines.join("\n")), []);
	});

	it("短复读坨不到 minLines / minChars，不折", () => {
		// 复读 20 轮（40 行 / 120 字），离 minLines 40 与 minChars 600 都差得远
		const lines = [...normalLines(200), ...repeatLines(20, ["好。", "跑。"])];
		assert.deepEqual(findDupSegments(lines.join("\n")), []);
	});
});

describe("边界", () => {
	it("空文本", () => {
		assert.deepEqual(findDupSegments(""), []);
	});

	it("超短文本", () => {
		assert.deepEqual(findDupSegments("好。"), []);
		assert.deepEqual(findDupSegments("好。\n执行。\n好。"), []);
	});

	it("复读行数不到 minLines 不命中", () => {
		const short = Array.from({ length: 30 }, () => "好。").join("\n");
		assert.deepEqual(findDupSegments(short), []);
	});

	it("行号映射：空行 / 纯符号行不参与统计，但 startLine / endLine 是原始行号", () => {
		const raw = [
			"",
			"```",
			...Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? "好。" : "执行。")),
			"```",
			"",
		];
		const segs = findDupSegments(raw.join("\n"));
		assert.equal(segs.length, 1);
		assert.equal(segs[0].startLine, 2, "第一行有效内容是原始下标 2");
		assert.equal(segs[0].endLine, 302, "段止于最后一个复读行的下一行");
		assert.equal(segs[0].lines, 300, "``` 与空行不进统计");
	});

	it("阈值可以调：关掉 minChars 后短块也能命中", () => {
		const text = Array.from({ length: 50 }, () => "好。").join("\n");
		assert.deepEqual(findDupSegments(text), []);
		const segs = findDupSegments(text, { minChars: 0, minLines: 40 });
		assert.equal(segs.length, 1);
		assert.equal(segs[0].kinds, 1);
	});

	it("gapMax 可调：0 时夹一行也断段", () => {
		const lines = [
			...normalLines(60),
			...repeatLines(150, ["好。", "跑。"]),
			"换一下。",
			...repeatLines(150, ["好。", "跑。"]),
			...normalLines(40, 8000),
		];
		assert.equal(findDupSegments(lines.join("\n"), { gapMax: 0 }).length, 2);
		assert.equal(findDupSegments(lines.join("\n"), { gapMax: 2 }).length, 1);
	});
});

describe("applyFold 之外的调用约定", () => {
	it("段与段之间的行完整地在两段之外（splice 时不会丢）", () => {
		const between = ["这里是一段真的推理，只有一次。", "第二行也不重复。", "第三行同上，连起来超过 gapMax。"];
		const text = [
			...normalLines(60),
			...repeatLines(150, ["好。", "跑。"]),
			...between,
			...repeatLines(150, ["好。", "跑。"]),
			...normalLines(20, 7000),
		].join("\n");
		const segs = findDupSegments(text);
		assert.equal(segs.length, 2);
		const raw = text.split("\n");
		const kept = raw.slice(segs[0].endLine, segs[1].startLine);
		assert.deepEqual(kept, between, "段之间的内容原样保留");
	});

	it("endLine 之后的行数就是保留的尾巴", () => {
		const text = [...repeatLines(150, ["好。", "跑。"]), "尾注：收工。"].join("\n");
		const segs = findDupSegments(text);
		assert.equal(segs.length, 1);
		assert.equal(countOccurrences(text, "尾注：收工。"), 1);
		assert.equal(text.split("\n").slice(segs[0].endLine).join("\n"), "尾注：收工。");
	});
});
