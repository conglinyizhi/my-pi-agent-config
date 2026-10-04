// lib/ptc-fold-calls.test.ts — 折叠芯片的生成口径
// 跑法：node --test --experimental-strip-types lib/ptc-fold-calls.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanScript } from "./ptc-analyze.ts";
import { foldCallsOf, patchPathsOf, scriptEffectsOf } from "./ptc-audit.ts";
import type { FoldCallPayload } from "./approval-channel.ts";

const HOME = "/home/clyzhi";
const CWD = "/home/clyzhi/.pi/agent";
const AGENT = "/home/clyzhi/.pi/agent";

async function fold(source: string): Promise<FoldCallPayload[]> {
	return foldCallsOf({
		script: source,
		reason: "测试",
		tools: [],
		scan: await scanScript(source),
		cwd: CWD,
		home: HOME,
	});
}

function pick(calls: FoldCallPayload[], tool: string): FoldCallPayload {
	const found = calls.find((call) => call.tool === tool);
	assert.ok(found, `没有折出 ${tool}`);
	return found;
}

describe("折叠白名单", () => {
	it("只折会改状态的调用，其它一律亮原文", async () => {
		const source = [
			`const r = await tools.read({ path: "${AGENT}/src/a.js" });`,
			`const w = await tools.write({ path: "${AGENT}/src/a.js", content: "hello" });`,
			`const b = await tools.bash({ command: "git status" });`,
			`const c = await my_custom_tool({ path: "/etc/hosts" });`,
		].join("\n");
		const calls = await fold(source);
		assert.deepEqual(calls.map((call) => call.tool), ["write", "bash"]);
	});

	it("是文件编辑折灰、bash 折橙（kind 分开）", async () => {
		const calls = await fold([
			`tools.write({ path: "/tmp/a.js", content: "x" });`,
			`tools.bash({ command: "ls" });`,
		].join("\n"));
		assert.equal(pick(calls, "write").kind, "file");
		assert.equal(pick(calls, "bash").kind, "shell");
	});
});

describe("显示路径", () => {
	it("write 的目标路径按 $PWD 缩短", async () => {
		const calls = await fold(`tools.write({ path: "${AGENT}/src/a.js", content: "x" });`);
		assert.equal(pick(calls, "write").displayPath, "$PWD/src/a.js");
	});

	it("bash 缩的是 cwd（命令作用面），不是命令本身", async () => {
		const calls = await fold(`tools.bash({ command: "git status", cwd: "${AGENT}/src" });`);
		const bash = pick(calls, "bash");
		assert.equal(bash.displayPath, "$PWD/src");
	});

	it("没有 cwd 参数就没 displayPath，不瞎猜", async () => {
		const calls = await fold(`tools.bash({ command: "ls" });`);
		assert.equal(pick(calls, "bash").displayPath, undefined);
	});

	it("家目录下的路径缩成 ~", async () => {
		const calls = await fold(`tools.write({ path: "${HOME}/notes/a.md", content: "x" });`);
		assert.equal(pick(calls, "write").displayPath, "~/notes/a.md");
	});
});

describe("区间与规模", () => {
	it("区间能原样切回这次调用的源码", async () => {
		const source = `const w = await tools.write({ path: "/tmp/a.js", content: "hi" });`;
		const calls = await fold(source);
		const write = pick(calls, "write");
		// 芯片只盖实参：左边是 ( 、右边是 )，函数名留在代码里
		const sliced = source.slice(write.startOffset, write.endOffset);
		assert.equal(source[write.startOffset - 1], "(");
		assert.equal(source[write.endOffset], ")");
		assert.equal(sliced, '{ path: "/tmp/a.js", content: "hi" }');
		assert.equal(write.line, 1);
		assert.equal(write.endLine, 1);
	});

	it("多行调用的行号区间对得上", async () => {
		const source = [
			"const x = 1;",
			"await tools.write({",
			'  path: "/tmp/a.js",',
			'  content: "hi",',
			"});",
		].join("\n");
		const write = pick(await fold(source), "write");
		assert.equal(write.line, 2);
		assert.equal(write.endLine, 5);
	});

	it("write 的正文规模按字节与行数给", async () => {
		const calls = await fold(`tools.write({ path: "/tmp/a.js", content: "a\\nb" });`);
		const write = pick(calls, "write");
		assert.equal(write.bytes, 3);
		assert.equal(write.lines, 2);
		assert.equal(write.contentPreview, "a\nb");
	});

	it("bash 的规模按命令算，但不带命令预览（前端切原文）", async () => {
		const calls = await fold(`tools.bash({ command: "echo hi" });`);
		const bash = pick(calls, "bash");
		assert.equal(bash.bytes, 7);
		assert.equal(bash.contentPreview, undefined);
	});
});

describe("看不清的调用", () => {
	it("正文是变量时标 literal:false", async () => {
		const source = [
			"const body = readSomething();",
			`tools.write({ path: "/tmp/a.js", content: body });`,
		].join("\n");
		const write = pick(await fold(source), "write");
		assert.equal(write.literal, false);
		assert.equal(write.contentPreview, undefined);
	});

	it("路径是变量时同样看得见但看不全，路径不缩也不编", async () => {
		const source = [
			"const target = pick();",
			"tools.write({ path: target, content: \"x\" });",
		].join("\n");
		const write = pick(await fold(source), "write");
		assert.equal(write.literal, false);
		assert.equal(write.displayPath, undefined);
	});
});

describe("edit 的新旧文", () => {
	it("old/new 都是字面量时带 replacement", async () => {
		const source = `tools.edit({ path: "/tmp/a.js", old: "before", new: "after" });`;
		const edit = pick(await fold(source), "edit");
		assert.deepEqual(edit.replacement, { old: "before", new: "after", truncated: false });
	});
});

describe("预览上限", () => {
	it("超长正文截到 4000 并标 truncated，但规模仍按全文算", async () => {
		const body = "x".repeat(5000);
		const calls = await fold(`tools.write({ path: "/tmp/a.js", content: "${body}" });`);
		const write = pick(calls, "write");
		assert.equal(write.contentPreview?.length, 4000);
		assert.equal(write.truncated, true);
		assert.equal(write.bytes, 5000);
	});
});

describe("没有实参的调用", () => {
	it("没有实参就不折（没东西可看，也没有变量部分可包）", async () => {
		const calls = await fold(`tools.bash();`);
		assert.deepEqual(calls, []);
	});
});

describe("展示文本优先", () => {
	it("有 displayScan 时折叠区间落在展示文本上", async () => {
		// 展示文本（重排过的）比原文短，区间只对展示文本成立
		const display = "tools.write({ path: \"/tmp/a.js\", content: \"x\" });";
		const effects = scriptEffectsOf({
			script: `   ${display}`,
			reason: "测试",
			tools: [],
			scan: await scanScript(`   ${display}`),
			display,
			displayScan: await scanScript(display),
			cwd: CWD,
			home: HOME,
		});
		const call = effects.editCalls?.[0];
		assert.ok(call);
		assert.equal(call.literal, true);
		// 区间必须落在被显示的那份文本上（原文前面多了三个空格，切出来就对不上）
		assert.equal(display.slice(call.startOffset, call.endOffset), '{ path: "/tmp/a.js", content: "x" }');
	});
});

describe("接进影响面载荷", () => {
	it("scriptEffectsOf 带上 editCalls，既有字段一个不少", async () => {
		const source = `tools.write({ path: "${AGENT}/a.js", content: "x" });`;
		const effects = scriptEffectsOf({
			script: source,
			reason: "测试",
			tools: [],
			scan: await scanScript(source),
			cwd: CWD,
			home: HOME,
		});
		assert.equal(effects.editCalls?.length, 1);
		assert.deepEqual(effects.tools, ["write"]);
		assert.deepEqual(effects.paths, [`${AGENT}/a.js`]);
		assert.equal(effects.digestShort.length, 12);
	});

	it("没有要折的调用时干脆不带这个字段", async () => {
		const source = `tools.read({ path: "/tmp/a.js" });`;
		const effects = scriptEffectsOf({
			script: source,
			reason: "测试",
			tools: [],
			scan: await scanScript(source),
			cwd: CWD,
			home: HOME,
		});
		assert.equal("editCalls" in effects, false);
	});
});

describe("str_replace_editor 的字段映射", () => {
	it("old_str/new_str 变成新旧文，command 带成 mode", async () => {
		const source = 'tools.str_replace_editor({ command: "str_replace", path: "/tmp/a.js", old_str: "before", new_str: "after" });';
		const call = pick(await fold(source), "str_replace_editor");
		assert.deepEqual(call.replacement, { old: "before", new: "after", truncated: false });
		assert.equal(call.mode, "str_replace");
	});

	it("file_text 当作正文预览", async () => {
		const source = 'tools.str_replace_editor({ command: "create", path: "/tmp/a.js", file_text: "hello" });';
		const call = pick(await fold(source), "str_replace_editor");
		assert.equal(call.contentPreview, "hello");
		assert.equal(call.mode, "create");
	});
});

describe("补丁类工具", () => {
	it("补丁正文原样带出，并从正文里认出目标文件", async () => {
		const patch = "*** Update File: /home/clyzhi/.pi/agent/lib/x.ts" + String.fromCharCode(10) + "@@" + String.fromCharCode(10) + "-old" + String.fromCharCode(10) + "+new";
		const source = "tools.apply_patch({ patch: " + JSON.stringify(patch) + " });";
		const call = pick(await fold(source), "apply_patch");
		assert.equal(call.patchText, patch);
		assert.equal(call.displayPath, "$PWD/lib/x.ts");
		assert.deepEqual(call.paths, ["$PWD/lib/x.ts"]);
	});

	it("统一 diff 头里的 a/ b/ 前缀与 /dev/null 都处理掉", () => {
		const patch = "--- a/src/x.ts" + String.fromCharCode(10) + "+++ b/src/x.ts";
		assert.deepEqual(patchPathsOf(patch), ["src/x.ts"]);
		assert.deepEqual(patchPathsOf("--- /dev/null"), []);
	});

	it("认不出路径时芯片标签给省略号，不编", async () => {
		const source = 'tools.patch({ patch: "@@" });';
		const call = pick(await fold(source), "patch");
		assert.equal(call.displayPath, undefined);
		assert.equal(call.patchText, "@@");
	});
});

describe("合并视图进载荷", () => {
	it("同文件两次改动合一份，路径缩短，并标出改前是按空文件算的", async () => {
		const source = [
			'tools.write({ path: "/home/clyzhi/.pi/agent/a.js", content: "one" });',
			'tools.edit({ path: "/home/clyzhi/.pi/agent/a.js", old: "one", new: "ONE" });',
		].join(String.fromCharCode(10));
		const effects = scriptEffectsOf({
			script: source,
			reason: "测试",
			tools: [],
			scan: await scanScript(source),
			cwd: CWD,
			home: HOME,
		});
		assert.equal(effects.mergedChanges?.length, 1);
		assert.equal(effects.mergedChanges?.[0].path, "$PWD/a.js");
		assert.equal(effects.mergedChanges?.[0].status, "merged");
		assert.equal(effects.mergedChanges?.[0].baseAssumedEmpty, true);
		assert.equal(effects.mergedChanges?.[0].ops, 2);
	});

	it("没有可推演的改动时不带这个字段", async () => {
		const source = 'tools.read({ path: "/tmp/a.js" });';
		const effects = scriptEffectsOf({
			script: source,
			reason: "测试",
			tools: [],
			scan: await scanScript(source),
			cwd: CWD,
			home: HOME,
		});
		assert.equal("mergedChanges" in effects, false);
	});
});

