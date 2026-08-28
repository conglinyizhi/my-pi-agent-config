// skillful.test.ts — 本地迁移核心的纯逻辑测试
//
// 覆盖技能名称规范化、frontmatter 剥离、显式技能块构造和技能提示词替换。
// UI、网络和安装遥测不在测试范围内。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	normalizeSkillName,
	normalizeSkillNames,
} from "./src/config.ts";
import {
	readSkillBlock,
	sourceInfoToSkill,
	stripFrontmatter,
} from "./src/skills.ts";
import { replaceSkillsSection } from "./src/skill-prompt.ts";

describe("skillful 配置纯逻辑", () => {
	it("规范化 skill 名称并去重排序", () => {
		assert.equal(normalizeSkillName(" skill:Code-Review "), "Code-Review");
		assert.deepEqual(
			normalizeSkillNames(["git", "skill:git", "review", "git"]),
			["git", "review"],
		);
	});
});

describe("技能正文处理", () => {
	it("剥离 frontmatter", () => {
		assert.equal(
			stripFrontmatter("---\nname: demo\n---\n\n# Body\ncontent"),
			"\n# Body\ncontent",
		);
		assert.equal(stripFrontmatter("# No frontmatter"), "# No frontmatter");
	});

	it("从 sourceInfo 构造显式技能信息", () => {
		const skill = sourceInfoToSkill({
			name: "skill:demo",
			sourceInfo: { path: "/tmp/demo/SKILL.md", baseDir: "/tmp/demo" },
		});
		assert.deepEqual(skill, {
			name: "demo",
			path: "/tmp/demo/SKILL.md",
			baseDir: "/tmp/demo",
		});
		assert.equal(sourceInfoToSkill({ name: "other", sourceInfo: { path: "/tmp/x" } }), null);
	});
});

describe("技能提示词替换", () => {
	it("只替换 Pi 的 skills 区块", () => {
		const prompt = [
			"base",
			"",
			"The following skills provide specialized instructions for specific tasks.",
			"",
			"<available_skills>",
			"<skill><name>old</name></skill>",
			"</available_skills>",
		].join("\n");
		const result = replaceSkillsSection(prompt, [{
			name: "skill:new",
			description: "new skill",
			filePath: "/tmp/new/SKILL.md",
			baseDir: "/tmp/new",
			disableModelInvocation: false,
			sourceInfo: {
				origin: "top-level",
				source: "test",
				scope: "user",
				path: "/tmp/new/SKILL.md",
				baseDir: "/tmp/new",
			},
		}]);
		assert.ok(result);
		assert.ok(result!.includes("new skill"));
		assert.ok(!result!.includes("old"));
	});
});

void readSkillBlock;
