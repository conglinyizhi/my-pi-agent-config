// sandbox-guard — 敏感路径黑名单防护（恶意 skill 防护）
//
// 背景（2026-08 用户需求）：恶意/不可信 skill 可能诱导模型读取敏感文件
// （浏览器密码、加密钱包密钥、API 密钥等）并外传。本扩展在工具层拦截：
//   read / write / edit 的目标路径、bash 命令中引用的路径，命中黑名单即拒绝。
//
// 黑名单文件：~/.pi/agent/sandbox-blacklist.json（git 跟踪的路径模式，本身不敏感）
//   - 格式：{ "blacklist": ["glob 模式", ...] }
//   - glob 支持：~ 展开为 home；** 递归；* 单段（不含 /）；? 单字符
//   - 读取时机：session_start（初始化与 /reload 都会触发）时读取并编译
//
// 拦截点（pi.on("tool_call")，返回 { block: true, reason } 阻止执行）：
//   read    → 参数 path
//   write   → 参数 path（黑名单 + 仅写保护路径）
//   edit    → 参数 path（黑名单 + 仅写保护路径）
//   bash    → 参数 command 中的路径引用（保守匹配：命中任一黑名单模式的
//             展开前缀即拒绝——命令可能经变量/拼接间接读，检测不完美但安全优先）
//
// 仅写保护路径（合并自原 protected-paths 扩展）：只拦 write/edit，不拦 read。
//   .git/ 与 node_modules/ 是工程级路径，模型需要读（如查 node_modules 类型），
//   但不应写；.env* 比黑名单（.env / .env.local）更宽，覆盖 .env.production 等。
//
// 注意：本扩展加载于主进程；subagent 子进程（--no-extensions）不加载本扩展，
// 但其 bash 已由沙箱限制在 worktree，且子进程的敏感读取由主进程的 skill
// 注入场景经本拦截兜底（模型在主进程的 read/bash 已被拦）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, resolve, sep } from "node:path";

const AGENT_DIR = getAgentDir();
const BLACKLIST_PATH = join(AGENT_DIR, "sandbox-blacklist.json");
const HOME = homedir();

// ── glob → 正则（最小实现：** 递归、* 单段、? 单字符） ──

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // **：跨目录任意（含空）；后随 / 时连斜杠一起吞
        if (pattern[i + 2] === sep || pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if ("\\.^$+{}()|[]".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** 展开 ~ 并把反斜杠统一为正斜杠便于匹配 */
function expand(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized === "~" || normalized.startsWith("~/")) {
    return join(HOME, normalized.slice(2)).replaceAll("\\", "/");
  }
  return normalized;
}

interface CompiledRule {
  pattern: string;
  re: RegExp;
  /** 展开后的固定前缀（用于 bash 命令里的粗匹配；~/.ssh → /home/u/.ssh 与 ~/.ssh） */
  prefix: string;
  tildePrefix: string;
}

function compileRule(raw: string): CompiledRule | null {
  const expanded = expand(raw.trim());
  if (!expanded) return null;
  try {
    const re = globToRegExp(expanded);
    // 固定前缀：去掉末尾通配段（~/.ssh/** → ~/.ssh）
    const staticPart = expanded.replace(/[/\\]?\*\*.*$/, "").replace(/[/\\]?\*[^/]*$/, "");
    return {
      pattern: raw.trim(),
      re,
      prefix: staticPart,
      tildePrefix: raw.trim().replace(/[/\\]?\*\*.*$/, "").replace(/[/\\]?\*[^/]*$/, ""),
    };
  } catch {
    return null;
  }
}

// ── 黑名单加载（session_start 时读取，reload 随扩展重载重新触发） ──

export function loadBlacklist(): CompiledRule[] {
  try {
    const raw = readFileSync(BLACKLIST_PATH, "utf8");
    const data = JSON.parse(raw) as { blacklist?: string[] };
    return (data.blacklist ?? []).map(compileRule).filter((r): r is CompiledRule => r !== null);
  } catch {
    return [];
  }
}

/** 目标路径是否命中黑名单（路径规范化：绝对化 + realpath 存在时解析符号链接） */
export function pathBlocked(path: string, cwd: string, rules: CompiledRule[]): boolean {
  if (!path) return false;
  // 先展开 ~ 再绝对化（避免 resolve 把 "~/.ssh/…" 变成 "/cwd/~/.ssh/…"）
  const expanded = expand(path);
  let abs: string;
  try {
    abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  } catch {
    abs = expanded;
  }
  // 存在时 realpath（防符号链接绕过）
  let canonical = abs;
  try {
    canonical = expand(realpathSync(abs));
  } catch {
    // 文件不存在：用绝对化路径匹配
  }
  for (const rule of rules) {
    if (rule.re.test(canonical) || rule.re.test(abs)) return true;
  }
  return false;
}

/** bash 命令中是否引用黑名单路径（保守前缀匹配；含 ~ 形式与展开形式） */
export function commandBlocked(command: string, rules: CompiledRule[]): boolean {
  if (!command) return false;
  for (const rule of rules) {
    if (!rule.prefix) continue;
    // ~/.ssh 形式（原样）与 /home/u/.ssh（展开）
    if (rule.tildePrefix && command.includes(rule.tildePrefix)) return true;
    if (rule.prefix && command.includes(rule.prefix)) return true;
    // 项目级 .env（无 ~）：匹配路径段
    if (!rule.prefix.startsWith("/") && command.includes("/" + rule.prefix)) return true;
  }
  return false;
}

function blockedReason(kind: string, target: string, rule: CompiledRule): string {
  return `[sandbox-guard] ${kind} 命中敏感路径黑名单（${rule.pattern}）：${target}。为防恶意 skill 泄露凭据已拒绝。`;
}

// ── 仅写保护路径（原 protected-paths 扩展并入） ──
// 黑名单是「防读也防写」的敏感凭据路径；而这里只拦 write/edit，不拦 read，
// 因为 .git/ 与 node_modules/ 模型经常需要读，但绝不该写。

const WRITE_ONLY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(?:^|\/)\.env(?:\.|$)/i, label: ".env*" },
  { re: /(?:^|\/)\.git\//i, label: ".git/" },
  { re: /(?:^|\/)node_modules\//i, label: "node_modules/" },
];

/** 目标路径是否命中「仅写保护」（write/edit 拦截，read 放行） */
export function writePathBlocked(path: string): boolean {
  if (!path) return false;
  return WRITE_ONLY_PATTERNS.some((p) => p.re.test(path));
}

// ── 扩展入口 ──

export default function (pi: ExtensionAPI) {
  // 初始化：factory 即加载（worker 子进程 --no-session 无 session_start，
  // 必须在此加载黑名单才能拦截）；/reload 重载扩展会重新执行 factory
  let rules: CompiledRule[] = loadBlacklist();

  const refresh = (): void => {
    rules = loadBlacklist();
  };

  // 双保险：session_start（含 reload）时刷新
  pi.on("session_start", (_event, ctx) => {
    refresh();
    ctx.ui.setStatus("sandbox-guard", rules.length > 0 ? `🔒 ${rules.length} 条黑名单` : undefined);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("sandbox-guard", undefined);
  });

  // 工具层拦截
  pi.on("tool_call", (event, ctx) => {
    const input = event.input as Record<string, unknown>;
    const path = typeof input?.path === "string" ? input.path : undefined;
    const command = typeof input?.command === "string" ? input.command : undefined;

    // read：仅黑名单（敏感凭据路径防读也防写）
    if (path !== undefined && event.toolName === "read") {
      const hit = rules.find((r) => pathBlocked(path, ctx.cwd, [r]));
      if (hit) {
        return { block: true, reason: blockedReason(`工具 ${event.toolName}`, path, hit) };
      }
    }
    // write / edit：黑名单 + 仅写保护路径（.git/、node_modules/、.env*）
    if (path !== undefined && (event.toolName === "write" || event.toolName === "edit")) {
      const hit = rules.find((r) => pathBlocked(path, ctx.cwd, [r]));
      if (hit) {
        return { block: true, reason: blockedReason(`工具 ${event.toolName}`, path, hit) };
      }
      const wp = WRITE_ONLY_PATTERNS.find((p) => p.re.test(path));
      if (wp) {
        return { block: true, reason: `[sandbox-guard] ${event.toolName} 目标路径受保护（${wp.label}）：${path}。为防止误改工程/配置路径已拒绝。` };
      }
    }
    // bash：命令中的路径引用（保守拦截）
    if (command !== undefined && event.toolName === "bash") {
      const hit = rules.find((r) => commandBlocked(command, [r]));
      if (hit) {
        return { block: true, reason: blockedReason("bash 命令", command.slice(0, 120), hit) };
      }
    }
    return undefined;
  });
}
