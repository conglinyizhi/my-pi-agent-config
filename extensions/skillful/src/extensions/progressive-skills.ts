// Portions adapted from pi-skillful 0.4.0, Copyright (c) 2026 Jose Mocito, MIT.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExternalSkills } from "../external-skills.ts";

/**
 * Walks from cwd up through all ancestor directories (no git boundary)
 * and discovers `.agents/skills/` directories that Pi's built-in discovery
 * misses because it stops at the git repo root.
 *
 * This mirrors how AGENTS.md context files are loaded from every parent
 * directory, not just within the repo boundary.
 *
 * 全局技能根 `~/.agents/skills` 不在这里登记：Pi 自己的发现已经覆盖它，
 * 重复登记只会把整根技能标成「扩展临时资源」。本文件只负责 Pi 漏掉的祖先目录。
 */
export default function progressiveSkills(pi: ExtensionAPI) {
  pi.on("resources_discover", async (event, ctx) => {
    const external = await registerExternalSkills(event.cwd, ctx.isProjectTrusted());
    if (external.newNames.length > 0) {
      ctx.ui.notify(
        `发现 ${external.newNames.length} 个新技能，已默认隐藏：${external.newNames.join(", ")}。请使用 /skillful 自行开启。`,
        "info",
      );
    }

    const gitRoot = findGitRoot(event.cwd);

    // 没有 git 仓库：没有「祖先目录」要补，Pi 自己的发现已经覆盖全局根。
    if (!gitRoot) return;

    const resolvedGitRoot = resolve(gitRoot);
    const homeAgentsSkills = resolve(homedir(), ".agents", "skills");
    const skillPaths: string[] = [];

    // Walk from git root's parent up to filesystem root.
    // Order: git-parent first (closer to cwd = higher priority via first-wins).
    let dir = dirname(resolvedGitRoot);
    while (true) {
      const agentsSkills = join(dir, ".agents", "skills");
      const resolved = resolve(agentsSkills);

      // Skip ~/.agents/skills (handled globally by Pi) and non-existent dirs.
      if (resolved !== homeAgentsSkills && existsSync(resolved)) {
        skillPaths.push(resolved);
      }

      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    if (skillPaths.length === 0) return;
    return { skillPaths };
  });
}

function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
