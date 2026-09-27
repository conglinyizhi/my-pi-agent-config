// thinking-fold/index.test.ts — 接线层语义测试（用假 pi 驱动真实 handler）
//
// 跑法：node --test --experimental-strip-types extensions/thinking-fold/index.test.ts
//
// 重点：只改渲染文本、关闭时零副作用、异常兜底、命令与快捷键真的切得动。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Key } from "@earendil-works/pi-tui";
import {
	applyFold,
	buildFoldNotice,
	createThinkingFold,
	type FoldConfig,
	loadConfig,
} from "./index.ts";

type Transformer = (markdown: string, context: any) => string;

// ── 假 pi / 假 ctx ──

function fakePi() {
	const transformers: Transformer[] = [];
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const pi = {
		registerMarkdownTransformer(t: Transformer) {
			transformers.push(t);
		},
		registerCommand(name: string, def: any) {
			commands.set(name, def);
		},
		registerShortcut(shortcut: string, def: any) {
			shortcuts.set(shortcut, def);
		},
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	} as any;
	const emit = (name: string, ctx: any) => {
		for (const h of handlers.get(name) ?? []) h({}, ctx);
	};
	return { pi, transformers, commands, shortcuts, emit };
}

function fakeCtx() {
	const notes: Array<{ text: string; level?: string }> = [];
	const statuses: Array<{ key: string; text?: string }> = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify: (text: string, level?: string) => notes.push({ text, level }),
			setStatus: (key: string, text?: string) => statuses.push({ key, text }),
		},
	};
	return { ctx, notes, statuses };
}

/** 构造「一段正常内容 + 尾部复读」的 thinking 块 */
function thinkingBlock(head = 300, cycles = 100): string {
	const lines: string[] = [];
	for (let i = 0; i < head; i++) {
		lines.push(`- 第 ${i} 项：核对模块 ${i} 的导出与依赖，确认没有循环引用。`);
	}
	for (let c = 0; c < cycles; c++) {
		lines.push("好。", "执行。");
	}
	return lines.join("\n");
}

/** 构造「头部 + 中间复读段 + 尾部正常内容」的 thinking 块 */
function midRepeatBlock(head = 200, cycles = 150, tail = 100): string {
	const lines: string[] = [];
	for (let i = 0; i < head; i++) lines.push(`- 第 ${i} 项：核对模块 ${i} 的导出与依赖。`);
	for (let c = 0; c < cycles; c++) lines.push("好。", "跑。");
	for (let i = 0; i < tail; i++) lines.push(`尾段第 ${i} 行：复读完了继续写正事，这段不能折。`);
	return lines.join("\n");
}

const transformOf = (transformers: Transformer[]): Transformer => {
	assert.equal(transformers.length, 1, "应该恰好注册一个 markdown transformer");
	return transformers[0];
};

const ctxFor = (messageType: string, isStreaming = false) => ({
	messageType,
	isStreaming,
	availableWidth: 80,
});

const flush = () => new Promise((r) => setTimeout(r, 10));

const cfg = (over: Partial<FoldConfig> = {}): FoldConfig => ({
	enabled: true,
	detector: {},
	...over,
});

describe("命中折叠", () => {
	it("thinking 块尾部的复读被折成一行提示，复读行不再出现在输出里", () => {
		const { pi, transformers } = fakePi();
		createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const source = thinkingBlock();

		const out = transform(source, ctxFor("assistant-thinking"));
		assert.notEqual(out, source, "命中后应该改写");
		assert.ok(out.includes("⋯ [已折叠 "), `输出应含折叠提示：${out.slice(-120)}`);
		assert.ok(out.includes("好。 ×100"), "提示里应列样例与次数");
		assert.ok(out.includes("执行。 ×100"));
		// 头部 300 行正常内容全保留，尾部 200 行复读（含夹在里面的行）合成 1 行提示；
		// 起点会对齐到复读段的第一行，所以开头那几行普通内容不会被吃掉
		const lines = out.split("\n");
		assert.equal(lines.length, 301, "保留头部 300 行 + 1 行提示");
		assert.equal(lines[lines.length - 1].startsWith("⋯ [已折叠 "), true);
		assert.equal(
			lines.filter((l) => l === "好。" || l === "执行。").length,
			0,
			"裸的复读行不该留下",
		);
	});

	it("块整段都是复读时只剩一行提示", () => {
		const { pi, transformers } = fakePi();
		createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const source = Array.from({ length: 200 }, (_, i) => (i % 2 ? "执行。" : "好。")).join("\n");
		const out = transform(source, ctxFor("assistant-thinking"));
		assert.equal(out.split("\n").length, 1);
		assert.ok(out.startsWith("⋯ [已折叠 200 行重复输出："));
	});

	it("中间复读段也被折，段后的正常内容原样留下", () => {
		const { pi, transformers } = fakePi();
		createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const source = midRepeatBlock();
		const out = transform(source, ctxFor("assistant-thinking"));

		assert.notEqual(out, source);
		const lines = out.split("\n");
		// 200 行头 + 1 行提示 + 100 行尾（复读段那 300 行被折掉）
		assert.equal(lines.length, 301);
		assert.equal(lines[200].startsWith("⋯ [已折叠 300 行重复输出："), true);
		assert.equal(lines[201], "尾段第 0 行：复读完了继续写正事，这段不能折。");
		assert.equal(lines[lines.length - 1], "尾段第 99 行：复读完了继续写正事，这段不能折。");
		assert.equal(lines.filter((l) => l === "好。" || l === "跑。").length, 0);
	});

	it("多段：一段一行提示，段与段之间的内容不动", () => {
		const { pi, transformers } = fakePi();
		const state = createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const middle = Array.from({ length: 90 }, (_, i) => `中间第 ${i} 行：这段是真推理，只出现一次。`);
		const source = [
			...Array.from({ length: 300 }, (_, i) => (i % 2 ? "跑。" : "好。")),
			...middle,
			...Array.from({ length: 300 }, (_, i) => (i % 2 ? "停。" : "发。")),
		].join("\n");
		const out = transform(source, ctxFor("assistant-thinking"));

		const lines = out.split("\n");
		assert.equal(lines.length, 2 + middle.length, "两行提示 + 中间的 90 行");
		assert.equal(lines[0].startsWith("⋯ [已折叠 300 行重复输出："), true);
		assert.deepEqual(lines.slice(1, 1 + middle.length), middle, "段之间的内容逐行原样保留");
		assert.equal(lines[lines.length - 1].startsWith("⋯ [已折叠 300 行重复输出："), true);
		const last = state.last;
		assert.ok(last, "应该记下了最近一次折叠");
		assert.equal(last.segments, 2);
		assert.equal(last.lines, 600);
	});

	it("流式中也折（否则屏幕照样被刷满）", () => {
		const { pi, transformers } = fakePi();
		createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const out = transform(thinkingBlock(), ctxFor("assistant-thinking", true));
		assert.ok(out.includes("⋯ [已折叠 "));
	});

	it("同一段 markdown 重复渲染只算一次（memo）", () => {
		const { pi, transformers } = fakePi();
		const state = createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const source = thinkingBlock();
		const first = transform(source, ctxFor("assistant-thinking"));
		const second = transform(source, ctxFor("assistant-thinking"));
		assert.equal(first, second);
		assert.equal(state.folds, 1, "重复渲染不该重复计数");
	});

	it("命中后不碰状态栏（地皮留给别的扩展）", async () => {
		const { pi, transformers, emit } = fakePi();
		createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const { ctx, statuses } = fakeCtx();
		emit("session_start", ctx);

		transform(thinkingBlock(), ctxFor("assistant-thinking"));
		await flush();
		assert.deepEqual(statuses, [], `折叠不该写状态栏，实得 ${JSON.stringify(statuses)}`);
	});
});

describe("不该动的东西", () => {
	it("非 assistant-thinking 类型原样返回", () => {
		const { pi, transformers } = fakePi();
		const state = createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const source = thinkingBlock();
		assert.equal(transform(source, ctxFor("assistant")), source);
		assert.equal(transform(source, ctxFor("user")), source);
		assert.equal(state.folds, 0, "非 thinking 块不该计数");
	});

	it("正常 thinking 块原样返回", () => {
		const { pi, transformers } = fakePi();
		createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const source = Array.from(
			{ length: 150 },
			(_, i) => `第 ${i} 步：检查 ${i} 号文件的类型标注与调用点。`,
		).join("\n");
		assert.equal(transform(source, ctxFor("assistant-thinking")), source);
	});

	it("关闭状态下原样返回，且没有副作用", async () => {
		const { pi, transformers, emit } = fakePi();
		const state = createThinkingFold(pi, cfg({ enabled: false }));
		const transform = transformOf(transformers);
		const { ctx, notes, statuses } = fakeCtx();
		emit("session_start", ctx);

		const source = thinkingBlock();
		assert.equal(transform(source, ctxFor("assistant-thinking")), source);
		assert.equal(state.folds, 0);
		await flush();
		assert.equal(notes.length, 0, "关闭状态不该通知");
		assert.ok(
			statuses.every((s) => s.text === undefined),
			"关闭状态不该写状态栏统计",
		);
	});

	it("异常输入不炸：非字符串原样回吐", () => {
		const { pi, transformers } = fakePi();
		createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const weird = null as unknown as string;
		assert.equal(transform(weird, ctxFor("assistant-thinking")), null);
		assert.equal(transform(123 as unknown as string, ctxFor("assistant-thinking")), 123);
		assert.equal(transform(thinkingBlock(), undefined as any), thinkingBlock().toString());
	});
});

describe("命令与快捷键", () => {
	it("注册了 /thinking-fold 与 Ctrl+Shift+D", () => {
		const { pi, commands, shortcuts } = fakePi();
		createThinkingFold(pi, cfg());
		assert.ok(commands.has("thinking-fold"));
		assert.ok(shortcuts.has(Key.ctrlShift("d")), "快捷键应注册在 ctrl+shift+d");
	});

	it("命令可以开关，并报告状态", async () => {
		const { pi, transformers, commands } = fakePi();
		createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const cmd = commands.get("thinking-fold");
		const { ctx, notes } = fakeCtx();
		const source = thinkingBlock();

		await cmd.handler("off", ctx);
		assert.ok(notes.some((n) => n.text.includes("已关闭")));
		assert.equal(transform(source, ctxFor("assistant-thinking")), source);

		await cmd.handler("status", ctx);
		assert.ok(notes.some((n) => n.text.includes("状态：关闭")));
		assert.ok(notes.some((n) => n.text.includes("判定：复读行出现")));

		await cmd.handler("", ctx);
		assert.ok(notes.some((n) => n.text.includes("最近折叠")));

		await cmd.handler("on", ctx);
		assert.ok(notes.some((n) => n.text.includes("已开启")));
		assert.ok(transform(source, ctxFor("assistant-thinking")).includes("⋯ [已折叠 "));

		await cmd.handler("乱写", ctx);
		assert.ok(notes.some((n) => n.text.includes("用法：")));
	});

	it("快捷键切换开关（只发通知，不动状态栏）", () => {
		const { pi, transformers, shortcuts } = fakePi();
		createThinkingFold(pi, cfg());
		const transform = transformOf(transformers);
		const shortcut = shortcuts.get(Key.ctrlShift("d"));
		const { ctx, notes, statuses } = fakeCtx();
		const source = thinkingBlock();

		shortcut.handler(ctx);
		assert.ok(notes.some((n) => n.text.includes("已关闭")));
		assert.equal(transform(source, ctxFor("assistant-thinking")), source);
		assert.deepEqual(statuses, [], "开关不该动状态栏");

		shortcut.handler(ctx);
		assert.ok(notes.some((n) => n.text.includes("已开启")));
		assert.ok(transform(source, ctxFor("assistant-thinking")).includes("⋯ [已折叠 "));
		assert.deepEqual(statuses, [], "开启也不该动状态栏");
	});
});

describe("配置读取", () => {
	// 沙箱不一定让写 /tmp，临时目录建在扩展目录下，跑完删掉
	const dir = mkdtempSync(join(import.meta.dirname, ".tmp-"));
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("文件缺失时用默认值", () => {
		const c = loadConfig(join(dir, "nonexistent.toml"));
		assert.equal(c.enabled, true);
		assert.deepEqual(c.detector, {});
	});

	it("读 [thinking-fold] 与 [thinking-fold.detector]", () => {
		const path = join(dir, "extensions.toml");
		writeFileSync(
			path,
			[
				"[thinking-fold]",
				"enabled = false",
				"",
				"[thinking-fold.detector]",
				"minCount = 7",
				"minChars = 42",
				'maxKinds = "不合法"',
				"",
			].join("\n"),
		);
		const c = loadConfig(path);
		assert.equal(c.enabled, false);
		assert.equal(c.detector.minCount, 7);
		assert.equal(c.detector.minChars, 42);
		assert.equal(c.detector.maxKinds, undefined, "非法值应被忽略");
	});

	it("配置真的接进装配：关闭时 transformer 不折", () => {
		const path = join(dir, "off.toml");
		writeFileSync(path, "[thinking-fold]\nenabled = false\n");
		const { pi, transformers } = fakePi();
		createThinkingFold(pi, loadConfig(path));
		const transform = transformOf(transformers);
		const source = thinkingBlock();
		assert.equal(transform(source, ctxFor("assistant-thinking")), source);
	});
});

describe("纯函数", () => {
	it("applyFold 没命中时原样返回", () => {
		const text = "第一行\n第二行\n第三行";
		const r = applyFold(text);
		assert.equal(r.text, text);
		assert.deepEqual(r.segments, []);
	});

	it("buildFoldNotice 最多列 3 个样例", () => {
		const notice = buildFoldNotice({
			startLine: 0,
			endLine: 236,
			lines: 236,
			chars: 2000,
			kinds: 5,
			top: ["好。 ×81", "执行。 ×39", "Output. ×11", "（行动）×8"],
		});
		assert.equal(notice, "⋯ [已折叠 236 行重复输出：好。 ×81 / 执行。 ×39 / Output. ×11]");
	});

	it("前缀为空时只输出提示行", () => {
		const r = applyFold(Array.from({ length: 200 }, () => "好。").join("\n"));
		assert.equal(r.segments.length, 1);
		assert.equal(r.segments[0].startLine, 0);
		assert.equal(r.text.split("\n").length, 1);
	});

	it("段与段之间的内容逐行原样保留", () => {
		const middle = Array.from({ length: 80 }, (_, i) => `中间第 ${i} 行：这段是真推理，只能出现一次。`);
		const source = [
			...Array.from({ length: 300 }, (_, i) => (i % 2 ? "跑。" : "好。")),
			...middle,
			...Array.from({ length: 300 }, (_, i) => (i % 2 ? "停。" : "发。")),
		].join("\n");
		const r = applyFold(source);
		assert.equal(r.segments.length, 2);
		assert.equal(r.text.split("\n").filter((l) => l.startsWith("⋯ [已折叠 ")).length, 2);
		for (const line of middle) assert.ok(r.text.includes(line), `中间内容不该动：${line}`);
	});
});
