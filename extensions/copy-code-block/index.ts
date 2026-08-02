// copy-code-block：/copy-code-block 复制当前会话的代码块到剪贴板
//
// 用法：
//   /copy-code-block          交互选择（TUI）后复制
//   /copy-code-block 3        直接复制第 3 个（非 TUI 模式可用）
//
// 代码块从当前会话消息中提取（assistant 与 user 的 ``` 围栏块），
// 每个代码块标注「距最近用户发言的回合数」（user 消息内为 0），
// 按该距离升序排列：离用户最近的排最前，重编号后 #1 即最近。
// 剪贴板按 wl-copy → xclip → xsel → pbcopy 依次尝试。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

interface CodeBlock {
  /** 排序后序号，从 1 开始（离用户最近的为 1） */
  index: number;
  /** 距最近用户发言的回合数：user 消息内为 0，assistant 回复从 1 递增 */
  dist: number;
  lang: string;
  code: string;
  role: "assistant" | "user";
  lines: number;
  firstLine: string;
}

// ---------------------------------------------------------------------------
// 提取代码块
// ---------------------------------------------------------------------------

function isTextContent(c: unknown): c is { type: "text"; text: string } {
  if (typeof c !== "object" || c === null) return false;
  const obj = c as { type?: unknown; text?: unknown };
  return obj.type === "text" && typeof obj.text === "string";
}

/** 从消息 content（string 或块数组）提取纯文本，排除 thinking */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextContent)
    .map((c) => c.text)
    .join("\n");
}

const FENCE = /```([\w+#.-]*)\r?\n([\s\S]*?)```/g;

function collectCodeBlocks(entries: unknown[]): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let dist = 0;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (e.type !== "message" || !e.message) continue;
    const role = e.message.role === "user" ? "user" : "assistant";
    if (role === "user") {
      dist = 0;
    } else {
      dist += 1;
    }
    const text = extractText(e.message.content);
    FENCE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FENCE.exec(text)) !== null) {
      const lang = (m[1] || "text").trim();
      const code = m[2].replace(/\r?\n$/, "");
      const lines = code.split("\n");
      const firstLine = lines.find((l) => l.trim())?.trim().slice(0, 60) ?? "";
      blocks.push({ index: blocks.length + 1, dist, lang, code, role, lines: lines.length, firstLine });
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// 剪贴板
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string): Promise<{ ok: true; tool: string } | { ok: false; errors: string[] }> {
  const CLIP_TIMEOUT = 3000;
  const errors: string[] = [];
  const candidates: { name: string; shellCmd: string }[] = [
    { name: "wl-copy", shellCmd: `wl-copy '${text.replace(/'/g, "'\\''")}'` },
    { name: "xclip", shellCmd: `echo '${text.replace(/'/g, "'\\''")}' | xclip -selection clipboard` },
    { name: "xsel", shellCmd: `echo '${text.replace(/'/g, "'\\''")}' | xsel -ib` },
    { name: "pbcopy", shellCmd: `echo '${text.replace(/'/g, "'\\''")}' | pbcopy` },
  ];
  for (const { name, shellCmd } of candidates) {
    try {
      await execAsync(shellCmd, { timeout: CLIP_TIMEOUT, killSignal: "SIGKILL", encoding: "utf-8" });
      return { ok: true, tool: name };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      errors.push(`${name}: ${err.stderr?.trim() || err.message?.slice(0, 120) || "未知错误"}`);
    }
  }
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// TUI 选择
// ---------------------------------------------------------------------------

function pickBlock(ctx: ExtensionCommandContext, blocks: CodeBlock[]): Promise<CodeBlock | null> {
  const items: SelectItem[] = blocks.map((b) => ({
    value: String(b.index - 1),
    label: `#${b.index}  距上问 ${b.dist} 轮  ${b.lang}  ${b.firstLine || "(空代码块)"}`,
    description: `${b.role === "user" ? "你" : "林汐"} · ${b.lines} 行`,
  }));

  return ctx.ui.custom<CodeBlock | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold(`代码块 · 当前会话共 ${blocks.length} 个`))));
    container.addChild(new Text(theme.fg("dim", "↑↓ 选择 · Enter 复制 · Esc 取消")));
    const selectList = new SelectList(items, Math.min(items.length, 14), getSelectListTheme());
    selectList.onSelect = (item) => done(blocks[Number(item.value)]);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
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

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

async function handleCopyCodeBlock(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const blocks = collectCodeBlocks(ctx.sessionManager.getEntries());
  if (blocks.length === 0) {
    ctx.ui.notify("当前会话没有代码块", "info");
    return;
  }

  // 按距最近用户发言的回合数升序（近的在前），同距保持会话内顺序，再重编号
  blocks.sort((a, b) => a.dist - b.dist || a.index - b.index);
  blocks.forEach((b, i) => {
    b.index = i + 1;
  });

  // 可选参数：直接指定编号，跳过选择
  const argNum = Number(args.trim());
  let chosen: CodeBlock | null = null;
  if (Number.isInteger(argNum) && argNum >= 1 && argNum <= blocks.length) {
    chosen = blocks[argNum - 1];
  } else if (ctx.mode === "tui") {
    chosen = await pickBlock(ctx, blocks);
  } else {
    ctx.ui.notify(`非 TUI 模式：请用 /copy-code-block <1-${blocks.length}> 指定编号`, "warning");
    return;
  }

  if (!chosen) {
    ctx.ui.notify("已取消", "info");
    return;
  }

  const result = await copyToClipboard(chosen.code);
  if (result.ok) {
    ctx.ui.notify(`已复制代码块 #${chosen.index}（距上问 ${chosen.dist} 轮，${chosen.lang}，${chosen.lines} 行）`, "info");
  } else {
    ctx.ui.notify(`复制失败：${result.errors.join("；")}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-code-block", {
    description: "选择当前会话的代码块并复制到剪贴板（用法：/copy-code-block [编号]）",
    handler: handleCopyCodeBlock,
  });
}
