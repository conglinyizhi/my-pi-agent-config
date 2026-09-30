/**
 * 字符串工具函数
 */

// ---------------------------------------------------------------------------
// 逗号列表解析
// ---------------------------------------------------------------------------

/**
 * 按逗号拆分字符串并清理空白。
 *
 * 适用于解析配置中的逗号分隔列表（如工具列表、模型 ID 列表）。
 *
 * @param s - 逗号分隔的字符串（如 "read, bash, edit"）
 * @returns 清理后的字符串数组，过滤空值
 */
export function parseCommaList(s: string | undefined): string[] {
  return s
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean) ?? [];
}

// ---------------------------------------------------------------------------
// MCP 工具名
// ---------------------------------------------------------------------------

/** 官方 MCP 工具名形如 `mcp__<server>__<tool>`（pi 0.99.1 起的内置 mcp 扩展） */
const MCP_TOOL_PREFIX = /^mcp__[A-Za-z0-9_-]+__/;

/**
 * 剥掉 MCP 命名前缀，取工具原名：`mcp__better-edit-tools__be-read` → `be-read`。
 *
 * 非 MCP 工具名原样返回，所以按原名建的判定表（读写工具、副作用启发式）
 * 对内置工具与 MCP 直挂工具是同一张表。
 */
export function bareMcpToolName(name: string): string {
  return name.replace(MCP_TOOL_PREFIX, "");
}
