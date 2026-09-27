// thinking-fold/detector.test.ts — 尾部复读后缀检测的单测
//
// 跑法：node --test --experimental-strip-types extensions/thinking-fold/detector.test.ts
//
// 重点：命中尾部复读、正常长块（代码 / 并列清单 / 表格）不碰、边界与行号映射。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_DUP_OPTIONS, findDupSuffix } from "./detector.ts";

/** 构造「一段正常内容 + 尾部复读」的块 */
function blockWithRepeat(head: number, cycles: number, kinds: string[]): string {
	const lines: string[] = [];
	for (let i = 0; i < head; i++) {
		lines.push(`- 第 ${i} 项：核对模块 ${i} 的导出与依赖，确认没有循环引用。`);
	}
	for (let c = 0; c < cycles; c++) for (const k of kinds) lines.push(k);
	return lines.join("\n");
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

describe("命中尾部复读", () => {
	it("「好。/执行。」反复几十次的块，尾部被判为复读后缀", () => {
		const text = blockWithRepeat(400, 100, ["好。", "执行。", "Output."]);
		const hit = findDupSuffix(text);
		assert.ok(hit, "应该命中");
		assert.ok(hit.lines >= DEFAULT_DUP_OPTIONS.minLines);
		assert.ok(hit.chars >= DEFAULT_DUP_OPTIONS.minChars);
		assert.ok(hit.kinds >= 1 && hit.kinds <= DEFAULT_DUP_OPTIONS.maxKinds);
		assert.ok(hit.top.length <= 4, "最多列 4 个样例");
		assert.ok(
			hit.top.some((t) => /^好。 ×\d+$/.test(t)),
			`top 里应有「好。 ×次数」，实得 ${JSON.stringify(hit.top)}`,
		);
		assert.ok(hit.startLine > 0, "后缀从复读段开始");
	});

	it("后缀起点之前的内容不在折叠范围内", () => {
		// 头部很长（占比过半），后缀只能吃到密度 0.5 的边界
		const text = blockWithRepeat(400, 100, ["好。", "执行。"]);
		const hit = findDupSuffix(text);
		assert.ok(hit);
		const raw = text.split("\n");
		const head = raw.slice(0, hit.startLine);
		// 前 100 行普通内容必须留在保留区里
		assert.ok(head.length >= 100, `普通头部不该被吃掉，实得 ${head.length} 行`);
		assert.ok(raw.slice(hit.startLine).length === hit.lines);
	});

	it("单种短句刷屏也算（最典型形态）", () => {
		const text = blockWithRepeat(50, 300, ["好。"]);
		const hit = findDupSuffix(text);
		assert.ok(hit);
		assert.equal(hit.kinds, 1);
		assert.match(hit.top[0], /^好。 ×/);
	});
});

describe("正常块绝不碰", () => {
	it("长推理：行行不同", () => {
		const lines: string[] = [];
		for (let i = 0; i < 200; i++) {
			lines.push(`第 ${i} 步：检查 ${i} 号文件的类型标注与调用点，评估改动面。`);
		}
		assert.equal(findDupSuffix(lines.join("\n")), null);
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
		assert.equal(findDupSuffix(lines.join("\n")), null);
	});

	it("散落的重复行不算复读（没到 minTopCount）", () => {
		const lines: string[] = [];
		for (let i = 0; i < 120; i++) {
			lines.push(`第 ${i} 步：继续检查。`);
			if (i % 40 === 0) lines.push("好。");
		}
		assert.equal(findDupSuffix(lines.join("\n")), null);
	});

	it("重复行太长不算复读行（日志回显形态）", () => {
		const lines: string[] = [];
		for (let i = 0; i < 80; i++) {
			lines.push(`第 ${i} 步：继续。`);
			for (let j = 0; j < 3; j++) lines.push(`warning: module not found while resolving dependency chain ${i}-${j}`);
		}
		assert.equal(findDupSuffix(lines.join("\n")), null);
	});
});

describe("边界", () => {
	it("空文本", () => {
		assert.equal(findDupSuffix(""), null);
	});

	it("超短文本", () => {
		assert.equal(findDupSuffix("好。"), null);
		assert.equal(findDupSuffix("好。\n执行。\n好。"), null);
	});

	it("复读行数不到 minLines 不命中", () => {
		const short = Array.from({ length: 30 }, () => "好。").join("\n");
		assert.equal(findDupSuffix(short), null);
	});

	it("整块都是复读 → startLine = 0", () => {
		const text = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? "好。" : "执行。")).join("\n");
		const hit = findDupSuffix(text);
		assert.ok(hit);
		assert.equal(hit.startLine, 0);
		assert.equal(hit.lines, 200);
	});

	it("行号映射：空行 / 纯符号行不参与统计，但 startLine 是原始行号", () => {
		const raw = [
			"",
			"```",
			...Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? "好。" : "执行。")),
			"```",
			"",
		];
		const hit = findDupSuffix(raw.join("\n"));
		assert.ok(hit);
		assert.equal(hit.startLine, 2, "第一行有效内容是原始下标 2");
		assert.equal(hit.lines, 300, "``` 与空行不进统计");
	});

	it("窗口会往前吃普通行，但起点对齐到第一个复读行", () => {
		// 100 行普通 + 200 行复读：按占比窗口能吃进十几行普通内容，
		// 但最终起点会对齐回复读段第一行（第 100 行），宁可少折
		const text = blockWithRepeat(100, 100, ["好。", "执行。"]);
		const hit = findDupSuffix(text);
		assert.ok(hit);
		assert.equal(hit.startLine, 100, "起点对齐到复读段第一行");
		assert.equal(hit.lines, 200);
	});

	it("阈值可以调：关掉 minChars 后短块也能命中", () => {
		const text = Array.from({ length: 50 }, () => "好。").join("\n");
		assert.equal(findDupSuffix(text), null);
		const hit = findDupSuffix(text, { minChars: 0, minLines: 40 });
		assert.ok(hit);
		assert.equal(hit.kinds, 1);
	});
});
