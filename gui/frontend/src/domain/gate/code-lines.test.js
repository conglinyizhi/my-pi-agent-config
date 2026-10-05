import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitLines } from "./code-lines.js";

const text = (value, start, marks) => ({ kind: "text", text: value, start, marks });

describe("切行", () => {
	it("按换行切开，行号从 1 起", () => {
		const lines = splitLines([text("a\nb\nc", 0)], []);
		assert.deepEqual(lines.map((line) => line.no), [1, 2, 3]);
		assert.deepEqual(lines[1].parts.map((part) => part.text), ["b"]);
	});

	it("芯片留在它所在的那一行", () => {
		const chip = { kind: "chip", chip: { label: "写文件" } };
		const lines = splitLines([text("a\n", 0), chip, text("\nc", 2)], []);
		assert.equal(lines.length, 3);
		assert.equal(lines[1].parts[0].kind, "chip");
		assert.equal(lines[1].parts[0].chip.label, "写文件");
	});

	it("令牌与标记的偏移跟着切，跨界的一起裁", () => {
		const lines = splitLines([text("ab\ncd", 10)], [
			{ s: 11, e: 13, color: "#fff" },
			{ s: 13, e: 14, color: "#000" },
		]);
		assert.deepEqual(lines[0].parts[0].tokens, [{ s: 1, e: 2, color: "#fff" }]);
		assert.deepEqual(lines[1].parts[0].tokens, [{ s: 0, e: 1, color: "#000" }]);
	});

	it("marks 是片段内坐标，切行后按行内偏移留下", () => {
		// 折叠模型交出来的 marks 已经平移到片段内，不能再加整段起点
		const lines = splitLines([text("ab\ncd", 10, [{ s: 1, e: 2, tone: "env", t: "赋值" }])], []);
		assert.deepEqual(lines[0].parts[0].marks, [{ s: 1, e: 2, tone: "env", t: "赋值" }]);
		assert.deepEqual(lines[1].parts[0].marks, []);
	});

	it("空行不塞空片段，但行号照占", () => {
		const lines = splitLines([text("a\n\nb", 0)], []);
		assert.equal(lines.length, 3);
		assert.deepEqual(lines[1].parts, []);
	});
});
