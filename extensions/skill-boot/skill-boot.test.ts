// skill-boot.test.ts — skill-boot（skill-kit + skill-manual 合并）清单/解析/查找测试
//
// 覆盖：frontmatter 块标量解析、清单构建（vault + 自动 3 个）、findSkill 最短匹配、
// readSkillBody 剥离 frontmatter
//
// 跑法：node --experimental-strip-types extensions/skill-boot/skill-boot.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManualSkillList, findSkill, readSkillBody } from "./vault.ts";
import { parseFrontmatter } from "./frontmatter.ts";

describe("frontmatter 块标量解析", () => {
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
		const dir = mkdtempSync(join(tmpdir(), "sb-fm-"));
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
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("清单构建（skill-vault + 自动 3 个）", () => {
	it("vault 全部为手动候选；自动可见仅 3 个", () => {
		const list = buildManualSkillList();
		assert.ok(list.length >= 37, `技能总数应 >= 37，实际 ${list.length}`);
		const auto = list.filter((s) => !s.manualOnly);
		assert.deepEqual(
			auto.map((s) => s.name).sort(),
			["data-name", "git-commit", "which-pi-docs"],
			`自动可见技能应为 3 个，实际: ${auto.map((s) => s.name).join(", ")}`,
		);
		// vault 内技能可发现（第三方软链接 + clyzhi 目录）
		const names = list.map((s) => s.name);
		assert.ok(names.includes("paoding-jieniu"));
		assert.ok(names.includes("brainstorming")); // superpowers 子技能
		assert.ok(names.includes("lazycat-dev")); // clyzhi 已移入 vault
	});

	it("findSkill：精确名/大小写/最短子串/路径匹配", () => {
		const list = buildManualSkillList();
		assert.equal(findSkill(list, "git-commit")?.name, "git-commit");
		assert.equal(findSkill(list, "GIT-COMMIT")?.name, "git-commit");
		assert.equal(findSkill(list, "git")?.name, "git-commit"); // 最短子串优先
		assert.equal(findSkill(list, "不存在技能"), undefined);
	});
});
