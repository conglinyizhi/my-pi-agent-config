// visibility-model.test.ts — 批量显隐与来源分组纯逻辑测试

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SkillGroupRule } from "../config.ts";
import {
	buildVisibilityRows,
	groupSkills,
	rowState,
	toggleVisibleNames,
} from "./visibility-model.ts";

function skill(name: string, source: string, scope: "user" | "project" = "user") {
	return {
		name,
		description: `${name} description`,
		sourceInfo: {
			path: `/skills/${name}/SKILL.md`,
			source,
			scope,
			origin: "top-level" as const,
			baseDir: `/skills/${name}`,
		},
	};
}

function atPath(name: string, source: string, path: string) {
	const base = skill(name, source);
	return { ...base, sourceInfo: { ...base.sourceInfo, path } };
}

// 与 extensions.toml 里的实际规则同构（id/label 可任意，这里取短名便于断言）
const MOONBIT_RULES: SkillGroupRule[] = [{
	id: "moonbit-environment",
	label: "MoonBit 开发环境",
	match: [
		"skills/external/moonbit-skills",
		"skills/external/clyzhi-moonwell-spring",
		"skills/clyzhi/moonbit-skills-guide",
	],
}];

describe("skill visibility model", () => {
	it("按 Pi 的 source 和 scope 分组，不从技能名猜包", () => {
		const groups = groupSkills([
			skill("zeta", "pkg-a"),
			skill("alpha", "pkg-a"),
			skill("beta", "pkg-b"),
			skill("local", "local", "project"),
		]);

		assert.deepEqual(groups.map((group) => group.label), [
			"local (project)",
			"pkg-a (user)",
			"pkg-b (user)",
		]);
		assert.deepEqual(groups[1]!.skills.map((item) => item.name), ["alpha", "zeta"]);
	});

	it("规则命中的外部包与本地技能合并为一组", () => {
		const groups = groupSkills([
			atPath("moonbit-agent-guide", "local", "/home/user/skills/external/moonbit-skills/skills/moonbit-agent-guide/SKILL.md"),
			atPath("clyzhi-moonwell-spring", "local", "/home/user/skills/external/clyzhi-moonwell-spring/SKILL.md"),
			atPath("moonbit-skills-guide", "auto", "/home/user/skills/clyzhi/moonbit-skills-guide/SKILL.md"),
		], MOONBIT_RULES);

		assert.deepEqual(groups.map((group) => [group.id, group.label, group.skills.map((item) => item.name)]), [
			["moonbit-environment", "MoonBit 开发环境", ["clyzhi-moonwell-spring", "moonbit-agent-guide", "moonbit-skills-guide"]],
		]);
	});

	it("没配规则时按来源和包名分组，不做任何特判", () => {
		const groups = groupSkills([
			atPath("moonbit-agent-guide", "local", "/home/user/skills/external/moonbit-skills/skills/moonbit-agent-guide/SKILL.md"),
			atPath("moonbit-skills-guide", "auto", "/home/user/skills/clyzhi/moonbit-skills-guide/SKILL.md"),
		]);

		assert.deepEqual(groups.map((group) => [group.id, group.label, group.skills.map((item) => item.name)]), [
			["auto\0user", "auto (user)", ["moonbit-skills-guide"]],
			["external:moonbit-skills", "skill 包：moonbit-skills", ["moonbit-agent-guide"]],
		]);
	});

	it("多条规则按顺序先匹配先归组", () => {
		const groups = groupSkills(
			[atPath("moonbit-orientation", "local", "/home/user/skills/external/moonbit-skills/skills/moonbit-orientation/SKILL.md")],
			[
				{ id: "broad", label: "广组", match: ["skills/external/moonbit-skills"] },
				{ id: "narrow", label: "窄组", match: ["skills/external/moonbit-skills/skills/moonbit-orientation"] },
			],
		);

		assert.deepEqual(groups.map((group) => [group.id, group.skills.map((item) => item.name)]), [
			["broad", ["moonbit-orientation"]],
		]);
	});

	it("canonical path 与规则片段的分隔符不一致也能命中", () => {
		const groups = groupSkills(
			[atPath("moonbit-orientation", "local", "C:\\Users\\me\\skills\\external\\moonbit-skills\\skills\\moonbit-orientation\\SKILL.md")],
			MOONBIT_RULES,
		);

		assert.deepEqual(groups.map((group) => group.label), ["MoonBit 开发环境"]);
	});

	it("生成全部、来源组和单项三层行", () => {
		const rows = buildVisibilityRows([
			skill("a", "pkg-a"),
			skill("b", "pkg-a"),
			skill("c", "pkg-b"),
		]);

		assert.deepEqual(rows.map((row) => [row.kind, row.label]), [
			["all", "全部技能"],
			["group", "pkg-a (user)"],
			["skill", "a"],
			["skill", "b"],
			["group", "pkg-b (user)"],
			["skill", "c"],
		]);
	});

	it("来源组部分可见时切换为全可见，再切换为全隐藏", () => {
		const names = ["a", "b", "c"];
		let hidden = new Set(["a"]);
		assert.equal(rowState(hidden, names), "partial");

		hidden = toggleVisibleNames(hidden, names);
		assert.deepEqual([...hidden], []);
		assert.equal(rowState(hidden, names), "visible");

		hidden = toggleVisibleNames(hidden, names);
		assert.deepEqual([...hidden], names);
		assert.equal(rowState(hidden, names), "hidden");
	});
});
