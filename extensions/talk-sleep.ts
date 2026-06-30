/**
 * talk-sleep 扩展
 *
 * /talk-sleep [备注]    — 将当前对话信息存入 ~/.pi/talk-sleep.jsonl
 * /talk-sleep-load       — 弹出 TUI 选择器，选中后显示恢复指令
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE_PATH = join(homedir(), ".pi", "talk-sleep.jsonl");

interface StoredSession {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  note: string;
  timestamp: string;
}

function readStore(): StoredSession[] {
  if (!existsSync(STORE_PATH)) return [];
  const raw = readFileSync(STORE_PATH, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      try { return JSON.parse(line) as StoredSession; }
      catch { return null; }
    })
    .filter((s): s is StoredSession => s !== null)
    .reverse();
}

export default function (pi: ExtensionAPI) {
  // ============================================================
  // /talk-sleep [备注]
  // ============================================================
  pi.registerCommand("talk-sleep", {
    description: "暂存当前对话 (用法: /talk-sleep [备注])",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const cwd = ctx.sessionManager.getCwd();

      if (!sessionFile) {
        ctx.ui.notify("当前会话未持久化（in-memory），无法暂存", "warning");
        return;
      }

      const entry: StoredSession = {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile,
        cwd,
        note: args.trim(),
        timestamp: new Date().toISOString(),
      };

      appendFileSync(STORE_PATH, JSON.stringify(entry) + "\n", "utf-8");

      const label = entry.note ? `"${entry.note}"` : "无备注";
      ctx.ui.notify(`已暂存: ${label}  (${cwd})`, "success");
    },
  });

  // ============================================================
  // /talk-sleep-load
  // ============================================================
  pi.registerCommand("talk-sleep-load", {
    description: "选择并复制一个暂存对话的恢复指令",
    handler: async (_args, ctx) => {
      const sessions = readStore();

      if (sessions.length === 0) {
        ctx.ui.notify("没有暂存的对话，先用 /talk-sleep [备注] 暂存一个吧", "info");
        return;
      }

      const items = sessions.map((s) => {
        const label = s.note || "(无备注)";
        const shortCwd = s.cwd.replace(homedir(), "~");
        const time = new Date(s.timestamp).toLocaleString("zh-CN", {
          month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit",
        });
        return `${label}  │  ${shortCwd}  │  ${time}`;
      });

      const chosen = await ctx.ui.select("选择要恢复的对话 (Esc 取消)", items);
      if (!chosen) return;

      const target = sessions[items.indexOf(chosen)];

      if (!existsSync(target.sessionFile)) {
        ctx.ui.notify(
          `会话文件已不存在: ${target.sessionFile}\n可能已被删除或移动`,
          "error",
        );
        return;
      }

      const cmd = `cd ${target.cwd} && pi --session ${target.sessionId}`;
      const suffix = target.note ? `  # ${target.note}` : "";
      ctx.ui.notify(cmd + suffix, "info");
    },
  });
}
