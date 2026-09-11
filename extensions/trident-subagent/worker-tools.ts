// worker-tools.ts — worker 工具白名单
//
// 普通 worker 使用安全白名单：只放文件读写、bash 与本地检索工具，
// 排除 web_search/mcp 等可绕过 bash 网络墙的工具。--tools 是精确名单，不支持通配。

const DEFAULT_WORKER_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

export function buildSafeWorkerTools(active: string[]): string[] {
  return active
    .filter((name) => DEFAULT_WORKER_TOOLS.has(name) || name.startsWith("be-"))
    .sort();
}
