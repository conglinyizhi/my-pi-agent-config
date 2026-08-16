// str-replace.test.ts — dsh-tools str_replace_editor 语义测试
//
// 纯函数（matchOffsets/lineNumbersAt/normalizeViewRange/formatFileView）直测；
// fs 集成（view/create/str_replace/insert + 错误路径）用 tmp 目录真实文件。
//
// 跑法：node --experimental-strip-types extensions/dsh-tools/str-replace.test.ts

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TRUNCATED_MESSAGE,
	createFile,
	formatFileView,
	insertLine,
	lineNumbersAt,
	matchOffsets,
	maybeTruncate,
	normalizeViewRange,
	strReplace,
	viewPath,
} from "./str-replace.ts";

describe("纯函数", () => {
	it("matchOffsets 找到全部偏移", () => {
		assert.deepEqual(matchOffsets("aaXbbXcc", "X"), [2, 5]);
		assert.deepEqual(matchOffsets("abc", "X"), []);
	});

	it("lineNumbersAt 映射偏移到行号（1-indexed）", () => {
		const content = "line1\nline2\nline3";
		assert.deepEqual(lineNumbersAt(content, [0, 6, 12]), [1, 2, 3]);
	});

	it("normalizeViewRange 校验", () => {
		const lines = ["a", "b", "c"];
		assert.deepEqual(normalizeViewRange([2, 3], lines), { initialLine: 2, finalLine: 3 });
		assert.deepEqual(normalizeViewRange([2, -1], lines), { initialLine: 2, finalLine: -1 });
		assert.deepEqual(normalizeViewRange(undefined, lines), undefined);
		assert.throws(() => normalizeViewRange([0, 1], lines), /within the range/);
		assert.throws(() => normalizeViewRange([2, 5], lines), /smaller than the number of lines/);
		assert.throws(() => normalizeViewRange([3, 2], lines), /larger or equal/);
		assert.throws(() => normalizeViewRange([1], lines), /two integers/);
	});

	it("formatFileView 行号 padStart(6) 与 view_range 切片", () => {
		const out = formatFileView("/tmp/f.ts", "a\nb\nc", 16000, undefined);
		assert.ok(out.includes("     1  a"));
		assert.ok(out.includes("     3  c"));
		assert.ok(out.includes("total of 3 lines"));

		const ranged = formatFileView("/tmp/f.ts", "a\nb\nc", 16000, [2, -1]);
		assert.ok(ranged.includes("view_range=[2, -1]"));
		assert.ok(ranged.includes("     2  b"));
		assert.ok(!ranged.includes("     1  a"));
	});

	it("maybeTruncate 超限截断并标注", () => {
		const long = "x".repeat(200);
		const out = maybeTruncate(long, 100);
		assert.equal(out.length, 100 + TRUNCATED_MESSAGE.length);
		assert.ok(out.endsWith(TRUNCATED_MESSAGE));
		assert.equal(maybeTruncate("short", 100), "short");
	});
});

describe("fs 集成（tmp 文件）", () => {
	const dir = mkdtempSync(join(tmpdir(), "sre-test-"));
	const file = join(dir, "sample.ts");
	writeFileSync(file, "line1\nline2\nline3\n", "utf8");

	after(() => rmSync(dir, { recursive: true, force: true }));

	it("view 显示行号", () => {
		const out = viewPath(file, undefined, 16000);
		assert.ok(out.includes("     1  line1"));
		assert.ok(out.includes("     3  line3"));
	});

	it("view_range 截取", () => {
		const out = viewPath(file, [2, 2], 16000);
		assert.ok(out.includes("     2  line2"));
		assert.ok(!out.includes("line1"));
	});

	it("str_replace 精确替换", () => {
		strReplace(file, "line2", "REPLACED");
		assert.equal(readFileSync(file, "utf8"), "line1\nREPLACED\nline3\n");
	});

	it("str_replace 未匹配拒绝执行且不改文件", () => {
		const before = readFileSync(file, "utf8");
		assert.throws(() => strReplace(file, "不存在的内容", "x"), /did not appear verbatim/);
		assert.equal(readFileSync(file, "utf8"), before);
	});

	it("str_replace 多匹配拒绝执行并给出行号", () => {
		const dup = join(dir, "dup.txt");
		writeFileSync(dup, "same\nother\nsame\n", "utf8");
		assert.throws(() => strReplace(dup, "same", "x"), /Multiple occurrences.*lines \[1, 3\]/);
		assert.equal(readFileSync(dup, "utf8"), "same\nother\nsame\n");
	});

	it("insert 在指定行后插入", () => {
		insertLine(file, 1, "INSERTED");
		assert.equal(readFileSync(file, "utf8"), "line1\nINSERTED\nREPLACED\nline3\n");
	});

	it("insert_line 越界抛错", () => {
		assert.throws(() => insertLine(file, 99, "x"), /within the range/);
	});

	it("create 创建新文件并拒绝覆盖", () => {
		const created = join(dir, "new.txt");
		const msg = createFile(created, "hello");
		assert.ok(msg.includes("created successfully"));
		assert.equal(readFileSync(created, "utf8"), "hello");
		assert.throws(() => createFile(created, "again"), /already exists/);
	});

	it("相对路径拒绝", () => {
		assert.throws(() => viewPath("relative/path", undefined, 16000), /not an absolute path/);
	});

	it("不存在路径报错", () => {
		assert.throws(() => viewPath(join(dir, "missing.txt"), undefined, 16000), /does not exist/);
	});

	it("目录仅 view 可用", () => {
		const out = viewPath(dir, undefined, 16000);
		assert.ok(out.includes("up to 2 levels deep"));
		assert.throws(() => strReplace(dir, "x", "y"), /only the `view` command/);
		assert.ok(existsSync(dir));
	});
});
