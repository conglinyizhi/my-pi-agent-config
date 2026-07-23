// 跨 workdir 浏览 / 筛选历史 session，按最后活动时间排序，可选 resume
//
// 用法：
//   /sessions                  交互选择（默认 All，显示绝对时间 + cwd）
//   /sessions 10               只看最近 10 条
//   /sessions shin             过滤 cwd / 名称 / 首条消息
//   /sessions list             纯文本列表（不切换）
//   /sessions list 20 shin     文本 + 条数 + 过滤
//
// 也注册 list_sessions 工具，方便 LLM 在对话里直接列最近 session。

import type { ExtensionAPI, ExtensionCommandContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  getSelectListTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

function shortenPath(path: string): string {
  if (!path) return "(unknown cwd)";
  const home = homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

/** 相对时间：3m / 2h / 1d … */
function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return "future";
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** 本地绝对时间：07-15 21:56 */
function formatAbsolute(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function sessionTitle(s: SessionInfo): string {
  if (s.name?.trim()) return s.name.trim();
  return oneLine(s.firstMessage || "(no messages)", 60);
}

function sessionDescription(s: SessionInfo): string {
  const abs = formatAbsolute(s.modified);
  const rel = formatRelative(s.modified);
  const cwd = shortenPath(s.cwd || "");
  return `${abs} (${rel}) · ${cwd} · ${s.messageCount} msgs`;
}

// ---------------------------------------------------------------------------
// 参数 / 加载
// ---------------------------------------------------------------------------

function parseArgs(raw: string): {
  listOnly: boolean;
  limit?: number;
  filter?: string;
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let listOnly = false;
  let limit: number | undefined;
  const filterParts: string[] = [];

  for (const t of tokens) {
    if (t === "list" || t === "--list" || t === "-l") {
      listOnly = true;
      continue;
    }
    if (/^\d+$/.test(t)) {
      limit = Number(t);
      continue;
    }
    filterParts.push(t);
  }

  return {
    listOnly,
    limit,
    filter: filterParts.length ? filterParts.join(" ") : undefined,
  };
}

function matchSession(s: SessionInfo, filter?: string): boolean {
  if (!filter) return true;
  const hay = [
    s.cwd,
    s.name ?? "",
    s.firstMessage,
    s.path,
    s.id,
    s.allMessagesText,
  ]
    .join("\n")
    .toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((kw) => hay.includes(kw));
}

async function loadSessions(filter?: string, limit?: number): Promise<SessionInfo[]> {
  const all = await SessionManager.listAll();
  const filtered = all.filter((s) => matchSession(s, filter));
  // listAll 已按 modified 降序
  return typeof limit === "number" ? filtered.slice(0, Math.max(1, limit)) : filtered;
}

function formatTextList(sessions: SessionInfo[], filter?: string): string {
  if (sessions.length === 0) {
    return filter
      ? `没有匹配 "${filter}" 的 session。`
      : "没有找到任何 session。";
  }

  const header = filter
    ? `跨目录 session（过滤: ${filter}）共 ${sessions.length} 条，按最后活动时间降序：\n`
    : `跨目录 session 共 ${sessions.length} 条，按最后活动时间降序：\n`;

  const lines = sessions.map((s, i) => {
    const n = String(i + 1).padStart(2, " ");
    const abs = formatAbsolute(s.modified);
    const rel = formatRelative(s.modified).padStart(4, " ");
    return `${n}. [${abs} | ${rel}] ${sessionTitle(s)}
    cwd: ${shortenPath(s.cwd || "")}
    file: ${s.path}
    id: ${s.id} · msgs: ${s.messageCount}`;
  });

  return `${header}\n${lines.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

async function showTextOverlay(ctx: ExtensionCommandContext, text: string): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(text.slice(0, 800), "info");
    return;
  }

  await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Session list (All workdirs)"))));
    // 列表可能很长：截到约 40 行，避免刷屏
    const lines = text.split("\n");
    const capped = lines.length > 40 ? [...lines.slice(0, 40), `… 另有 ${lines.length - 40} 行未显示`] : lines;
    for (const line of capped) {
      container.addChild(new Text(theme.fg("muted", line || " ")));
    }
    container.addChild(new Text(theme.fg("dim", "任意键 / Esc 关闭")));
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput() {
        done(undefined);
      },
    };
  });
}

async function pickSession(
  ctx: ExtensionCommandContext,
  sessions: SessionInfo[],
): Promise<string | null> {
  if (sessions.length === 0) {
    ctx.ui.notify("没有可选择的 session", "warning");
    return null;
  }

  const items: SelectItem[] = sessions.map((s) => ({
    value: s.path,
    label: sessionTitle(s),
    description: sessionDescription(s),
  }));

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(
      new Text(
        theme.fg(
          "accent",
          theme.bold(`Sessions · All workdirs · ${sessions.length} 条（按最后活动）`),
        ),
      ),
    );
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          "label = 名称/首条消息 · 右侧 = 绝对时间 (相对) · cwd · 消息数",
        ),
      ),
    );
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          "过滤请用命令参数：/sessions <关键词> · /sessions list 20 tmp",
        ),
      ),
    );

    const selectList = new SelectList(items, Math.min(items.length, 14), getSelectListTheme());
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    container.addChild(
      new Text(theme.fg("dim", "↑↓ 选择 · Enter 恢复该 session · Esc 取消")),
    );
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

async function handleSessionsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { listOnly, limit, filter } = parseArgs(args);

  ctx.ui.setStatus("session-browse", "加载全部 session…");
  let sessions: SessionInfo[];
  try {
    // 交互模式默认不截断；list 模式默认 30
    sessions = await loadSessions(filter, limit ?? (listOnly ? 30 : undefined));
  } catch (err) {
    ctx.ui.setStatus("session-browse", undefined);
    ctx.ui.notify(
      `加载 session 失败: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return;
  }
  ctx.ui.setStatus("session-browse", undefined);

  if (listOnly || ctx.mode !== "tui") {
    await showTextOverlay(ctx, formatTextList(sessions, filter));
    return;
  }

  const chosen = await pickSession(ctx, sessions);
  if (!chosen) {
    ctx.ui.notify("已取消", "info");
    return;
  }

  const result = await ctx.switchSession(chosen, {
    withSession: async (newCtx) => {
      newCtx.ui.notify(`已恢复 session · ${shortenPath(newCtx.sessionManager.getCwd() || chosen)}`, "info");
    },
  });
  if (result.cancelled) {
    ctx.ui.notify("切换被取消", "warning");
  }
}

// ---------------------------------------------------------------------------
// 搜索结果类型 & 内容搜索逻辑（从 session-search 合并）
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

interface SearchResult {
  sessionFile: string;
  cwd: string;
  timestamp: string;
  role: string;
  snippet: string;
  entryId: string;
}

async function searchSessions(params: {
  query: string;
  limit: number;
  project?: string;
}): Promise<{ results: SearchResult[]; totalSessions: number }> {
  const { query, limit, project } = params;
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: SearchResult[] = [];

  const allSessions = await SessionManager.listAll();

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
        const text = extractText((msg as { content?: unknown }).content);
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
      // 跳过无法打开的 session
    }
  }

  return { results, totalSessions: sessions.length };
}

function formatSearchResults(query: string, results: SearchResult[], totalSessions: number): string {
  if (results.length === 0) {
    return `在 ${totalSessions} 个 session 中未找到包含 "${query}" 的记录。`;
  }

  const header = `搜索 "${query}"：在 ${totalSessions} 个 session 中找到 ${results.length} 条匹配：\n`;

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
  const desc =
    "跨 workdir 浏览 session（按最后活动时间）。用法: /sessions [list] [N] [filter]";

  pi.registerCommand("sessions", {
    description: desc,
    handler: (args, ctx) => handleSessionsCommand(args, ctx),
  });

  pi.registerCommand("find-session", {
    description: "同 /sessions：跨 workdir 按最后活动时间查找 session",
    handler: (args, ctx) => handleSessionsCommand(args, ctx),
  });

  pi.registerTool({
    name: "list_sessions",
    label: "List Sessions",
    description:
      "跨所有项目目录列出历史 session，按最后活动时间降序。用于停电恢复、找回「上次在哪个目录干了什么」。返回 cwd、绝对/相对更新时间、名称/首条消息、文件路径。",
    promptSnippet: "List recent sessions across all workdirs with last-modified time",
    promptGuidelines: [
      "Use list_sessions when the user needs to recover work after a crash, or find which project/session was last active.",
      "Prefer this over guessing paths; pass filter keywords (project name fragments) when known.",
    ],
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({ description: "返回条数，默认 20，最大 50", default: 20 }),
      ),
      filter: Type.Optional(
        Type.String({
          description: "过滤关键词（匹配 cwd / 名称 / 首条消息 / 全文，空格 AND）",
        }),
      ),
    }),
    async execute(_id, params) {
      const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
      const sessions = await loadSessions(params.filter, limit);
      const text = formatTextList(sessions, params.filter);

      return {
        content: [{ type: "text", text }],
        details: {
          count: sessions.length,
          sessions: sessions.map((s) => ({
            path: s.path,
            id: s.id,
            cwd: s.cwd,
            name: s.name,
            modified: s.modified.toISOString(),
            modifiedLocal: formatAbsolute(s.modified),
            relative: formatRelative(s.modified),
            messageCount: s.messageCount,
            title: sessionTitle(s),
          })),
        },
      };
    },
  });

  // ---- 搜索工具（从 session-search 合并） ----
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
            text: formatSearchResults(params.query, results, totalSessions),
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
