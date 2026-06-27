/**
 * Skill Toggle 扩展
 *
 * 注册 /skill-toggle 命令，打开 TUI 多选列表让用户开关技能。
 * 状态保存在 ~/.pi/agent/skill-states.json（不追踪），即时生效。
 */

import { parse } from "smol-toml";
import { readFileSync, writeFileSync, existsSync, lstatSync, symlinkSync, unlinkSync, mkdirSync } from "node:fs";
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
  bundle?: boolean;
  link_targets?: string[];
}

interface SkillState {
  disabled: string[];
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

const AGENT_DIR = getAgentDir();
const REPO_DIR = join(AGENT_DIR, "skills", "_repo");
const TOML_PATH = join(REPO_DIR, "repo.toml");
const STATE_PATH = join(AGENT_DIR, "skill-states.json");

// ---------------------------------------------------------------------------
// 状态读写
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 技能列表
// ---------------------------------------------------------------------------

interface SkillInfo {
  name: string;
  source: string; // "bundle:repoName" or "repo:repoName"
  enabled: boolean;
}

function collectSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const state = loadState();

  let entries: SkillEntry[] = [];
  try {
    const raw = readFileSync(TOML_PATH, "utf8");
    const data = parse(raw) as { skills?: SkillEntry[] };
    entries = data.skills ?? [];
  } catch {
    return [];
  }

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

// ---------------------------------------------------------------------------
// 软链接操作
// ---------------------------------------------------------------------------

function ensureSymlink(linkName: string): boolean {
  // 找到源路径：扫描 repo.toml 中 link_targets 对应的实际路径
  let entries: SkillEntry[] = [];
  try {
    const raw = readFileSync(TOML_PATH, "utf8");
    const data = parse(raw) as { skills?: SkillEntry[] };
    entries = data.skills ?? [];
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.bundle && entry.link_targets) {
      for (const target of entry.link_targets) {
        if (basename(target) === linkName) {
          const repoDirName = entry.source_dir || entry.name;
          const src = join(REPO_DIR, repoDirName, target);
          const linkPath = join(REPO_DIR, linkName);

          if (!existsSync(src)) return false;

          const relativeTarget = relative(REPO_DIR, src);

          // 删除旧软链接（如果存在且错误）
          try {
            const stat = lstatSync(linkPath);
            if (stat.isSymbolicLink()) {
              unlinkSync(linkPath);
            } else {
              return false; // 实体目录，不覆盖
            }
          } catch {
            // 不存在，继续
          }

          symlinkSync(relativeTarget, linkPath);
          return true;
        }
      }
    } else if (entry.name === linkName) {
      // 单技能：目录即技能，不需要软链接
      return existsSync(join(REPO_DIR, linkName));
    }
  }

  return false;
}

function removeSymlink(linkName: string): void {
  const linkPath = join(REPO_DIR, linkName);
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      unlinkSync(linkPath);
    }
  } catch {
    // 不存在，忽略
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default function skillToggleExtension(pi: ExtensionAPI): void {
  pi.registerCommand("skill-toggle", {
    description: "开启/关闭已导入的技能",
    async execute(_args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("skill-toggle 仅支持 TUI 模式", "error");
        return;
      }

      const state = loadState();
      const skills = collectSkills();
      if (skills.length === 0) {
        ctx.ui.notify("没有已导入的技能", "info");
        return;
      }

      // 构建选项列表，标记当前状态
      const options = skills.map((s, i) => ({
        value: s.name,
        label: `${s.enabled ? "●" : "○"} ${s.name}  ${s.enabled ? "" : "(已禁用)"}`,
        description: s.source,
      }));

      // 预选已启用的技能
      const selected = skills.filter((s) => s.enabled).map((s) => s.name);

      const result = await ctx.ui.select("技能开关 — 空格切换，Enter 确认", {
        options,
        multi: true,
        initial: selected,
      });

      if (result === null || result === undefined) {
        // 用户取消
        return;
      }

      // 新的禁用列表 = 全部技能 - 选中的技能
      const selectedSet = new Set(result as string[]);
      const newDisabled = skills
        .filter((s) => !selectedSet.has(s.name))
        .map((s) => s.name);

      // 找出变化：被新禁用的 和 被新启用的
      const oldDisabledSet = new Set(state.disabled);
      const toDisable = newDisabled.filter((n) => !oldDisabledSet.has(n));
      const toEnable = state.disabled.filter((n) => !new Set(newDisabled).has(n));

      // 即时生效
      for (const name of toDisable) removeSymlink(name);
      for (const name of toEnable) ensureSymlink(name);

      // 保存状态
      saveState({ disabled: newDisabled });

      const changed = toDisable.length + toEnable.length;
      if (changed > 0) {
        const parts: string[] = [];
        if (toEnable.length > 0) parts.push(`启用 ${toEnable.join(", ")}`);
        if (toDisable.length > 0) parts.push(`禁用 ${toDisable.join(", ")}`);
        ctx.ui.notify(`技能状态已更新：${parts.join("；")}`, "info");
      } else {
        ctx.ui.notify("技能状态未变化", "info");
      }
    },
  });
}
