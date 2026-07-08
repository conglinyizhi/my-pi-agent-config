/**
 * 外部编辑器快捷键扩展
 *
 * Ctrl+O: 用外部编辑器打开当前工作目录（detached，不限入输入框内容）。
 * Ctrl+E: 把当前输入框内容写入临时文件（mkdtemp，不影响工作目录），
 *         用外部编辑器（同步等待）打开，关闭后将内容放回输入框。
 *
 * 编辑器配置（~/.pi/agent/settings.json）:
 *   "editor":     "code"           → Ctrl+O 用（也用于 /open-editor）
 *   "waitEditor": "code --wait"   → Ctrl+E 用（需要同步等待）
 *   未配置 waitEditor 时自动对已知 GUI 编辑器追加 --wait
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

interface Settings {
  editor?: string;
  waitEditor?: string;
}

function loadSettings(): Settings {
  try {
    const raw = readFileSync(`${getAgentDir()}/settings.json`, "utf8");
    return JSON.parse(raw) as Settings;
  } catch {
    return {};
  }
}

/** 打开目录 / 文件用的编辑器（不需要等待） */
function getEditor(): string {
  return loadSettings().editor || "code";
}

/** 已知需要 --wait 才能同步等待的 GUI 编辑器 */
const GUI_WAIT_FLAGS: Record<string, string> = {
  code: "--wait",
  "code-insiders": "--wait",
  subl: "--wait",
  sublime_text: "--wait",
  gedit: "--wait",
  atom: "--wait",
  "atom-beta": "--wait",
  "nvim-qt": "--wait",
};

/**
 * 获取同步等待式编辑器命令。
 * 优先 settings.waitEditor，其次对已知 GUI 编辑器自动加 --wait。
 */
function getWaitEditor(): string {
  const settings = loadSettings();

  if (settings.waitEditor) return settings.waitEditor;

  const editor = settings.editor || "code";

  const flag = GUI_WAIT_FLAGS[editor];
  if (flag) return `${editor} ${flag}`;

  // 终端编辑器本身就是同步的
  return editor;
}

// ---------------------------------------------------------------------------
// 外部编辑器启动
// ---------------------------------------------------------------------------

/** 解析 "code --wait" → { cmd: "code", args: ["--wait"] } */
function parseCommand(raw: string): { cmd: string; args: string[] } {
  const parts = raw.trim().split(/\s+/);
  return { cmd: parts[0]!, args: parts.slice(1) };
}

/** 异步等待式编辑器：暂停 TUI raw mode，spawn，等子进程退出后恢复 raw mode */
function spawnWaitEditor(
  cmd: string,
  args: string[],
  target: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let wasRaw = false;
    try {
      wasRaw =
        (process.stdin as unknown as { isRaw?: boolean }).isRaw ?? false;
      if (wasRaw) process.stdin.setRawMode(false);
    } catch {
      // stdin 非 TTY
    }

    process.stdout.write("\x1b[?25h"); // 显示光标

    const proc = spawn(cmd, [...args, target], { stdio: "inherit" });

    proc.on("exit", (code) => {
      if (wasRaw) {
        try {
          process.stdin.setRawMode(true);
        } catch {
          // ignore
        }
      }
      if (code === 0) resolve();
      else reject(new Error(`编辑器退出码: ${code}`));
    });

    proc.on("error", (err) => {
      if (wasRaw) {
        try {
          process.stdin.setRawMode(true);
        } catch {
          // ignore
        }
      }
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// 重复打开提示
// ---------------------------------------------------------------------------

/** 3 秒内重复按同一快捷键时显示 “已再次（xN）...” */
function repeatNotifier() {
  let count = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const RESET_MS = 3000;

  return {
    /** 返回格式化前缀：首次 ""，再次 "再次（x2）"，三次 "再次（x3）" ... */
    bump(): string {
      count++;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        count = 0;
      }, RESET_MS);
      if (count === 1) return "";
      return `再次（x${count}）`;
    },
  };
}

// ---------------------------------------------------------------------------
// 临时文件（mkdtemp，不污染工作目录 / git）
// ---------------------------------------------------------------------------

function createTempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const ctrlORepeat = repeatNotifier();
  const ctrlERepeat = repeatNotifier();

  // ── Ctrl+O: 用外部编辑器打开当前工作目录 ──────────────────────

  pi.registerShortcut("ctrl+o", {
    description: "用外部编辑器打开当前工作目录",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;

      const editor = getEditor();
      const targetPath = ctx.cwd;

      const proc = spawn(editor, [targetPath], {
        detached: true,
        stdio: "ignore",
        cwd: ctx.cwd,
      });
      proc.unref();

      const again = ctrlORepeat.bump();
      const prefix = again ? `已${again} ` : "已";
      ctx.ui.notify(
        `${prefix}用 ${editor} 打开: ${targetPath}`,
        "info",
      );
    },
  });

  // ── Ctrl+E: 编辑输入框文本 → 放回输入框 ──────────────────────

  pi.registerShortcut("ctrl+e", {
    description: "用外部编辑器编辑当前输入",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;

      const currentText = ctx.ui.getEditorText() ?? "";
      const dir = createTempDir("pi-edit-send-");
      const filePath = join(dir, "message.md");

      try {
        writeFileSync(filePath, currentText, "utf8");

        const waitEditor = getWaitEditor();
        const { cmd, args } = parseCommand(waitEditor);
        const fullCommand = `${waitEditor} ${filePath}`;

        const again = ctrlERepeat.bump();
        const prefix = again ? `已${again} ` : "已";
        ctx.ui.notify(`${prefix}打开外部编辑器: ${fullCommand}`, "info");
        await spawnWaitEditor(cmd, args, filePath);

        const edited = readFileSync(filePath, "utf8");
        ctx.ui.setEditorText(edited);
      } catch (err) {
        ctx.ui.notify(
          `外部编辑器出错: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  });
}
