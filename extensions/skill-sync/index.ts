/**
 * Skill 管理扩展（合并 skill-sync + skill-toggle）
 *
 * session_start: 后台异步同步仓库（clone / 软链接），状态栏实时进度
 * /skill-toggle: TUI 循环单选列表，即时开关技能
 *
 * skill-repo/  ─ 纯 clone 存放 + repo.toml
 * skills/      ─ 软链接 + 直放技能，Pi 扫描此目录
 */

import { parse } from "smol-toml";
import {
  readFileSync,
  writeFileSync,
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

// =========================================================================
// 路径常量
// =========================================================================

const AGENT_DIR = getAgentDir();
const SKILL_REPO_DIR = join(AGENT_DIR, "skill-repo");
const SKILLS_DIR = join(AGENT_DIR, "skills");
const TOML_PATH = join(SKILL_REPO_DIR, "repo.toml");
const STATE_PATH = join(AGENT_DIR, "skill-states.json");
const STATUS_KEY = "skill-sync";
const CLONE_TIMEOUT = 15_000;

// =========================================================================
// 类型
// =========================================================================

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

interface SkillState {
  disabled: string[];
}

interface SyncResult {
  name: string;
  action: "skipped" | "cloned" | "linked" | "failed";
  error?: string;
}

interface SkillInfo {
  name: string;
  source: string; // "bundle:repoName" | "repo:repoName"
  enabled: boolean;
}

// =========================================================================
// 配置读写
// =========================================================================

function loadRepoConfig(): SkillEntry[] | null {
  try {
    const raw = readFileSync(TOML_PATH, "utf8");
    const data = parse(raw) as { skills?: SkillEntry[] };
    return data.skills ?? [];
  } catch {
    return null;
  }
}

function loadState(): SkillState {
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { disabled: [] };
  }
}

function saveState(state: SkillState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function loadDisabledList(): string[] {
  return loadState().disabled;
}

// =========================================================================
// git clone（异步）
// =========================================================================

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

// =========================================================================
// 软链接（sync 用：已知源路径 → 在 skills/ 创建相对软链接）
// =========================================================================

function linkSkill(linkName: string, srcAbs: string): "linked" | "skipped" {
  const linkPath = join(SKILLS_DIR, linkName);
  const relativeTarget = relative(SKILLS_DIR, srcAbs);

  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const { readlinkSync } = require("node:fs");
      if (readlinkSync(linkPath) === relativeTarget) return "skipped";
      unlinkSync(linkPath);
    } else {
      return "skipped"; // 实体目录，不覆盖
    }
  } catch {
    // 不存在，继续
  }

  symlinkSync(relativeTarget, linkPath);
  return "linked";
}

// =========================================================================
// 后台同步（session_start 触发）
// =========================================================================

async function syncSkillsAsync(tick: () => void): Promise<SyncResult[]> {
  const entries = loadRepoConfig();
  if (!entries || entries.length === 0) return [];

  mkdirSync(SKILL_REPO_DIR, { recursive: true });
  mkdirSync(SKILLS_DIR, { recursive: true });
  const results: SyncResult[] = [];

  for (const entry of entries) {
    const repoDirName = entry.source_dir || entry.name;
    const repoDir = join(SKILL_REPO_DIR, repoDirName);

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

        if (!existsSync(src)) {
          results.push({
            name: `${entry.name}/${linkName}`,
            action: "failed",
            error: `源路径不存在: ${target}`,
          });
          continue;
        }

        const action = linkSkill(linkName, src);
        if (action === "linked") {
          results.push({ name: `${entry.name}/${linkName}`, action: "linked" });
        }
      }

      tick();
      continue;
    }

    // --- 单技能仓库 ---
    if (existsSync(repoDir)) {
      // 确保 skills/ 下有软链接
      const linkPath = join(SKILLS_DIR, entry.name);
      if (!existsSync(linkPath)) {
        linkSkill(entry.name, repoDir);
        results.push({ name: entry.name, action: "linked" });
      } else {
        results.push({ name: entry.name, action: "skipped" });
      }
      tick();
      continue;
    }

    try {
      await cloneRepoAsync(entry.source, repoDir);
      linkSkill(entry.name, repoDir);
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

  // 禁用列表清理
  const disabled = loadDisabledList();
  for (const name of disabled) {
    const linkPath = join(SKILLS_DIR, name);
    try {
      if (lstatSync(linkPath).isSymbolicLink()) {
        unlinkSync(linkPath);
        results.push({ name, action: "linked" });
      }
    } catch {
      // 不存在
    }
  }

  return results;
}

// =========================================================================
// 软链接（toggle 用：按技能名查找源路径）
// =========================================================================

function toggleEnsureSymlink(linkName: string): boolean {
  const entries = loadRepoConfig();
  if (!entries) return false;

  for (const entry of entries) {
    if (entry.bundle && entry.link_targets) {
      for (const target of entry.link_targets) {
        if (basename(target) === linkName) {
          const repoDirName = entry.source_dir || entry.name;
          const src = join(SKILL_REPO_DIR, repoDirName, target);
          if (!existsSync(src)) return false;
          linkSkill(linkName, src);
          return true;
        }
      }
    } else if (entry.name === linkName) {
      // 单技能：确保 skills/ 下有软链接
      const src = join(SKILL_REPO_DIR, linkName);
      if (!existsSync(src)) return false;
      linkSkill(linkName, src);
      return true;
    }
  }

  return false;
}

function toggleRemoveSymlink(linkName: string): void {
  const linkPath = join(SKILLS_DIR, linkName);
  try {
    if (lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath);
  } catch {
    // 不存在
  }
}

// =========================================================================
// 技能列表（toggle 用）
// =========================================================================

function collectSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const state = loadState();

  const entries = loadRepoConfig();
  if (!entries) return [];

  for (const entry of entries) {
    if (entry.bundle && entry.link_targets && entry.link_targets.length > 0) {
      for (const target of entry.link_targets) {
        const skillName = basename(target);
        skills.push({
          name: skillName,
          source: `bundle:${entry.name}`,
          enabled: !state.disabled.includes(skillName),
        });
      }
    } else {
      skills.push({
        name: entry.name,
        source: `repo:${entry.name}`,
        enabled: !state.disabled.includes(entry.name),
      });
    }
  }

  return skills;
}

// =========================================================================
// 入口
// =========================================================================

export default function skillSyncExtension(pi: ExtensionAPI): void {
  // ---- session_start: 后台同步 ----
  pi.on("session_start", (_event, ctx) => {
    const entries = loadRepoConfig();
    if (!entries || entries.length === 0) return;

    const total = entries.length;
    const { ui } = ctx;
    let done = 0;

    ui.setStatus(STATUS_KEY, `skill-syncing... [${done}/${total}]`);

    const tick = () => {
      done++;
      if (done < total) {
        ui.setStatus(STATUS_KEY, `skill-syncing... [${done}/${total}]`);
      }
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

  // ---- session_shutdown: 清理状态栏 ----
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // ---- /skill-toggle 命令 ----
  pi.registerCommand("skill-manager", {
    description: "管理已导入的技能（开启/关闭）",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("skill-toggle 仅支持 TUI 模式", "error");
        return;
      }

      const toggled = new Set<string>();

      while (true) {
        const skills = collectSkills();
        if (skills.length === 0) {
          ctx.ui.notify("没有已导入的技能", "info");
          return;
        }

        interface LabelEntry {
          label: string;
          type: "group" | "leaf";
          skillNames: string[];
        }

        const labelEntries: LabelEntry[] = [];
        const seenGroups = new Set<string>();

        for (const skill of skills) {
          if (skill.source.startsWith("bundle:")) {
            const groupName = skill.source.slice(7);
            if (!seenGroups.has(groupName)) {
              seenGroups.add(groupName);
              const groupSkills = skills.filter(
                (s) => s.source === skill.source,
              );
              const enabled = groupSkills.filter((s) => s.enabled).length;
              const total = groupSkills.length;
              let status: string;
              if (enabled === total) status = "全部启用";
              else if (enabled === 0) status = "全部禁用";
              else status = `已启用 ${enabled}/${total}`;

              labelEntries.push({
                label: `▸ ${groupName}（${status}）`,
                type: "group",
                skillNames: groupSkills.map((s) => s.name),
              });
            }
            labelEntries.push({
              label: `  ${skill.enabled ? "●" : "○"} ${skill.name}  ${skill.enabled ? "" : "(已禁用)"}`,
              type: "leaf",
              skillNames: [skill.name],
            });
          } else {
            labelEntries.push({
              label: `${skill.enabled ? "●" : "○"} ${skill.name}  ${skill.enabled ? "" : "(已禁用)"}`,
              type: "leaf",
              skillNames: [skill.name],
            });
          }
        }

        const choice = await ctx.ui.select(
          "技能开关 — 选中翻转，Esc 退出",
          labelEntries.map((e) => e.label),
        );

        if (choice === undefined) break;

        const hit = labelEntries.find((e) => e.label === choice);
        if (!hit) continue;

        const state = loadState();

        if (hit.type === "group") {
          const allEnabled = hit.skillNames.every(
            (n) => !state.disabled.includes(n),
          );
          for (const name of hit.skillNames) {
            if (allEnabled) {
              if (!state.disabled.includes(name)) {
                state.disabled.push(name);
                toggleRemoveSymlink(name);
                toggled.add(name);
              }
            } else {
              state.disabled = state.disabled.filter((n) => n !== name);
              toggleEnsureSymlink(name);
              toggled.add(name);
            }
          }
          saveState(state);
          ctx.ui.notify(
            `已${allEnabled ? "禁用" : "启用"} ${hit.skillNames.length} 个技能`,
            "info",
          );
        } else {
          const name = hit.skillNames[0];
          const wasDisabled = state.disabled.includes(name);
          if (wasDisabled) {
            state.disabled = state.disabled.filter((n) => n !== name);
            toggleEnsureSymlink(name);
          } else {
            state.disabled.push(name);
            toggleRemoveSymlink(name);
          }
          saveState(state);
          toggled.add(name);
          ctx.ui.notify(
            `已${wasDisabled ? "启用" : "禁用"} ${name}`,
            "info",
          );
        }
      }

      if (toggled.size > 0) {
        ctx.ui.notify(
          `共切换 ${toggled.size} 个技能：${[...toggled].join(", ")}`,
          "info",
        );
      }
    },
  });
}
