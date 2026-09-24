// render.ts — sandbox-allow 的 TUI 展示（纯字符串组装，便于单测）
//
// 为什么需要它：这个工具原先没有渲染器，走 pi 的兜底展示——调用行只有工具名，
// 结果区只预览 10 行。结果是「模型要跑什么命令、申请了什么权限」在执行前后都看不见，
// 与 bash 的观感差很远。这里把两件事拼出来：
//   1. 调用行：命令首行 + 权限摘要（write-paths 几个根 / full-access）+ 时限与内存 + 理由
//   2. 结果区：bash 式尾部窗口（不展开看最新几行，展开看更多）+ 页脚（退出码/权限/全量输出路径）

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_MEMORY_MB } from "./helpers.ts";

/** 渲染只用到 fg / bold 两个主题能力，取最小接口以便单测用无着色主题 */
export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface SandboxAllowCallInput {
  command?: unknown;
  permission?: unknown;
  paths?: unknown;
  justification?: unknown;
  timeout?: unknown;
  memoryMb?: unknown;
}

export interface SandboxAllowResultInput {
  exitCode?: number | null;
  permission?: string;
  writePaths?: string[];
  memoryMb?: number;
  timeout?: number;
  fullOutputPath?: string;
}

/** 命令首行与理由的展示宽度上限：调用行要能一眼扫完 */
export const CALL_COMMAND_MAX = 100;
export const CALL_REASON_MAX = 60;
/** 折叠态显示多少行（尾部窗口，最新动向在最下面） */
export const COLLAPSED_TAIL_LINES = 15;
/** 展开态的硬上限：再长就该去看全量输出文件了 */
export const EXPANDED_MAX_LINES = 400;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (visibleWidth(flat) <= max) return flat;
  return truncateToWidth(flat, max, "…");
}

/** 权限摘要：这是用户在调用行上最该先看到的一行 */
export function describePermission(permission: unknown, paths: unknown): string {
  if (permission === "full-access") return "full-access（本次取消文件系统沙箱）";
  if (permission === "write-paths") {
    const roots = Array.isArray(paths) ? paths.filter((p) => typeof p === "string" && p.trim()) : [];
    return `write-paths（${roots.length} 个可写根）`;
  }
  return "权限未定";
}

export function formatCallText(input: SandboxAllowCallInput, theme: RenderTheme): string {
  const parts = [describePermission(input.permission, input.paths)];
  if (typeof input.timeout === "number" && Number.isFinite(input.timeout)) {
    parts.push(`时限 ${Math.floor(input.timeout)}s`);
  }
  if (typeof input.memoryMb === "number" && Number.isFinite(input.memoryMb)) {
    parts.push(`内存 ${Math.floor(input.memoryMb)}MB`);
  }
  let text = theme.fg("toolTitle", theme.bold("sandbox-allow")) + theme.fg("dim", " · ") + theme.fg("muted", parts.join(" · "));
  const command = typeof input.command === "string" ? input.command : "";
  if (command) {
    text += `\n  ${theme.fg("dim", "$ ")}${oneLine(command, CALL_COMMAND_MAX)}`;
  }
  const justification = typeof input.justification === "string" ? input.justification : "";
  if (justification) {
    text += `\n  ${theme.fg("dim", "理由：")}${oneLine(justification, CALL_REASON_MAX)}`;
  }
  return text;
}

/** 结果页脚：退出码 + 本次权限 + 可写根 + 内存上限 + 全量输出位置 */
export function formatResultFooter(input: SandboxAllowResultInput, theme: RenderTheme): string {
  const parts: string[] = [];
  if (input.exitCode !== undefined && input.exitCode !== null) parts.push(`退出码 ${input.exitCode}`);
  if (input.permission === "full-access") {
    parts.push("full-access");
  } else if (input.permission === "write-paths") {
    const roots = (input.writePaths ?? []).filter(Boolean);
    parts.push(roots.length > 0 ? `额外可写：${roots.join("、")}` : "无额外可写根");
  }
  if (typeof input.timeout === "number" && Number.isFinite(input.timeout)) parts.push(`时限 ${Math.floor(input.timeout)}s`);
  parts.push(input.memoryMb === undefined ? `内存默认 ${DEFAULT_MEMORY_MB}MB` : `内存 ${input.memoryMb}MB`);
  let footer = theme.fg("dim", parts.join(" · "));
  if (input.fullOutputPath) {
    footer += `\n${theme.fg("muted", `全量输出：${input.fullOutputPath}`)}`;
  }
  return footer;
}

export interface ResultViewOptions {
  expanded: boolean;
  footer: string;
}

/**
 * 结果区：尾部窗口 + 省略提示 + 页脚。
 * 折叠态只给最后 COLLAPSED_TAIL_LINES 行（正在跑的时候最新几行最有用），
 * 展开态给到 EXPANDED_MAX_LINES，再多的部分提示去看全量输出文件。
 */
export function formatResultText(output: string, opts: ResultViewOptions, theme: RenderTheme): string {
  const lines = output.length > 0 ? output.split("\n") : [];
  const window = opts.expanded ? EXPANDED_MAX_LINES : COLLAPSED_TAIL_LINES;
  const shown = lines.slice(-window);
  const skipped = lines.length - shown.length;
  const body = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
  const hints: string[] = [];
  if (skipped > 0) {
    const action = opts.expanded ? "已到展开上限，剩余部分看全量输出" : "展开看更早的行";
    hints.push(theme.fg("muted", `…（共 ${lines.length} 行，此处为最后 ${shown.length} 行；${action}）`));
  }
  return [body, ...hints, opts.footer].filter(Boolean).join("\n");
}
