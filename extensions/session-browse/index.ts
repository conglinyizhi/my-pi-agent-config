// 跨 workdir 浏览 / 筛选历史 session，按最后活动时间排序，可选 resume
//
// 用法：
//   /session-switch                   交互选择（默认 All，显示绝对时间 + cwd）
//   /session-switch 10               只看最近 10 条
//   /session-switch shin             过滤 cwd / 名称 / 首条消息
//   /session-switch list             纯文本列表（不切换）
//   /session-switch list 20 shin     文本 + 条数 + 过滤
//   /session-switch:fast-fork        从当前 session 当前位置 fork 出一个新 session 继续对话
//
// 也注册 list_sessions 工具，方便 LLM 在对话里直接列最近 session。

import type { ExtensionAPI, ExtensionCommandContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  getAgentDir,
  getSelectListTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { join } from "node:path";
import { Type } from "typebox";
import { LazySessionSource } from "./lazy-sessions.ts";

/** 首屏解析多少条，以及每次往下翻再多解析多少条 */
const SESSION_BATCH = 30;
/** 光标离已加载末尾这么近时，提前加载下一批 */
const PREFETCH_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

function shortenPath(path: string): string {
  if (!path) return "(unknown cwd)";
  const home = homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

/** 归一化目录路径以比较（resolve 尾部斜杠 / 相对路径差异）。 */
function normalizeDir(dir?: string | null): string {
  if (!dir) return "";
  return nodePath.resolve(dir);
}

/** 判断两个 cwd 是否指向同一目录，用于高亮当前目录的 session。 */
function isSameDir(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return normalizeDir(a) === normalizeDir(b);
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

function formatTextList(sessions: SessionInfo[], filter: string | undefined, currentCwd: string): string {
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
    const isCurrent = isSameDir(s.cwd, currentCwd);
    const marker = isCurrent ? "● " : "  ";
    const cwdLine = `cwd: ${shortenPath(s.cwd || "")}${isCurrent ? "  (当前目录)" : ""}`;
    return `${n}. [${abs} | ${rel}] ${marker}${sessionTitle(s)}
    ${cwdLine}
    file: ${s.path}
    id: ${s.id} · msgs: ${s.messageCount}`;
  });

  return `${header}（● = 当前目录 ${shortenPath(currentCwd)}）\n\n${lines.join("\n\n")}`;
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
  source: LazySessionSource,
  currentCwd: string,
  filter?: string,
): Promise<string | null> {
  if (source.sessions.length === 0) {
    ctx.ui.notify("没有可选择的 session", "warning");
    return null;
  }

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    // 主题可能缺 success token，回退为纯文本标记，避免崩溃。
    const highlight = (text: string): string => {
      try {
        return theme.fg("success", text);
      } catch {
        return text;
      }
    };

    const toItems = (): SelectItem[] =>
      source.sessions.map((s) => {
        const title = sessionTitle(s);
        const desc = sessionDescription(s);
        if (isSameDir(s.cwd, currentCwd)) {
          return {
            value: s.path,
            label: highlight(`● ${title}`),
            description: `${desc} · ${highlight("当前目录")}`,
          };
        }
        return { value: s.path, label: title, description: desc };
      });

    const buildList = (): SelectList => {
      const items = toItems();
      const list = new SelectList(items, Math.min(Math.max(items.length, 1), 14), getSelectListTheme());
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      return list;
    };

    const container = new Container();
    let selectList = buildList();
    let loading = false;

    /** 底部状态：加载进度 + 是否还能往下翻 */
    const footerText = (): string => {
      const loaded = source.sessions.length;
      const parts: string[] = [];
      if (filter) {
        parts.push(`已加载 ${loaded} 条匹配`);
        parts.push(`已扫描 ${source.scannedFiles}/${source.totalFiles} 个文件`);
      } else {
        parts.push(`已加载 ${loaded}/${source.totalFiles}`);
      }
      if (loading) parts.push("正在加载更多…");
      else if (source.hasMore) parts.push("继续向下翻加载更多");
      return `↑↓ 选择 · Enter 恢复 · Esc 取消 · ${parts.join(" · ")}`;
    };

    const renderChrome = () => {
      container.clear();
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Sessions · All workdirs（按最后活动）")), 1, 0),
      );
      container.addChild(
        new Text(
          theme.fg("dim", "label = 名称/首条消息 · 右侧 = 绝对时间 (相对) · cwd · 消息数"),
          1,
          0,
        ),
      );
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            `● = 当前目录 · 当前 cwd: ${currentCwd ? shortenPath(currentCwd) : "(unknown)"}`,
          ),
          1,
          0,
        ),
      );
      container.addChild(
        new Text(
          theme.fg("dim", "过滤请用命令参数：/session-switch <关键词> · /session-switch list 20 tmp"),
          1,
          0,
        ),
      );
      container.addChild(selectList);
      container.addChild(new Text(theme.fg("dim", footerText()), 1, 0));
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    };

    /** 光标接近已加载末尾时再解析下一批，并把光标停在原选中项上 */
    const maybeLoadMore = async () => {
      if (loading || !source.hasMore) return;
      const selected = selectList.getSelectedItem();
      const index = selected ? source.sessions.findIndex((s) => s.path === selected.value) : 0;
      if (index < source.sessions.length - PREFETCH_THRESHOLD) return;

      loading = true;
      renderChrome();
      tui.requestRender();

      const before = source.sessions.length;
      await source.loadMore(SESSION_BATCH);
      loading = false;

      if (source.sessions.length !== before) {
        selectList = buildList();
        const restored = selected ? source.sessions.findIndex((s) => s.path === selected.value) : -1;
        if (restored >= 0) selectList.setSelectedIndex(restored);
      }
      renderChrome();
      tui.requestRender();
    };

    renderChrome();

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
        void maybeLoadMore();
      },
    };
  });
}

async function handleSessionsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { listOnly, limit, filter } = parseArgs(args);
  const currentCwd = ctx.sessionManager.getCwd() || process.cwd();

  // 文本列表（或非 TUI）：一次性加载，默认只取 30 条
  if (listOnly || ctx.mode !== "tui") {
    ctx.ui.setStatus("session-browse", "加载 session…");
    let sessions: SessionInfo[];
    try {
      sessions = await loadSessions(filter, limit ?? SESSION_BATCH);
    } catch (err) {
      ctx.ui.setStatus("session-browse", undefined);
      ctx.ui.notify(
        `加载 session 失败: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return;
    }
    ctx.ui.setStatus("session-browse", undefined);
    await showTextOverlay(ctx, formatTextList(sessions, filter, currentCwd));
    return;
  }

  // 交互模式：先只解析最近 SESSION_BATCH 条，往下翻时再解析下一批
  ctx.ui.setStatus("session-browse", `加载最近 ${SESSION_BATCH} 条 session…`);
  let source: LazySessionSource;
  try {
    source = await LazySessionSource.create(join(getAgentDir(), "sessions"), {
      match: (info) => matchSession(info, filter),
      limit,
    });
    await source.loadMore(SESSION_BATCH);
  } catch (err) {
    ctx.ui.setStatus("session-browse", undefined);
    ctx.ui.notify(
      `加载 session 失败: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return;
  }
  ctx.ui.setStatus("session-browse", undefined);

  if (source.sessions.length === 0) {
    ctx.ui.notify(
      filter ? `没有匹配 "${filter}" 的 session` : "没有找到任何 session",
      "info",
    );
    return;
  }

  const chosen = await pickSession(ctx, source, currentCwd, filter);
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
    "跨 workdir 浏览 session（按最后活动时间）。用法: /session-switch [list] [N] [filter]";

  pi.registerCommand("session-switch", {
    description: desc,
    handler: (args, ctx) => handleSessionsCommand(args, ctx),
  });

  pi.registerCommand("find-session", {
    description: "同 /session-switch：跨 workdir 按最后活动时间查找 session",
    handler: (args, ctx) => handleSessionsCommand(args, ctx),
  });

  // /session-switch:fast-fork
  // 从当前 session 当前位置（leaf）fork 出一个新 session 文件继续后续对话。
  // 用 position: "at" 复制当前 active path，保留全部上下文，不向编辑器回填历史 prompt。
  pi.registerCommand("session-switch:fast-fork", {
    description: "从当前 session fork 出一个新 session 继续对话（复制当前上下文到新 session 文件）",
    handler: async (_args, ctx) => {
      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) {
        ctx.ui.notify("当前 session 没有可 fork 的入口（空会话）", "warning");
        return;
      }

      ctx.ui.setStatus("session-browse", "fork session…");
      try {
        const result = await ctx.fork(leafId, {
          position: "at",
          withSession: async (newCtx) => {
            newCtx.ui.notify("已 fork 到新 session，可继续对话", "info");
          },
        });
        if (result.cancelled) {
          ctx.ui.notify("fork 被取消", "warning");
        }
      } catch (err) {
        ctx.ui.notify(
          `fork 失败: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      } finally {
        ctx.ui.setStatus("session-browse", undefined);
      }
    },
  });

}
