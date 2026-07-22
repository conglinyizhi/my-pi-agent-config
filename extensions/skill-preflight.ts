/**
 * 技能预检扩展 — 每次 agent 请求前注入精简的技能唤醒规则。
 *
 * 启动时读取 ~/.pi/agent/skill-repo/repo.toml，提取所有 trigger 字段，
 * 构建紧凑预检列表注入 system prompt。
 *
 * 技能变更（新增/删除/修改 trigger）后需 /reload 使其生效。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// 极简 TOML 解析 — 只提取 [[skills]] 块中的 name + trigger
// ---------------------------------------------------------------------------
function loadTriggers(): Map<string, string> | null {
  const tomlPath = resolve(homedir(), ".pi/agent/skill-repo/repo.toml");
  let content: string;
  try {
    content = readFileSync(tomlPath, "utf-8");
  } catch {
    return null;
  }

  const triggers = new Map<string, string>();
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
    }

    if (line.startsWith("[[skills]]")) {
      currentName = "";
    }
  }

  return triggers;
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
// 入口
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  const triggers = loadTriggers();
  if (!triggers) return; // toml 不存在，不注入

  const preflightRule = buildPreflightRule(triggers);

  pi.on("before_agent_start", async (event, ctx) => {
    return { systemPrompt: event.systemPrompt + preflightRule };
  });
}
