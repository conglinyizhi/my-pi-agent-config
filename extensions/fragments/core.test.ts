// extensions/fragments/core.test.ts — 碎片配置解析与 &触发展开（纯逻辑）
//
// 跑法：node --experimental-strip-types extensions/fragments/core.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expandFragments, findFragment, loadFragments, parseFragments, triggerNames, type Fragment } from "./core.ts";

const 单步: Fragment = { name: "单步计划", desc: "仅调查不行动", text: "对于这一步，只做调查、不要动手" };
const core: Fragment = { name: "core-prompt", text: "读 ~/disk/core-prompt/\n然后继续" };

describe("parseFragments", () => {
	it("数组表：name / desc / text", () => {
		const { fragments, problems } = parseFragments(`
[[fragment]]
name = "单步计划"
desc = "仅调查不行动"
text = """
对于这一步，只做调查
不要动手
"""

[[fragment]]
name = "core-prompt"
text = "读 ~/disk/core-prompt/"
`);
		assert.deepEqual(problems, []);
		assert.deepEqual(fragments, [
			{ name: "单步计划", desc: "仅调查不行动", text: "对于这一步，只做调查\n不要动手\n" },
			{ name: "core-prompt", text: "读 ~/disk/core-prompt/" },
		]);
	});

	it("空文件与没有 fragment 段：都不报错", () => {
		assert.deepEqual(parseFragments(""), { fragments: [], problems: [] });
		assert.deepEqual(parseFragments("# 只有注释\n"), { fragments: [], problems: [] });
	});

	it("缺 name / 缺 text / 名字带空白 / 重名：逐条报出来，好的照收", () => {
		const { fragments, problems } = parseFragments(`
[[fragment]]
desc = "没有名字"
text = "x"

[[fragment]]
name = "没有正文"

[[fragment]]
name = "带 空白"
text = "x"

[[fragment]]
name = "好的"
text = "正文"

[[fragment]]
name = "好的"
text = "重复的"
`);
		assert.deepEqual(fragments, [{ name: "好的", text: "正文" }]);
		assert.equal(problems.length, 4);
		assert.match(problems[0] ?? "", /缺少 name/);
		assert.match(problems[1] ?? "", /缺少 text/);
		assert.match(problems[2] ?? "", /空白/);
		assert.match(problems[3] ?? "", /重复/);
	});

	it("别名：一条正文挂多个触发词", () => {
		const { fragments, problems } = parseFragments(`
[[fragment]]
name = "关于我"
aliases = ["core-prompt", "基础了解层", "我"]
desc = "背景资料入口"
text = "读 ~/disk/core-prompt/"
`);
		assert.deepEqual(problems, []);
		assert.deepEqual(fragments, [
			{ name: "关于我", aliases: ["core-prompt", "基础了解层", "我"], desc: "背景资料入口", text: "读 ~/disk/core-prompt/" },
		]);
		assert.deepEqual(triggerNames(fragments[0]), ["关于我", "core-prompt", "基础了解层", "我"]);
	});

	it("别名的毛病：不数组 / 带空白 / 与已有名字或别名撞车 / 与主名重复", () => {
		const { fragments, problems } = parseFragments(`
[[fragment]]
name = "a"
aliases = "core-prompt"
text = "x"

[[fragment]]
name = "b"
aliases = ["带 空白", "", "a", "b", "好的"]
text = "y"
`);
		assert.deepEqual(fragments, [{ name: "b", aliases: ["好的"], text: "y" }]);
		assert.equal(problems.length, 4);
		assert.match(problems[0] ?? "", /要写成字符串数组/);
		assert.match(problems[1] ?? "", /别名「带 空白」里有空白/);
		assert.match(problems[2] ?? "", /别名里有空值/);
		assert.match(problems[3] ?? "", /别名「a」和已有的名字或别名重复/);
	});

	it("形状不对：不是数组表 / TOML 坏了", () => {
		assert.match(parseFragments('fragment = "x"').problems[0] ?? "", /数组表/);
		assert.match(parseFragments("[[fragment]\nname=").problems[0] ?? "", /TOML 解析失败/);
	});
});

describe("loadFragments", () => {
	it("文件不在算 missing，不算错", () => {
		const dir = mkdtempSync(join(tmpdir(), "frag-missing-"));
		const file = loadFragments(join(dir, "fragments.toml"));
		assert.deepEqual(file, { fragments: [], problems: [], missing: true });
	});

	it("读得动就解析", () => {
		const dir = mkdtempSync(join(tmpdir(), "frag-load-"));
		const path = join(dir, "fragments.toml");
		writeFileSync(path, '[[fragment]]\nname = "a"\ntext = "b"\n', "utf8");
		const file = loadFragments(path);
		assert.deepEqual(file.fragments, [{ name: "a", text: "b" }]);
	});
});

describe("expandFragments", () => {
	it("行首与空白后的 &名字 展开，换行原样带进来", () => {
		const result = expandFragments("&单步计划\n先看看 &core-prompt", [单步, core]);
		assert.equal(result.text, "对于这一步，只做调查、不要动手\n先看看 读 ~/disk/core-prompt/\n然后继续");
		assert.deepEqual(result.expanded.sort(), ["core-prompt", "单步计划"]);
		assert.deepEqual(result.unknown, []);
	});

	it("不碰 shell 与 URL 里的 &：&&、a & b、&x=1", () => {
		const text = "make && ls -la\na & b\ncurl 'http://x/?a=1&b=2'";
		const result = expandFragments(text, [单步, core]);
		assert.equal(result.text, text);
		assert.deepEqual(result.unknown, []);
	});

	it("代码块与反引号里的 &名字 不展开", () => {
		const text = ["```bash", "&单步计划", "```", "行内 `&单步计划` 也保留", "&单步计划 这里要展开"].join("\n");
		const result = expandFragments(text, [单步]);
		assert.equal(result.text, ["```bash", "&单步计划", "```", "行内 `&单步计划` 也保留", "对于这一步，只做调查、不要动手 这里要展开"].join("\n"));
		assert.deepEqual(result.expanded, ["单步计划"]);
	});

	it("用别名触发也展开到同一条正文", () => {
		const 关于我: Fragment = { name: "关于我", aliases: ["core-prompt", "我"], text: "读 ~/disk/core-prompt/" };
		const byAlias = expandFragments("&core-prompt 继续", [关于我]);
		assert.equal(byAlias.text, "读 ~/disk/core-prompt/ 继续");
		assert.deepEqual(byAlias.expanded, ["core-prompt"]);
		const byShort = expandFragments("&我 看看", [关于我]);
		assert.equal(byShort.text, "读 ~/disk/core-prompt/ 看看");
	});

	it("别名都指向同一条：改内容只改一处（展开结果一样）", () => {
		const 关于我: Fragment = { name: "关于我", aliases: ["core-prompt", "基础了解层"], text: "同一段正文" };
		for (const key of triggerNames(关于我)) {
			assert.equal(expandFragments(`&${key}`, [关于我]).text, "同一段正文");
		}
	});

	it("没定义的名字原样留着，只记进 unknown", () => {
		const result = expandFragments("&没这个 和 &单步计划", [单步]);
		assert.equal(result.text, "&没这个 和 对于这一步，只做调查、不要动手");
		assert.deepEqual(result.unknown, ["没这个"]);
	});

	it("单趟展开：片段正文里再写 &别的 不会继续展开", () => {
		const nested: Fragment = { name: "外层", text: "展开后还有 &单步计划" };
		const result = expandFragments("&外层", [nested, 单步]);
		assert.equal(result.text, "展开后还有 &单步计划");
		assert.deepEqual(result.expanded, ["外层"]);
	});

	it("标点紧跟在名字后面时只吃名字", () => {
		const result = expandFragments("&单步计划，然后再说", [单步]);
		assert.equal(result.text, "对于这一步，只做调查、不要动手，然后再说");
	});

	it("配置为空：把 &名字 都报成未知（好提示用户去写配置）", () => {
		const result = expandFragments("&单步计划 &core-prompt", []);
		assert.equal(result.text, "&单步计划 &core-prompt");
		assert.deepEqual(result.unknown.sort(), ["core-prompt", "单步计划"]);
	});

	it("findFragment 主名与别名都找得到", () => {
		assert.equal(findFragment([单步, core], "core-prompt")?.text, core.text);
		assert.equal(findFragment([单步, core], "没有"), undefined);
		const 关于我: Fragment = { name: "关于我", aliases: ["我"], text: "x" };
		assert.equal(findFragment([关于我], "关于我")?.text, "x");
		assert.equal(findFragment([关于我], "我")?.text, "x");
	});
});
