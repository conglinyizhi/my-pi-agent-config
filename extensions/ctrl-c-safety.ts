/**
 * Ctrl+C 历史保存插件
 *
 * 按下 Ctrl+C 时不拦截，而是保存当前编辑器内容到历史队列，然后清空编辑器。
 * /edit-gui 命令可以查看和恢复历史内容。
 *
 * 实现原理：
 * 1. 注册 ctrl+c 快捷键：保存内容 → 清空编辑器
 * 2. 历史队列存于 ~/.pi/agent/queue/cliphist.json，最多 15 条
 * 3. 每次保存的新条目排在最前
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MAX_HISTORY = 15;
const HIST_FILE = join(homedir(), ".pi", "agent", "queue", "cliphist.json");

/** 读取历史队列 */
function loadHistory(): string[] {
  try {
    if (!existsSync(HIST_FILE)) return [];
    const raw = readFileSync(HIST_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** 追加一条历史（最新在前），裁剪到 MAX_HISTORY 条 */
function pushHistory(text: string): void {
  if (!text.trim()) return;
  const hist = loadHistory();
  hist.unshift(text);
  if (hist.length > MAX_HISTORY) hist.length = MAX_HISTORY;
  mkdirSync(join(homedir(), ".pi", "agent", "queue"), { recursive: true });
  writeFileSync(HIST_FILE, JSON.stringify(hist, null, 2));
}

/** 获取历史队列（只读） */
export function getClipHistory(): string[] {
  return loadHistory();
}

export default function (pi: ExtensionAPI) {
  // ========== 快捷键绑定：释放原有的 app.clear ==========
  const keybindingsPath = join(getAgentDir(), "keybindings.json");
  let config: Record<string, string | string[]> = {};
  if (existsSync(keybindingsPath)) {
    try {
      const raw = readFileSync(keybindingsPath, "utf-8").trim();
      if (raw) config = JSON.parse(raw);
    } catch {}
  }

  // app.clear 从 ctrl+c 改为 shift+ctrl+c（保留手动清空能力）
  const clearKeys = config["app.clear"];
  if (clearKeys === undefined || clearKeys === "ctrl+c" ||
    (Array.isArray(clearKeys) && clearKeys.length === 1 && clearKeys[0] === "ctrl+c")) {
    config["app.clear"] = "shift+ctrl+c";
  } else if (Array.isArray(clearKeys) && clearKeys.includes("ctrl+c")) {
    const filtered = (clearKeys as string[]).filter((k: string) => k !== "ctrl+c");
    if (!filtered.includes("shift+ctrl+c")) filtered.push("shift+ctrl+c");
    config["app.clear"] = filtered;
  }

  // tui.input.copy 从 ctrl+c 改为 ctrl+insert
  const copyKeys = config["tui.input.copy"];
  if (copyKeys === undefined || copyKeys === "ctrl+c" ||
    (Array.isArray(copyKeys) && copyKeys.length === 1 && copyKeys[0] === "ctrl+c")) {
    config["tui.input.copy"] = "ctrl+insert";
  } else if (Array.isArray(copyKeys) && copyKeys.includes("ctrl+c")) {
    const filtered = (copyKeys as string[]).filter((k: string) => k !== "ctrl+c");
    if (!filtered.includes("ctrl+insert")) filtered.push("ctrl+insert");
    config["tui.input.copy"] = filtered;
  }

  writeFileSync(keybindingsPath, JSON.stringify(config, null, 2) + "\n");

  // ========== 注册 ctrl+c 快捷键：保存 → 清空 ==========
  pi.registerShortcut("ctrl+c", {
    description: "保存当前编辑器内容到历史队列后清空（/edit-gui 可恢复）",
    handler: async (ctx) => {
      try {
        const text = ctx.ui.getEditorText?.() ?? "";
        if (text.trim()) {
          pushHistory(text);
          ctx.ui.notify("内容已保存到历史队列。输入 /edit-gui 可回溯恢复。", "info");
        }
        ctx.ui.setEditorText("");
      } catch {
        ctx.ui.notify("Ctrl+C 保存失败", "error");
      }
      return true;
    },
  });
}
