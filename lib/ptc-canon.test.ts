// ptc-canon.test.ts — PTC 规范化重写的用例
//
// 跑法：node --test --experimental-strip-types lib/ptc-canon.test.ts
//
// 盯的不变量：
//   1 只做等价变换：工具序列与字面量参数不许变，opaque 只许变少
//   2 名字位置（属性名 / 成员名 / 解构 / 参数）永不被替换
//   3 遮蔽、重赋值、有副作用的初始化、TDZ 顺序——一律不动

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalizeScript, compareScans } from "./ptc-canon.ts";
import type { ScriptScan } from "./ptc-analyze.ts";

const canon = (src: string) => canonicalizeScript(src);

describe("常量内联", () => {
	it("同块 const 字面量内联进使用处，声明随之消失", async () => {
		const r = await canon(`const p = "/tmp/a.txt";
const got = await tools.read({ path: p });
text(got);`);
		assert.equal(r.verified, true);
		assert.deepEqual(r.inlined, ["p"]);
		assert.ok(r.code.includes('{ path: "/tmp/a.txt" }'), r.code);
		assert.ok(!r.code.includes("const p ="), r.code);
	});

	it("简写属性 { path } 摊成 { path: \"/x\" }", async () => {
		const r = await canon(`const path = "/tmp/a.txt";
const got = await tools.read({ path });
text(got);`);
		assert.equal(r.verified, true);
		assert.ok(r.code.includes('{ path: "/tmp/a.txt" }'), r.code);
	});

	it("属性名不是取值：不会被变量名替换掉", async () => {
		const r = await canon(`const path = "/tmp/a.txt";
await tools.read({ path: "/tmp/b.txt" });
text(path);`);
		assert.equal(r.verified, true);
		assert.ok(r.code.includes('path: "/tmp/b.txt"'), r.code);
	});

	it("多声明语句：只有被内联的那个声明符消失，另一个留着", async () => {
		const r = await canon(`const p = "/tmp/a.txt", size = getSize();
await tools.read({ path: p, limit: size });`);
		assert.equal(r.verified, true);
		assert.ok(r.code.includes('{ path: "/tmp/a.txt", limit: size }'), r.code);
		assert.ok(r.code.includes("size = getSize()"), r.code);
	});
});

describe("折叠", () => {
	it("字面量拼接折成一个字面量", async () => {
		const r = await canon(`const d = "/tmp";
await tools.read({ path: d + "/a.txt" });`);
		assert.equal(r.verified, true);
		assert.ok(r.code.includes('{ path: "/tmp/a.txt" }'), r.code);
	});

	it("无插值模板与「插值全是字面量」的模板都折成字符串", async () => {
		const r = await canon("const a = \`/tmp/x\`;\nconst b = \`/tmp/\${'y'}.txt\`;\nawait tools.read({ path: a });\nawait tools.read({ path: b });");
		assert.equal(r.verified, true);
		assert.ok(r.code.includes('{ path: "/tmp/x" }'), r.code);
		assert.ok(r.code.includes('{ path: "/tmp/y.txt" }'), r.code);
	});
});

describe("不该动的地方", () => {
	it("内层遮蔽：内层同名变量不受外层影响", async () => {
		const r = await canon(`const p = "/outer";
const f = () => {
	const p = "/inner";
	return tools.read({ path: p });
};
await tools.read({ path: p });`);
		assert.equal(r.verified, true);
		// 两层各自内联成自己的值：内层 "/inner"、外层 "/outer"，谁也不串到对方
		assert.ok(r.code.includes('{ path: "/inner" }'), r.code);
		assert.ok(r.code.includes('{ path: "/outer" }'), r.code);
	});

	it("let 声明不内联（可能被重赋值）", async () => {
		const r = await canon(`let p = "/tmp/a";
p = "/tmp/b";
await tools.read({ path: p });`);
		assert.equal(r.changed, false);
	});

	it("初始化有副作用（函数调用 / await）不内联", async () => {
		const r = await canon(`const p = compute();
await tools.read({ path: p });`);
		assert.equal(r.changed, false);
	});

	it("用在声明之前（TDZ 顺序）不内联", async () => {
		const r = await canon(`await tools.read({ path: p });
const p = "/tmp/a";`);
		assert.equal(r.changed, false);
	});

	it("没有可内联的东西时原样返回", async () => {
		const r = await canon(`const p = process.env.HOME;
await tools.read({ path: p });`);
		assert.equal(r.changed, false);
		assert.equal(r.code.includes("process.env.HOME"), true);
	});

	it("语法错误：不重写，如实说明", async () => {
		const r = await canon("const p = ;");
		assert.equal(r.changed, false);
		assert.ok((r.skipped ?? "").includes("语法错误"), r.skipped);
	});
});

describe("compareScans 的方向性", () => {
	const call = (tool: string, args: Record<string, string>, unresolved = false) => ({
		tool,
		args,
		...(unresolved ? { unresolvedArgs: true } : {}),
		line: 1,
		column: 1,
		startOffset: 0,
		endOffset: 1,
		endLine: 1,
		endColumn: 1,
	});
	const scan = (calls: ReturnType<typeof call>[], opaque: string[] = []): ScriptScan => ({
		calls,
		tools: [...new Set(calls.map((c) => c.tool))],
		paths: [],
		commands: [],
		opaque,
	});

	it("完全一致 → 通过", () => {
		const s = scan([call("read", { path: "/x" })]);
		assert.equal(compareScans(s, s), undefined);
	});

	it("重写后多看清一个参数 → 通过（这是重写的意义）", () => {
		const before = scan([call("read", {}, true)]);
		const after = scan([call("read", { path: "/x" })]);
		assert.equal(compareScans(before, after), undefined);
	});

	it("参数丢了 / 值变了 / 反而看不清了 / opaque 变多 → 都要拦下", () => {
		const before = scan([call("read", { path: "/x" })]);
		assert.ok(compareScans(before, scan([call("read", {})])));
		assert.ok(compareScans(before, scan([call("read", { path: "/y" })])));
		assert.ok(compareScans(scan([call("read", { path: "/x" })]), scan([call("read", { path: "/x" }, true)])));
		assert.ok(compareScans(scan([call("read", { path: "/x" })]), scan([call("read", { path: "/x" })], ["看不清"])));
	});

	it("工具序列变了 → 拦下", () => {
		assert.ok(compareScans(scan([call("read", {})]), scan([call("write", {})])));
		assert.ok(compareScans(scan([call("read", {})]), scan([call("read", {}), call("read", {})])));
	});
});
