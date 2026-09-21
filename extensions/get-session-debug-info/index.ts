// get-session-debug-info：把排查要用的会话信息摊在 TUI 里，用户点同意才写进剪贴板。
//
// 为什么中间要隔一道确认：剪贴板是出口 —— 东西进了剪贴板，下一步往往就是粘进聊天发给别人。
// 让用户先看到「将要复制的是什么」，比复制完再解释省事得多。
//
// 剪贴板本身不在这里实现：lib/clipboard.ts 已经处理完平台路由、wl-copy 的 daemon 坑、
// 以及 remote 会话的 OSC 52 兜底。这里只负责「展示什么」与「怎么报结果」。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OSC52_TOOL, copyToClipboard, describeClipboardResult } from "../../lib/clipboard.ts";

const STATUS_ID = "get-session-debug-info";

/** 这几行要展示给用户，也是最后复制出去的东西 —— 两者必须同源，免得展示的和复制的悄悄不一致 */
export interface DebugInfoSource {
  cwd: string;
  sessionManager?: {
    getSessionId?(): string;
    getSessionFile?(): string | undefined;
  };
}

/**
 * 中英混排下算显示宽度：CJK 与全角符号占两列。
 * 直接用空格对齐会在「会话 ID」这种中英混排的标签上错位，标签列一歪，值也跟着歪。
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return width;
}

export function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/** 标签列宽度。比最长的标签（会话文件 = 8 列）再留两列空隙 */
const LABEL_WIDTH = 10;

/** 要展示、也要复制的那几行。纯函数，顺序即展示顺序 */
export function debugInfoLines(src: DebugInfoSource): string[] {
  const sm = src.sessionManager;
  const sessionId = sm?.getSessionId?.() ?? "";
  const sessionFile = sm?.getSessionFile?.() ?? "";
  return [
    `${padRight("会话 ID", LABEL_WIDTH)}${sessionId || "(拿不到)"}`,
    `${padRight("会话文件", LABEL_WIDTH)}${sessionFile || "(拿不到)"}`,
    `${padRight("当前路径", LABEL_WIDTH)}${src.cwd}`,
  ];
}

export interface DebugInfoDeps {
  /** 测试注入；生产走 lib/clipboard 的默认实现 */
  copy?: typeof copyToClipboard;
}

/** 命令本体。做成工厂是为了让测试注入 copy —— 不然冒烟测试会真的去 spawn wl-copy/xclip */
export function createDebugInfoHandler(deps: DebugInfoDeps = {}) {
  const copy = deps.copy ?? copyToClipboard;
  return async (_args: string, ctx: ExtensionContext): Promise<void> => {
    // 没有 UI 就不复制：这个命令的价值全在「用户看过再复制」，静默复制不算达成目的
    if (!ctx.hasUI) return;

    const text = debugInfoLines(ctx as unknown as DebugInfoSource).join("\n");
    const agreed = await ctx.ui.confirm("复制排查信息到剪贴板？", text);
    if (!agreed) return;

    const result = await copy(text, {
      onAttempt: (tool) => ctx.ui.setStatus(STATUS_ID, `正在尝试剪贴板工具 ${tool}…`),
    });
    ctx.ui.setStatus(STATUS_ID, undefined);

    const report = describeClipboardResult(result);
    // 没真写进去的时候把原文附上：用户至少能手动复制，不至于白跑一趟
    const wroteToClipboard = result.ok && result.tool !== OSC52_TOOL;
    ctx.ui.notify(wroteToClipboard ? report.message : `${report.message}\n${text}`, report.level);
  };
}

export default function getSessionDebugInfo(pi: ExtensionAPI): void {
  pi.registerCommand("get-session-debug-info", {
    description: "展示当前会话与路径，确认后复制到剪贴板",
    handler: createDebugInfoHandler(),
  });
}
