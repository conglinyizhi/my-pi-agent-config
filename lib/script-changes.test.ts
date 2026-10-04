// lib/script-changes.test.ts
// 跑法：node --test --experimental-strip-types lib/script-changes.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanScript } from "./ptc-analyze.ts";
import { mergeFileChanges } from "./script-changes.ts";

const NL = String.fromCharCode(10);
const lines = (...items: string[]) => items.join(NL);

async function merge(source: string) {
	return mergeFileChanges((await scanScript(source)).calls);
}

describe("写入打底", () => {
	it("单次 write：一份新增的净变化", async () => {
		const source = 'tools.write({ path: "/tmp/a.txt", content: "one\\ntwo" });';
		const merged = await merge(source);
		assert.equal(merged.length, 1);
		assert.equal(merged[0].status, "merged");
		assert.equal(merged[0].ops, 1);
		assert.equal(merged[0].added, 2);
		assert.equal(merged[0].removed, 0);
		assert.equal(merged[0].path, "/tmp/a.txt");
	});

	it("write 之后再 edit：合成一份净变化", async () => {
		const source = [
			'tools.write({ path: "/tmp/a.txt", content: "one\\ntwo\\nthree" });',
			'tools.edit({ path: "/tmp/a.txt", old: "two", new: "TWO changed" });',
		].join(NL);
		const merged = await merge(source);
		assert.equal(merged.length, 1);
		assert.equal(merged[0].status, "merged");
		assert.equal(merged[0].ops, 2);
		assert.equal(merged[0].added, 1);
		assert.equal(merged[0].removed, 1);
		const rows = merged[0].blocks.flatMap((block) => (block.type === "rows" ? block.rows : []));
		assert.ok(rows.some((row) => row.text === "TWO changed"), JSON.stringify(rows));
	});

	it("后一次 write 覆盖前一次", async () => {
		const source = [
			'tools.write({ path: "/tmp/a.txt", content: "old" });',
			'tools.write({ path: "/tmp/a.txt", content: "new" });',
		].join(NL);
		const merged = await merge(source);
		assert.equal(merged[0].status, "merged");
		assert.equal(merged[0].added, 1);
		assert.equal(merged[0].removed, 1);
	});

	it("不同文件各合成一份", async () => {
		const source = [
			'tools.write({ path: "/tmp/a.txt", content: "a" });',
			'tools.write({ path: "/tmp/b.txt", content: "b" });',
		].join(NL);
		const merged = await merge(source);
		assert.deepEqual(merged.map((entry) => entry.path), ["/tmp/a.txt", "/tmp/b.txt"]);
	});
});

describe("断链要明说", () => {
	it("只有局部替换、没有可推演的全文本：unknown-base", async () => {
		const source = 'tools.edit({ path: "/tmp/a.txt", old: "x", new: "y" });';
		const merged = await merge(source);
		assert.equal(merged[0].status, "unknown-base");
		assert.match(merged[0].reason ?? "", /基准内容不知道/);
		assert.deepEqual(merged[0].blocks, []);
	});

	it("old 在推演出的文本里找不到：chain-broken 并指出行号", async () => {
		const source = [
			'tools.write({ path: "/tmp/a.txt", content: "one" });',
			'tools.edit({ path: "/tmp/a.txt", old: "not-there", new: "y" });',
		].join(NL);
		const merged = await merge(source);
		assert.equal(merged[0].status, "chain-broken");
		assert.match(merged[0].reason ?? "", /第 2 行 edit/);
		assert.equal(merged[0].ops, 1);
	});

	it("正文是变量：chain-broken，不猜内容", async () => {
		const source = [
			'const body = readIt();',
			'tools.write({ path: "/tmp/a.txt", content: body });',
		].join(NL);
		const merged = await merge(source);
		assert.equal(merged[0].status, "chain-broken");
		assert.match(merged[0].reason ?? "", /不是字面量/);
	});

	it("apply_patch 断链，并说明为什么不重造 patch", async () => {
		// 补丁正文里带着目标路径（apply_patch 就是靠这个认文件的）
		const source = [
			'tools.write({ path: "/tmp/a.txt", content: "one" });',
			'tools.apply_patch({ patch: "*** Update File: /tmp/a.txt\\n@@\\n-one\\n+two\\n" });',
		].join(NL);
		const merged = await merge(source);
		assert.equal(merged.length, 1);
		assert.equal(merged[0].status, "chain-broken");
		assert.match(merged[0].reason ?? "", /不重造 patch/);
	});

	it("补丁认不出改的是哪个文件时，合并结果标存疑", async () => {
		const source = [
			'tools.write({ path: "/tmp/a.txt", content: "one" });',
			'tools.apply_patch({ patch: "*** Update File: /somewhere/else.txt\\n@@\\n-x\\n+y\\n" });',
		].join(NL);
		const merged = await merge(source);
		assert.equal(merged[0].status, "chain-broken");
		assert.match(merged[0].reason ?? "", /认不出它改的是哪些文件/);
	});

	it("路径不是字面量就不参与合并", async () => {
		const source = [
			'const p = pick();',
			'tools.write({ path: p, content: "x" });',
		].join(NL);
		assert.deepEqual(await merge(source), []);
	});
});

describe("有界", () => {
	it("改动超过 400 行时截断并标记", async () => {
		const body = Array.from({ length: 500 }, (_, index) => "line " + index).join("\\n");
		const source = 'tools.write({ path: "/tmp/big.txt", content: "' + body + '" });';
		const merged = await merge(source);
		assert.equal(merged[0].truncated, true);
		const rows = merged[0].blocks.flatMap((block) => (block.type === "rows" ? block.rows : []));
		assert.equal(rows.length, 400);
	});
});
