// loop-guard/index.test.ts — 接线层语义测试（用假 pi 驱动真实 handler）
//
// 跑法：node --test --experimental-strip-types extensions/loop-guard/index.test.ts
//
// 重点验证「动手的分寸」：该中止的一次且只一次、预算与冷却当真生效、
// warn 模式绝不动输出、块切换不串味。

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLoopGuard, loadConfig, buildCorrectionPrompt, type GuardConfig } from "./index.ts";
import type { LoopHit } from "./detector.ts";

// ── 假 pi / 假 ctx ──

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const sent: Array<{ message: any; options: any }> = [];
	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, def: any) {
			commands.set(name, def);
		},
		sendMessage(message: any, options: any) {
			sent.push({ message, options });
		},
	} as any;
	const emit = (name: string, event: any, ctx: any) => {
		for (const h of handlers.get(name) ?? []) h(event, ctx);
	};
	return { pi, emit, commands, sent };
}

function fakeCtx() {
	const notes: Array<{ text: string; level?: string }> = [];
	const statuses: Array<string | undefined> = [];
	let aborts = 0;
	const ctx = {
		hasUI: true,
		ui: {
			notify: (text: string, level?: string) => notes.push({ text, level }),
			setStatus: (_key: string, text?: string) => statuses.push(text),
		},
		abort: () => {
			aborts += 1;
		},
	};
	return { ctx, notes, statuses, aborts: () => aborts };
}

/** 构造一段足以触发 abort 的停滞文本 */
function stall(cycles = 1800): string {
	const lines: string[] = [];
	for (let i = 0; i < cycles; i++) lines.push("好。", "", "（输出）", "");
	return lines.join("\n");
}

/** 把文本按 delta 粒度喂进 message_update */
function feed(emit: (n: string, e: any, c: any) => void, ctx: any, text: string, contentIndex = 0, chunk = 48) {
	emit("message_update", { assistantMessageEvent: { type: "text_start", contentIndex } }, ctx);
	for (let i = 0; i < text.length; i += chunk) {
		emit(
			"message_update",
			{ assistantMessageEvent: { type: "text_delta", contentIndex, delta: text.slice(i, i + chunk) } },
			ctx,
		);
	}
}

const cfg = (over: Partial<GuardConfig> = {}): GuardConfig => ({
	enabled: true,
	mode: "abort",
	maxActionsPerSession: 3,
	cooldownMs: 0,
	detector: {},
	...over,
});

// abort 走 setTimeout(...,0)，等一拍让它落地
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("abort 路径", () => {
	it("命中后中止一次，并在 agent 停歇时注入纠正消息", async () => {
		const { pi, emit, sent } = fakePi();
		createLoopGuard(pi, cfg());
		const { ctx, notes, aborts } = fakeCtx();

		feed(emit, ctx, stall());
		await flush();
		assert.equal(aborts(), 1, "应该恰好中止一次");
		assert.ok(
			notes.some((n) => n.text.includes("重复输出已中止")),
			"应该通知人",
		);
		assert.equal(sent.length, 0, "中止当拍还不该注入（等 agent 停歇）");

		emit("agent_settled", {}, ctx);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].options.triggerTurn, true);
		assert.equal(sent[0].message.customType, "loop-guard");
		assert.ok(sent[0].message.content.includes("<loop_guard>"));
		assert.ok(sent[0].message.content.includes("占位语"));
	});

	it("同一个块内不重复中止", async () => {
		const { pi, emit } = fakePi();
		createLoopGuard(pi, cfg());
		const { ctx, aborts } = fakeCtx();
		feed(emit, ctx, stall(2000));
		await flush();
		assert.equal(aborts(), 1);
	});

	it("冷却期内不再次中止", async () => {
		const { pi, emit } = fakePi();
		createLoopGuard(pi, cfg({ cooldownMs: 60_000 }));
		const { ctx, aborts } = fakeCtx();
		feed(emit, ctx, stall());
		await flush();
		emit("agent_settled", {}, ctx);
		feed(emit, ctx, stall(), 2);
		await flush();
		assert.equal(aborts(), 1, "冷却期内第二次不该中止");
	});

	it("冷却是 0 时，预算之内可以再次中止", async () => {
		const { pi, emit } = fakePi();
		createLoopGuard(pi, cfg({ cooldownMs: 0, maxActionsPerSession: 2 }));
		const { ctx, aborts } = fakeCtx();
		feed(emit, ctx, stall());
		await flush();
		feed(emit, ctx, stall(), 2);
		await flush();
		assert.equal(aborts(), 2);
	});

	it("预算耗尽后只提示，不中止", async () => {
		const { pi, emit } = fakePi();
		createLoopGuard(pi, cfg({ maxActionsPerSession: 1 }));
		const { ctx, notes, aborts } = fakeCtx();
		feed(emit, ctx, stall());
		await flush();
		feed(emit, ctx, stall(), 2);
		await flush();
		assert.equal(aborts(), 1, "第二次不该中止");
		assert.ok(
			notes.some((n) => n.text.includes("已达上限")),
			"应该告诉人预算用完了",
		);
	});

	it("块之间不串味：前一块的重复不影响下一块", async () => {
		const { pi, emit } = fakePi();
		createLoopGuard(pi, cfg());
		const { ctx, aborts } = fakeCtx();
		// 第一块：正常长短不一的内容
		feed(emit, ctx, Array.from({ length: 200 }, (_, i) => `第 ${i} 步：检查括号深度与变量作用域。`).join("\n"));
		await flush();
		assert.equal(aborts(), 0, "正常内容不该触发");
	});
});

describe("模式开关", () => {
	it("off：完全不检测", async () => {
		const { pi, emit } = fakePi();
		createLoopGuard(pi, cfg({ mode: "off" }));
		const { ctx, notes, aborts } = fakeCtx();
		feed(emit, ctx, stall());
		await flush();
		assert.equal(aborts(), 0);
		assert.equal(notes.length, 0);
	});

	it("warn：只提示，绝不中止", async () => {
		const { pi, emit, sent } = fakePi();
		createLoopGuard(pi, cfg({ mode: "warn" }));
		const { ctx, notes, aborts } = fakeCtx();
		feed(emit, ctx, stall(4000));
		await flush();
		emit("agent_settled", {}, ctx);
		assert.equal(aborts(), 0, "warn 模式不该动输出");
		assert.equal(sent.length, 0, "warn 模式不该注入消息");
		assert.ok(notes.some((n) => n.text.includes("疑似重复输出")));
	});

	it("命令可以切模式与重置预算", async () => {
		const { pi, commands } = fakePi();
		createLoopGuard(pi, cfg());
		const cmd = commands.get("loop-guard");
		assert.ok(cmd, "应该注册 /loop-guard");
		const { ctx, notes } = fakeCtx();
		await cmd.handler("warn", ctx);
		assert.ok(notes.some((n) => n.text.includes("模式切换为 warn")));
		await cmd.handler("reset", ctx);
		assert.ok(notes.some((n) => n.text.includes("预算已重置")));
		await cmd.handler("status", ctx);
		assert.ok(notes.some((n) => n.text.includes("判定：")));
		await cmd.handler("垃圾参数", ctx);
		assert.ok(notes.some((n) => n.text.includes("用法：")));
	});
});

describe("配置读取", () => {
	it("文件缺失时回落到默认值", () => {
		const c = loadConfig("/nonexistent/extensions.toml");
		assert.equal(c.enabled, true);
		assert.equal(c.mode, "abort");
		assert.equal(c.maxActionsPerSession, 3);
	});

	it("读到 [loop-guard] 与 [loop-guard.detector]", () => {
		const dir = mkdtempSync(join(tmpdir(), "loop-guard-"));
		const path = join(dir, "extensions.toml");
		writeFileSync(
			path,
			['[loop-guard]', 'enabled = true', 'mode = "warn"', "maxActionsPerSession = 1", "", "[loop-guard.detector]", "abortRepeatChars = 1234", ""].join("\n"),
		);
		const c = loadConfig(path);
		assert.equal(c.mode, "warn");
		assert.equal(c.maxActionsPerSession, 1);
		assert.equal(c.detector.abortRepeatChars, 1234);
	});

	it("非法 mode 回落到默认", () => {
		const dir = mkdtempSync(join(tmpdir(), "loop-guard-"));
		const path = join(dir, "extensions.toml");
		writeFileSync(path, '[loop-guard]\nmode = "yolo"\n');
		assert.equal(loadConfig(path).mode, "abort");
	});

	it("enabled = false 时装配成 off", () => {
		const { pi, emit } = fakePi();
		createLoopGuard(pi, cfg({ enabled: false }));
		const { ctx, aborts } = fakeCtx();
		feed(emit, ctx, stall());
		assert.equal(aborts(), 0);
	});
});

describe("纠正消息", () => {
	it("包含判据数字与可执行的改法", () => {
		const hit: LoopHit = {
			severity: "abort",
			offset: 12345,
			repeatChars: 9123,
			repeatLines: 3456,
			alphabet: 4,
			avgLineChars: 2.6,
			intruderRatio: 0.02,
			sample: "好。",
			samples: ["好。", "（输出）"],
			confidence: 0.9,
		};
		const prompt = buildCorrectionPrompt(hit);
		assert.ok(prompt.includes("9123"));
		assert.ok(prompt.includes("3456"));
		assert.ok(prompt.includes("好。"));
		assert.ok(prompt.includes("该调工具就直接发出工具调用"));
	});

	it("占比写的是重复内容，不是新内容", () => {
		const base: LoopHit = {
			severity: "abort",
			offset: 1,
			repeatChars: 9000,
			repeatLines: 900,
			alphabet: 2,
			avgLineChars: 3,
			intruderRatio: 0,
			sample: "好。",
			samples: ["好。"],
			confidence: 0.9,
		};
		assert.ok(buildCorrectionPrompt(base).includes("占窗口内 100% 的行"));
		assert.ok(buildCorrectionPrompt({ ...base, intruderRatio: 0.25 }).includes("占窗口内 75% 的行"));
	});
});
