// 技能段替换的回归：2026-10-05 那次静默失配就是栽在这个正则上
// 跑法：node --test --experimental-strip-types extensions/skillful/src/skill-prompt.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SKILLS_SECTION_PATTERN, replaceSkillsSection } from "./skill-prompt.ts";

const BODY = [
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches its description.",
	"",
	"<available_skills>",
	"  <skill>",
	"    <name>a</name>",
	"  </skill>",
	"</available_skills>",
].join("\n");

const SKILL = {
	name: "a",
	description: "demo",
	filePath: "/x/SKILL.md",
	baseDir: "/x",
	sourceInfo: {} as never,
	disableModelInvocation: false,
};

describe("技能段替换", () => {
	it("老格式（句前两个换行、无外层标签）仍然匹配，文本兜底还能用", () => {
		const prompt = `前文\n\n${BODY}\n后文`;
		assert.equal(SKILLS_SECTION_PATTERN.test(prompt), true);
		assert.ok(replaceSkillsSection(prompt, [SKILL]));
	});

	it("pi 1.0.2 的格式（<skills> 包裹、句前单换行）也必须匹配", () => {
		const prompt = `前文\n<skills>\n${BODY}\n</skills>\n后文`;
		assert.equal(
			SKILLS_SECTION_PATTERN.test(prompt),
			true,
			"格式一变就失配的话，可见性过滤会静默跳过——这条用例就是钉那次事故的",
		);
	});

	it("被过滤掉的技能不会留在替换后的提示词里", () => {
		const prompt = `前文\n<skills>\n${BODY}\n</skills>\n后文`;
		const replaced = replaceSkillsSection(prompt, []);
		assert.ok(replaced);
		assert.equal(replaced.includes("<name>a</name>"), false);
		assert.equal(replaced.includes("后文"), true, "只替换技能段，别动别的");
	});
});
