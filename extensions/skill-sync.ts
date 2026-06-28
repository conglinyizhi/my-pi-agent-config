/**
 * Skill 同步扩展
 *
 * 每次 session_start 时自动检查 skills/_repo/repo.toml 中记录的 skill：
 * - 单技能仓库：目录缺失则自动 git clone --depth=1
 * - 多技能聚合仓库（bundle=true）：clone 后为 link_targets 创建软链接
 * - 换机器零操作，pi 启动自动重建
 *
 * 所有网络操作均为异步后台执行，不阻塞 session 启动。
 * TUI 状态栏实时显示同步进度（N/总数），完成后自动清除。
 */

import { parse } from "smol-toml";
import {
  readFileSync,
  existsSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join, basename, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(exec);

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
const STATUS_KEY = "skill-sync";

// ---------------------------------------------------------------------------
// 配置读取
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

function loadDisabledList(): string[] {
  try {
    const raw = readFileSync(join(AGENT_DIR, "skill-states.json"), "utf8");
    const state = JSON.parse(raw) as { disabled?: string[] };
    return state.disabled ?? [];
  } catch {
    return [];
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

const CLONE_TIMEOUT = 15_000;

/** git clone（gh CLI 优先，回退 git）—— 异步，不阻塞事件循环 */
async function cloneRepoAsync(source: string, targetDir: string): Promise<void> {
  const repo = source.replace("https://github.com/", "");

  try {
    await execAsync(`gh repo clone "${repo}" "${targetDir}" -- --depth=1`, {
      timeout: CLONE_TIMEOUT,
      killSignal: "SIGKILL",
    });
    return;
  } catch {
    // gh 失败，回退 git
  }

  await execAsync(`git clone --depth=1 "${source}" "${targetDir}"`, {
    timeout: CLONE_TIMEOUT,
    killSignal: "SIGKILL",
  });
}

/** 确保相对路径软链接存在且指向正确 */
function ensureSymlink(target: string, linkPath: string): "linked" | "skipped" {
  const relativeTarget = relative(REPO_DIR, target);

  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const { readlinkSync } = require("node:fs");
      if (readlinkSync(linkPath) === relativeTarget) {
        return "skipped";
      }
      unlinkSync(linkPath);
    } else {
      return "skipped";
    }
  } catch {
    // 不存在，继续创建
  }

  symlinkSync(relativeTarget, linkPath);
  return "linked";
}

/**
 * 异步同步所有技能仓库。
 * 每完成一个条目（跳过/克隆/失败/软链接）回调 onTick 以更新进度。
 */
async function syncSkillsAsync(
  tick: () => void,
): Promise<SyncResult[]> {
  const entries = loadRepoConfig();
  if (!entries || entries.length === 0) return [];

  mkdirSync(REPO_DIR, { recursive: true });
  const results: SyncResult[] = [];

  for (const entry of entries) {
    const repoDirName = entry.source_dir || entry.name;
    const repoDir = join(REPO_DIR, repoDirName);

    // --- 多技能聚合仓库 ---
    if (entry.bundle && entry.link_targets && entry.link_targets.length > 0) {
      if (!existsSync(repoDir)) {
        try {
          await cloneRepoAsync(entry.source, repoDir);
          results.push({ name: `${entry.name} (bundle)`, action: "cloned" });
        } catch (e: any) {
          results.push({
            name: entry.name,
            action: "failed",
            error: String(e.stderr || e.message || "未知错误").slice(0, 200),
          });
          tick();
          continue;
        }
      }

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

      tick();
      continue;
    }

    // --- 单技能仓库 ---
    if (existsSync(repoDir)) {
      results.push({ name: entry.name, action: "skipped" });
      tick();
      continue;
    }

    try {
      await cloneRepoAsync(entry.source, repoDir);
      results.push({ name: entry.name, action: "cloned" });
    } catch (e: any) {
      results.push({
        name: entry.name,
        action: "failed",
        error: String(e.stderr || e.message || "未知错误").slice(0, 200),
      });
    }

    tick();
  }

  // --- 后处理：禁用列表中的技能删除软链接 ---
  const disabled = loadDisabledList();
  for (const name of disabled) {
    const linkPath = join(REPO_DIR, name);
    try {
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        unlinkSync(linkPath);
        results.push({ name, action: "linked" });
      }
    } catch {
      // 不存在，忽略
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default function skillSyncExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const entries = loadRepoConfig();
    if (!entries || entries.length === 0) return;

    // 计算需要同步的条目总数（与 syncSkillsAsync 中 tick 一一对应）
    const total = entries.length;
    if (total === 0) return;

    // --- 显示进度，后台异步执行，不阻塞 session 启动 ---
    const { ui } = ctx;
    let done = 0;

    ui.setStatus(STATUS_KEY, `skill-syncing... [${done}/${total}]`);

    const tick = () => {
      done++;
      if (done < total) {
        ui.setStatus(STATUS_KEY, `skill-syncing... [${done}/${total}]`);
      }
      // 全部 tick 完后不在此处设状态，交给 .then() / .catch() 决定最终状态
    };

    syncSkillsAsync(tick)
      .then((results) => {
        const cloned = results.filter((r) => r.action === "cloned");
        const linked = results.filter((r) => r.action === "linked");
        const failed = results.filter((r) => r.action === "failed");

        if (failed.length > 0) {
          ui.setStatus(STATUS_KEY, ui.theme.fg("error", "skill-sync: !"));
          const names = failed.map((r) => `${r.name}: ${r.error}`).join("; ");
          ui.notify(`skill-sync: ${failed.length} 个失败 — ${names}`, "error");
        } else {
          ui.setStatus(STATUS_KEY, ui.theme.fg("success", "skill-sync: ✓"));
        }

        const doneList: string[] = [];
        if (cloned.length > 0) doneList.push(`${cloned.length} 个 clone`);
        if (linked.length > 0) doneList.push(`${linked.length} 个软链接`);
        if (doneList.length > 0) {
          ui.notify(`skill-sync: ${doneList.join("，")} 已完成`, "info");
        }
      })
      .catch((err) => {
        ui.setStatus(STATUS_KEY, ui.theme.fg("error", "skill-sync: !"));
        ui.notify(
          `skill-sync: 同步异常 — ${String(err.message || err).slice(0, 200)}`,
          "error",
        );
      });
  });

  // 会话关闭时清理状态栏
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
