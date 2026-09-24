// sandbox-guard — 敏感路径黑名单防护（恶意 skill 防护）
//
// 背景（2026-08 用户需求）：恶意/不可信 skill 可能诱导模型读取敏感文件
// （浏览器密码、加密钱包密钥、API 密钥等）并外传。本扩展在工具层拦截：
//   read / write / edit 的目标路径、bash 命令中引用的路径，命中黑名单即拒绝。
//
// 黑名单配置：extensions.toml 的 [sandbox-guard] section（git 跟踪，本身不敏感）
//   - 格式：blacklist = ["glob 模式", ...]
//   - glob 支持：~ 展开为 home；** 递归；* 单段（不含 /）；? 单字符
//   - 读取时机：session_start（初始化与 /reload 都会触发）时读取并编译
//
// 拦截点（pi.on("tool_call")，返回 { block: true, reason } 阻止执行）：
//   read / be-read                     → 参数 path / file（黑名单）
//   write / edit / be-write / be-replace / be-insert / be-delete / be-insert-chip
//                                      → 参数 path / file / to（黑名单 + 仅写保护路径 + worker 沙箱可写根）
//   （be-* 是 MCP 直挂的写通道，不挂上来就绕过了这一层；见 targetPathOf）
//   bash    → 2026-08 起不再在此拦截：bash 检查移至 extensions/bash-guard.ts
//             的 bash 工具内部（checkCommand 前置调用 commandBlocked）。
//             纯函数 commandBlocked/loadBlacklist 仍保留，供 lib/sandbox-check.ts 复用。
//
// 仅写保护路径（合并自原 protected-paths 扩展）：只拦 write/edit，不拦 read。
//   .git/ 与 node_modules/ 是工程级路径，模型需要读（如查 node_modules 类型），
//   但不应写；.env* 比黑名单（.env / .env.local）更宽，覆盖 .env.production 等。
//
// worker 沙箱可写根（2026-09 起）：subagent 派工的 readonly / sandbox_dir 过去只约束
// bash（sandbox-shell 的 landlock grants），worker 的写入类工具直接绕过，
// 「只读」档位名不符实。现在按同一份 env 契约在工具层补齐（见 readWorkerWriteScope）。
//
// 加载面：主进程加载本扩展；subagent 子进程由 lib/subagent-run.ts 经 `--extension`
// 显式加载 guard.ts（见该文件的 SANDBOX_GUARD_EXT），所以 worker 的读写拦截走的是同一份代码、
// 同一张黑名单；worker 的 bash 另有 subagent-bash-guard.ts 负责无 UI 审批链。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadSandboxPaths } from "./paths.ts";
import { yoloEnabled } from "./yolo.ts";

const AGENT_DIR = getAgentDir();
const EXTENSIONS_TOML = join(AGENT_DIR, "extensions.toml");
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
  const patterns: string[] = [];
  try {
    const doc = parseToml(readFileSync(EXTENSIONS_TOML, "utf8")) as Record<string, unknown>;
    const section = (doc["sandbox-guard"] ?? {}) as { blacklist?: unknown };
    if (Array.isArray(section.blacklist)) {
      patterns.push(...section.blacklist.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    /* extensions.toml 缺失/损坏：仅用动态黑名单 */
  }
  // 动态黑名单目录（GUI 审核时用户添加的 block_dirs）：目录自身 + 目录下所有内容
  for (const dir of loadSandboxPaths().blockDirs) {
    patterns.push(dir, `${dir.replace(/\/+$/, "")}/**`);
  }
  return patterns.map(compileRule).filter((r): r is CompiledRule => r !== null);
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

/** 命令里命中的黑名单条目 */
export interface BlacklistCommandHit {
  /** 配置里写的那条模式原文（如 ".env" / "~/.ssh/**"） */
  pattern: string;
  /**
   * 命令里实际命中的片段。
   *
   * 返回命中串而不只是 true，是因为审批窗要把命中的那一段高亮给人看：
   * 光说「命中 .env 黑名单」不告诉人命中在命令的哪个位置。
   */
  token: string;
}

/**
 * 命令里命中的黑名单条目（保守前缀匹配；含 ~ 形式与展开形式）。
 *
 * 一次收全部命中而不是「命中就返回」：同一道命令可能同时踩 .env 与 ~/.ssh，
 * 审批窗要把几条都列出来（patterns 去重由调用方做）。
 */
export function matchBlacklistHits(command: string, rules: CompiledRule[]): BlacklistCommandHit[] {
  const hits: BlacklistCommandHit[] = [];
  if (!command) return hits;
  for (const rule of rules) {
    // 全通配模式（如 "**/.env"）编译后没有静态前缀，拿它做子串匹配会把任何带 / 的命令都算命中：直接跳过
    if (!rule.prefix) continue;
    // ~/.ssh 形式（原样）与 /home/u/.ssh（展开）
    if (rule.tildePrefix && command.includes(rule.tildePrefix)) {
      hits.push({ pattern: rule.pattern, token: rule.tildePrefix });
      continue;
    }
    if (command.includes(rule.prefix)) {
      hits.push({ pattern: rule.pattern, token: rule.prefix });
      continue;
    }
    // 项目级 .env（无 ~）：匹配路径段
    if (!rule.prefix.startsWith("/") && command.includes("/" + rule.prefix)) {
      hits.push({ pattern: rule.pattern, token: "/" + rule.prefix });
    }
  }
  return hits;
}

/** bash 命令中是否引用黑名单路径（保守前缀匹配；含 ~ 形式与展开形式） */
export function commandBlocked(command: string, rules: CompiledRule[]): boolean {
  return matchBlacklistHits(command, rules).length > 0;
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

// ── worker 沙箱可写根（subagent 派工的 readonly / worktree 档位） ──
// readonly 与 sandbox_dir 过去只约束 bash（由 scripts/sandbox-shell.mjs 的 landlock
// grants 执行），而 worker 白名单里的写入类工具不过那一层：标了「只读」的 worker
// 照样能把文件写进工作区，名不符实（2026-09-23 实测）。这里把同一份边界补到
// 写入类工具上，可写根与 sandbox-shell 的 grants 对齐：
//   /tmp（内置临时区）+（非只读时）PI_SANDBOX_RW + PI_SANDBOX_RW_EXTRA
// RW_EXTRA 在只读档位下也生效：它是 sandbox-allow 一次性升权的通道，与 bash 一致。

/** worker 沙箱可写范围；主进程 / 未设档位 / 已降零时返回 undefined（不做额外拦截） */
export interface WorkerWriteScope {
  /** 绝对路径形式的可写根 */
  roots: string[];
  /** true = 只读档位（除内置临时区与显式 RW_EXTRA 外一律不可写） */
  readonly: boolean;
}

/** 与 sandbox-shell 的内置可写根对齐（/dev/null 不是写入类工具的目标，不列） */
const WORKER_BUILTIN_WRITABLE = ["/tmp"];

function splitRoots(raw: string | undefined): string[] {
  return (raw ?? "").split(":").map((p) => p.trim()).filter(Boolean);
}

/** 绝对化 + 尽量消解符号链接（目标不存在时回溯到最近的已存在祖先） */
function canonicalize(path: string, cwd: string): string {
  const expanded = expand(path);
  let abs: string;
  try {
    abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  } catch {
    return expanded;
  }
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      /* 不存在：退一级继续找已存在的祖先 */
    }
    const parent = dirname(current);
    if (parent === current) return abs;
    tail.push(basename(current));
    current = parent;
  }
}

/** 读 worker 沙箱可写范围（纯函数，env 可注入便于单测） */
export function readWorkerWriteScope(env: NodeJS.ProcessEnv = process.env): WorkerWriteScope | undefined {
  if (env.PI_SUBAGENT !== "1") return undefined;
  // 降零（/yolo 或 full-access 升权）：不在这里拦
  if (env.PI_SANDBOX_DISABLE === "1") return undefined;
  const readonly = env.PI_SANDBOX_READONLY === "1";
  const declared = [...(readonly ? [] : splitRoots(env.PI_SANDBOX_RW)), ...splitRoots(env.PI_SANDBOX_RW_EXTRA)];
  if (!readonly && declared.length === 0) return undefined;
  const roots = [...WORKER_BUILTIN_WRITABLE];
  for (const root of declared) {
    const abs = canonicalize(root, process.cwd());
    if (!roots.includes(abs)) roots.push(abs);
  }
  return { roots, readonly };
}

/** 路径是否落在某个可写根内（按路径段边界，防 /tmpfoo 冒充 /tmp） */
function withinRoot(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

/**
 * worker 的写入是否越出沙箱可写根；越界时返回给模型看的拒绝理由。
 */
export function workerWriteBlocked(path: string, cwd: string, scope: WorkerWriteScope): string | undefined {
  if (!path) return undefined;
  const target = canonicalize(path, cwd);
  if (scope.roots.some((root) => withinRoot(target, root))) return undefined;
  const mode = scope.readonly
    ? `只读档位（可写：${scope.roots.join("、")}）`
    : `worktree 档位（可写：${scope.roots.join("、")}）`;
  return `[sandbox-guard] ${path} 不在本批 worker 的沙箱可写根内（${mode}）。`
    + `worker 的写入被限制在派工时指定的范围，需要改这里就把改动范围报给主 agent，由主 agent 调整 sandbox_dir 或自己动手。`;
}

// ── 目标路径提取（内置 read/write/edit 与 better-edit-tools 的 be-*） ──
// be-* 是 MCP 直挂工具，参数用的是 `file`（可带 `:行范围` / `:ALL` 后缀），
// 只挂内置 write/edit 会留下一条完全绕开黑名单与 worker 写入边界的通道
// （2026-09-23 实测：readonly worker 用 be-write 成功写了工作区）。

/** 工具名 → 目标路径字段+是否剥 `:行范围` 后缀 */
const READ_TARGET: Record<string, { field: string; rangeSuffix: boolean }> = {
  read: { field: "path", rangeSuffix: false },
  "be-read": { field: "file", rangeSuffix: true },
  // be-insert-chip 的 from 可以是 file://（从某文件取内容插到另一处）——取内容也是读
  "be-insert-chip": { field: "from", rangeSuffix: false },
};

const WRITE_TARGET: Record<string, { field: string; rangeSuffix: boolean }> = {
  write: { field: "path", rangeSuffix: false },
  edit: { field: "path", rangeSuffix: false },
  "be-write": { field: "file", rangeSuffix: true },
  "be-replace": { field: "file", rangeSuffix: true },
  "be-insert": { field: "file", rangeSuffix: true },
  "be-delete": { field: "file", rangeSuffix: true },
  // 插入目标写成 file:///abs/path:line
  "be-insert-chip": { field: "to", rangeSuffix: true },
};

/**
 * 取本次工具调用的目标路径；不是读写类工具或没带路径就返回 undefined。
 *
 * be-trx 的 rollback/status 不带路径（它只能回滚本会话已经写过的快照，
 * 而那些写已经过一次同样的边界检查），所以不在表里。
 */
export function targetPathOf(
  toolName: string,
  input: unknown,
  kind: "read" | "write",
): string | undefined {
  const spec = (kind === "read" ? READ_TARGET : WRITE_TARGET)[toolName];
  if (!spec || !input || typeof input !== "object") return undefined;
  const raw = (input as Record<string, unknown>)[spec.field];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  // chip 缓存不是文件系统路径，不参与路径拦截
  if (raw.startsWith("chip://")) return undefined;
  const stripped = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
  return spec.rangeSuffix ? stripped.replace(/:(?:\d+(?:-\d+)?|ALL)$/i, "") : stripped;
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
  // 黑名单规则数不显示在状态栏（用户反馈用处不多，已隐藏）
  pi.on("session_start", (_event, _ctx) => {
    refresh();
  });

  // 工具层拦截
  pi.on("tool_call", (event, ctx) => {
    // yolo：跳过 read/write 黑名单（全部降零，不再拦截敏感路径）
    if (yoloEnabled()) return undefined;

    const input = event.input as Record<string, unknown>;
    // 读写表分开查：同一个工具只可能在一张表里，用错 kind 会让整条写入通道静默失效
    const readPath = targetPathOf(event.toolName, input, "read");
    const writePath = targetPathOf(event.toolName, input, "write");

    // read / be-read：仅黑名单（敏感凭据路径防读也防写）
    if (readPath !== undefined) {
      const hit = rules.find((r) => pathBlocked(readPath, ctx.cwd, [r]));
      if (hit) {
        return { block: true, reason: blockedReason(`工具 ${event.toolName}`, readPath, hit) };
      }
    }
    // write / edit（含 be-* 写入通道）：黑名单 + 仅写保护路径（.git/、node_modules/、.env*）+ worker 可写根
    if (writePath !== undefined) {
      const hit = rules.find((r) => pathBlocked(writePath, ctx.cwd, [r]));
      if (hit) {
        return { block: true, reason: blockedReason(`工具 ${event.toolName}`, writePath, hit) };
      }
      const wp = WRITE_ONLY_PATTERNS.find((p) => p.re.test(writePath));
      if (wp) {
        return { block: true, reason: `[sandbox-guard] ${event.toolName} 目标路径受保护（${wp.label}）：${writePath}。为防止误改工程/配置路径已拒绝。` };
      }
      // worker 的写入边界：readonly / sandbox_dir 对 bash 生效的那一套，在写入类工具上同样强制
      const scope = readWorkerWriteScope();
      if (scope) {
        const outside = workerWriteBlocked(writePath, ctx.cwd, scope);
        if (outside) return { block: true, reason: outside };
      }
    }
    // bash：命令中的路径引用（保守拦截）
    // 2026-08 起 bash 检查已移至 extensions/bash-guard.ts 的工具内部（checkCommand
    // 前置调用 commandBlocked）。此处不再拦 bash，避免 guard hook 与工具内检查双重拦截。
    return undefined;
  });
}
