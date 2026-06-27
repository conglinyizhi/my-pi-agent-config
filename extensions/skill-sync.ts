/**
 * Skill 同步扩展
 *
 * 每次 session_start 时自动检查 skills/_repo/repo.toml 中记录的 skill，
 * 如果目录缺失则自动 git clone --depth=1。换机器零操作，pi 启动自动重建。
 */

import { parse } from "smol-toml";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface SkillEntry {
  name: string;
  source: string;
  subdir?: string;
  description?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

const AGENT_DIR = getAgentDir();
const REPO_DIR = join(AGENT_DIR, "skills", "_repo");
const TOML_PATH = join(REPO_DIR, "repo.toml");

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function loadRepoConfig(): SkillEntry[] | null {
  try {
    const raw = readFileSync(TOML_PATH, "utf8");
    const data = parse(raw) as { skills?: SkillEntry[] };
    return data.skills ?? [];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 同步逻辑
// ---------------------------------------------------------------------------

interface SyncResult {
  name: string;
  action: "skipped" | "cloned" | "failed";
  error?: string;
}

function syncSkills(): SyncResult[] {
  const entries = loadRepoConfig();
  if (!entries || entries.length === 0) return [];

  const results: SyncResult[] = [];

  for (const entry of entries) {
    const targetDir = join(REPO_DIR, entry.name);

    if (existsSync(targetDir)) {
      results.push({ name: entry.name, action: "skipped" });
      continue;
    }

    try {
      // 优先用 gh CLI（避免 HTTPS 限速），回退 git
      const repo = entry.source.replace("https://github.com/", "");
      try {
        execSync(`gh repo clone "${repo}" "${targetDir}" -- --depth=1`, {
          stdio: "pipe",
          timeout: 30_000,
        });
      } catch {
        execSync(`git clone --depth=1 "${entry.source}" "${targetDir}"`, {
          stdio: "pipe",
          timeout: 30_000,
        });
      }
      results.push({ name: entry.name, action: "cloned" });
    } catch (e: any) {
      results.push({
        name: entry.name,
        action: "failed",
        error: String(e.stderr || e.message).slice(0, 200),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default function skillSyncExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const results = syncSkills();

    const cloned = results.filter((r) => r.action === "cloned");
    const failed = results.filter((r) => r.action === "failed");

    if (failed.length > 0) {
      const names = failed.map((r) => `${r.name}: ${r.error}`).join(", ");
      ctx.ui.notify(`skill-sync: ${failed.length} 个 clone 失败 (${names})`, "error");
    } else if (cloned.length > 0) {
      const names = cloned.map((r) => r.name).join(", ");
      ctx.ui.notify(`skill-sync: 已自动重建 ${cloned.length} 个 skill (${names})`, "info");
    }
    // 全部 skipped → 不通知，完全无感
  });
}
