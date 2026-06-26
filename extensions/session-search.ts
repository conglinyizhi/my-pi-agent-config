/**
 * Session Search Extension
 *
 * 注册一个 search_sessions 工具，让 LLM 可以跨所有项目和目录搜索历史 session 对话内容。
 * 用于查找之前讨论过的主题、代码片段、决策等。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 从各种 content 格式中提取纯文本 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" &&
        c !== null &&
        "type" in c &&
        c.type === "text" &&
        "text" in c,
    )
    .map((c) => c.text)
    .join(" ");
}

/** 截断文本到指定长度 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

// ---------------------------------------------------------------------------
// 搜索结果类型
// ---------------------------------------------------------------------------

interface SearchResult {
  sessionFile: string;
  cwd: string;
  timestamp: string;
  role: string;
  snippet: string;
  entryId: string;
}

// ---------------------------------------------------------------------------
// 核心搜索逻辑（工具和命令共用）
// ---------------------------------------------------------------------------

async function searchSessions(params: {
  query: string;
  limit: number;
  project?: string;
}): Promise<{ results: SearchResult[]; totalSessions: number }> {
  const { query, limit, project } = params;
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: SearchResult[] = [];

  // 获取所有 session
  const allSessions = await SessionManager.listAll();

  // 按 project 过滤
  const sessions = project
    ? allSessions.filter((s) => s.path.includes(project))
    : allSessions;

  for (const sessionInfo of sessions) {
    if (results.length >= limit) break;

    try {
      const sm = SessionManager.open(sessionInfo.path);
      const header = sm.getHeader();
      const entries = sm.getEntries();

      for (const entry of entries) {
        if (results.length >= limit) break;
        if (entry.type !== "message") continue;

        const msg = entry.message;
        const text = extractText(msg.content);
        if (!text) continue;

        const lowerText = text.toLowerCase();
        if (keywords.every((kw) => lowerText.includes(kw))) {
          results.push({
            sessionFile: sessionInfo.path,
            cwd: header?.cwd ?? "unknown",
            timestamp: entry.timestamp,
            role: msg.role,
            snippet: truncate(text, 400),
            entryId: entry.id,
          });
        }
      }
    } catch {
      // 跳过无法打开的 session（可能已被删除或格式损坏）
    }
  }

  return { results, totalSessions: sessions.length };
}

// ---------------------------------------------------------------------------
// 格式化输出
// ---------------------------------------------------------------------------

function formatResults(query: string, results: SearchResult[], totalSessions: number): string {
  if (results.length === 0) {
    return `在 ${totalSessions} 个 session 中未找到包含 "${query}" 的记录。`;
  }

  const header = `搜索 "${query}"：在 ${totalSessions} 个 session 中找到 ${results.length} 条匹配（最多显示 ${results.length} 条）:\n`;

  const body = results
    .map(
      (r, i) =>
        `### 结果 ${i + 1}
- **项目**: \`${r.cwd}\`
- **时间**: ${r.timestamp}
- **角色**: ${r.role === "user" ? "👤 用户" : r.role === "assistant" ? "🤖 助手" : r.role}
- **Session 文件**: \`${r.sessionFile}\`
\`\`\`
${r.snippet}
\`\`\``,
    )
    .join("\n\n");

  return header + "\n" + body;
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ---- 注册工具（LLM 可调用） ----
  pi.registerTool({
    name: "search_sessions",
    label: "Search Sessions",
    description:
      "跨所有项目和目录搜索历史 session 对话内容。用于查找之前讨论过的主题、代码片段、关键决策、Bug 修复等。当用户询问「我们之前讨论过 XX 吗」或需要回顾历史对话时使用。",
    promptSnippet: "Search conversation history across all session files for a keyword query",
    promptGuidelines: [
      "Use search_sessions when the user asks whether a topic was discussed previously, or needs to find context from past conversations.",
      "Provide specific keywords as the query parameter for best results.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词，多个词语用空格分隔（AND 逻辑）" }),
      limit: Type.Optional(
        Type.Number({ description: "返回结果数量上限，默认 10，最大 20", default: 10 }),
      ),
      project: Type.Optional(
        Type.String({
          description:
            "限制在特定项目目录中搜索（匹配 session 文件路径的子串）。不传则搜索所有项目。",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const limit = Math.min(params.limit ?? 10, 20);
      const { results, totalSessions } = await searchSessions({
        query: params.query,
        limit,
        project: params.project,
      });

      return {
        content: [
          {
            type: "text",
            text: formatResults(params.query, results, totalSessions),
          },
        ],
        details: {
          count: results.length,
          totalSessions,
          query: params.query,
          results: results.map((r) => ({
            sessionFile: r.sessionFile,
            cwd: r.cwd,
            timestamp: r.timestamp,
            role: r.role,
            entryId: r.entryId,
          })),
        },
      };
    },
  });

}
