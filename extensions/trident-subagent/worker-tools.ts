// worker-tools.ts — worker 工具白名单
//
// 普通 worker 使用安全白名单：文件读写、bash、本地检索，以及 web_search（联网搜索）。
// MCP 的编排类工具（codemode / tool_search）不下发：worker 不需要脚本化工具面。
// 曾用的 better-edit-tools（be-* 族）已停用（mcp.json 里 enabled: false），
// 匹配留在下面：哪天再挂上 MCP 编辑工具，worker 不会静默丢掉编辑能力。
//
// 后台任务走 dsh-jobs 扩展（bash_background / job_output）：worker 起长任务后
// 不必同步空等，由主会话按 job id 收集；job_list / job_kill 不下发。
//
// 名字形态：pi 内置 mcp 扩展把 MCP 工具注册为 `mcp__<server>__<tool>`，
// 所以 be-* 族在活跃工具集里是 `mcp__<server>__be-read` 这种。
// 这里按族名匹配、不写死服务器名；写入边界照样由 guard.ts 的路径表管。
// --tools 是精确名单，不支持通配。

const DEFAULT_WORKER_TOOLS = new Set([
  "read", "write", "edit", "bash", "grep", "find", "ls", "web_search",
  "bash_background", "job_output",
]);

/** MCP 直挂的编辑工具：`mcp__<server>__be-*` */
const MCP_BE_TOOL = /^mcp__[A-Za-z0-9_-]+__be-[a-z0-9-]+$/;

export function buildSafeWorkerTools(active: string[]): string[] {
  return active
    .filter((name) => DEFAULT_WORKER_TOOLS.has(name) || MCP_BE_TOOL.test(name))
    .sort();
}
