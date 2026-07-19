/**
 * 外部编辑器快捷键扩展
 *
 * Ctrl+O:          用外部编辑器打开当前工作目录（detached，不阻塞）
 * /open-editor:    用外部编辑器打开文件或目录，无参数时打开当前工作目录
 *
 * 编辑器配置（~/.pi/agent/settings.json）:
 *   "editor": "code"   → 未配置默认也用 code
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

function getEditor(): string {
  try {
    const raw = JSON.parse(
      readFileSync(`${getAgentDir()}/settings.json`, "utf8"),
    );
    return (raw.editor as string) || "code";
  } catch {
    return "code";
  }
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ── Ctrl+O: 用外部编辑器打开当前工作目录 ──────────────────────

  pi.registerShortcut("ctrl+o", {
    description: "用外部编辑器打开当前工作目录",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;

      const editor = getEditor();
      const proc = spawn(editor, [ctx.cwd], {
        detached: true,
        stdio: "ignore",
        cwd: ctx.cwd,
      });
      proc.unref();

      ctx.ui.notify(`已用 ${editor} 打开: ${ctx.cwd}`, "info");
    },
  });

  // ── /open-editor: 打开文件或目录 ──────────────────────────────

  pi.registerCommand("open-editor", {
    description: "用外部编辑器打开文件或目录，无参数时打开当前工作目录",
    handler: async (args, ctx) => {
      const editor = getEditor();
      const targetPath = args.trim()
        ? resolve(ctx.cwd, args.trim())
        : ctx.cwd;

      if (!existsSync(targetPath)) {
        ctx.ui.notify(`路径不存在: ${targetPath}`, "error");
        return;
      }

      const proc = spawn(editor, [targetPath], {
        detached: true,
        stdio: "ignore",
        cwd: ctx.cwd,
      });
      proc.unref();

      ctx.ui.notify(`已用 ${editor} 打开: ${targetPath}`, "info");
    },
  });
}
