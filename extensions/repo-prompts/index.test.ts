// index.test.ts — repo-prompts 单测
//
// 覆盖：路径前缀命中（相等 / 子目录）、不命中（前缀相似、父目录）、~ 展开、
// 多条命中按 order 拼接、file 缺失 / TOML 坏掉 / 目录不存在时不抛不影响别的段、
// 多 toml 按文件名序合并与同名覆盖、私有后缀 *.local.toml 不作特殊判断、
// 同目录重复装配稳定、md 缓存失效、/repo-prompts 报告内容、[repo-prompts] 设置读取。
//
// 跑法：node --test --experimental-strip-types extensions/repo-prompts/index.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { type AssembleContext, assemble, renderPrompt, resetRegistry } from "../../lib/prompt-sections.ts";
import { DEFAULT_ORDER, type Rule, loadRules, loadSettings } from "./config.ts";
import { clearContentCache, readTextCached } from "./content.ts";
import { expandHome, isUnder, matchingRules, normalizePath } from "./match.ts";
import { buildReport } from "./report.ts";
import { injectedRules, registerRuleSections, resetWarned, ruleSectionName, ruleText } from "./sections.ts";

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTree(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "repo-prompts-test-"));
	tempDirs.push(dir);
	for (const [rel, content] of Object.entries(files)) {
		const path = join(dir, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return dir;
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function ctxFor(cwd: string): AssembleContext {
	return {
		cwd,
		model: "test-model",
		date: "2026-09-28",
		time: "10:00",
		prompt: "do the thing",
		defaultSystemPrompt: "[DEFAULT]",
	};
}

/** 注册一批规则的段，测试用完注销；返回段名列表便于断言 */
function registerForTest(rules: Rule[]) {
	resetRegistry();
	resetWarned();
	return registerRuleSections(rules);
}

async function sectionNamesFor(rules: Rule[], cwd: string): Promise<string[]> {
	const reg = registerForTest(rules);
	try {
		const assembly = await assemble(ctxFor(cwd));
		return assembly.sections.map((s) => s.name);
	} finally {
		reg.dispose();
	}
}

// ---------------------------------------------------------------------------
// 归一化与前缀
// ---------------------------------------------------------------------------

describe("路径归一化", () => {
	it("~ 与 ~/… 展开成家目录", () => {
		assert.equal(expandHome("~"), homedir());
		assert.equal(normalizePath("~"), homedir());
		assert.equal(normalizePath("~/disk/x/"), join(homedir(), "disk", "x"));
	});

	it("去尾斜线 / 去 . 与 ..", () => {
		assert.equal(normalizePath("/a/b/"), "/a/b");
		assert.equal(normalizePath("/a//b///"), "/a/b");
		assert.equal(normalizePath("/a/./b/../c"), "/a/c");
		assert.equal(normalizePath("/"), "/");
	});

	it("相对路径与空串解析成空（按不匹配处理）", () => {
		assert.equal(normalizePath("relative/dir"), "");
		assert.equal(normalizePath("  "), "");
		assert.equal(normalizePath(""), "");
	});
});

describe("前缀匹配", () => {
	it("cwd 等于规则路径 → 命中", () => {
		assert.equal(isUnder("/a/b", "/a/b"), true);
	});

	it("cwd 在规则路径的子目录 → 命中", () => {
		assert.equal(isUnder("/a/b/c", "/a/b"), true);
		assert.equal(isUnder("/a/b/c/d/e", "/a/b"), true);
	});

	it("前缀相似但不包含 → 不命中", () => {
		assert.equal(isUnder("/a/bc", "/a/b"), false);
		assert.equal(isUnder("/a/b-old", "/a/b"), false);
	});

	it("父目录 → 不命中（只向下）", () => {
		assert.equal(isUnder("/a", "/a/b"), false);
	});

	it("根前缀匹配一切绝对路径，空串匹配不了", () => {
		assert.equal(isUnder("/anything/here", "/"), true);
		assert.equal(isUnder("/a", ""), false);
	});

	it("~ 写法与家目录下的 cwd 命中", () => {
		const rule: Rule = {
			name: "t",
			order: DEFAULT_ORDER,
			paths: [normalizePath("~/disk/ai_workspace/preshell")],
			rawPaths: ["~/disk/ai_workspace/preshell"],
		};
		assert.deepEqual(matchingRules([rule], join(homedir(), "disk/ai_workspace/preshell")).map((r) => r.name), ["t"]);
		assert.deepEqual(matchingRules([rule], join(homedir(), "disk/ai_workspace/preshell/cmd")).map((r) => r.name), ["t"]);
		assert.deepEqual(matchingRules([rule], join(homedir(), "disk/ai_workspace/preshell-other")), []);
		assert.deepEqual(matchingRules([rule], join(homedir(), "disk/ai_workspace")), []);
	});
});

// ---------------------------------------------------------------------------
// index.toml 解析
// ---------------------------------------------------------------------------

describe("index.toml 解析", () => {
	it("解析 name / paths / file / order，order 缺省 200", () => {
		const dir = makeTree({
			"index.toml": [
				'[[prompt]]',
				'name = "a"',
				'paths = ["/tmp/app-a"]',
				'file = "a.md"',
				'order = 210',
				'[[prompt]]',
				'name = "b"',
				'paths = ["/tmp/app-b", "/tmp/app-b2"]',
				'text = "inline rule"',
				"",
			].join("\n"),
			"a.md": "# a\n",
		});
		const loaded = loadRules(dir);
		assert.equal(loaded.found, true);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.rules.length, 2);
		const [a, b] = loaded.rules;
		assert.equal(a.name, "a");
		assert.equal(a.order, 210);
		assert.deepEqual(a.paths, ["/tmp/app-a"]);
		assert.equal(a.file, join(dir, "a.md"));
		assert.equal(b.order, DEFAULT_ORDER);
		assert.equal(b.text, "inline rule");
		assert.equal(b.file, undefined);
		assert.deepEqual(b.rawPaths, ["/tmp/app-b", "/tmp/app-b2"]);
	});

	it("目录 / index.toml 不存在 → 零规则，不算错误", () => {
		const dir = join(tmpdir(), `repo-prompts-missing-${Date.now()}-${Math.random()}`);
		const loaded = loadRules(dir);
		assert.equal(loaded.found, false);
		assert.deepEqual(loaded.rules, []);
		assert.deepEqual(loaded.errors, []);
	});

	it("空的 index.toml → 零规则，不抛", () => {
		const dir = makeTree({ "index.toml": "" });
		const loaded = loadRules(dir);
		assert.equal(loaded.found, true);
		assert.deepEqual(loaded.rules, []);
	});

	it("TOML 坏掉 → 零规则 + 一条错误，不抛", () => {
		const dir = makeTree({ "index.toml": "[[prompt]\nname = \n" });
		let loaded: ReturnType<typeof loadRules> | undefined;
		assert.doesNotThrow(() => {
			loaded = loadRules(dir);
		});
		assert.equal(loaded?.found, true);
		assert.deepEqual(loaded?.rules, []);
		assert.equal(loaded?.errors.length, 1);
	});

	it("单条写错只丢它自己，其它规则照常", () => {
		const dir = makeTree({
			"index.toml": [
				'[[prompt]]',
				'name = "no-paths"',
				'file = "x.md"',
				'[[prompt]]',
				'name = "no-source"',
				'paths = ["/tmp/x"]',
				'[[prompt]]',
				'name = "bad name"',
				'paths = ["/tmp/y"]',
				'text = "t"',
				'[[prompt]]',
				'name = "relative-path"',
				'paths = ["some/rel"]',
				'text = "t"',
				'[[prompt]]',
				'name = "good"',
				'paths = ["/tmp/z"]',
				'text = "ok"',
				"",
			].join("\n"),
		});
		const loaded = loadRules(dir);
		assert.deepEqual(loaded.rules.map((r) => r.name), ["good"]);
		assert.equal(loaded.errors.length, 4);
	});

	it("同名规则后一条覆盖前一条，并记一条错误", () => {
		const dir = makeTree({
			"index.toml": [
				'[[prompt]]',
				'name = "dup"',
				'paths = ["/tmp/one"]',
				'text = "one"',
				'[[prompt]]',
				'name = "dup"',
				'paths = ["/tmp/two"]',
				'text = "two"',
				"",
			].join("\n"),
		});
		const loaded = loadRules(dir);
		assert.equal(loaded.rules.length, 1);
		assert.deepEqual(loaded.rules[0].paths, ["/tmp/two"]);
		assert.equal(loaded.errors.length, 1);
	});

	it("段名规则：repo:<name>", () => {
		assert.equal(ruleSectionName("preshell"), "repo:preshell");
	});
});

// ---------------------------------------------------------------------------
// 多 toml 合并（共享 / 私有）
// ---------------------------------------------------------------------------

describe("多 toml 合并", () => {
	/** 一段最小可用的 [[prompt]] */
	function one(name: string, path: string, text: string): string {
		return ["[[prompt]]", `name = "${name}"`, `paths = ["${path}"]`, `text = "${text}"`, ""].join("\n");
	}

	it("目录下多个 toml 全部被读，按文件名序合并", () => {
		const dir = makeTree({
			"index.toml": one("base", "/ws", "BASE"),
			"a-team.toml": one("team", "/ws", "TEAM"),
			"zeta.toml": one("zeta", "/ws", "ZETA"),
		});
		const loaded = loadRules(dir);
		assert.deepEqual(loaded.errors, []);
		assert.deepEqual(loaded.notes, []);
		assert.equal(loaded.found, true);
		assert.deepEqual(
			loaded.configFiles.map((f) => f.slice(dir.length + 1)),
			["a-team.toml", "index.toml", "zeta.toml"],
		);
		// 文件名序决定规则顺序（同 order 时段先后就是这个顺序）
		assert.deepEqual(loaded.rules.map((r) => `${r.name}@${r.source?.slice(dir.length + 1)}`), [
			"team@a-team.toml",
			"base@index.toml",
			"zeta@zeta.toml",
		]);
	});

	it("同名规则后者覆盖前者：内容与位置都取后一个文件，并记一条提示", () => {
		const dir = makeTree({
			"base.toml": one("shared", "/ws-a", "FROM BASE"),
			"zz-local.toml": one("shared", "/ws-b", "FROM LOCAL"),
		});
		const loaded = loadRules(dir);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.rules.length, 1);
		assert.equal(loaded.rules[0].text, "FROM LOCAL");
		assert.deepEqual(loaded.rules[0].paths, ["/ws-b"]);
		assert.equal(loaded.rules[0].source?.slice(dir.length + 1), "zz-local.toml");
		assert.equal(loaded.notes.length, 1);
		assert.ok(loaded.notes[0].includes('规则 "shared" 被 zz-local.toml 覆盖'));
		assert.ok(loaded.notes[0].includes("base.toml"));
	});

	it("同一文件里重名仍算问题（与跨文件的提示区分开）", () => {
		const dir = makeTree({ "index.toml": [one("dup", "/ws-a", "A"), one("dup", "/ws-b", "B")].join("\n") });
		const loaded = loadRules(dir);
		assert.deepEqual(loaded.notes, []);
		assert.equal(loaded.errors.length, 1);
		assert.deepEqual(loaded.rules.map((r) => r.text), ["B"]);
	});

	it("单个 toml 坏掉只丢它自己，其它文件的规则照常", () => {
		const dir = makeTree({
			"aa-broken.toml": "[[prompt]\nname = \n",
			"index.toml": one("good", "/ws", "GOOD"),
		});
		const loaded = loadRules(dir);
		assert.equal(loaded.found, true);
		assert.deepEqual(loaded.rules.map((r) => r.name), ["good"]);
		assert.equal(loaded.errors.length, 1);
		assert.ok(loaded.errors[0].includes("aa-broken.toml"));
	});

	it("*.local.toml 就是普通文件：不特殊对待，也不因此报错", () => {
		const dir = makeTree({
			"a.local.toml": one("only-local", "/ws", "ONLY LOCAL"),
			"index.toml": one("shared", "/ws", "SHARED"),
		});
		const loaded = loadRules(dir);
		assert.deepEqual(loaded.errors, []);
		assert.deepEqual(loaded.rules.map((r) => r.name), ["only-local", "shared"]);
		// 私有/共享只是文件名约定（由 git 管），扩展不看名字；只有私有文件也算配了规则
		assert.equal(loaded.found, true);
	});

	it("子目录里的 toml 不读（不递归）", () => {
		const dir = makeTree({
			"index.toml": one("top", "/ws", "TOP"),
			"nested/deep.toml": one("deep", "/ws", "DEEP"),
			"nested/deeper/more.toml": one("deeper", "/ws", "DEEPER"),
		});
		const loaded = loadRules(dir);
		assert.deepEqual(loaded.rules.map((r) => r.name), ["top"]);
		assert.equal(loaded.configFiles.length, 1);
	});

	it("没有 toml 只有 md / 别的文件 → 零规则，不算错误", () => {
		const dir = makeTree({ "preshell.md": "正文", "rules.txt": "x" });
		const loaded = loadRules(dir);
		assert.equal(loaded.found, false);
		assert.deepEqual(loaded.rules, []);
		assert.deepEqual(loaded.errors, []);
	});

	it("合并后的规则能一起装配（同 order 按文件名序）", async () => {
		const dir = makeTree({
			"a.toml": one("first", "/ws", "FIRST"),
			"b.toml": one("second", "/ws", "SECOND"),
		});
		assert.deepEqual(await sectionNamesFor(loadRules(dir).rules, "/ws"), ["pi:default", "repo:first", "repo:second"]);
	});
});

// ---------------------------------------------------------------------------
// 段注册与装配
// ---------------------------------------------------------------------------

describe("段注册与装配", () => {
	it("命中 → 段名 repo:<name>，内容取 md 正文（trim）", async () => {
		const dir = makeTree({ "index.toml": "", "r.md": "\n  规则正文\n\n" });
		const rules = loadRules(dir).rules;
		const rule: Rule = {
			name: "preshell",
			order: DEFAULT_ORDER,
			paths: [dir],
			rawPaths: [dir],
			file: join(dir, "r.md"),
			rawFile: "r.md",
		};
		assert.deepEqual(rules, []);
		const reg = registerForTest([rule]);
		try {
			const assembly = await assemble(ctxFor(join(dir, "sub")));
			const section = assembly.sections.find((s) => s.name === "repo:preshell");
			assert.equal(section?.text, "规则正文");
			assert.ok(renderPrompt(assembly).includes("规则正文"));
		} finally {
			reg.dispose();
		}
	});

	it("不命中 → 空段被丢掉，其它段不受影响", async () => {
		const rule: Rule = { name: "nope", order: DEFAULT_ORDER, paths: ["/somewhere/else"], rawPaths: ["/somewhere/else"], text: "不该出现" };
		const reg = registerForTest([rule]);
		try {
			const assembly = await assemble(ctxFor("/tmp/other"));
			assert.deepEqual(assembly.sections.map((s) => s.name), ["pi:default"]);
			assert.ok(!renderPrompt(assembly).includes("不该出现"));
		} finally {
			reg.dispose();
		}
	});

	it("多条命中按 order 升序拼接", async () => {
		const rules: Rule[] = [
			{ name: "late", order: 300, paths: ["/ws"], rawPaths: ["/ws"], text: "LATE" },
			{ name: "early", order: 100, paths: ["/ws"], rawPaths: ["/ws"], text: "EARLY" },
			{ name: "mid", order: 200, paths: ["/ws"], rawPaths: ["/ws"], text: "MID" },
		];
		assert.deepEqual(await sectionNamesFor(rules, "/ws/sub"), ["pi:default", "repo:early", "repo:mid", "repo:late"]);
	});

	it("同 order 保持配置顺序（稳定排序）", async () => {
		const rules: Rule[] = [
			{ name: "one", order: 200, paths: ["/ws"], rawPaths: ["/ws"], text: "1" },
			{ name: "two", order: 200, paths: ["/ws"], rawPaths: ["/ws"], text: "2" },
			{ name: "three", order: 200, paths: ["/ws"], rawPaths: ["/ws"], text: "3" },
		];
		assert.deepEqual(await sectionNamesFor(rules, "/ws"), ["pi:default", "repo:one", "repo:two", "repo:three"]);
	});

	it("一条规则的 md 读不到 → 该段空，其它规则照常注入", async () => {
		const dir = makeTree({ "ok.md": "OK RULE" });
		const rules: Rule[] = [
			{ name: "broken", order: 200, paths: [dir], rawPaths: [dir], file: join(dir, "missing.md"), rawFile: "missing.md" },
			{ name: "ok", order: 201, paths: [dir], rawPaths: [dir], file: join(dir, "ok.md"), rawFile: "ok.md" },
		];
		const reg = registerForTest(rules);
		try {
			const assembly = await assemble(ctxFor(dir));
			assert.deepEqual(assembly.sections.map((s) => s.name), ["pi:default", "repo:ok"]);
			assert.equal(renderPrompt(assembly).includes("OK RULE"), true);
		} finally {
			reg.dispose();
		}
	});

	it("index.toml 坏掉时注册零段，不影响其它扩展的段", async () => {
		const dir = makeTree({ "index.toml": "!!! not toml" });
		const loaded = loadRules(dir);
		const reg = registerForTest(loaded.rules);
		try {
			const assembly = await assemble(ctxFor(dir));
			assert.deepEqual(assembly.sections.map((s) => s.name), ["pi:default"]);
			assert.ok(loaded.errors.length > 0);
		} finally {
			reg.dispose();
		}
	});

	it("同一目录重复装配结果稳定（KV 前缀不抖）", async () => {
		const dir = makeTree({ "index.toml": "", "a.md": "AAA" });
		const rules: Rule[] = [
			{ name: "a", order: 200, paths: [dir], rawPaths: [dir], file: join(dir, "a.md"), rawFile: "a.md" },
			{ name: "b", order: 200, paths: [dir], rawPaths: [dir], text: "BBB" },
		];
		const reg = registerForTest(rules);
		try {
			const first = renderPrompt(await assemble(ctxFor(dir)));
			const second = renderPrompt(await assemble(ctxFor(dir)));
			const third = renderPrompt(await assemble(ctxFor(join(dir, "deeper"))));
			assert.equal(first, second);
			assert.equal(first, third);
			assert.ok(first.includes("AAA") && first.includes("BBB"));
		} finally {
			reg.dispose();
		}
	});

	it("重新注册（/reload 语义）会清掉上一轮的段，包括已从配置删掉的规则", async () => {
		resetRegistry();
		resetWarned();
		const a: Rule = { name: "r-a", order: 200, paths: ["/ws"], rawPaths: ["/ws"], text: "A" };
		const b: Rule = { name: "r-b", order: 201, paths: ["/ws"], rawPaths: ["/ws"], text: "B" };

		registerRuleSections([a, b]);
		assert.deepEqual(
			(await assemble(ctxFor("/ws"))).sections.map((s) => s.name),
			["pi:default", "repo:r-a", "repo:r-b"],
		);

		// 模拟 /reload：配置里 b 被删掉，重跑 factory 后旧的 repo:r-b 不能再留在注册表里
		const second = registerRuleSections([a]);
		try {
			const names = (await assemble(ctxFor("/ws"))).sections.map((s) => s.name);
			assert.deepEqual(names, ["pi:default", "repo:r-a"]);
		} finally {
			second.dispose();
		}
	});

	it("ruleText 直接调用：不命中为空串，内联不碰 fs", () => {
		const inline: Rule = { name: "i", order: 200, paths: ["/ws"], rawPaths: ["/ws"], text: "INLINE" };
		assert.equal(ruleText(inline, "/ws"), "INLINE");
		assert.equal(ruleText(inline, "/ws/deeper"), "INLINE");
		assert.equal(ruleText(inline, "/elsewhere"), "");
		assert.equal(ruleText(inline, "relative"), "");
	});
});

// ---------------------------------------------------------------------------
// md 缓存
// ---------------------------------------------------------------------------

describe("md 读取缓存", () => {
	it("文件改了重读拿到新内容，没改走缓存", () => {
		const dir = makeTree({ "f.md": "AAAA" });
		const path = join(dir, "f.md");
		clearContentCache();

		const first = readTextCached(path);
		assert.deepEqual({ ok: first.ok, text: first.text, cached: first.cached }, { ok: true, text: "AAAA", cached: undefined });

		const second = readTextCached(path);
		assert.equal(second.text, "AAAA");
		assert.equal(second.cached, true);

		writeFileSync(path, "BBBBBB");
		const third = readTextCached(path);
		assert.equal(third.text, "BBBBBB");
		assert.equal(third.cached, undefined);
	});

	it("文件不存在 → ok=false + 原因，不抛", () => {
		clearContentCache();
		const read = readTextCached(join(tmpdir(), "repo-prompts-no-such-file.md"));
		assert.equal(read.ok, false);
		assert.equal(read.text, "");
		assert.equal(read.reason, "文件不存在");
	});
});

// ---------------------------------------------------------------------------
// /repo-prompts 报告
// ---------------------------------------------------------------------------

describe("报告", () => {
	function reportFor(dir: string, cwd: string) {
		const loaded = loadRules(dir);
		const reg = registerRuleSections(loaded.rules);
		try {
			return buildReport({ dir, loaded, registered: reg.sections, cwd, enabled: true });
		} finally {
			reg.dispose();
		}
	}

	it("列出规则数 / 路径 / 命中 / 文件可读性 / 已注册段", () => {
		const dir = makeTree({
			"index.toml": ['[[prompt]]', 'name = "preshell"', `paths = ["${join(homedir(), "disk/ai_workspace/preshell")}"]`, 'file = "preshell.md"', ""].join("\n"),
			"preshell.md": "# preshell\n",
		});
		const report = reportFor(dir, join(homedir(), "disk/ai_workspace/preshell"));
		assert.ok(report.includes("规则: 1 条"));
		assert.ok(report.includes("已注册段: 1 个"));
		assert.ok(report.includes("repo:preshell"));
		assert.ok(report.includes("命中: preshell"));
		assert.ok(report.includes("读得到"));
		assert.ok(report.includes(dir));
	});

	it("未命中时写明「命中: 无」，文件读不到时标出来", () => {
		const dir = makeTree({
			"index.toml": ['[[prompt]]', 'name = "gone"', 'paths = ["/tmp/who-knows"]', 'file = "gone.md"', ""].join("\n"),
		});
		const report = reportFor(dir, "/tmp/elsewhere");
		assert.ok(report.includes("命中: 无"));
		assert.ok(report.includes("读不到"));
	});

	it("index.toml 不存在也能出报告", () => {
		const dir = join(tmpdir(), `repo-prompts-empty-${Date.now()}-${Math.random()}`);
		const loaded = loadRules(dir);
		const report = buildReport({ dir, loaded, registered: [], cwd: "/tmp", enabled: true });
		assert.ok(report.includes("规则: 0 条"));
		assert.ok(report.includes("不存在"));
	});

	it("标出每条规则来自哪个 toml，并列规则表清单", () => {
		const dir = makeTree({
			"a-team.toml": ['[[prompt]]', 'name = "team"', `paths = ["${join(homedir(), "disk/ai_workspace/team")}"]`, 'text = "TEAM RULE"', ""].join("\n"),
			"index.toml": ['[[prompt]]', 'name = "preshell"', 'paths = ["/tmp/who-knows"]', 'file = "preshell.md"', ""].join("\n"),
			"preshell.md": "# preshell\n",
		});
		const report = reportFor(dir, join(homedir(), "disk/ai_workspace/team"));
		assert.ok(report.includes("规则表: 2 个 toml"));
		assert.ok(report.includes("  a-team.toml"));
		assert.ok(report.includes("  index.toml"));
		assert.ok(report.includes("规则表: a-team.toml"));
		assert.ok(report.includes("规则表: index.toml"));
		assert.ok(report.includes("命中: team"));
	});

	it("跨文件同名覆盖在报告里进「提示」而不是「问题」", () => {
		const dir = makeTree({
			"base.toml": ['[[prompt]]', 'name = "shared"', 'paths = ["/ws-a"]', 'text = "FROM BASE"', ""].join("\n"),
			"zz.local.toml": ['[[prompt]]', 'name = "shared"', 'paths = ["/ws-b"]', 'text = "FROM LOCAL"', ""].join("\n"),
		});
		const report = reportFor(dir, "/ws-b");
		assert.ok(report.includes("规则表: zz.local.toml"));
		assert.ok(report.includes("提示:"));
		assert.ok(/覆盖（前一条来自 base\.toml）/.test(report));
		assert.ok(!report.includes("问题:"));
	});
});

// ---------------------------------------------------------------------------
// extensions.toml 的 [repo-prompts]
// ---------------------------------------------------------------------------

describe("[repo-prompts] 设置", () => {
	it("读取 enabled 与 dir（dir 支持 ~）", () => {
		const dir = makeTree({
			"extensions.toml": ['[repo-prompts]', 'enabled = true', 'dir = "~/disk/repo-prompts-store"', ""].join("\n"),
		});
		const settings = loadSettings(join(dir, "extensions.toml"));
		assert.equal(settings.enabled, true);
		assert.equal(settings.dir, join(homedir(), "disk", "repo-prompts-store"));
	});

	it("enabled = false", () => {
		const dir = makeTree({ "extensions.toml": "[repo-prompts]\nenabled = false\n" });
		assert.equal(loadSettings(join(dir, "extensions.toml")).enabled, false);
	});

	it("文件缺失 / 坏掉 / 没有该段 → 默认开启 + fallback 目录", () => {
		assert.deepEqual(loadSettings(join(tmpdir(), "no-such-extensions.toml"), "/fallback"), { enabled: true, dir: "/fallback" });
		const broken = makeTree({ "extensions.toml": "[repo-prompts\n" });
		assert.deepEqual(loadSettings(join(broken, "extensions.toml"), "/fallback"), { enabled: true, dir: "/fallback" });
		const other = makeTree({ "extensions.toml": "[loop-guard]\nenabled = true\n" });
		assert.deepEqual(loadSettings(join(other, "extensions.toml"), "/fallback"), { enabled: true, dir: "/fallback" });
	});
});

describe("注入告知：本目录真的注入了什么", () => {
	it("命中且文件可读 → 报出规则名与来源文件", () => {
		const dir = makeTree({
			"index.toml": `[[prompt]]\nname = "x"\npaths = ["/tmp"]\nfile = "x.md"\n`,
			"x.md": "正文",
		});
		assert.deepEqual(injectedRules(loadRules(dir).rules, dir, "/tmp/sub"), [{ name: "x", from: "x.md" }]);
	});

	it("cwd 不命中 → 空", () => {
		const dir = makeTree({
			"index.toml": `[[prompt]]\nname = "x"\npaths = ["/home/nobody"]\nfile = "x.md"\n`,
			"x.md": "正文",
		});
		assert.deepEqual(injectedRules(loadRules(dir).rules, dir, "/tmp/sub"), []);
	});

	it("路径命中但 md 读不到 → 不算注入（问题走告警）", () => {
		const dir = makeTree({ "index.toml": `[[prompt]]\nname = "x"\npaths = ["/tmp"]\nfile = "missing.md"\n` });
		assert.deepEqual(injectedRules(loadRules(dir).rules, dir, "/tmp/sub"), []);
	});

	it("内联规则的来源指向定义它的那份 toml", () => {
		const dir = makeTree({ "rules.toml": `[[prompt]]\nname = "y"\npaths = ["/tmp"]\ntext = "短规则"\n` });
		const hits = injectedRules(loadRules(dir).rules, dir, "/tmp/sub");
		assert.equal(hits.length, 1);
		assert.equal(hits[0].name, "y");
		assert.match(hits[0].from, /rules\.toml（内联）$/);
	});
});
