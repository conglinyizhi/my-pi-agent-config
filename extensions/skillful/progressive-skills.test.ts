// progressive-skills.test.ts — 验证 Git 根目录之外的 .agents/skills 发现
//
// 全局技能根 `~/.agents/skills` 由 Pi 自己的发现覆盖，本扩展只补「祖先目录」里 Pi 漏掉的，
// 所以断言里不再包含全局根路径（2026-10-15 起全局根就是技能统一根，见 external-skills.ts）。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import progressiveSkills from "./src/extensions/progressive-skills.ts";

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
			assert.deepEqual(result, { skillPaths: [parentSkills] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("没有 Git 仓库时不注入任何路径", async () => {
		const root = mkdtempSync(join(tmpdir(), "skillful-nogit-"));
		try {
			const captured = captureHandler();
			progressiveSkills(captured.pi as never);
			assert.equal(
				await captured.get()(
					{ cwd: join(root, "src") },
					{ isProjectTrusted: () => true, ui: { notify: () => undefined } },
				),
				undefined,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
