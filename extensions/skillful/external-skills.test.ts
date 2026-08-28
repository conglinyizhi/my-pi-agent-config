// external-skills.test.ts — 正式外部技能发现边界测试

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { scanExternalSkillNames } from "./src/external-skills.ts";

describe("external skill discovery", () => {
	it("递归发现 skill 包内新增的 SKILL.md，并在技能根停止递归", () => {
		const root = mkdtempSync(join(tmpdir(), "skillful-external-"));
		try {
			mkdirSync(join(root, "pkg-a", "skills", "alpha"), { recursive: true });
			mkdirSync(join(root, "pkg-a", "skills", "nested", "beta"), { recursive: true });
			writeFileSync(join(root, "pkg-a", "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n", "utf8");
			writeFileSync(join(root, "pkg-a", "skills", "nested", "beta", "SKILL.md"), "---\nname: beta\n---\n", "utf8");

			assert.deepEqual(scanExternalSkillNames(root), [
				"pkg-a/skills/alpha:alpha",
				"pkg-a/skills/nested/beta:beta",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
