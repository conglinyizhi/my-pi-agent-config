// extensions/fragments/index.test.ts — 扩展接线：input 展开、两个命令、autocomplete
//
// 跑法：node --experimental-strip-types extensions/fragments/index.test.ts
//
// 用假的 pi / ctx 跑真 handler：这里要钉的是「接线接对了没」，
// 纯逻辑本身由 core.test.ts 覆盖。

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import fragmentsExtension, { resetFragmentCache, resetFragmentNotices } from "./index.ts";

const CONFIG = `
[[fragment]]
name = "单步计划"
desc = "仅调查不行动"
text = """
对于这一步，只做调查、不要动手
"""

[[fragment]]
name = "关于我"
aliases = ["core-prompt", "基础了解层", "我"]
desc = "背景资料"
text = "读 ~/disk/core-prompt/"
`;

type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = { description?: string; handler: (args: string, ctx: unknown) => unknown };

/** 假的 pi：把注册进来的 handler / command 收下来，测试直接调 */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	return {
		handlers,
		commands,
		api: {
			on(type: string, handler: Handler) {
				const list = handlers.get(type) ?? [];
				list.push(handler);
				handlers.set(type, list);
			},
			registerCommand(name: string, command: Command) {
				commands.set(name, command);
			},
		},
	};
}

/** 假的 UI ctx：把 notify / select / 输入框内容记下来 */
function fakeCtx(options: { editor?: string; pick?: string } = {}) {
	const notices: Array<{ message: string; level: string }> = [];
	let editor = options.editor ?? "";
	return {
		notices,
		get editor() {
			return editor;
		},
		ctx: {
			hasUI: true,
			ui: {
				notify(message: string, level = "info") {
					notices.push({ message, level });
				},
				async select() {
					return options.pick;
				},
				getEditorText() {
					return editor;
				},
				setEditorText(text: string) {
					editor = text;
				},
				addAutocompleteProvider(factory: (current: unknown) => unknown) {
					providers.push(factory);
				},
			},
		},
	};
}

const providers: Array<(current: unknown) => any> = [];
let agentDir = "";

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "frag-index-"));
	writeFileSync(join(agentDir, "fragments.toml"), CONFIG, "utf8");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetFragmentCache();
	resetFragmentNotices();
	providers.length = 0;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
});

/** 装载一次扩展，拿到它的 handler / command */
function load() {
	const pi = fakePi();
	fragmentsExtension(pi.api as never);
	return {
		input: pi.handlers.get("input")?.[0] as (event: unknown, ctx: unknown) => { action: string; text?: string },
		sessionStart: pi.handlers.get("session_start")?.[0] as (event: unknown, ctx: unknown) => void,
		build: pi.commands.get("frag:build") as Command,
		list: pi.commands.get("frag:list") as Command,
	};
}

describe("input：提交前展开", () => {
	it("interactive 的输入里 &名字 换成正文（多行保留）", async () => {
		const { input } = load();
		const result = await input({ type: "input", text: "&单步计划 帮我看看这个报错", source: "interactive" }, fakeCtx().ctx);
		assert.equal(result.action, "transform");
		assert.equal(result.text, "对于这一步，只做调查、不要动手\n 帮我看看这个报错");
	});

	it("没有 & 的输入原样放行", async () => {
		const { input } = load();
		const result = await input({ type: "input", text: "帮我看看这个报错", source: "interactive" }, fakeCtx().ctx);
		assert.deepEqual(result, { action: "continue" });
	});

	it("不是 interactive 来源就不动（rpc / 别的扩展发进来的文本不该被改写）", async () => {
		const { input } = load();
		const result = await input({ type: "input", text: "&单步计划", source: "rpc" }, fakeCtx().ctx);
		assert.deepEqual(result, { action: "continue" });
	});

	it("没定义的名字：原样发出去，只提醒一次", async () => {
		const { input } = load();
		const env = fakeCtx();
		const first = await input({ type: "input", text: "&没这个 和 &也没这个", source: "interactive" }, env.ctx);
		assert.deepEqual(first, { action: "continue" });
		assert.equal(env.notices.length, 2);
		assert.match(env.notices[0].message, /没有 &没这个 这个碎片/);
		await input({ type: "input", text: "&没这个 又来一次", source: "interactive" }, env.ctx);
		assert.equal(env.notices.length, 2, "同一条不该刷第二遍");
	});

	it("配置还没建：提示路径，且不吞输入", async () => {
		const empty = mkdtempSync(join(tmpdir(), "frag-none-"));
		process.env.PI_CODING_AGENT_DIR = empty;
		resetFragmentCache();
		resetFragmentNotices();
		const { input } = load();
		const env = fakeCtx();
		const result = await input({ type: "input", text: "&单步计划", source: "interactive" }, env.ctx);
		assert.deepEqual(result, { action: "continue" });
		assert.match(env.notices[0].message, /还没有 .*fragments\.toml/);
	});

	it("配置有问题时报出来（但仍然把能展开的展开）", async () => {
		writeFileSync(join(agentDir, "fragments.toml"), '[[fragment]]\nname = "坏"\n', "utf8");
		resetFragmentCache();
		const { input } = load();
		const env = fakeCtx();
		await input({ type: "input", text: "&坏 试试", source: "interactive" }, env.ctx);
		assert.ok(env.notices.some((n) => /缺少 text/.test(n.message)));
	});
});

describe("/frag:build 与 /frag:list", () => {
	it("build 把正文插进空输入框", async () => {
		const { build } = load();
		const env = fakeCtx();
		await build.handler("单步计划", env.ctx);
		assert.equal(env.editor, "对于这一步，只做调查、不要动手\n");
		assert.match(env.notices.at(-1)?.message ?? "", /已插入 &单步计划/);
	});

	it("输入框里已有内容时追加在后面，不覆盖", async () => {
		const { build } = load();
		const env = fakeCtx({ editor: "先看这个报错：" });
		await build.handler("关于我", env.ctx);
		assert.equal(env.editor, "先看这个报错：\n读 ~/disk/core-prompt/");
	});

	it("用别名调 build 也插同一条正文", async () => {
		const { build } = load();
		for (const alias of ["core-prompt", "基础了解层", "我"]) {
			const env = fakeCtx();
			await build.handler(alias, env.ctx);
			assert.equal(env.editor, "读 ~/disk/core-prompt/", `别名 ${alias} 应当插出同一条正文`);
			assert.match(env.notices.at(-1)?.message ?? "", /已插入 &关于我/);
		}
	});

	it("名字不对 / 没给名字：只提示，不动输入框", async () => {
		const { build } = load();
		const env = fakeCtx({ editor: "原样" });
		await build.handler("没这个", env.ctx);
		await build.handler("", env.ctx);
		assert.equal(env.editor, "原样");
		assert.match(env.notices[0].message, /没有 没这个 这个碎片/);
		assert.match(env.notices[1].message, /用法：\/frag:build/);
	});

	it("list 选中一条就插进输入框，别名一起列出来", async () => {
		const { list } = load();
		const env = fakeCtx({ pick: "关于我（别名：core-prompt、基础了解层、我） — 背景资料" });
		await list.handler("", env.ctx);
		assert.equal(env.editor, "读 ~/disk/core-prompt/");

		// 没选中那条也别插错：标签对不上就不动输入框
		const odd = fakeCtx({ pick: "关于我 — 背景资料" });
		await list.handler("", odd.ctx);
		assert.equal(odd.editor, "");
	});

	it("list 取消选择时什么都不做", async () => {
		const { list } = load();
		const env = fakeCtx({ pick: undefined });
		await list.handler("", env.ctx);
		assert.equal(env.editor, "");
	});
});

describe("autocomplete", () => {
	it("输入 & 时给候选，并沿用原来的补全器", async () => {
		const { sessionStart } = load();
		sessionStart({ type: "session_start" }, fakeCtx().ctx);
		assert.equal(providers.length, 1);

		const currentCalls: string[] = [];
		const current = {
			async getSuggestions(_lines: string[], _cl: number, _cc: number) {
				currentCalls.push("delegate");
				return { items: [{ value: "占位", label: "占位" }], prefix: "占位" };
			},
			applyCompletion: (lines: string[]) => ({ lines, cursorLine: 0, cursorCol: 0 }),
		};
		const provider = providers[0](current);

		const hit = await provider.getSuggestions(["先 &单"], 0, 5, { signal: new AbortController().signal });
		assert.deepEqual(hit.items.map((item: { value: string }) => item.value), ["&单步计划"]);
		assert.equal(hit.prefix, "&单");

		// 别名也进候选，并注明它属于谁
		const aliasHit = await provider.getSuggestions(["看看 &core"], 0, 8, { signal: new AbortController().signal });
		assert.deepEqual(aliasHit.items.map((item: { value: string }) => item.value), ["&core-prompt"]);
		assert.match(aliasHit.items[0].description, /关于我 的别名/);

		// 没有 & token：交给原来的补全器
		const miss = await provider.getSuggestions(["先看报错"], 0, 4, { signal: new AbortController().signal });
		assert.deepEqual(miss.items.map((item: { value: string }) => item.value), ["占位"]);
		assert.deepEqual(currentCalls, ["delegate"]);
	});
});
