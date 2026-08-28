// visibility-model.test.ts — 批量显隐与来源分组纯逻辑测试

import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

	it("把官方 MoonBit 技能和 moonwell 热修复层合并为一个开发环境组", () => {
		const groups = groupSkills([
			{
				...skill("moonbit-agent-guide", "local"),
				sourceInfo: { ...skill("moonbit-agent-guide", "local").sourceInfo, path: "/home/user/skills/external/moonbit-skills/skills/moonbit-agent-guide/SKILL.md" },
			},
			{
				...skill("clyzhi-moonwell-spring", "local"),
				sourceInfo: { ...skill("clyzhi-moonwell-spring", "local").sourceInfo, path: "/home/user/skills/external/clyzhi-moonwell-spring/SKILL.md" },
			},
		]);

		assert.deepEqual(groups.map((group) => [group.id, group.label, group.skills.map((item) => item.name)]), [
			["external:moonbit-environment", "MoonBit 开发环境", ["clyzhi-moonwell-spring", "moonbit-agent-guide"]],
		]);
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
