// 折叠渲染的不变量：可视化片段 + 被折进芯片的原文 = 原始文本，一字不多一字不少
//
// 起因：有人怀疑审核窗折叠会改坏脚本（截图里出现孤零零的 await {）。实测这条不变量在真实形状上成立，
// 于是把它固化成用例：折叠只能"换掉"区间，不能凭空造字或吞字。
// 跑法：node --test --experimental-strip-types lib/ptc-fold-invariant.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatScriptForDisplay } from "./script-format.ts";
import { scanScript } from "./ptc-analyze.ts";
import { foldCallsOf } from "./ptc-audit.ts";
// @ts-expect-error 前端是 JS，没有类型声明；这里只借它的纯函数验折叠不变量
import { foldScript } from "../gui/frontend/src/domain/gate/script-fold.js";

const L = (...xs: string[]) => xs.join(String.fromCharCode(10));

const CORPUS: Array<[string, string]> = [
	["多行 bash 与字面量路径", L('const root = "/tmp/x/lzc-gateway";', 'await tools.bash({ command: "mkdir -p " + root });', 'const r = await tools.bash({ command: "ls", cwd: root });', "return text(r.output);")],
	["同一个文件两次编辑", L('await tools.edit({ path: "/tmp/a\", old: "x", new: "y" });', 'await tools.edit({ path: "/tmp/a\", old: "y", new: "z" });')],
	["嵌套调用", L('const nested = await tools.read({ path: await tools.write({ path: "/tmp/n\", content: "x" }) });')],
	["注释与字符串里的伪调用", L('// 注释里也有 tools.write({ path: "/x" })', 'const s = "tools.write({ path: \\"/y\\" })";', 'await tools.edit({ path: "/tmp/e\", old: "a", new: "b" });')],
];

async function foldFor(script: string) {
	const display = await formatScriptForDisplay(script);
	const text = display.formatted ? display.text : script;
	const scan = await scanScript(text);
	const calls = foldCallsOf({
		script,
		reason: "不变量检查",
		tools: [],
		scan,
		display: text,
		displayScan: scan,
		cwd: "/tmp",
		home: "/root",
	} as never);
	return { text, model: foldScript(text, calls, []) };
}

describe("折叠不变量", () => {
	for (const [name, script] of CORPUS) {
		it(`${name}：拼回原文一字不差`, async () => {
			const { text, model } = await foldFor(script);
			const rebuilt = (model.segments as Array<{ kind: string; text?: string; start: number; end: number }>)
				.map((seg) => (seg.kind === "text" ? seg.text ?? "" : text.slice(seg.start, seg.end)))
				.join("");
			assert.equal(rebuilt, text, "折叠只能换掉区间，不能凭空造字或吞字");
		});
	}

	it("确实折出了芯片（不然上面几条是空转）", async () => {
		const { model } = await foldFor(L('await tools.write({ path: "/tmp/a\", content: "x" });'));
		assert.ok((model.chips as unknown[]).length >= 1);
	});
});
