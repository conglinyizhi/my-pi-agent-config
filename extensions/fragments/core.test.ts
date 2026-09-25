// extensions/fragments/core.test.ts — 碎片配置解析与 &触发展开（纯逻辑）
//
// 跑法：node --experimental-strip-types extensions/fragments/core.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	addFragmentToFile,
	appendFragmentText,
	encodeTomlString,
	expandFragments,
	findFragment,
	loadFragments,
	parseFragments,
	triggerNames,
	validateNewFragment,
	type Fragment,
} from "./core.ts";

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

describe("写配置（/frag:add 的落盘那一段）", () => {
	/** 走一遍序列化的边角料：多行、三连引号、反斜杠、控制字符 */
	const 难缠: Fragment[] = [
		{ name: "关于我", desc: "背景资料入口", text: "读 ~/disk/core-prompt/" },
		{ name: "多行", text: "第一行\n第二行\n" },
		{ name: "三连引号", text: '正文里连写三个引号 """ 也不能坏' },
		{ name: '名字带\\反斜杠"和引号', desc: '描述里也有 \\ 与 "', text: '正文末尾是反斜杠 \\\n还有 "引号"' },
		{ name: "带三连单引号", text: "第一行\n'''\n第二行" },
		{ name: "结尾单引号", text: "正文结尾是单引号 '" },
		{ name: "留白", text: "  前后留白  \n\n" },
		{ name: "控制字符", text: "制表\t符\n还有 \u0001 一个" },
		{ name: "转义路径收尾引号", text: '第一行\n\u0007 结尾是引号"' },
		{ name: "转义路径收尾三引号", text: '带控制\u0007 和结尾 """' },
		{ name: "换行开头单引号收尾", text: "\n开头换行，结尾是单引号'" },
		{ name: "换行开头两单引号收尾", text: "\n开头换行，结尾是两个单引号''" },
	];

	it("往返：一条一条写进去，parseFragments 都能原样读回", () => {
		for (const fragment of 难缠) {
			const text = appendFragmentText("", fragment);
			const { fragments, problems } = parseFragments(text);
			assert.deepEqual(problems, [], `写 ${fragment.name} 时解析出了问题`);
			assert.deepEqual(fragments, [fragment], `写 ${fragment.name} 时往返不一致`);
		}
	});

	it("往返：全部写进同一个文件，顺序与内容都不变", () => {
		let text = "";
		for (const fragment of 难缠) text = appendFragmentText(text, fragment);
		const { fragments, problems } = parseFragments(text);
		assert.deepEqual(problems, []);
		assert.deepEqual(fragments, 难缠);
	});

	it("挑形状：单行用普通字符串，多行用 '''，带 ''' 走转义的多行基本字符串", () => {
		const single = encodeTomlString("单行");
		assert.equal(single[0], '"');
		assert.ok(!single.includes("\n"), "单行不该多出换行");
		assert.ok(encodeTomlString("第一行\n第二行").startsWith("'''\n"));
		assert.ok(encodeTomlString("第一行\n'''\n第二行").startsWith('"""\n'));
	});

	it("追加到已有配置：旧条目一条不少，新的挂在最后", () => {
		const old = '[[fragment]]\nname = "旧的"\ntext = "老正文"\n';
		const next = appendFragmentText(old, { name: "新的", text: "新正文" });
		const { fragments, problems } = parseFragments(next);
		assert.deepEqual(problems, []);
		assert.deepEqual(fragments.map((fragment) => fragment.name), ["旧的", "新的"]);
		assert.equal(fragments[0]?.text, "老正文");
	});

	it("空文件 / 只有注释 / 末尾没换行：都能接上", () => {
		const seeds = ["", "# 只有注释\n", "[[fragment]]\nname = \"x\"\ntext = \"y\""];
		for (const seed of seeds) {
			const { fragments, problems } = parseFragments(appendFragmentText(seed, { name: "新的", text: "新正文" }));
			assert.deepEqual(problems, [], `种子 ${JSON.stringify(seed)} 接不上`);
			assert.equal(fragments.at(-1)?.name, "新的");
		}
		assert.equal(parseFragments(appendFragmentText("# 只有注释\n", { name: "新的", text: "x" })).fragments.length, 1);
	});

	it("校验：名字重复、撞别名、带空白、& 打不出来、正文为空都要拒绝", () => {
		const existing: Fragment[] = [{ name: "关于我", aliases: ["我"], text: "x" }];
		const cases: Array<[string, string, string, RegExp]> = [
			["关于我", "描述", "正文", /已经有 &关于我/],
			["我", "描述", "正文", /已经是 关于我 的别名/],
			["带 空白", "描述", "正文", /名字里不能有空白/],
			["点.名字", "描述", "正文", /打不出 & 触发/],
			["", "描述", "正文", /名字不能为空/],
			["   ", "描述", "正文", /名字不能为空/],
			["新名字", "描述", "", /正文不能为空/],
			["新名字", "描述", "  \n ", /正文不能为空/],
		];
		for (const [name, desc, text, pattern] of cases) {
			const result = validateNewFragment(name, desc, text, existing);
			assert.equal(result.ok, false, `${JSON.stringify(name)} 应该被拒绝`);
			assert.match(result.ok ? "" : result.reason, pattern);
		}
		const good = validateNewFragment(" 新名字 ", " 两段 描述 ", "正文", existing);
		assert.deepEqual(good, { ok: true, fragment: { name: "新名字", desc: "两段 描述", text: "正文" } });
		assert.deepEqual(validateNewFragment("只有名字", "", "正文", existing), {
			ok: true,
			fragment: { name: "只有名字", text: "正文" },
		});
	});

	it("addFragmentToFile：写进临时目录，读回来就是新的，不留临时文件", () => {
		const dir = mkdtempSync(join(tmpdir(), "frag-write-"));
		try {
			const path = join(dir, "fragments.toml");
			const first = addFragmentToFile(path, { name: "新的", desc: "描述", text: "第一行\n第二行" });
			assert.equal(first.ok, true);
			assert.deepEqual(loadFragments(path).fragments, [{ name: "新的", desc: "描述", text: "第一行\n第二行" }]);
			assert.deepEqual(readdirSync(dir), ["fragments.toml"], "不该留下 .tmp 文件");

			const second = addFragmentToFile(path, { name: "第二条", text: '带 """ 与 \\ 的正文' });
			assert.equal(second.ok, true);
			const file = loadFragments(path);
			assert.deepEqual(file.problems, []);
			assert.deepEqual(file.fragments.map((fragment) => fragment.name), ["新的", "第二条"]);
			assert.equal(file.fragments[1]?.text, '带 """ 与 \\ 的正文');
			assert.deepEqual(readdirSync(dir), ["fragments.toml"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("addFragmentToFile：拒绝时一个字节都不写（文件不在就不建，在就原样）", () => {
		const dir = mkdtempSync(join(tmpdir(), "frag-refuse-"));
		try {
			const path = join(dir, "fragments.toml");
			const rejected = addFragmentToFile(path, { name: "坏 名字", text: "正文" });
			assert.equal(rejected.ok, false);
			assert.deepEqual(readdirSync(dir), [], "拒绝时不该建文件");

			writeFileSync(path, '[[fragment]]\nname = "旧的"\ntext = "老正文"\n', "utf8");
			const before = readFileSync(path, "utf8");
			for (const input of [
				{ name: "旧的", text: "重名" },
				{ name: "新的", text: "" },
				{ name: "新的", text: "   " },
				{ name: "点.名字", text: "正文" },
			]) {
				assert.equal(addFragmentToFile(path, input).ok, false, `${input.name} 应该被拒绝`);
			}
			assert.equal(readFileSync(path, "utf8"), before, "拒绝时原文不能动");
			assert.deepEqual(readdirSync(dir), ["fragments.toml"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("addFragmentToFile：现有文件解析不了就拒绝，不覆盖", () => {
		const dir = mkdtempSync(join(tmpdir(), "frag-broken-"));
		try {
			const path = join(dir, "fragments.toml");
			const broken = '[[fragment]\nname = "x"\n';
			writeFileSync(path, broken, "utf8");
			const result = addFragmentToFile(path, { name: "新的", text: "正文" });
			assert.equal(result.ok, false);
			assert.match(result.ok ? "" : result.reason, /解析不了/);
			assert.equal(readFileSync(path, "utf8"), broken);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
