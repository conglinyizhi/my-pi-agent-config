// lib/ptc-analyze.test.ts — 字面量级扫描
//
// 跑法：node --test --experimental-strip-types lib/ptc-analyze.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanScript } from "./ptc-analyze.ts";

describe("字面量扫描", () => {
	it("拿到工具名与参数字面量", async () => {
		const scan = await scanScript("return await tools.read({ path: '/etc/hostname' })");
		assert.deepEqual(scan.tools, ["read"]);
		assert.deepEqual(scan.paths, ["/etc/hostname"]);
		assert.equal(scan.calls[0].line, 1);
		assert.ok(scan.calls[0].column > 1);
		assert.equal(scan.calls[0].unresolvedArgs, undefined);
	});

	it("多个调用：工具去重、路径与命令分开收", async () => {
		const scan = await scanScript(`
const a = await tools.read({ path: "a.ts" });
const b = await tools.read({ path: "b.ts" });
const c = await tools.bash({ command: "git status", timeout: 30 });
const d = await tools.write({ path: "out.ts", content: "x" });
return [a, b, c, d];
`);
		assert.deepEqual(scan.tools, ["read", "bash", "write"]);
		assert.deepEqual(scan.paths, ["a.ts", "b.ts", "out.ts"]);
		assert.deepEqual(scan.commands, ["git status"]);
		assert.deepEqual(scan.opaque, []);
	});

	it("下标写法与模板字面量（无插值）算字面量", async () => {
		const scan = await scanScript('return await tools["read"]({ path: `/tmp/x` })');
		assert.deepEqual(scan.tools, ["read"]);
		assert.deepEqual(scan.paths, ["/tmp/x"]);
	});

	it("参数里有变量：记下调用，同时标成推不出来", async () => {
		const scan = await scanScript('const p = "/etc/" + name; return await tools.read({ path: p })');
		assert.deepEqual(scan.tools, ["read"]);
		assert.deepEqual(scan.paths, []);
		assert.equal(scan.calls[0].unresolvedArgs, true);
		assert.match(scan.opaque[0], /read 的参数里有非字面量/);
	});

	it("动态工具名与 eval 都记进 opaque", async () => {
		const scan = await scanScript('const name = pick(); return await tools[name]({})');
		assert.deepEqual(scan.tools, []);
		assert.match(scan.opaque.join("\n"), /工具名是动态算出来的/);

		const scan2 = await scanScript('eval("1+1"); return 1');
		assert.match(scan2.opaque.join("\n"), /用了 eval/);

		const scan3 = await scanScript('return new Function("return 1")()');
		assert.match(scan3.opaque.join("\n"), /用了 new Function/);
	});

	it("不是 tools 的调用不动它", async () => {
		const scan = await scanScript('const x = Math.max(1, 2); return await fetch("/x")');
		assert.deepEqual(scan.tools, []);
		assert.deepEqual(scan.paths, []);
		assert.deepEqual(scan.opaque, []);
	});

	it("语法错误照实报出来，不抛错", async () => {
		const scan = await scanScript("return await tools.read({ path: ");
		assert.ok(scan.parseError, "应当给出解析错误");
		assert.match(scan.parseError ?? "", /^\d+:\d+ /);
	});

	it("没有参数调用也算调用，但标成看不清参数", async () => {
		const scan = await scanScript("return await tools.bash()");
		assert.deepEqual(scan.tools, ["bash"]);
		assert.equal(scan.calls[0].unresolvedArgs, true);
	});
});
