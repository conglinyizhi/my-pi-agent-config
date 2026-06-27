/**
 * Skill 同步扩展
 *
 * 每次 session_start 时自动检查 skills/_repo/repo.toml 中记录的 skill：
 * - 单技能仓库：目录缺失则自动 git clone --depth=1
 * - 多技能聚合仓库（bundle=true）：clone 后为 link_targets 创建软链接
 * - 换机器零操作，pi 启动自动重建
 */

import { parse } from "smol-toml";
import { readFileSync, existsSync, lstatSync, symlinkSync, unlinkSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface SkillEntry {
  name: string;
  source: string;
  source_dir?: string;
  description?: string;
  tags?: string[];
  aliases?: string[];
  bundle?: boolean;
  link_targets?: string[];
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
  action: "skipped" | "cloned" | "linked" | "failed";
  error?: string;
}

/** git clone（gh CLI 优先，回退 git） */
function cloneRepo(source: string, targetDir: string): void {
  const repo = source.replace("https://github.com/", "");
  try {
    execSync(`gh repo clone "${repo}" "${targetDir}" -- --depth=1`, {
      stdio: "pipe", timeout: 30_000,
    });
  } catch {
    execSync(`git clone --depth=1 "${source}" "${targetDir}"`, {
      stdio: "pipe", timeout: 30_000,
    });
  }
}

/** 确保相对路径软链接存在且指向正确 */
function ensureSymlink(target: string, linkPath: string): "linked" | "skipped" {
  const relativeTarget = relative(REPO_DIR, target);

  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      // 软链接已存在，检查是否指向正确目标
      const { readlinkSync } = require("node:fs");
      if (readlinkSync(linkPath) === relativeTarget) {
        return "skipped";
      }
      // 指向错误，删掉重建
      unlinkSync(linkPath);
    } else {
      // 实体目录，不覆盖
      return "skipped";
    }
  } catch {
    // 不存在，继续创建
  }

  symlinkSync(relativeTarget, linkPath);
  return "linked";
}

function syncSkills(): SyncResult[] {
  const entries = loadRepoConfig();
  if (!entries || entries.length === 0) return [];

  mkdirSync(REPO_DIR, { recursive: true });
  const results: SyncResult[] = [];

  for (const entry of entries) {
    // source_dir 覆写仓库目录名，默认等于 name
    const repoDirName = entry.source_dir || entry.name;
    const repoDir = join(REPO_DIR, repoDirName);

    // --- 若是多技能聚合仓库 ---
    if (entry.bundle && entry.link_targets && entry.link_targets.length > 0) {
      // 1) 确保仓库 clone 存在
      if (!existsSync(repoDir)) {
        try {
          cloneRepo(entry.source, repoDir);
          results.push({ name: `${entry.name} (bundle)`, action: "cloned" });
        } catch (e: any) {
          results.push({
            name: entry.name,
            action: "failed",
            error: String(e.stderr || e.message).slice(0, 200),
          });
          continue;
        }
      }

      // 2) 为每个 link_target 创建软链接
      for (const target of entry.link_targets) {
        const src = join(repoDir, target);
        const linkName = basename(target);
        const linkPath = join(REPO_DIR, linkName);

        if (!existsSync(src)) {
          results.push({
            name: `${entry.name}/${linkName}`,
            action: "failed",
            error: `源路径不存在: ${target}`,
          });
          continue;
        }

        const action = ensureSymlink(src, linkPath);
        if (action === "linked") {
          results.push({ name: `${entry.name}/${linkName}`, action: "linked" });
        }
      }
      continue;
    }

    // --- 单技能仓库 ---
    if (existsSync(repoDir)) {
      results.push({ name: entry.name, action: "skipped" });
      continue;
    }

    try {
      cloneRepo(entry.source, repoDir);
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
    const linked = results.filter((r) => r.action === "linked");
    const failed = results.filter((r) => r.action === "failed");

    if (failed.length > 0) {
      const names = failed.map((r) => `${r.name}: ${r.error}`).join(", ");
      ctx.ui.notify(`skill-sync: ${failed.length} 个失败 (${names})`, "error");
    }

    const done: string[] = [];
    if (cloned.length > 0) done.push(`${cloned.length} 个 clone`);
    if (linked.length > 0) done.push(`${linked.length} 个软链接`);
    if (done.length > 0) {
      ctx.ui.notify(`skill-sync: ${done.join("，")} 已自动修复`, "info");
    }
    // 全部 skipped → 不通知，完全无感
  });
}
