// worker-tools.ts — worker 工具白名单
//
// 普通 worker 使用安全白名单：文件读写、bash、本地检索，以及 web_search（联网搜索）。
// MCP 工具（mcp / mcpScript）不下发：worker 不需要 MCP 工具面。--tools 是精确名单，不支持通配。

const DEFAULT_WORKER_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "web_search"]);

export function buildSafeWorkerTools(active: string[]): string[] {
  return active
    .filter((name) => DEFAULT_WORKER_TOOLS.has(name) || name.startsWith("be-"))
    .sort();
}
