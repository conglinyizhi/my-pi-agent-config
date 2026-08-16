// skill-manual.test.ts — skill-manual 清单/解析/查找测试
//
// 覆盖：frontmatter 解析、递归扫描、bundle 子技能展开（manualOnly 判定）、
// findSkill 匹配、readSkillBody 剥离 frontmatter
//
// 跑法：node --experimental-strip-types extensions/skill-manual/skill-manual.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManualSkillList, findSkill, parseFrontmatter, readSkillBody } from "./index.ts";

describe("frontmatter 解析（间接经 readSkillBody）", () => {
	it("YAML 折叠块标量（description: >- / > / |）正确展开，不显示块标记", () => {
		// >- strip：换行折叠为空格，无尾随换行
		const strip = parseFrontmatter("---\ndescription: >-\n  第一行\n  第二行\n---\n正文");
		assert.equal(strip.frontmatter.description, "第一行 第二行");
		assert.ok(!strip.frontmatter.description!.includes(">-"));
		// > clip：折叠，保留单个尾换行
		const clip = parseFrontmatter("---\ndescription: >\n  内容\n---");
		assert.equal(clip.frontmatter.description, "内容\n");
		// | 字面：保留换行
		const literal = parseFrontmatter("---\ndescription: |-\n  行一\n  行二\n---");
		assert.equal(literal.frontmatter.description, "行一\n行二");
		// 单行值不受影响
		const plain = parseFrontmatter("---\ndescription: 单行描述\n---");
		assert.equal(plain.frontmatter.description, "单行描述");
	});

	it("readSkillBody 剥离 frontmatter 并附加说明头", () => {
		const dir = mkdtempSync(join(tmpdir(), "sm-fm-"));
		const skillDir = join(dir, "test-skill");
		mkdirSync(skillDir);
		const md = join(skillDir, "SKILL.md");
		writeFileSync(
			md,
			"---\nname: test-skill\ndescription: 测试技能\ndisable-model-invocation: true\n---\n\n# 正文\n内容",
			"utf8",
		);
		const body = readSkillBody({ name: "test-skill", description: "", path: md, manualOnly: true });
		assert.ok(body.includes("正文"));
		assert.ok(body.includes("内容"));
		assert.ok(!body.includes("disable-model-invocation"));
		assert.ok(body.includes("[手动注入 skill: test-skill]"));
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("清单构建", () => {
	it("当前仓库：全部技能为手动注入候选（无自动可见）", () => {
		const list = buildManualSkillList();
		assert.ok(list.length >= 30, `技能总数应 >= 30，实际 ${list.length}`);
		const auto = list.filter((s) => !s.manualOnly);
		assert.equal(auto.length, 0, `不应有自动可见技能，实际: ${auto.map((s) => s.name).join(", ")}`);
		// 关键技能在清单里
		const names = list.map((s) => s.name);
		assert.ok(names.includes("git-commit"));
		assert.ok(names.includes("data-name"));
		assert.ok(names.includes("moonbit-agent-guide"));
		assert.ok(names.includes("brainstorming")); // superpowers 子技能
	});

	it("findSkill：精确名/子串/路径匹配", () => {
		const list = buildManualSkillList();
		assert.equal(findSkill(list, "git-commit")?.name, "git-commit");
		assert.equal(findSkill(list, "GIT-COMMIT")?.name, "git-commit"); // 大小写
		assert.equal(findSkill(list, "git")?.name, "git-commit"); // 子串
		assert.equal(findSkill(list, "不存在技能"), undefined);
	});
});
