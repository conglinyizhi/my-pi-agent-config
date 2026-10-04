// lib/script-format.test.ts
// 跑法：node --test --experimental-strip-types lib/script-format.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatScriptForDisplay } from "./script-format.ts";

const firstIndents = (text: string): number[] =>
	text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => (line.match(/^ */)?.[0] ?? "").length);

describe("重排", () => {
	it("挤在一行的代码拆成多行", async () => {
		const result = await formatScriptForDisplay("const a=1;const b=2;");
		assert.equal(result.formatted, true);
		assert.ok(result.text.split("\n").length >= 2, result.text);
	});

	it("行首缩进按 2 空格重算", async () => {
		const source = [
			"async function main() {",
			"const x = await tools.write({",
			'path: "/tmp/a.js",',
			'content: "hi",',
			"});",
			"if (x) {",
			"return 1;",
			"}",
			"}",
		].join("\n");
		const result = await formatScriptForDisplay(source);
		assert.equal(result.formatted, true);
		const indents = firstIndents(result.text);
		assert.ok(indents.every((width) => width % 2 === 0), JSON.stringify(indents));
		assert.ok(indents.includes(2), JSON.stringify(indents));
		assert.ok(indents.includes(4), JSON.stringify(indents));
		assert.ok(!indents.includes(6) || indents.every((width) => width % 2 === 0), JSON.stringify(indents));
	});

	it("模板字符串内部原样不动（那里的空白是内容）", async () => {
		const source = [
			"const sql = `",
			"    select 1",
			"        from t",
			"`;",
			"tools.write({ path: \"/tmp/a.js\", content: sql });",
		].join("\n");
		const result = await formatScriptForDisplay(source);
		assert.equal(result.formatted, true, result.reason);
		assert.ok(result.text.includes("    select 1"), result.text);
		assert.ok(result.text.includes("        from t"), result.text);
	});

	it("块注释内部原样不动", async () => {
		const source = ["/*", "    缩进过的说明", "*/", "const a = 1;"].join("\n");
		const result = await formatScriptForDisplay(source);
		assert.equal(result.formatted, true, result.reason);
		assert.ok(result.text.includes("    缩进过的说明"), result.text);
	});

	it("字符串里的花括号不带偏层级", async () => {
		const source = ['const s = "}";', "if (s) {", "const t = 1;", "}"].join("\n");
		const result = await formatScriptForDisplay(source);
		assert.equal(result.formatted, true);
		const lines = result.text.split("\n").filter((line) => line.trim() !== "");
		const closing = lines[lines.length - 1];
		assert.equal(closing.trim(), "}");
		assert.equal((closing.match(/^ */)?.[0] ?? "").length, 0, result.text);
	});

	it("注释不会在重排里丢掉", async () => {
		const source = ["// 先读再写", "const a = 1;", "/* 块注释 */", "const b = 2;"].join("\n");
		const result = await formatScriptForDisplay(source);
		assert.equal(result.formatted, true, result.reason);
		assert.ok(result.text.includes("// 先读再写"), result.text);
		assert.ok(result.text.includes("/* 块注释 */"), result.text);
	});
});

describe("安全网", () => {
	it("语法有问题时退回原文，逐字不动", async () => {
		const broken = "const a = ;\n).";
		const result = await formatScriptForDisplay(broken);
		assert.equal(result.formatted, false);
		assert.equal(result.text, broken);
		assert.ok(result.reason);
	});

	it("空脚本不折腾", async () => {
		const result = await formatScriptForDisplay("");
		assert.equal(result.formatted, false);
		assert.equal(result.text, "");
	});

	it("重排后调用与参数一个不少（token 流一致）", async () => {
		const source = 'tools.write({path:"/tmp/a.js",content:"x"});tools.bash({command:"ls -la"});';
		const result = await formatScriptForDisplay(source);
		assert.equal(result.formatted, true, result.reason);
		for (const token of ["tools", "write", "/tmp/a.js", "x", "bash", "ls -la"]) {
			assert.ok(result.text.includes(token), token);
		}
	});
});
