/**
 * skill-kit — 技能管理一体化扩展
 *
 * 合并自：skill-sync + skill-preflight + system-prompt-filter
 *
 * 功能：
 *   1. session_start 后台同步（clone + 软链接）
 *   2. /skill-manager 命令（TUI 技能开关）
 *   3. before_agent_start 系统提示词处理（占位符、日期、pi-self）
 *   4. before_agent_start 技能预检（过滤禁用 + 注入 trigger 表）
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
  readlinkSync,
  readdirSync,
  rmSync,
  renameSync,
} from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join, basename, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  getDocsPath,
  getExamplesPath,
  getReadmePath,
} from "@earendil-works/pi-coding-agent";


const execAsync = promisify(exec);

// =========================================================================
// 路径常量
// =========================================================================

const AGENT_DIR = getAgentDir();
const SKILL_REPO_DIR = join(AGENT_DIR, "skill-repo");
const SKILLS_DIR = join(AGENT_DIR, "skills");
const TOML_PATH = join(SKILL_REPO_DIR, "repo.toml");
const STATE_PATH = join(AGENT_DIR, "skill-states.json");
const STATUS_KEY = "skill-kit";
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
  trigger?: string;
  disable_model_invocation?: boolean;
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
  source: string;
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
// 软链接
// =========================================================================

function linkSkill(linkName: string, srcAbs: string): "linked" | "skipped" {
  const linkPath = join(SKILLS_DIR, linkName);
  const relativeTarget = relative(SKILLS_DIR, srcAbs);

  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      if (readlinkSync(linkPath) === relativeTarget) return "skipped";
      unlinkSync(linkPath);
    } else {
      return "skipped";
    }
  } catch {
    // 不存在
  }

  symlinkSync(relativeTarget, linkPath);
  return "linked";
}

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
// 冲突解决：清理 skills/_repo/ 旧架构残留
// =========================================================================

function resolveCollisions(entries: SkillEntry[]): SyncResult[] {
  const results: SyncResult[] = [];

  const knownSkills = new Set<string>();
  for (const entry of entries) {
    if (entry.bundle && entry.link_targets) {
      for (const target of entry.link_targets) {
        knownSkills.add(basename(target));
      }
    } else {
      knownSkills.add(entry.name);
    }
  }

  const oldRepoDir = join(SKILLS_DIR, "_repo");
  let oldEntries: string[];
  try {
    oldEntries = readdirSync(oldRepoDir);
  } catch {
    return results;
  }

  for (const name of oldEntries) {
    if (!knownSkills.has(name)) continue;

    const oldPath = join(oldRepoDir, name);
    let oldStat;
    try {
      oldStat = lstatSync(oldPath);
    } catch {
      continue;
    }
    if (!oldStat.isDirectory()) continue;

    const skillRepoSrc = join(SKILL_REPO_DIR, name);
    const skillLinkPath = join(SKILLS_DIR, name);

    // 情况 1：skills/<name> 已是软链接 → 直接删 _repo 残留
    try {
      const linkStat = lstatSync(skillLinkPath);
      if (linkStat.isSymbolicLink()) {
        rmSync(oldPath, { recursive: true, force: true });
        results.push({ name, action: "linked" });
        continue;
      }
    } catch {
      // 不存在，走情况 2
    }

    // 情况 2：迁移 _repo 内容到 skill-repo，再建软链接
    try {
      if (!existsSync(skillRepoSrc)) {
        mkdirSync(SKILL_REPO_DIR, { recursive: true });
        renameSync(oldPath, skillRepoSrc);
        linkSkill(name, skillRepoSrc);
        results.push({ name, action: "linked" });
      } else {
        rmSync(oldPath, { recursive: true, force: true });
        linkSkill(name, skillRepoSrc);
        results.push({ name, action: "linked" });
      }
    } catch (e: any) {
      results.push({
        name,
        action: "failed",
        error: `_repo 清理失败: ${String(e.message || e).slice(0, 100)}`,
      });
    }
  }

  return results;
}

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
// 后台同步
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

    // --- bundle ---
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

  // 冲突解决
  const collisionResults = resolveCollisions(entries);
  for (const r of collisionResults) results.push(r);

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
// 技能预检（原 skill-preflight）
// =========================================================================

function buildPreflightRule(entries: SkillEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.trigger) {
      lines.push(`| ${entry.name} | ${entry.trigger} |`);
    }
  }
  if (lines.length === 0) return "";

  return `

---

## ⚠️ 技能预检

处理每个请求前，先扫描 <available_skills>，用**语义理解**判断当前请求是否匹配以下场景。命中即用 read 加载对应 SKILL.md，模糊时宁可多读。

| 技能 | 触发场景 |
|------|---------|
${lines.join("\n")}

命中但未加载 SKILL.md 就作答 → 违规。
`;
}

function filterDisabledSkills(prompt: string, disabled: Set<string>): string {
  if (disabled.size === 0) return prompt;
  return prompt.replace(
    /<skill>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<\/skill>/g,
    (_match, name) => (disabled.has(name.trim()) ? "" : _match),
  );
}

// =========================================================================
// pi-self.md
// =========================================================================

function getSelfPromptPath(): string {
  return `${AGENT_DIR}/extensions/skill-kit/pi-self.md`;
}

// =========================================================================
// 入口
// =========================================================================

export default function skillKitExtension(pi: ExtensionAPI): void {
  // ---- session_start: 后台同步 ----
  pi.on("session_start", (_event, ctx) => {
    const config = loadRepoConfig();
    if (!config || config.length === 0) return;

    const total = config.length;
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
          ui.setStatus(STATUS_KEY, ui.theme.fg("error", "skill-kit: !"));
          const names = failed.map((r) => `${r.name}: ${r.error}`).join("; ");
          ui.notify(`skill-kit: ${failed.length} 个失败 — ${names}`, "error");
        } else {
          ui.setStatus(STATUS_KEY, ui.theme.fg("success", "skill-kit: ✓"));
        }

        const doneList: string[] = [];
        if (cloned.length > 0) doneList.push(`${cloned.length} 个 clone`);
        if (linked.length > 0) doneList.push(`${linked.length} 个软链接`);
        if (doneList.length > 0) {
          ui.notify(`skill-kit: ${doneList.join("，")} 已完成`, "info");
        }
      })
      .catch((err) => {
        ui.setStatus(STATUS_KEY, ui.theme.fg("error", "skill-kit: !"));
        ui.notify(
          `skill-kit: 同步异常 — ${String(err.message || err).slice(0, 200)}`,
          "error",
        );
      });
  });

  // ---- session_shutdown: 清理状态栏 ----
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // ---- before_agent_start: 提示词处理 + 技能预检 ----
  pi.on("before_agent_start", async (event, ctx) => {
    let prompt = event.systemPrompt;

    // 1. 占位符替换
    prompt = prompt.replaceAll("{{PI_README_PATH}}", getReadmePath());
    prompt = prompt.replaceAll("{{PI_DOCS_PATH}}", getDocsPath());
    prompt = prompt.replaceAll("{{PI_EXAMPLES_PATH}}", getExamplesPath());

    // 2. 去掉自动追加的日期
    prompt = prompt.replace(/\nCurrent date: \d{4}-\d{2}-\d{2}/, "");

    // 3. pi 自身配置目录上下文
    if (ctx.cwd === AGENT_DIR) {
      try {
        const selfPrompt = readFileSync(getSelfPromptPath(), "utf8");
        prompt += `\n\n${selfPrompt}`;
      } catch {
        /* 文件不存在 */
      }
    }

    // 4. 过滤 disable_model_invocation=true 的技能
    const latestEntries = loadRepoConfig();
    if (latestEntries) {
      const disabled = new Set<string>();
      for (const e of latestEntries) {
        if (e.disable_model_invocation) {
          disabled.add(e.name);
          // bundle：子技能（link_targets 的 basename）一并禁用
          for (const target of e.link_targets ?? []) {
            disabled.add(target.split("/").pop() ?? target);
          }
        }
      }
      for (const name of loadDisabledList()) disabled.add(name);
      prompt = filterDisabledSkills(prompt, disabled);
    }

    return { systemPrompt: prompt };
  });

  // ---- /skill-manager 命令 ----
  pi.registerCommand("skill-manager", {
    description: "管理已导入的技能（开启/关闭）",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("skill-manager 仅支持 TUI 模式", "error");
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
          ctx.ui.notify(`已${wasDisabled ? "启用" : "禁用"} ${name}`, "info");
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
