// lib/preshell.ts — 命令事实层（preshell 子进程适配）
//
// 背景：本仓的命令审核原先是「黑名单模式对原始命令文本做子串匹配」+ token 化规则。
// 子串匹配会把引号里的字符串（grep "process.env"）、词内片段（env-prep.sh）、
// 模板文件名（.env.example）都当成命中的路径；同时又会漏掉相对路径
// （cd ~/.pi/agent && sed -n '610,630p' providers.toml 一次都没被拦）。
//
// preshell 是独立子进程的静态分析器：给它一条命令，它报出碰了什么路径（读/写/删/网络）、
// 跑了什么程序、哪里看不懂。它不做裁决，策略仍在本仓（调用方见 lib/sandbox-check.ts）。
//
// 契约（preshell 仓库 docs/integration.md）：
//   命令走 stdin，stdout 恰好一个 JSON；退出码 0 = 有报告，2 = 用法错误，其它 = 工具没跑起来
//   --version → {"tool":"preshell","version":"0.1.0","schema":1}：解析形状锁 schema
//   拿不到报告（缺二进制/超时/坏 JSON）时默认动作是保守兜底，绝不因此放行
//
// 缺省二进制：~/.pi/runtime/preshell，可用 extensions.toml 的 [preshell] 覆盖。

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface PreshellEffect {
  kind: string;
  target: string;
  /** 目标不是封闭集合（有洞或通配）：`rm -rf $DIR/*` 报不出一份完整文件表 */
  dynamic?: boolean;
  /** false = 程序跑了，但它碰什么由它自己决定（git/node/python/docker 这类） */
  modeled?: boolean;
  line?: number;
}

export interface PreshellReport {
  version?: number;
  status?: string;
  impact?: {
    effects?: PreshellEffect[];
    write_roots?: string[];
    uncertain?: boolean;
    cwd?: string;
  };
  issues?: unknown[];
}

/** 从报告里挑出决策用得上的那几样 */
export interface PreshellFacts {
  status: string;
  /** true = 这份影响面不是封闭集合。不可读成「没报写就是不写」 */
  uncertain: boolean;
  /** 命令内部 cd 过的目录：报告里的相对路径以它为基准 */
  cwd?: string;
  effects: PreshellEffect[];
  /** Exec/Spawn 里 modeled: false 的程序名（git/node/... 它们碰什么不由命令行决定） */
  unmodeled: string[];
  /** Net 目标 */
  net: string[];
  writeRoots: string[];
}

export type PreshellUnavailableReason = "disabled" | "missing" | "timeout" | "exit" | "bad-json" | "schema";

export type PreshellOutcome =
  | { ok: true; facts: PreshellFacts; version: string }
  | { ok: false; reason: PreshellUnavailableReason; detail?: string };

export interface PreshellConfig {
  enabled: boolean;
  bin: string;
  timeoutMs: number;
  /** 期望的契约版本；不一致按「事实层不可用」处理（保守兜底） */
  schema: number;
}

/** 缺省二进制位置：重启不丢（/tmp 是内存盘） */
export const DEFAULT_PRESHELL_BIN = "~/.pi/runtime/preshell";
export const DEFAULT_TIMEOUT_MS = 2000;
/** 我们验证过的 v0.1 契约版本 */
export const EXPECTED_SCHEMA = 1;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** 读 extensions.toml 的 [preshell]；缺失/写坏按缺省（默认启用，缺省值保守） */
export function loadPreshellConfig(path = join(getAgentDir(), "extensions.toml")): PreshellConfig {
  const fallback: PreshellConfig = {
    enabled: true,
    bin: DEFAULT_PRESHELL_BIN,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    schema: EXPECTED_SCHEMA,
  };
  try {
    const doc = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
    const section = (doc["preshell"] ?? {}) as Record<string, unknown>;
    const num = (value: unknown, byDefault: number): number =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : byDefault;
    return {
      enabled: section.enabled === undefined ? fallback.enabled : section.enabled === true,
      bin: typeof section.bin === "string" && section.bin.trim() ? section.bin.trim() : fallback.bin,
      timeoutMs: num(section.timeoutMs, fallback.timeoutMs),
      schema: num(section.schema, fallback.schema),
    };
  } catch {
    return fallback;
  }
}

export function resolvePreshellBin(config: PreshellConfig = loadPreshellConfig()): string {
  // PRESHELL_BIN 优先：与他们文档推荐的封装姿势一致，也方便测试指向替身
  const fromEnv = process.env.PRESHELL_BIN;
  return expandHome(fromEnv && fromEnv.trim() ? fromEnv.trim() : config.bin);
}

export function factsFromReport(report: PreshellReport): PreshellFacts {
  const impact = report.impact ?? {};
  const effects = impact.effects ?? [];
  return {
    status: report.status ?? "?",
    uncertain: impact.uncertain === true,
    ...(impact.cwd ? { cwd: impact.cwd } : {}),
    effects,
    unmodeled: [
      ...new Set(
        effects
          .filter((e) => (e.kind === "Exec" || e.kind === "Spawn") && e.modeled === false)
          .map((e) => e.target),
      ),
    ],
    net: [...new Set(effects.filter((e) => e.kind === "Net").map((e) => e.target))],
    writeRoots: impact.write_roots ?? [],
  };
}

// ── 调用与缓存 ──

/** 有界缓存：同一条命令在一次会话里会被问好几遍（bash、审计、升权、重试） */
const MAX_CACHE = 200;
const cache = new Map<string, PreshellOutcome>();

export function clearPreshellCache(): void {
  cache.clear();
}

/** 每次进程只问一次 --version（版本/schema 是产物属性，不随命令变） */
const versionCache = new Map<string, { version: string; schema: number } | { error: PreshellUnavailableReason }>();

function queryVersion(bin: string, timeoutMs: number): { version: string; schema: number } | { error: PreshellUnavailableReason } {
  const hit = versionCache.get(bin);
  if (hit) return hit;
  let result: { version: string; schema: number } | { error: PreshellUnavailableReason };
  try {
    const proc = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: timeoutMs });
    if (proc.error) {
      result = { error: (proc.error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "exit" };
    } else if (proc.status !== 0) {
      result = { error: "exit" };
    } else {
      const parsed = JSON.parse(proc.stdout) as { version?: unknown; schema?: unknown };
      result =
        typeof parsed.version === "string" && typeof parsed.schema === "number"
          ? { version: parsed.version, schema: parsed.schema }
          : { error: "bad-json" };
    }
  } catch {
    result = { error: "bad-json" };
  }
  versionCache.set(bin, result);
  return result;
}

/** 测试用：清掉版本探测缓存 */
export function resetPreshellVersionCache(): void {
  versionCache.clear();
}

/**
 * 分析一条命令。任何异常都翻成 ok:false + reason，不抛：调用方据此走保守兜底。
 */
export function analyzeCommand(command: string, opts: { config?: PreshellConfig } = {}): PreshellOutcome {
  const config = opts.config ?? loadPreshellConfig();
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const bin = resolvePreshellBin(config);
  const key = `${bin}\u0000${command}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const outcome = ((): PreshellOutcome => {
    const version = queryVersion(bin, config.timeoutMs);
    if ("error" in version) return { ok: false, reason: version.error };
    if (version.schema !== config.schema) {
      return { ok: false, reason: "schema", detail: `工具报 schema=${version.schema}，期望 ${config.schema}` };
    }
    try {
      const proc = spawnSync(bin, ["--shell=probe"], {
        input: command,
        encoding: "utf8",
        timeout: config.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (proc.error) {
        const code = (proc.error as NodeJS.ErrnoException).code;
        return { ok: false, reason: code === "ENOENT" ? "missing" : code === "ETIMEDOUT" ? "timeout" : "exit", detail: proc.error.message };
      }
      if (proc.status !== 0) return { ok: false, reason: "exit", detail: `退出码 ${proc.status}` };
      const report = JSON.parse(proc.stdout) as PreshellReport;
      return { ok: true, facts: factsFromReport(report), version: version.version };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: /timed? ?out/i.test(message) ? "timeout" : "bad-json", detail: message };
    }
  })();

  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, outcome);
  return outcome;
}

/** 事实 → 给模型/人看的紧凑文本（LLM 预审与审计条目共用，措辞保持同一套） */
export function formatFacts(facts: PreshellFacts, limit = 12): string {
  const byKind = (kinds: string[]) =>
    facts.effects
      .filter((e) => kinds.includes(e.kind))
      .slice(0, limit)
      .map((e) => `${e.target}${e.dynamic ? "（目标不封闭）" : ""}${e.modeled === false ? "（未建模）" : ""}`);
  const lines: string[] = [];
  const read = byKind(["Read"]);
  const write = byKind(["Write", "Delete"]);
  const exec = [...new Set(facts.effects.filter((e) => e.kind === "Exec" || e.kind === "Spawn").map((e) => e.target))].slice(0, limit);
  if (exec.length > 0) lines.push(`- 程序：${exec.join(" ")}`);
  if (read.length > 0) lines.push(`- 读：${read.join(" ")}`);
  if (write.length > 0) lines.push(`- 写/删：${write.join(" ")}`);
  if (facts.net.length > 0) lines.push(`- 网络：${facts.net.slice(0, limit).join(" ")}`);
  if (facts.unmodeled.length > 0) lines.push(`- 未建模程序（它们碰什么不由命令行决定）：${facts.unmodeled.join(" ")}`);
  lines.push(`- 解析：${facts.status}${facts.cwd ? ` · cwd=${facts.cwd}` : ""}${facts.uncertain ? " · uncertain（影响面不封闭，「没报写」不等于「不写」）" : ""}`);
  return lines.join("\n");
}
