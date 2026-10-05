// lib/review-flow/source-guard.test.ts — 流程源码的越界检查
// 跑法：node --test --experimental-strip-types lib/review-flow/source-guard.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkFlowSource, formatViolations } from "./source-guard.ts";

describe("流程源码越界检查", () => {
	it("导入原生模块直接拒", async () => {
		const found = await checkFlowSource("import { readFileSync } from \"node:fs\";\n");
		assert.equal(found.length, 1);
		assert.match(found[0]?.message ?? "", /原生模块/);
	});

	it("裸名的原生模块一样拒：fs 与 node:fs 是同一个东西", async () => {
		for (const line of [
			'import fs from "fs";',
			'import { promises as p } from "fs/promises";',
			'import { spawn } from "child_process";',
		]) {
			const found = await checkFlowSource(line + "\n");
			assert.equal(found.length, 1, line);
			assert.match(found[0]?.message ?? "", /原生模块/, line);
		}
	});

	it("别的模块也拒：流程是单文件（带帮手文件是绕道）", async () => {
		for (const line of ['import _ from "lodash";', 'import { helper } from "./helper.ts";', 'export { x } from "./other.ts";']) {
			const found = await checkFlowSource(line + "\n");
			assert.equal(found.length, 1, line);
			assert.match(found[0]?.message ?? "", /单文件/, line);
		}
	});

	it("只借类型是允许的：type-only 会被整段擦掉", async () => {
		const found = await checkFlowSource('import type { ReviewKit } from "../lib/review-flow/kit.ts";\n');
		assert.deepEqual(found, []);
	});

	it("具名里标了 type 的也算只借类型；import = require 则拒", async () => {
		assert.deepEqual(await checkFlowSource('import { type ReviewKit } from "../lib/review-flow/kit.ts";\n'), []);
		const found = await checkFlowSource('import fs = require("fs");\n');
		assert.ok(found.length >= 1);
	});

	it("碰 process 直接拒（退出、环境变量都在这里）", async () => {
		const found = await checkFlowSource("process.exit(1);\n");
		assert.equal(found.length, 1);
		assert.match(found[0]?.message ?? "", /碰进程/);
	});

	it("动态 import 与 require 直接拒", async () => {
		const dynamic = await checkFlowSource("const os = await import(\"node:os\");\n");
		assert.ok(dynamic.some((v) => v.message.includes("动态 import")));
		const common = await checkFlowSource("const fs = require(\"fs\");\n");
		assert.ok(common.some((v) => v.message.includes("require")));
	});

	it("属性的名字、参数的名字不算引用", async () => {
		const found = await checkFlowSource("const cfg = { process: 1 };\nconst x = ctx.settings.process;\n");
		assert.deepEqual(found, []);
	});

	it("正常形状的流程一行都不报", async () => {
		const source = [
			"export default (kit) => kit.flow({",
			"\tid: \"bash-pre\",",
			"\tnodes: [kit.node(\"chatreview\", { id: \"chat\", next: \"judge\" }), kit.custom(\"judge\", async () => ({ status: \"ok\", terminal: \"deny\" }))],",
			"});",
		].join("\n");
		assert.deepEqual(await checkFlowSource(source), []);
	});

	it("报错文案带行列，最多列八条", async () => {
		const found = await checkFlowSource("process.exit(1);\nglobalThis.x = 1;\n");
		const text = formatViolations(found, "x.ts");
		assert.match(text, /x\.ts:1:1/);
		assert.match(text, /只做判定/);
	});
});
