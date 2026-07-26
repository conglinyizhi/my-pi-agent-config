/**
 * 技能预检扩展 — 每次 agent 请求前：
 *   1. 从 system prompt 中移除 disable_model_invocation=true 的技能
 *   2. 注入精简的技能唤醒规则（trigger 表）
 *
 * 启动时读取 ~/.pi/agent/skill-repo/repo.toml。
 * 配置变更后需 /reload 使其生效。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

interface SkillConfig {
  triggers: Map<string, string>;
  disabled: Set<string>;
}

// ---------------------------------------------------------------------------
// 极简 TOML 解析 — 提取 name + trigger + disable_model_invocation
// ---------------------------------------------------------------------------
function loadSkillConfig(): SkillConfig | null {
  const tomlPath = resolve(homedir(), ".pi/agent/skill-repo/repo.toml");
  let content: string;
  try {
    content = readFileSync(tomlPath, "utf-8");
  } catch {
    return null;
  }

  const triggers = new Map<string, string>();
  const disabled = new Set<string>();
  let currentName = "";

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const nameMatch = line.match(/^name\s*=\s*"(.+)"$/);
    if (nameMatch) {
      currentName = nameMatch[1];
      continue;
    }

    const triggerMatch = line.match(/^trigger\s*=\s*"(.+)"$/);
    if (triggerMatch && currentName) {
      triggers.set(currentName, triggerMatch[1]);
      continue;
    }

    if (/^disable_model_invocation\s*=\s*true\s*$/.test(line) && currentName) {
      disabled.add(currentName);
    }

    if (line.startsWith("[[skills]]")) {
      currentName = "";
    }
  }

  return { triggers, disabled };
}

// ---------------------------------------------------------------------------
// 构建预检规则文本（纯从 toml 数据生成，不对任何技能做特殊处理）
// ---------------------------------------------------------------------------
function buildPreflightRule(triggers: Map<string, string>): string {
  const lines: string[] = [];
  for (const [name, trigger] of triggers) {
    lines.push(`| ${name} | ${trigger} |`);
  }

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

// ---------------------------------------------------------------------------
// 从 system prompt 中移除 disable_model_invocation=true 的技能
// ---------------------------------------------------------------------------
function filterDisabledSkills(prompt: string, disabled: Set<string>): string {
  if (disabled.size === 0) return prompt;
  return prompt.replace(
    /<skill>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<\/skill>/g,
    (_match, name) => (disabled.has(name.trim()) ? "" : _match)
  );
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  const config = loadSkillConfig();
  if (!config) return; // toml 不存在，不注入

  const preflightRule = buildPreflightRule(config.triggers);

  pi.on("before_agent_start", async (event, ctx) => {
    const filtered = filterDisabledSkills(event.systemPrompt, config.disabled);
    return { systemPrompt: filtered + preflightRule };
  });
}
