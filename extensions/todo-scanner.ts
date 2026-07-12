/**
 * TODO 扫描器扩展
 *
 * 扫描当前工作目录下包含 "TODO:" 的行，在 TUI 编辑器上方以 widget 展示。
 * 优先使用 rg（自动尊重 .gitignore），回退到 grep。
 * rg/grep 超时则清除 widget，不显示任何内容。
 *
 * /todos         手动刷新 TODO 列表
 * ctrl+shift+t  手动刷新
 *
 * 标题格式: TODO(s): 完成数/总数
 * TODO:DONE 前缀的行视为已完成
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExecResult,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 配置常量
// ---------------------------------------------------------------------------

const TODO_PATTERN = "TODO:";
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
  /** 是否标记为已完成（TODO:DONE） */
  done: boolean;
}

type ScanState =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "done"; items: TodoItem[]; total: number; doneCount: number }
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
      done: text.includes("TODO:DONE"),
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
          return [theme.fg("dim", `📋 TODO: ${label}`)];
        }

        if (state.status === "timeout") {
          // 超时：显示红色提示而非静默清除
          return [theme.fg("error", `📋 TODO: 扫描超时（>${SEARCH_TIMEOUT_MS / 1000}s）`)];
        }

        if (state.status === "error") {
          return [theme.fg("warning", `📋 TODO: ${state.message}`)];
        }

        // done
        const { items, total, doneCount } = state;
        if (total === 0) {
          return [theme.fg("success", "📋 TODO(s): 0/0 ✓")];
        }

        if (doneCount === total) {
          return [theme.fg("success", `📋 TODO(s): ${doneCount}/${total} ✓`)];
        }

        const pending = items.filter((i) => !i.done);
        const showing = Math.min(pending.length, MAX_DISPLAY);
        const header = `📋 TODO(s): ${doneCount}/${total}${
          pending.length > MAX_DISPLAY ? `（显示前 ${showing}）` : ""
        }`;
        const lines: string[] = [theme.fg("accent", header)];

        for (const item of pending.slice(0, MAX_DISPLAY)) {
          const rawLoc = `${item.file}:${item.line}`;
          // 文件位置最多占 35% 终端宽，最少给内容留 40 列
          const maxLocCols = Math.min(60, Math.floor(width * 0.35));
          const prefix = theme.fg("muted", truncateToWidth(rawLoc, maxLocCols));
          const sep = theme.fg("dim", " │ ");
          // 内容宽度 = 剩余宽度 - 缩进 2 - 分隔符 ~3
          const contentMax = Math.max(20, width - visibleWidth(truncateToWidth(rawLoc, maxLocCols)) - 5);
          const content = theme.fg("dim", truncateToWidth(item.text, contentMax));
          lines.push(`  ${prefix}${sep}${content}`);
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
      // 超时：显示红色提示而非静默清除
      ctx.ui.setWidget(WIDGET_ID, buildWidget(state));
      return;
    }

    state = { status: "done", items: result.items, total: result.total, doneCount: result.doneCount };
    ctx.ui.setWidget(WIDGET_ID, buildWidget(state));
  }

  // ── session_start: 自动扫描 ────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    await refresh(ctx);
  });

  // ── session_shutdown: 清理 ─────────────────────────────────────

  pi.on("session_shutdown", async () => {
    state = { status: "idle" };
  });

  // ── /todos 命令: 手动刷新 ───────────────────────────────────────

  pi.registerCommand("todos", {
    description: "扫描并刷新当前工作目录的 TODO 列表",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      await refresh(ctx);
      if (state.status === "done") {
        ctx.ui.notify(
          `TODO 扫描完成: ${state.doneCount}/${state.total}`,
          state.total > 0 ? "warning" : "info",
        );
      } else if (state.status === "timeout") {
        ctx.ui.notify("TODO 扫描超时，已跳过", "warning");
      }
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
