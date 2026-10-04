// lib/ptc-dryrun.test.ts — 干跑：假 ctx、超时、与真跑的对账
//
// 跑法：node --test --experimental-strip-types lib/ptc-dryrun.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareCalls, compareLine, dryRunContext, dryRunPlaceholder, runDryRun } from "./ptc-dryrun.ts";

describe("干跑的 ctx", () => {
	it("executeTool 只记账，返回引擎认得的形状", async () => {
		const sink: Array<{ tool: string; args: string }> = [];
		const ctx = dryRunContext({ tools: ["read"], cwd: "/work" }, sink);
		const outcome = (await (ctx as any).executeTool("read", { path: "/etc/hostname" })) as any;
		assert.deepEqual(sink, [{ tool: "read", args: '{"path":"/etc/hostname"}' }]);
		assert.equal(outcome.isError, false);
		assert.equal(outcome.content, undefined, "结果挂在 result 上，不在 outcome 上");
		assert.match(outcome.toolCall.id, /^dry\//);
		assert.equal(outcome.result.content[0].text, dryRunPlaceholder("read"));
	});

	it("其余字段原样透传（脚本看到的工具面必须一致）", () => {
		const tools = ["read", "bash"];
		const ctx = dryRunContext({ tools, cwd: "/work", sessionManager: { getBranch: () => [] } }, []);
		assert.equal((ctx as any).tools, tools);
		assert.equal((ctx as any).cwd, "/work");
	});

	it("只读不可配置的 executeTool 也能被换掉（Proxy 写法会违反不变量）", async () => {
		const sink: Array<{ tool: string }> = [];
		const real: Record<string, unknown> = {};
		Object.defineProperty(real, "executeTool", {
			value: async () => ({ toolCall: { id: "real" }, isError: false, result: { content: [] } }),
			writable: false,
			configurable: false,
			enumerable: true,
		});
		const dry = dryRunContext(real, sink as never) as any;
		const outcome = await dry.executeTool("read", {});
		assert.equal(outcome.toolCall.id, "dry/1", "拿到的是干跑的记账结果，不是真出口");
		assert.equal(sink.length, 1);
	});

	it("原型上的 getter 不会被丢掉（展开就会丢，真机上撞过）", () => {
		class RealCtx {
			get tools(): string[] {
				return ["read"];
			}
			sessionManager = { getBranch: () => [] };
		}
		const dry = dryRunContext(new RealCtx(), []);
		assert.deepEqual((dry as any).tools, ["read"]);
		assert.equal(typeof (dry as any).sessionManager.getBranch, "function");
	});

	it("模型出口被挡住：一调就抛，不花 token", () => {
		const ctx = dryRunContext({}, []) as any;
		assert.throws(() => ctx.modelRegistry.classify({}), /干跑不调用模型/);
		assert.equal(ctx.modelRegistry.then, undefined, "then 不能被当成函数返回，否则会被 await 挂住");
	});
});

describe("跑一遍干跑", () => {
	it("正常跑完：记账两次，状态 ok", async () => {
		const calls: Array<{ tool: string }> = [];
		const result = await runDryRun({
			toolCallId: "call-1",
			code: "ignored",
			ctx: {},
			execute: async (_id, _params, _signal, _onUpdate, ctx: any) => {
				await ctx.executeTool("read", { path: "/a" });
				await ctx.executeTool("bash", { command: "ls" });
				return { content: [] };
			},
		});
		assert.equal(result.status, "ok");
		assert.deepEqual(result.calls.map((call) => call.tool), ["read", "bash"]);
		assert.ok(result.ms >= 0);
		void calls;
	});

	it("挂住不回：按超时收，带上已经记到的调用", async () => {
		const result = await runDryRun({
			toolCallId: "call-2",
			code: "ignored",
			ctx: {},
			timeoutMs: 60,
			execute: async (_id, _params, _signal, _onUpdate, ctx: any) => {
				await ctx.executeTool("read", { path: "/a" });
				await new Promise((resolve) => setTimeout(resolve, 5000));
				return { content: [] };
			},
		});
		assert.equal(result.status, "timeout");
		assert.deepEqual(result.calls.map((call) => call.tool), ["read"], "超时前记到的调用要留下");
	});

	it("干跑自己出问题：状态 error 且带原因", async () => {
		const result = await runDryRun({
			toolCallId: "call-3",
			code: "ignored",
			ctx: {},
			execute: async () => {
				throw new Error("引擎没加载起来");
			},
		});
		assert.equal(result.status, "error");
		assert.match(result.error ?? "", /引擎没加载起来/);
	});
});

describe("干跑与真跑的对账", () => {
	it("一样就没什么可说", () => {
		const comparison = compareCalls([{ tool: "read", args: "" }], [{ tool: "read" }]);
		assert.deepEqual(comparison, { unfulfilled: [], unpredicted: [] });
		assert.equal(compareLine(comparison), "");
	});

	it("真跑多出来的（只有真数据才走到的路）", () => {
		const comparison = compareCalls(
			[{ tool: "read", args: "" }],
			[{ tool: "read" }, { tool: "bash" }, { tool: "bash" }],
		);
		assert.deepEqual(comparison.unpredicted, ["bash×2"]);
		assert.deepEqual(comparison.unfulfilled, []);
		assert.match(compareLine(comparison), /真跑多出：bash×2/);
	});

	it("干跑多算的（假数据把控制流带偏了）", () => {
		const comparison = compareCalls(
			[{ tool: "write", args: "" }, { tool: "write", args: "" }],
			[{ tool: "write" }],
		);
		assert.deepEqual(comparison.unfulfilled, ["write"]);
		assert.deepEqual(comparison.unpredicted, []);
		assert.match(compareLine(comparison), /干跑多算：write/);
	});
});
