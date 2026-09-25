// extensions/fragments/index.test.ts — 扩展接线：input 展开、两个命令、autocomplete
//
// 跑法：node --experimental-strip-types extensions/fragments/index.test.ts
//
// 用假的 pi / ctx 跑真 handler：这里要钉的是「接线接对了没」，
// 纯逻辑本身由 core.test.ts 覆盖。

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadFragments } from "./core.ts";
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

/** 假的 UI ctx：把 notify / select / 两个 TUI 的输入 / 输入框内容记下来 */
function fakeCtx(options: { editor?: string; pick?: string; input?: string; body?: string } = {}) {
	const notices: Array<{ message: string; level: string }> = [];
	const calls = { input: 0, editor: 0 };
	let editor = options.editor ?? "";
	return {
		notices,
		calls,
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
				async input() {
					calls.input++;
					return options.input; // undefined = 取消
				},
				async editor() {
					calls.editor++;
					return options.body; // undefined = 取消
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
		add: pi.commands.get("frag:add") as Command,
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

describe("/frag:add", () => {
	const path = () => join(agentDir, "fragments.toml");

	it("两个 TUI 都填完：追加进配置，写完立刻能用（不用 reload）", async () => {
		const { add, input } = load();
		const env = fakeCtx({ input: "新碎片 这是个描述", body: "第一行\n第二行" });
		await add.handler("", env.ctx);

		assert.equal(env.calls.input, 1);
		assert.equal(env.calls.editor, 1);
		const file = loadFragments(path());
		assert.deepEqual(file.problems, []);
		assert.deepEqual(file.fragments.at(-1), { name: "新碎片", desc: "这是个描述", text: "第一行\n第二行" });
		assert.match(env.notices.at(-1)?.message ?? "", /已写入 &新碎片/);
		assert.deepEqual(readdirSync(agentDir), ["fragments.toml"], "不该留下 .tmp 文件");

		// 立即生效：接着打 &新碎片 就该展开
		const out = await input({ type: "input", text: "&新碎片 帮我看下", source: "interactive" }, env.ctx);
		assert.equal(out.action, "transform");
		assert.equal(out.text, "第一行\n第二行 帮我看下");
	});

	it("第一段是名字，剩下的都算描述；描述可省", async () => {
		const { add } = load();
		await add.handler("", fakeCtx({ input: "  名字   描述 里 还有 空格  ", body: "正文" }).ctx);
		await add.handler("", fakeCtx({ input: "光名字", body: "正文" }).ctx);

		const names = loadFragments(path()).fragments;
		assert.deepEqual(names.at(-2), { name: "名字", desc: "描述 里 还有 空格", text: "正文" });
		assert.deepEqual(names.at(-1), { name: "光名字", text: "正文" });
	});

	it("第一个 TUI 取消：不写文件，也不再问正文", async () => {
		const { add } = load();
		const before = readFileSync(path(), "utf8");
		const env = fakeCtx({ body: "正文" }); // input 返回 undefined
		await add.handler("", env.ctx);
		assert.equal(env.calls.editor, 0);
		assert.equal(readFileSync(path(), "utf8"), before);
		assert.deepEqual(readdirSync(agentDir), ["fragments.toml"]);
	});

	it("第二个 TUI 取消：不写文件", async () => {
		const { add } = load();
		const before = readFileSync(path(), "utf8");
		const env = fakeCtx({ input: "新碎片" }); // editor 返回 undefined
		await add.handler("", env.ctx);
		assert.equal(env.calls.editor, 1);
		assert.equal(readFileSync(path(), "utf8"), before);
		assert.deepEqual(readdirSync(agentDir), ["fragments.toml"]);
	});

	it("重名 / 名字为空 / 正文为空：给提示，一个字节不写", async () => {
		const { add } = load();
		const before = readFileSync(path(), "utf8");

		const dup = fakeCtx({ input: "关于我 想覆盖", body: "新正文" });
		await add.handler("", dup.ctx);
		assert.match(dup.notices.at(-1)?.message ?? "", /没写入：已经有 &关于我/);
		assert.equal(dup.calls.editor, 0, "名字就不行，别让人再写一通正文");

		const blank = fakeCtx({ input: "   ", body: "正文" });
		await add.handler("", blank.ctx);
		assert.match(blank.notices.at(-1)?.message ?? "", /名字不能为空/);
		assert.equal(blank.calls.editor, 0);

		const emptyBody = fakeCtx({ input: "新碎片", body: "  \n " });
		await add.handler("", emptyBody.ctx);
		assert.match(emptyBody.notices.at(-1)?.message ?? "", /正文不能为空/);

		assert.equal(readFileSync(path(), "utf8"), before, "拒绝时原文不能动");
		assert.deepEqual(readdirSync(agentDir), ["fragments.toml"]);
	});

	it("没有 UI（rpc / print）：给一句降级提示，不写文件", async () => {
		const { add } = load();
		assert.ok(add, "frag:add 得注册上");
		const notices: Array<{ message: string; level: string }> = [];
		const before = readFileSync(path(), "utf8");
		await add.handler("", {
			hasUI: false,
			ui: {
				notify(message: string, level = "info") {
					notices.push({ message, level });
				},
				select: async () => undefined,
				getEditorText: () => "",
				setEditorText: () => {},
				addAutocompleteProvider: () => {},
			},
		});
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.level, "warning");
		assert.match(notices[0]?.message ?? "", /没有可用的交互界面/);
		assert.equal(readFileSync(path(), "utf8"), before);
	});
});

describe("autocomplete", () => {
	/** 假的旧补全器：记下调了几次，返回一条占位候选 */
	function fakeCurrent() {
		const calls: string[] = [];
		return {
			calls,
			current: {
				async getSuggestions(_lines: string[], _cl: number, _cc: number) {
					calls.push("delegate");
					return { items: [{ value: "占位", label: "占位" }], prefix: "占位" };
				},
				applyCompletion: (lines: string[]) => ({ lines, cursorLine: 0, cursorCol: 0 }),
			},
		};
	}

	it("wrapper 把 & 声明成补全触发字符（pi 靠它自动弹候选）", () => {
		const { sessionStart } = load();
		sessionStart({ type: "session_start" }, fakeCtx().ctx);
		assert.equal(providers.length, 1);
		assert.deepEqual(providers[0](fakeCurrent().current).triggerCharacters, ["&"]);
	});

	it("输入 & 时给候选，并沿用原来的补全器", async () => {
		const { sessionStart } = load();
		sessionStart({ type: "session_start" }, fakeCtx().ctx);
		assert.equal(providers.length, 1);

		const { calls: currentCalls, current } = fakeCurrent();
		const provider = providers[0](current);

		const hit = await provider.getSuggestions(["先 &单"], 0, 5, { signal: new AbortController().signal });
		assert.deepEqual(hit.items.map((item: { value: string }) => item.value), ["&单步计划"]);
		assert.equal(hit.prefix, "&单");

		// 别名也进候选，并注明它属于谁
		const aliasHit = await provider.getSuggestions(["看看 &core"], 0, 8, { signal: new AbortController().signal });
		assert.deepEqual(aliasHit.items.map((item: { value: string }) => item.value), ["&core-prompt"]);
		assert.match(aliasHit.items[0].description, /关于我 的别名/);

		// 删光了名字只剩 &：候选全弹出来（这就是自动触发的场景）
		const bare = await provider.getSuggestions(["先看看 &"], 0, 5, { signal: new AbortController().signal });
		assert.deepEqual(bare.items.map((item: { value: string }) => item.value), [
			"&单步计划",
			"&关于我",
			"&core-prompt",
			"&基础了解层",
			"&我",
		]);
		assert.equal(bare.prefix, "&");

		// 没有 & token：交给原来的补全器
		const miss = await provider.getSuggestions(["先看报错"], 0, 4, { signal: new AbortController().signal });
		assert.deepEqual(miss.items.map((item: { value: string }) => item.value), ["占位"]);
		assert.deepEqual(currentCalls, ["delegate"]);
	});

	it("非 & 上下文一律回退：shell 的 &&、单独的 &、URL 里的 &", async () => {
		const { sessionStart } = load();
		sessionStart({ type: "session_start" }, fakeCtx().ctx);
		const { calls: currentCalls, current } = fakeCurrent();
		const provider = providers[0](current);

		const lines = ["make && ls -la", "a & b", "curl 'http://x/?a=1&b=2'", "a&&b", "&x=1"];
		for (const line of lines) {
			const out = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
			assert.deepEqual(out.items.map((item: { value: string }) => item.value), ["占位"], `${line} 不该弹碎片候选`);
		}
		assert.equal(currentCalls.length, lines.length, "每个非 & 上下文都要回退到原补全器");
	});

	it("刚打下一个 & 就弹；接着打第二个 & 或空格就退回去", async () => {
		const { sessionStart } = load();
		sessionStart({ type: "session_start" }, fakeCtx().ctx);
		const { current } = fakeCurrent();
		const provider = providers[0](current);

		// 触发字符决定的：& 一落地就弹（想打 && 或 a & b 时会闪一下，接着打就没了）
		const transient = await provider.getSuggestions(["a &"], 0, 3, { signal: new AbortController().signal });
		assert.equal(transient.items.length, 5);
		const second = await provider.getSuggestions(["a &&"], 0, 4, { signal: new AbortController().signal });
		assert.deepEqual(second.items.map((item: { value: string }) => item.value), ["占位"]);
		const spaced = await provider.getSuggestions(["a & "], 0, 4, { signal: new AbortController().signal });
		assert.deepEqual(spaced.items.map((item: { value: string }) => item.value), ["占位"]);
	});
});
