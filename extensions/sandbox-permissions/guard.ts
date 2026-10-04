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
//   read / grep / find / ls            → 参数 path（黑名单）
//   write / edit                       → 参数 path（黑名单 + 仅写保护路径 + worker 沙箱可写根）
//   （MCP 直挂工具的注册名是 mcp__<server>__<tool>，查表前剥前缀；表按原名维护，
//     见 targetPathOf —— 只挂内置工具、漏掉 MCP 的读写通道就留了一条绕开的路）
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
import { bareMcpToolName } from "../../lib/string-utils.ts";
import { isTrustedProgramPath } from "./trusted.ts";
import { beginSandboxSession, isSessionTrustedPath } from "./session-access.ts";
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

/** 词字符：紧贴着它的模式不算路径起点（`process.env` / `os.environ` 里的 `.env`） */
function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c);
}

/**
 * 找一个「有边界」的模式出现位置。
 *
 * 旧实现直接 `includes`，于是 `process.env`、`os.environ`、`.envrc` 都算命中（实测语料里
 * 26 条命令只因为这个子串而多问一次）。真路径总是被空白/引号/等号/斜杠围着，
 * 所以要求两侧都不能是词字符。
 *
 * checkBefore 只对「模式自己带路径起点」的形算：`/.env` 那一支的前一个字符是路径里的普通字符
 * （`foo/.env` 的 `o` 就不是边界），拿它判会把真路径一并放走。
 */
function findBoundedPattern(text: string, needle: string, checkBefore: boolean): number {
  let from = 0;
  while (from <= text.length) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) return -1;
    const beforeOk = !checkBefore || !isWordChar(idx === 0 ? undefined : text[idx - 1]);
    const afterOk = !isWordChar(text[idx + needle.length]);
    if (beforeOk && afterOk) return idx;
    from = idx + 1;
  }
  return -1;
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
    if (rule.tildePrefix && findBoundedPattern(command, rule.tildePrefix, true) !== -1) {
      hits.push({ pattern: rule.pattern, token: rule.tildePrefix });
      continue;
    }
    if (findBoundedPattern(command, rule.prefix, true) !== -1) {
      hits.push({ pattern: rule.pattern, token: rule.prefix });
      continue;
    }
    // 项目级 .env（无 ~）：匹配路径段。只查后边界：`/` 已把 `process.env` 这类排除了
    if (!rule.prefix.startsWith("/") && findBoundedPattern(command, "/" + rule.prefix, false) !== -1) {
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

/** 当前 session id：受保护路径的授权按 session 算（见 session-access.ts） */
let guardSessionId: string | undefined;

/**
 * 可信程序目录兼作**写入保护**。
 *
 * 一份名单两个方向，看着矛盾，其实是一件事：这些目录里是本机自己编译、自己维护的产物，
 * 「程序可信」所以可以执行，「产物重要」所以更不该被 agent 随手改。
 * 开启后：程序照跑，但写这些目录要过 sandbox-allow（人批）。
 * 名单默认为空——没启用时这个检查等于不存在（行为与从前完全一致）。
 */
export function trustedWriteBlockedReason(toolName: string, target: string): string | undefined {
  let hit: boolean;
  try {
    hit = isTrustedProgramPath(target);
  } catch {
    // 读配置出事（坏 JSON 等）：宁可当没启用，也不要因为一个读错就拦下所有写入
    return undefined;
  }
  if (!hit) return undefined;
  if (isSessionTrustedPath(target, guardSessionId, process.cwd())) return undefined;
  return (
    `[sandbox-guard] ${toolName} 目标路径受保护（可信程序目录）：${target}。` +
    `这里放的是本机自己编译/维护的产物：程序可以执行，但不许自动改写。` +
    `确实要改就用 sandbox-allow 申请（permission=write-paths，paths 指定这个目录），` +
    `人批过之后本次会话内可以写。`
  );
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

// ── worker 沙箱只读根（读面白名单） ──
// 与写入边界同理：worker 读的是不可信内容（三方仓库、网页、issue），读面就是潜在的外传源。
// bash 层由 sandbox-shell 的 landlock grants 收成白名单（--ro <具体目录>，不再是 --ro /），
// 这里把同一份白名单补到读取类工具上。两边读同一个配置文件、同一份 env 契约，
// 否则「bash 读得到、read 工具读不到」，或者反过来留一条完全绕开的通道。
//   白名单 = worker-read-roots.json + cwd + 可写根（RW / RW_EXTRA / /tmp）+ READ_EXTRA
// PI_SANDBOX_READ_OPEN=1 退回不拦（与 bash 层同一个逃生口）。

const WORKER_READ_ROOTS_FILE = join(AGENT_DIR, "extensions", "sandbox-permissions", "worker-read-roots.json");

/** 读只读根白名单文件（~ 写法保留，交给 canonicalize 展开）；读不到 / 坏 JSON → [] */
export function loadWorkerReadRoots(): string[] {
  try {
    const doc = JSON.parse(readFileSync(WORKER_READ_ROOTS_FILE, "utf8")) as { roots?: unknown };
    const list = Array.isArray(doc.roots) ? doc.roots : [];
    return list.filter((d): d is string => typeof d === "string" && d.trim().length > 0);
  } catch {
    return [];
  }
}

/** worker 的读面白名单；主进程 / 降零 / 读面开放时返回 undefined（不做额外拦截） */
export interface WorkerReadScope {
  /** 绝对路径形式的只读根 */
  roots: string[];
}

/** 读 worker 沙箱只读范围（纯函数，env 可注入便于单测） */
export function readWorkerReadScope(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): WorkerReadScope | undefined {
  if (env.PI_SUBAGENT !== "1") return undefined;
  if (env.PI_SANDBOX_DISABLE === "1") return undefined;
  if (env.PI_SANDBOX_READ_OPEN === "1") return undefined;
  const declared = [
    ...loadWorkerReadRoots(),
    cwd,
    ...splitRoots(env.PI_SANDBOX_RW),
    ...splitRoots(env.PI_SANDBOX_RW_EXTRA),
    ...WORKER_BUILTIN_WRITABLE,
    ...splitRoots(env.PI_SANDBOX_READ_EXTRA),
  ];
  const roots: string[] = [];
  for (const root of declared) {
    const abs = canonicalize(root, cwd);
    if (!roots.includes(abs)) roots.push(abs);
  }
  return { roots };
}

/** worker 的读取是否越出白名单；越界时返回给模型看的拒绝理由 */
export function workerReadBlocked(path: string, cwd: string, scope: WorkerReadScope): string | undefined {
  if (!path) return undefined;
  const target = canonicalize(path, cwd);
  if (scope.roots.some((root) => withinRoot(target, root))) return undefined;
  return `[sandbox-guard] ${path} 不在本批 worker 的只读白名单内。`
    + `worker 读的是不可信内容，读面被收成白名单（系统目录 + 工具链 + 工作目录）。`
    + `确实需要读这里，就把目录报给主 agent，由主 agent 通过派工参数决定。`;
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

// ── 目标路径提取（内置读/写/检索工具，以及带 MCP 前缀的同名工具） ──
// 名字形态：pi 内置 mcp 扩展把服务器工具注册成 `mcp__<server>__<tool>`，查表前先剥前缀，
// 表按工具原名维护，服务器改名 / 换工具源不用动这张表。
// 只挂内置工具、漏掉 MCP 直挂的读写通道，就留了一条完全绕开黑名单与 worker 写入
// 边界的路（2026-09-23 实测过：readonly worker 用 MCP 的写工具写进了工作区）。
// 接新的 MCP 工具时先看它的 schema：承载路径的字段名不一定是内置那套。

/** 工具名 → 承载目标路径的参数字段 */
const READ_TARGET: Record<string, string> = {
  read: "path",
  // 检索类工具同样是读通道：grep/find/ls 的 path 指向哪里，就能看见哪里的目录树
  grep: "path",
  find: "path",
  ls: "path",
};

const WRITE_TARGET: Record<string, string> = {
  write: "path",
  edit: "path",
};

/**
 * 取本次工具调用的目标路径；不是读写类工具或没带路径就返回 undefined。
 *
 * 不带路径的工具（回滚、状态查询这类）不进表：它们触及的对象要么是本会话已经
 * 过同一层检查的写入，要么压根不碰文件。
 */
export function targetPathOf(
  toolName: string,
  input: unknown,
  kind: "read" | "write",
): string | undefined {
  const field = (kind === "read" ? READ_TARGET : WRITE_TARGET)[bareMcpToolName(toolName)];
  if (!field || !input || typeof input !== "object") return undefined;
  const raw = (input as Record<string, unknown>)[field];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return raw.startsWith("file://") ? raw.slice("file://".length) : raw;
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
  pi.on("session_start", (_event, ctx) => {
    refresh();
    // 受保护路径的授权按 session 算，这里同步一下（bash-guard 也会调，幂等）
    guardSessionId = ctx.sessionManager.getSessionId();
    beginSandboxSession(guardSessionId);
  });

  // 工具层拦截
  pi.on("tool_call", (event, ctx) => {
    // yolo：跳过 read/write 黑名单（全部降零，不再拦截敏感路径）
    if (yoloEnabled()) return undefined;

    const input = event.input as Record<string, unknown>;
    // 读写表分开查：同一个工具只可能在一张表里，用错 kind 会让整条写入通道静默失效
    const readPath = targetPathOf(event.toolName, input, "read");
    const writePath = targetPathOf(event.toolName, input, "write");

    // read / grep / find / ls：黑名单（敏感凭据路径防读也防写）+ worker 读面白名单
    if (readPath !== undefined) {
      const hit = rules.find((r) => pathBlocked(readPath, ctx.cwd, [r]));
      if (hit) {
        return { block: true, reason: blockedReason(`工具 ${event.toolName}`, readPath, hit) };
      }
      const scope = readWorkerReadScope(undefined, ctx.cwd);
      if (scope) {
        const outside = workerReadBlocked(readPath, ctx.cwd, scope);
        if (outside) return { block: true, reason: outside };
      }
    }
    // write / edit（含 MCP 写通道）：黑名单 + 仅写保护路径（.git/、node_modules/、.env*）+ worker 可写根
    if (writePath !== undefined) {
      const hit = rules.find((r) => pathBlocked(writePath, ctx.cwd, [r]));
      if (hit) {
        return { block: true, reason: blockedReason(`工具 ${event.toolName}`, writePath, hit) };
      }
      const wp = WRITE_ONLY_PATTERNS.find((p) => p.re.test(writePath));
      if (wp) {
        return { block: true, reason: `[sandbox-guard] ${event.toolName} 目标路径受保护（${wp.label}）：${writePath}。为防止误改工程/配置路径已拒绝。` };
      }
      // 可信程序目录（人类列入）：那些目录里的东西自己编译/自己维护，程序可执行、文件不许自动改
      const trustedBlocked = trustedWriteBlockedReason(event.toolName, writePath);
      if (trustedBlocked) return { block: true, reason: trustedBlocked };
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
