// lib/text-diff.test.ts
// 跑法：node --test --experimental-strip-types lib/text-diff.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collapseContext, lineDiff, splitLines } from "./text-diff.ts";

const NL = String.fromCharCode(10);
const lines = (...items: string[]) => items.join(NL);

describe("切行", () => {
	it("尾随换行不产生空行", () => {
		assert.deepEqual(splitLines(`a${NL}b${NL}`), ["a", "b"]);
	});
	it("空文本是零行", () => {
		assert.deepEqual(splitLines(""), []);
	});
	it("CRLF 的行尾不被算进内容", () => {
		assert.deepEqual(splitLines(`a${NL}b`), ["a", "b"]);
		assert.deepEqual(splitLines(`a${"\r"}${NL}b`), ["a", "b"]);
	});
});

describe("逐行对比", () => {
	it("完全一样时明说 identical，行号成对给出", () => {
		const result = lineDiff(lines("a", "b"), lines("a", "b"));
		assert.equal(result.status, "identical");
		assert.equal(result.added, 0);
		assert.equal(result.removed, 0);
		assert.deepEqual(result.rows.map((row) => [row.kind, row.oldLine, row.newLine]), [
			["same", 1, 1],
			["same", 2, 2],
		]);
	});

	it("改一行：一行删一行加，行内差异被标出来", () => {
		const result = lineDiff(lines("one", "two", "three"), lines("one", "two", "three!")) ;
		assert.equal(result.status, "ok");
		assert.equal(result.added, 1);
		assert.equal(result.removed, 1);
		const del = result.rows.find((row) => row.kind === "del");
		const add = result.rows.find((row) => row.kind === "add");
		assert.equal(del?.oldLine, 3);
		assert.equal(del?.newLine, undefined);
		assert.equal(add?.newLine, 3);
		// 旧行是完整前缀，行内没有要标的地方；新行多出来的那一个字符要标
		assert.equal(del?.intra, undefined);
		assert.deepEqual(add?.intra, [{ s: 5, e: 6 }]);
	});

	it("插入若干行：只有 add，旧行号不乱跳", () => {
		const result = lineDiff(lines("a", "c"), lines("a", "b1", "b2", "c"));
		assert.equal(result.removed, 0);
		assert.equal(result.added, 2);
		assert.deepEqual(
			result.rows.map((row) => [row.kind, row.oldLine ?? null, row.newLine ?? null]),
			[["same", 1, 1], ["add", null, 2], ["add", null, 3], ["same", 2, 4]],
		);
	});

	it("删除若干行：只有 del", () => {
		const result = lineDiff(lines("a", "b1", "b2", "c"), lines("a", "c"));
		assert.equal(result.added, 0);
		assert.equal(result.removed, 2);
		assert.deepEqual(result.rows.map((row) => row.kind), ["same", "del", "del", "same"]);
	});

	it("改动在长文件中间时，前后文行号仍然对得上", () => {
		const before = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
		const after = [...before];
		after[29] = "line 30 改了";
		const result = lineDiff(before.join(NL), after.join(NL));
		assert.equal(result.status, "ok");
		assert.equal(result.added, 1);
		const lastSame = [...result.rows].reverse().find((row) => row.kind === "same");
		assert.equal(lastSame?.oldLine, 50);
		assert.equal(lastSame?.newLine, 50);
	});

	it("空旧文本=新建，空新文本=清空", () => {
		const created = lineDiff("", lines("a", "b"));
		assert.deepEqual(created.rows.map((row) => row.kind), ["add", "add"]);
		const cleared = lineDiff(lines("a", "b"), "");
		assert.deepEqual(cleared.rows.map((row) => row.kind), ["del", "del"]);
	});
});

describe("太大的中间段不硬算", () => {
	it("两段各 700 行且毫不相干时返回 too-large，不装作对比过", () => {
		const before = Array.from({ length: 700 }, (_, index) => `old ${index}`).join(NL);
		const after = Array.from({ length: 700 }, (_, index) => `new ${index}`).join(NL);
		const result = lineDiff(before, after);
		assert.equal(result.status, "too-large");
		assert.deepEqual(result.rows, []);
	});

	it("同一份文本里的小改动不吃上限（先剥公共前后缀）", () => {
		const before = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join(NL);
		const after = before.replace("line 1500", "line 1500 改了");
		const result = lineDiff(before, after);
		assert.equal(result.status, "ok");
		assert.equal(result.added, 1);
	});
});

describe("上下文折叠", () => {
	it("改动附近留 context 行，其余折成 gap", () => {
		const before = Array.from({ length: 40 }, (_, index) => `l${index}`).join(NL);
		const after = before.replace("l20", "l20 changed");
		const result = lineDiff(before, after);
		const blocks = collapseContext(result.rows, 3);
		assert.equal(blocks[0].type, "gap");
		assert.equal(blocks[0].count, 17);
		assert.equal(blocks[1].type, "rows");
		assert.equal(blocks[2].type, "gap");
		// 41 行里最后一颗 keep 落在下标 24，剩下 16 行折起来
		assert.equal(blocks[2].count, 16);
	});

	it("改动在文件头尾时不产生多余的 gap", () => {
		const blocks = collapseContext(lineDiff(lines("a"), lines("b")).rows, 3);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0].type, "rows");
	});

	it("一点没改时整份折成一整块 gap（调用方本该先看 status）", () => {
		const blocks = collapseContext(lineDiff(lines("a", "b"), lines("a", "b")).rows, 3);
		assert.deepEqual(blocks, [{ type: "gap", count: 2 }]);
	});
});
