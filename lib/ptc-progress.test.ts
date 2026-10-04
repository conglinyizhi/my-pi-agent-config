import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeProgressContext, progressLine } from "./ptc-progress.ts";

describe("progressLine", () => {
	it("取 content 里的 text 压成一行", () => {
		assert.equal(
			progressLine("subagent", { content: [{ type: "text", text: "w1 运行中·12s" }] }),
			"subagent: w1 运行中·12s",
		);
	});

	it("多块拼接、空白折叠", () => {
		assert.equal(
			progressLine("bash", { content: [{ type: "text", text: "第 1 行" }, { type: "text", text: "  第 2   行 " }] }),
			"bash: 第 1 行 第 2 行",
		);
	});

	it("非 text 块（图片等）忽略，只剩空则不出声", () => {
		assert.equal(progressLine("read", { content: [{ type: "image", data: "x" }] }), null);
	});

	it("形状不对也不出声", () => {
		assert.equal(progressLine("x", undefined), null);
		assert.equal(progressLine("x", { content: "不是数组" }), null);
		assert.equal(progressLine("x", { content: [{ type: "text", text: "   " }] }), null);
	});

	it("过长截断到 160 字符并带省略号", () => {
		const line = progressLine("bash", { content: [{ type: "text", text: "啊".repeat(200) }] });
		assert.ok(line);
		assert.equal(line.length, "bash: ".length + 160 + 1);
		assert.ok(line.endsWith("…"));
	});
});

describe("makeProgressContext", () => {
	function makeCtx() {
		const seen: Array<{ name: string; args: unknown; options: Record<string, unknown> }> = [];
		const ctx = {
			标记: "原型上的字段",
			executeTool: async (name: string, args: unknown, options: Record<string, unknown>) => {
				seen.push({ name, args, options });
				return { isError: false };
			},
		};
		return { ctx, seen };
	}

	it("给内层调用补上 onUpdate，且内层原有回调照旧收到", async () => {
		const { ctx, seen } = makeCtx();
		const lines: string[] = [];
		const inner: unknown[] = [];
		const wrapped = makeProgressContext(ctx, (l) => lines.push(l));
		await wrapped.executeTool("subagent", { task: "x" }, { signal: "sig", onUpdate: (p: unknown) => inner.push(p) });

		const opts = seen[0].options;
		assert.equal(opts.signal, "sig", "原参数不能丢");
		assert.equal(typeof opts.onUpdate, "function", "补上的 onUpdate");
		(opts.onUpdate as (p: unknown) => void)({ content: [{ type: "text", text: "w1 跑着" }] });
		assert.deepEqual(inner, [{ content: [{ type: "text", text: "w1 跑着" }] }], "内层回调不被吞");
		assert.deepEqual(lines, ["subagent: w1 跑着"]);
	});

	it("相邻同文只发一次", async () => {
		const { ctx, seen } = makeCtx();
		const lines: string[] = [];
		const wrapped = makeProgressContext(ctx, (l) => lines.push(l), () => 1000);
		await wrapped.executeTool("subagent", {}, {});
		const emit = seen[0].options.onUpdate as (p: unknown) => void;
		const same = { content: [{ type: "text", text: "同一行" }] };
		emit(same);
		emit(same);
		emit(same);
		assert.deepEqual(lines, ["subagent: 同一行"]);
	});

	it("按最小间隔节流（时间源可注入）", async () => {
		const { ctx, seen } = makeCtx();
		const lines: string[] = [];
		let clock = 0;
		const wrapped = makeProgressContext(ctx, (l) => lines.push(l), () => clock);
		await wrapped.executeTool("subagent", {}, {});
		const emit = seen[0].options.onUpdate as (p: unknown) => void;
		emit({ content: [{ type: "text", text: "第 1 次" }] });
		clock = 100;
		emit({ content: [{ type: "text", text: "第 2 次" }] });
		clock = 300;
		emit({ content: [{ type: "text", text: "第 3 次" }] });
		assert.deepEqual(lines, ["subagent: 第 1 次", "subagent: 第 3 次"]);
	});

	it("ctx 其余字段沿原型链照旧可取", () => {
		const { ctx } = makeCtx();
		const wrapped = makeProgressContext(ctx, () => {});
		assert.equal((wrapped as unknown as { 标记: string }).标记, "原型上的字段");
	});

	it("底层没有 executeTool 时原样返回，不硬造出口", () => {
		const bare = { 别的字段: 1 } as Record<string, unknown>;
		const wrapped = makeProgressContext(bare, () => {});
		assert.equal(wrapped, bare, "同一个对象、原样");
		assert.equal("executeTool" in wrapped, false, "不许凭空长出一个出口");
	});

	it("抠不出文字就不出声", async () => {
		const { ctx, seen } = makeCtx();
		const lines: string[] = [];
		const wrapped = makeProgressContext(ctx, (l) => lines.push(l));
		await wrapped.executeTool("read", {}, {});
		(seen[0].options.onUpdate as (p: unknown) => void)({ content: [{ type: "image", data: "x" }] });
		assert.deepEqual(lines, []);
	});
});
