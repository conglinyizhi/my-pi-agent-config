/**
 * agent 发现与配置
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

/**
 * 将逗号分隔的工具列表字符串解析为工具数组。
 *
 * @param toolsString - 逗号分隔的工具字符串
 * @returns 解析后的工具数组；为空时返回 undefined
 */
function parseTools(toolsString: string | undefined): string[] | undefined {
  const tools = toolsString
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return tools && tools.length > 0 ? tools : undefined;
}

/**
 * 解析单个 agent 文件。
 *
 * @param filePath - agent 文件路径
 * @param source - agent 来源
 * @returns 解析后的 agent 配置；解析失败时返回 undefined
 */
function parseAgentFile(filePath: string, source: "user" | "project"): AgentConfig | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }

  const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

  if (!frontmatter.name || !frontmatter.description) {
    return undefined;
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: parseTools(frontmatter.tools),
    model: frontmatter.model,
    systemPrompt: body,
    source,
    filePath,
  };
}

/**
 * 从指定目录加载 agent 配置。
 *
 * @param dir - agent 目录路径
 * @param source - agent 来源（user 或 project）
 * @returns 解析后的 agent 配置数组
 */
function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) {
    return agents;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    const agent = parseAgentFile(filePath, source);
    if (agent) agents.push(agent);
  }

  return agents;
}

/**
 * 判断指定路径是否为目录。
 *
 * @param p - 要检查的路径
 * @returns 如果是目录则返回 true，否则返回 false
 */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 从当前工作目录向上查找最近的项目本地 agents 目录（.pi/agents）。
 *
 * @param cwd - 起始目录
 * @returns 找到的目录路径；未找到则返回 null
 */
function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * 根据作用域合并用户与项目 agents。
 *
 * @param userAgents - 用户 agents
 * @param projectAgents - 项目 agents
 * @param scope - 搜索范围
 * @returns 合并后的 agent 映射
 */
function buildAgentMap(userAgents: AgentConfig[], projectAgents: AgentConfig[], scope: AgentScope): Map<string, AgentConfig> {
  const agentMap = new Map<string, AgentConfig>();

  if (scope === "both") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  } else if (scope === "user") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
  } else {
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  }

  return agentMap;
}

/**
 * 根据作用域发现可用的 agents。
 *
 * @param cwd - 当前工作目录，用于查找项目本地 agents
 * @param scope - 搜索范围：user、project 或 both
 * @returns 发现的 agents 及项目本地 agents 目录
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = buildAgentMap(userAgents, projectAgents, scope);

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/**
 * 将 agent 列表格式化为可读文本。
 *
 * @param agents - agent 配置数组
 * @param maxItems - 最多显示的条目数
 * @returns 包含格式化文本和剩余条目数的对象
 */
export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
    remaining,
  };
}
