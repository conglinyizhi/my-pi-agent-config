// 暂存/恢复对话书签（详见 README.md）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { copyToClipboard } from "../../lib/clipboard.ts";

const STORE_PATH = join(homedir(), ".pi", "talk-sleep.jsonl");

// 备注列宽度（终端单元格）：窄了挤掉列间距，宽了压缩后面的 cwd/时间
const NOTE_MIN_WIDTH = 8;
const NOTE_MAX_WIDTH = 28;

interface StoredSession {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  note: string;
  timestamp: string;
}

// ============================================================
// 排版工具：备注长短不该把列表搅歪
// ============================================================

function isWideChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += isWideChar(ch) ? 2 : 1;
  return width;
}

/** 备注统一成单行：换行/制表符会撑破列表排版，也会破坏恢复指令里的 `# 备注` */
function normalizeNote(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  let out = "";
  let width = 0;
  for (const ch of text) {
    const chWidth = isWideChar(ch) ? 2 : 1;
    if (width + chWidth > maxWidth - 1) break; // 留一格给省略号
    out += ch;
    width += chWidth;
  }
  return out + "…";
}

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}

/** 本次列表实际使用的备注列宽：随最长备注伸缩，但有上下限 */
function noteColumnWidth(notes: string[]): number {
  const widest = notes.reduce((max, note) => Math.max(max, displayWidth(note)), 0);
  return Math.min(NOTE_MAX_WIDTH, Math.max(NOTE_MIN_WIDTH, widest));
}

// ============================================================
// 存储
// ============================================================

async function readStore(): Promise<StoredSession[]> {
  if (!existsSync(STORE_PATH)) return [];
  const raw = (await readFile(STORE_PATH, "utf-8")).trim();
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

/** 就地改写一条记录的备注；其余行原样保留，解析不了的行也不动 */
async function updateStoredNote(target: StoredSession, note: string): Promise<boolean> {
  if (!existsSync(STORE_PATH)) return false;
  const lines = (await readFile(STORE_PATH, "utf-8")).split("\n");

  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let parsed: StoredSession;
    try { parsed = JSON.parse(lines[i]) as StoredSession; }
    catch { continue; }
    if (parsed.timestamp === target.timestamp && parsed.sessionId === target.sessionId) {
      parsed.note = note;
      lines[i] = JSON.stringify(parsed);
      changed = true;
      break;
    }
  }
  if (!changed) return false;

  const tmpPath = STORE_PATH + ".tmp";
  await writeFile(tmpPath, lines.join("\n"), "utf-8");
  await rename(tmpPath, STORE_PATH);
  return true;
}

export default function (pi: ExtensionAPI) {
  // ============================================================
  // /talk-sleep [备注] —— 备注必填
  // ============================================================
  pi.registerCommand("talk-sleep", {
    description: "暂存当前对话（备注必填，用法: /talk-sleep [备注]）",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const cwd = ctx.sessionManager.getCwd();

      if (!sessionFile) {
        ctx.ui.notify("当前会话未持久化（in-memory），无法暂存", "warning");
        return;
      }

      // 备注是列表里唯一的辨识依据，缺了就等于没标；命令行没给就弹框要
      let note = normalizeNote(args);
      if (!note) {
        const input = await ctx.ui.input(
          "备注（必填，用于在暂存列表里认出这段对话）",
          "例如：重构 sandbox 权限",
        );
        if (input === undefined) {
          ctx.ui.notify("已取消暂存：备注必填", "warning");
          return;
        }
        note = normalizeNote(input);
        if (!note) {
          ctx.ui.notify("已取消暂存：备注为空", "warning");
          return;
        }
      }

      const entry: StoredSession = {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile,
        cwd,
        note,
        timestamp: new Date().toISOString(),
      };

      await appendFile(STORE_PATH, JSON.stringify(entry) + "\n", "utf-8");
      ctx.ui.notify(`已暂存: "${note}"  (${cwd})`, "info");
    },
  });

  // ============================================================
  // /talk-sleep-load
  // ============================================================
  pi.registerCommand("talk-sleep-load", {
    description: "选择并复制一个暂存对话的恢复指令",
    handler: async (_args, ctx) => {
      const sessions = await readStore();

      if (sessions.length === 0) {
        ctx.ui.notify("没有暂存的对话，先用 /talk-sleep [备注] 暂存一个吧", "info");
        return;
      }

      const notes = sessions.map((s) => normalizeNote(s.note) || "(无备注)");
      const noteWidth = noteColumnWidth(notes);

      // 备注补齐到同一列宽，cwd/时间不再被长短备注挤走
      const seen = new Map<string, number>();
      const items = sessions.map((s, i) => {
        const shortCwd = s.cwd.replace(homedir(), "~");
        const time = new Date(s.timestamp).toLocaleString("zh-CN", {
          month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit",
        });
        let label = `${padToWidth(notes[i], noteWidth)}  │  ${shortCwd}  │  ${time}`;
        // 完全相同的行会导致 indexOf 选错目标，补个序号
        const dup = seen.get(label) ?? 0;
        seen.set(label, dup + 1);
        if (dup > 0) label += `  #${dup + 1}`;
        return label;
      });

      const chosen = await ctx.ui.select("选择要恢复的对话 (Esc 取消)", items);
      if (!chosen) return;

      const target = sessions[items.indexOf(chosen)];
      if (!target) {
        ctx.ui.notify("选择项已失效（列表可能已变化），请重新运行 /talk-sleep-load", "warning");
        return;
      }

      if (!existsSync(target.sessionFile)) {
        ctx.ui.notify(
          `会话文件已不存在: ${target.sessionFile}\n可能已被删除或移动`,
          "error",
        );
        return;
      }

      const cmd = `cd ${target.cwd} && pi --session ${target.sessionId}`;

      while (true) {
        const note = normalizeNote(target.note);
        const fullCmd = note ? `${cmd}  # ${note}` : cmd;

        const action = await ctx.ui.select("如何处理？", [
          "复制恢复指令到剪贴板",
          "仅显示恢复指令",
          "编辑备注",
          "取消",
        ]);

        if (!action || action === "取消") return;

        if (action === "编辑备注") {
          const edited = await ctx.ui.editor("编辑备注（Esc 取消，清空则删除备注）", note);
          if (edited === undefined) continue; // 取消编辑，回到动作菜单

          const next = normalizeNote(edited);
          if (next === note) {
            ctx.ui.notify("备注未变化", "info");
            continue;
          }

          const updated = await updateStoredNote(target, next);
          if (!updated) {
            ctx.ui.notify("备注更新失败：暂存文件里找不到这条记录", "error");
            continue;
          }
          target.note = next;
          ctx.ui.notify(next ? `备注已更新: "${next}"` : "备注已清空", "info");
          continue; // 改完还能接着复制
        }

        if (action.startsWith("复制")) {
          const result = await copyToClipboard(fullCmd, {
            onAttempt: (tool) => {
              ctx.ui.setStatus("talk-sleep", `正在测试剪贴板工具 (${tool})...`);
            },
          });
          ctx.ui.setStatus("talk-sleep", undefined);
          if (result.ok) {
            ctx.ui.notify("已复制到剪贴板: " + fullCmd, "info");
          } else {
            const failures = result.attempts.filter((a) => !a.ok);
            const detail = failures.length > 0
              ? `\n尝试了 ${failures.length} 个工具均失败：\n${failures.map((a) => `  · ${a.tool}: ${a.reason ?? "未知错误"}`).join("\n")}`
              : "";
            ctx.ui.notify("复制失败，未找到可用的剪贴板工具" + detail + "\n" + fullCmd, "warning");
          }
        } else {
          ctx.ui.notify(fullCmd, "info");
        }
        return;
      }
    },
  });
}
