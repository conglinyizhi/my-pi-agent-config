// progressive-skills.test.ts — 验证 Git 根目录之外的 .agents/skills 发现

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import progressiveSkills from "./src/extensions/progressive-skills.ts";
import { EXTERNAL_SKILLS_DIR } from "./src/external-skills.ts";

type Handler = (event: { cwd: string }, ctx: { isProjectTrusted: () => boolean; ui: { notify: () => void } }) => Promise<{ skillPaths?: string[] } | undefined> | { skillPaths?: string[] } | undefined;

function captureHandler(): { pi: { on: (event: string, handler: Handler) => void }; get: () => Handler } {
	let handler: Handler | undefined;
	return {
		pi: {
			on(event, next) {
				assert.equal(event, "resources_discover");
				handler = next;
			},
		},
		get() {
			assert.ok(handler);
			return handler;
		},
	};
}

describe("progressive skill discovery", () => {
	it("从 Git 根目录的父级继续发现 .agents/skills", async () => {
		const root = mkdtempSync(join(tmpdir(), "skillful-root-"));
		const gitRoot = join(root, "repo");
		const parentSkills = join(root, ".agents", "skills");
		mkdirSync(join(gitRoot, ".git"), { recursive: true });
		mkdirSync(parentSkills, { recursive: true });

		try {
			const captured = captureHandler();
			progressiveSkills(captured.pi as never);
			const result = await captured.get()(
				{ cwd: join(gitRoot, "src") },
				{ isProjectTrusted: () => true, ui: { notify: () => undefined } },
			);
			assert.deepEqual(result, { skillPaths: [EXTERNAL_SKILLS_DIR, parentSkills] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("没有 Git 仓库时不重复贡献路径", async () => {
		const root = mkdtempSync(join(tmpdir(), "skillful-nogit-"));
		try {
			const captured = captureHandler();
			progressiveSkills(captured.pi as never);
			assert.deepEqual(
				await captured.get()(
					{ cwd: join(root, "src") },
					{ isProjectTrusted: () => true, ui: { notify: () => undefined } },
				),
				{ skillPaths: [EXTERNAL_SKILLS_DIR] },
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
