// skill-boot.test.ts — skill-boot 来源同步兼容入口的正文处理测试
//
// skill-boot 已不再负责技能列表、启用管理或 prompt 过滤；这些职责交给 Pi / skillful。
// 本文件只覆盖手动注入仍需使用的 frontmatter 解析、查找和正文读取。
//
// 跑法：node --experimental-strip-types extensions/skill-boot/skill-boot.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSkill, readSkillBody, type ManualSkill } from "./vault.ts";
import { parseFrontmatter } from "./frontmatter.ts";

describe("frontmatter 块标量解析", () => {
	it("YAML 折叠块标量（description: >- / > / |）正确展开，不显示块标记", () => {
		const strip = parseFrontmatter("---\ndescription: >-\n  第一行\n  第二行\n---\n正文");
		assert.equal(strip.frontmatter.description, "第一行 第二行");
		assert.ok(!strip.frontmatter.description!.includes(">-"));

		const clip = parseFrontmatter("---\ndescription: >\n  内容\n---");
		assert.equal(clip.frontmatter.description, "内容\n");

		const literal = parseFrontmatter("---\ndescription: |-\n  行一\n  行二\n---");
		assert.equal(literal.frontmatter.description, "行一\n行二");

		const plain = parseFrontmatter("---\ndescription: 单行描述\n---");
		assert.equal(plain.frontmatter.description, "单行描述");
	});
});

describe("手动注入正文", () => {
	it("剥离 frontmatter 并附加技能目录", () => {
		const dir = mkdtempSync(join(tmpdir(), "sb-fm-"));
		const skillDir = join(dir, "test-skill");
		mkdirSync(skillDir);
		const md = join(skillDir, "SKILL.md");
		writeFileSync(
			md,
			"---\nname: test-skill\ndescription: 测试技能\ndisable-model-invocation: true\n---\n\n# 正文\n内容",
			"utf8",
		);

		const body = readSkillBody({ name: "test-skill", description: "", path: md });
		assert.ok(body.includes("正文"));
		assert.ok(body.includes("内容"));
		assert.ok(body.includes("test-skill"));
		assert.ok(!body.includes("disable-model-invocation"));
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("技能查找", () => {
	const list: ManualSkill[] = [
		{ name: "git-commit", description: "提交助手", path: "/vault/git-commit/SKILL.md" },
		{ name: "git-tools", description: "Git 工具", path: "/vault/git-tools/SKILL.md" },
	];

	it("支持精确名、大小写和最短子串匹配", () => {
		assert.equal(findSkill(list, "git-commit")?.name, "git-commit");
		assert.equal(findSkill(list, "GIT-COMMIT")?.name, "git-commit");
		assert.equal(findSkill(list, "git")?.name, "git-tools");
		assert.equal(findSkill(list, "不存在技能"), undefined);
	});
});
