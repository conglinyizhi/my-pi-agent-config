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
