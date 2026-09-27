// lib/process-singleton.test.ts — 回归：跨扩展共享状态必须真的共享
//
// 跑法：node --test --experimental-strip-types lib/process-singleton.test.ts
//
// 背景：pi 给每个扩展单独建 jiti 实例（moduleCache: false），lib 模块在每个扩展里
// 各求值一份。模块级变量因此**不共享**：photo 注册的 `img` provider，fragments 永远
// 看不见，`&img(1)` 一律不展开。这里用一个模块实例就够复现：同一路径带不同 query
// 加载两次，Node 会当成两个模块分别求值（等价于两个扩展各自的 jiti）。
//
// 这个测试要挡住的就是「把 processSingleton 改回模块级变量」这类回归。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** 把同一个文件当成两个互不相干的模块加载（模拟 pi 的两个 jiti 实例） */
async function loadTwice(file: string): Promise<[Record<string, any>, Record<string, any>]> {
	const a = (await import(new URL(`${file}?instance=a`, import.meta.url).href)) as Record<string, any>;
	const b = (await import(new URL(`${file}?instance=b`, import.meta.url).href)) as Record<string, any>;
	return [a, b];
}

describe("processSingleton", () => {
	it("同一 key 在两个模块实例里拿到同一份状态", async () => {
		const [a, b] = await loadTwice("./process-singleton.ts");
		assert.notEqual(a, b, "两次加载应当是不同模块实例");
		const first = a.processSingleton("test:shared", () => ({ hits: 0 }));
		const second = b.processSingleton("test:shared", () => ({ hits: 0 }));
		assert.equal(first, second, "同一 key 必须拿到同一份");
		first.hits += 1;
		assert.equal(second.hits, 1, "改动能被另一端看见");
		a.resetProcessSingleton("test:shared");
	});

	it("不同 key 互不干扰", async () => {
		const mod = (await import(new URL("./process-singleton.ts", import.meta.url).href)) as Record<string, any>;
		const one = mod.processSingleton("test:one", () => ({ v: 1 }));
		const two = mod.processSingleton("test:two", () => ({ v: 2 }));
		assert.notEqual(one, two);
		assert.equal(one.v, 1);
		assert.equal(two.v, 2);
		mod.resetProcessSingleton("test:one");
		mod.resetProcessSingleton("test:two");
	});
});

describe("fragment-providers 跨扩展共享", () => {
	it("一个实例注册的 provider，另一个实例能查到", async () => {
		const [a, b] = await loadTwice("./fragment-providers.ts");
		a.clearFragmentProviders();
		a.registerFragmentProvider({ name: "probe", expand: () => ({ text: "ok" }) });
		const seen = b.lookupFragmentProvider("probe");
		assert.ok(seen, "跨实例必须查得到（这正是 &img 之前失败的地方）");
		const result = await seen!.expand("");
		assert.deepEqual(result, { text: "ok" });
		a.clearFragmentProviders();
		assert.equal(b.lookupFragmentProvider("probe"), undefined, "clear 清的是共享的那份内容");
	});

	it("clear 不换引用，只清内容", async () => {
		const [a, b] = await loadTwice("./fragment-providers.ts");
		b.registerFragmentProvider({ name: "keep", expand: () => ({ text: "x" }) });
		a.clearFragmentProviders();
		assert.equal(a.lookupFragmentProvider("keep"), undefined);
		assert.equal(b.lookupFragmentProvider("keep"), undefined, "两边看的是同一份 Map");
		b.registerFragmentProvider({ name: "after", expand: () => ({ text: "y" }) });
		assert.ok(a.lookupFragmentProvider("after"), "清空后仍要继续共享");
		a.clearFragmentProviders();
	});
});
