/**
 * TODO 扫描器扩展
 *
 * 扫描当前工作目录下包含待办标记的行，在 TUI 编辑器上方以 widget 展示。
 * 优先使用 rg（自动尊重 .gitignore），回退到 grep。
 * rg/grep 超时则清除 widget，不显示任何内容。
 *
 * /scan-todo                展开 TODO 列表
 * /scan-todo <序号>[,<序号或范围>...]  选中发送，如 3 / 2-5 / 1,3,4-6
 * ctrl+shift+t         手动刷新
 *
 * 标题格式: 待办(s): 完成数/总数
 * 以完成标记结尾的行视为已完成
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExecResult,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 配置常量
// ---------------------------------------------------------------------------

// 拆分字符串避免插件源码自身被 rg/grep 命中
const TODO_PATTERN = "TO" + "DO:";
const TD_PREFIX = "\ud83d\udccb " + "TO" + "DO:";
const SEARCH_TIMEOUT_MS = 5000;
const MAX_DISPLAY = 15;
const WIDGET_ID = "todo-scanner";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface TodoItem {
  /** 相对路径 */
  file: string;
  /** 行号 */
  line: number;
  /** 行内容（已 trim） */
  text: string;
  /** 是否标记为已完成 */
  done: boolean;
}

type ScanState =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "done"; items: TodoItem[]; total: number; doneCount: number; expanded: boolean }
  | { status: "timeout" }
  | { status: "error"; message: string };

interface Theme {
  fg(color: string, text: string): string;
}

// ---------------------------------------------------------------------------
// 扫描逻辑
// ---------------------------------------------------------------------------

function parseSearchOutput(stdout: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;

    // 格式: path:linenum:content（rg 和 grep -rn 输出一致）
    // 路径可能含冒号，但行号一定是冒号间的纯数字
    const match = line.match(/^(.+):(\d+):(.*)$/);
    if (!match) continue;

    const text = match[3]!.trim();
    items.push({
      file: match[1]!,
      line: parseInt(match[2]!, 10),
      text,
      done: text.includes("TO" + "DO:DONE"),
    });
  }
  return items;
}

async function scanTodos(
  pi: ExtensionAPI,
  cwd: string,
): Promise<{ items: TodoItem[]; total: number } | null> {
  let result: ExecResult;

  // 尝试 rg
  try {
    result = await pi.exec("rg", [
      "-n",
      "--no-heading",
      "-g", "!node_modules",
      "-g", "!.git",
      "-g", "!dist",
      "-g", "!build",
      "-g", "!target",
      "-g", "!extensions/todo-scanner.ts",
      TODO_PATTERN,
      ".",
    ], {
      timeout: SEARCH_TIMEOUT_MS,
      cwd,
    });
  } catch {
    // rg 不存在或启动失败，回退到 grep
    try {
      result = await pi.exec(
        "grep",
        [
          "-rn",
          "--exclude-dir=node_modules",
          "--exclude-dir=.git",
          "--exclude-dir=dist",
          "--exclude-dir=build",
          "--exclude-dir=target",
          "--exclude=todo-scanner.ts",
          TODO_PATTERN,
          ".",
        ],
        { timeout: SEARCH_TIMEOUT_MS, cwd },
      );
    } catch {
      return null;
    }
  }

  // 超时
  if (result.killed) return null;

  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return { items: [], total: 0 };

  const items = parseSearchOutput(stdout);
  const doneCount = items.filter((i) => i.done).length;
  return { items, total: items.length, doneCount };
}

// ---------------------------------------------------------------------------
// Widget 渲染
// ---------------------------------------------------------------------------

/** 计算字符串在终端中的可见宽度（CJK 字符计 2，其他计 1） */
function visibleWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    // CJK 统一表意文字、全角标点、CJK 扩展区
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) ||   // CJK Radicals … Yi
      (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compatibility Ideographs
      (cp >= 0xfe30 && cp <= 0xfe6f) ||   // CJK Compatibility Forms
      (cp >= 0xff01 && cp <= 0xff60) ||   // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth Signs
      (cp >= 0x1b000 && cp <= 0x1b2ff) || // Kana Supplement, Extended
      (cp >= 0x1f004 && cp <= 0x1f251) || // Mahjong, Domino, Enclosed
      (cp >= 0x20000 && cp <= 0x2ffff)    // CJK Ext B…G
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** 将字符串按终端可见宽度截断 */
function truncateToWidth(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let w = 0;
  const chars = [...str];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const chW = visibleWidth(ch);
    if (w + chW > maxWidth) {
      return chars.slice(0, i).join("") + "…";
    }
    w += chW;
  }
  return str;
}

function buildWidget(state: ScanState) {
  return (_tui: unknown, theme: Theme) => {
    return {
      render(width: number): string[] {
        if (state.status === "idle" || state.status === "scanning") {
          const label =
            state.status === "scanning" ? "扫描中…" : "就绪";
          return [theme.fg("dim", `${TD_PREFIX} ${label}`)];
        }

        if (state.status === "timeout") {
          return [theme.fg("error", `${TD_PREFIX} 扫描超时（>${SEARCH_TIMEOUT_MS / 1000}s）`)];
        }

        if (state.status === "error") {
          return [theme.fg("warning", `${TD_PREFIX} ${state.message}`)];
        }

        // done
        const { items, total, doneCount, expanded } = state;
        if (total === 0) {
          return [theme.fg("success", "📋 TODO(s): 0/0 ✓")];
        }

        if (doneCount === total) {
          return [theme.fg("success", `📋 TODO(s): ${doneCount}/${total} ✓`)];
        }

        const pending = items.filter((i) => !i.done);

        // 折叠模式：只显示一行摘要
        if (!expanded) {
          const hint = theme.fg("dim", "  /scan-todo 展开");
          return [theme.fg("accent", `📋 TODO(s): ${doneCount}/${total}`) + hint];
        }

        // 展开模式：显示完整列表（带序号）
        const showing = Math.min(pending.length, MAX_DISPLAY);
        const header = `📋 TODO(s): ${doneCount}/${total}${
          pending.length > MAX_DISPLAY ? `（显示前 ${showing}）` : ""
        }`;
        const lines: string[] = [theme.fg("accent", header)];

        for (const [idx, item] of pending.slice(0, MAX_DISPLAY).entries()) {
          const num = theme.fg("warning", String(idx + 1).padStart(2));
          const rawLoc = `${item.file}:${item.line}`;
          // 文件位置最多占 35% 终端宽，最少给内容留 40 列
          const numCols = 2;
          const maxLocCols = Math.min(60, Math.floor(width * 0.35));
          const prefix = theme.fg("muted", truncateToWidth(rawLoc, maxLocCols));
          const sep = theme.fg("dim", " │ ");
          // 内容宽度 = 剩余宽度 - 缩进 1 - 序号 3 - 分隔符 ~3
          const contentMax = Math.max(20, width - numCols - visibleWidth(truncateToWidth(rawLoc, maxLocCols)) - 6);
          const content = theme.fg("dim", truncateToWidth(item.text, contentMax));
          lines.push(` ${num} ${prefix}${sep}${content}`);
        }

        return lines;
      },
      invalidate() {},
    };
  };
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let state: ScanState = { status: "idle" };

  async function refresh(ctx: ExtensionContext) {
    state = { status: "scanning" };
    ctx.ui.setWidget(WIDGET_ID, buildWidget(state));

    const result = await scanTodos(pi, ctx.cwd);

    if (result === null) {
      state = { status: "timeout" };
      ctx.ui.setWidget(WIDGET_ID, buildWidget(state));
      return;
    }

    // 保持之前展开/折叠状态（首次扫描默认折叠）
    const prevExpanded = state.status === "done" ? state.expanded : false;
    state = {
      status: "done",
      items: result.items,
      total: result.total,
      doneCount: result.doneCount,
      expanded: prevExpanded,
    };
    ctx.ui.setWidget(WIDGET_ID, buildWidget(state));
  }

  // ── session_start: 自动扫描（折叠模式） ────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    await refresh(ctx);
  });

  // ── session_shutdown: 清理 ─────────────────────────────────────

  pi.on("session_shutdown", async () => {
    state = { status: "idle" };
  });

  // ── /scan-todo 命令: 展开列表 / 选中 TODO ──────────────────────

  pi.registerCommand("scan-todo", {
    description: "展开 TODO 列表，或选中指定 TODO（支持逗号分隔和范围，如 1,3,4-6）发送给 AI",
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;

      // 先刷新数据
      await refresh(ctx);

      if (state.status !== "done") {
        ctx.ui.notify("TODO 扫描失败或超时", "error");
        return;
      }

      const trimmed = args.trim();

      // 不带参数：展开列表
      if (!trimmed) {
        state.expanded = true;
        ctx.ui.setWidget(WIDGET_ID, buildWidget(state));
        ctx.ui.notify(
          `TODO 扫描完成: ${state.doneCount}/${state.total}，输入 /scan-todo <序号> 选中`,
          state.total > 0 ? "warning" : "info",
        );
        return;
      }

      // 带参数：解析逗号分隔的序号/范围，如 1,3,4-6
      const pending = state.items.filter((i) => !i.done);
      const rawSet = new Set<number>();

      for (const part of trimmed.split(",")) {
        const seg = part.trim();
        const rangeMatch = seg.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]!, 10);
          const end = parseInt(rangeMatch[2]!, 10);
          if (start < 1 || end < 1 || start > end) {
            ctx.ui.notify(`范围无效: ${seg}`, "warning");
            return;
          }
          for (let i = start; i <= end; i++) rawSet.add(i);
        } else {
          const n = parseInt(seg, 10);
          if (isNaN(n) || n < 1) {
            ctx.ui.notify(`无法解析: "${seg}"，用法: /scan-todo <序号>[,<序号或范围>...]`, "warning");
            return;
          }
          rawSet.add(n);
        }
      }

      const indices = [...rawSet].sort((a, b) => a - b);
      if (indices.length === 0) {
        ctx.ui.notify("未选中任何 TODO", "warning");
        return;
      }
      const maxIdx = indices[indices.length - 1]!;
      if (maxIdx > pending.length) {
        ctx.ui.notify(`序号超出范围（共 ${pending.length} 个待处理 TODO）`, "warning");
        return;
      }

      const selected = indices.map((i) => pending[i - 1]!);

      // 弹出输入框让用户补充说明
      const label = selected.length === 1
        ? `补充信息（可选）— ${selected[0]!.file}:${selected[0]!.line}`
        : `补充信息（可选）— 已选中 ${selected.length} 个 TODO`;
      const note = await ctx.ui.input(label);

      // 拼接消息发送
      const itemsBlock = selected
        .map((item) => `- \`${item.file}:${item.line}\`\n  > ${item.text}`)
        .join("\n");
      let msg = `处理以下 ${TODO_PATTERN.substring(0, 4)}:\n\n${itemsBlock}`;
      if (note) {
        msg += `\n\n补充: ${note}`;
      }

      pi.sendUserMessage(msg);

      // 折叠 widget
      state.expanded = false;
      ctx.ui.setWidget(WIDGET_ID, buildWidget(state));

      const rangeLabel = indices.length === 1
        ? `#${indices[0]}: ${selected[0]!.file}:${selected[0]!.line}`
        : `#${indices[0]}-${indices[indices.length - 1]}（${indices.length} 个）`;
      ctx.ui.notify(`已发送 TODO ${rangeLabel}`, "info");
    },
  });

  // ── ctrl+shift+t 快捷键: 手动刷新 ───────────────────────────────

  pi.registerShortcut("ctrl+shift+t", {
    description: "刷新 TODO 列表",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await refresh(ctx);
    },
  });
}
