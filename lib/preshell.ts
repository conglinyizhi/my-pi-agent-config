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
import { notify } from "./notify-send.ts";

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
    /** 被 max_effects 截掉的条数；>0 表示这份 effects 不完整 */
    effects_dropped?: number;
  };
  issues?: unknown[];
  /** 被 max_issues 截掉的条数 */
  issues_dropped?: number;
}

/** 从报告里挑出决策用得上的那几样 */
export interface PreshellFacts {
  status: string;
  /** true = 这份影响面不是封闭集合。不可读成「没报写就是不写」 */
  uncertain: boolean;
  /**
   * 被上限截掉的条数（工具的 max_effects / max_issues）。
   * 真实命令里几乎撞不到（抽样 3105 条全为 0），一旦 >0 就是「这份影响面不完整」，
   * 不能拿它当完备集合用。
   */
  effectsDropped: number;
  issuesDropped: number;
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
/**
 * 单次调用上限（毫秒）。
 *
 * 定 100ms 的依据（本机实测）：分析本身 5µs/命令（它自己的 --bench：20000 条 112ms），
 * 起进程约 2ms，本机 4.7 万条真实命令里 p99.9 是 8KB、最大 22KB，对应几毫秒；
 * 病态输入也只是：1MB heredoc 18ms、5000 段串联 11ms。100ms 是它们的十几倍。
 * 真正的收益在坏情况：二进制卡住时，每条命令的阻塞从 2s 降到 100ms。
 */
export const DEFAULT_TIMEOUT_MS = 100;
/** 我们验证过的 v0.1 契约版本 */
export const EXPECTED_SCHEMA = 1;

/**
 * 安装说明：通知、配置注释、文档共用一份，避免三处各写一句、各有出入。
 * 工具本身不回传安装方式（它只是个静态分析器），所以这段文字只能由调用方给。
 */
export const INSTALL_HINT = [
  "preshell 是命令审核的事实层（独立子进程，GPL-3.0-or-later，仓库 conglinyizhi/preshell）",
  "装它：gh release download v0.1 -R conglinyizhi/preshell -D /tmp/p && sha256sum -c /tmp/p/SHA256SUMS",
  "      install -Dm755 /tmp/p/preshell-v0.1-*.linux ~/.pi/runtime/preshell",
  "或自己编：moon build --release --target native（再 install 到同一路径）",
  "没装也能用：路径判定退回旧的匹配规则（更严、误报更多），不会放行也不会崩",
].join("\n");

/** 给人和模型看的一句话：为什么不可用、意味着什么 */
export function describeUnavailable(reason: PreshellUnavailableReason, detail?: string): string {
  const suffix = detail ? `（${detail}）` : "";
  switch (reason) {
    case "disabled":
      return "事实层已在配置里关闭（extensions.toml 的 [preshell] enabled=false）";
    case "missing":
      return `未安装或路径不对${suffix}`;
    case "timeout":
      return `调用超时${suffix}`;
    case "exit":
      return `工具没跑起来${suffix}`;
    case "bad-json":
      return `输出不是合法的报告${suffix}`;
    case "schema":
      return `契约版本不符${suffix}`;
  }
}

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
    effectsDropped: impact.effects_dropped ?? 0,
    issuesDropped: report.issues_dropped ?? 0,
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

/**
 * 熔断：失败到阈值就不再试。
 *
 * 分两类，因为两类失败的代价不一样：
 *   - 确定性失败（缺件、schema 不符）：不会自愈，一次就断（但每进程只试一次）
 *   - 瞬时失败（超时、坏 JSON、非零退出）：可能只是机器忙了一下。
 *     超时 100ms 之后这类更容易碰上，而误熔断的代价是整个会话退回旧匹配（误报全回来），
 *     所以要求连续 5 次。真卡死的二进制最多担误 5 × 100ms。
 * `/reload` 或重启后重试。
 */
export const BREAKER_IMMEDIATE: ReadonlySet<PreshellUnavailableReason> = new Set(["missing", "schema"]);
export const BREAKER_TRANSIENT_THRESHOLD = 5;
let consecutiveFailures = 0;
let breakerReason: PreshellUnavailableReason | undefined;

export function preshellBreakerState(): { broken: PreshellUnavailableReason | undefined; failures: number } {
  return { broken: breakerReason, failures: consecutiveFailures };
}

export function resetPreshellBreaker(): void {
  consecutiveFailures = 0;
  breakerReason = undefined;
}

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
  if (breakerReason) return { ok: false, reason: breakerReason, detail: "熔断中：本进程已连续失败，不再尝试（/reload 后重试）" };
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

  // 熔断计数：成功清零；确定性失败一次就断，瞬时失败要连续到阈值
  if (outcome.ok) {
    consecutiveFailures = 0;
  } else if (outcome.reason !== "disabled") {
    consecutiveFailures++;
    if (BREAKER_IMMEDIATE.has(outcome.reason) || consecutiveFailures >= BREAKER_TRANSIENT_THRESHOLD) {
      breakerReason = outcome.reason;
    }
  }
  return outcome;
}

// ── 面向人的提示 ──

/** 只要能 notify / setStatus 就够，避免为了发一条提示去接整个 ExtensionContext */
export interface FactLayerUi {
  notify?(message: string, level?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text?: string): void;
}

const announced = new Set<PreshellUnavailableReason>();
const STATUS_KEY = "preshell";
let statusShown = false;

/**
 * 会往桌面弹通知的原因：能动手解决的那些。
 * 瞬时的超时/坏 JSON 不打扰，否则一次网络抖就弹一次。
 */
const DESKTOP_REASONS: ReadonlySet<PreshellUnavailableReason> = new Set(["missing", "schema", "disabled"]);

export interface FactLayerNotifyDeps {
  /** 测试注入；缺省走 lib/notify-send（失败静默，不影响判定） */
  desktopNotify?: (title: string, message: string) => void;
}

/**
 * 事实层不可用时提醒用户（每个原因在一个进程里只弹一次；状态栏常驻）。
 *
 * 为什么要弹：这是「审核变弱了」这种静默退化。不弹的话，用户只会看到
 * 「怎么又开始误报」而不知道是缺了个二进制；模型侧另有 factsUnavailable 字段，
 * 缺件时它也能自己说出来。
 *
 * 另发一条桌面通知，是因为经 hub/IM 用 pi 时没有 TUI，ctx.ui.notify 可能落空，
 * 桌面那条是那时唯一能到人的通道。
 */
export function notifyFactLayerUnavailable(
  ui: FactLayerUi | undefined,
  reason: PreshellUnavailableReason,
  detail?: string,
  deps: FactLayerNotifyDeps = {},
): string {
  try {
    ui?.setStatus?.(STATUS_KEY, `✗ 事实层 ${reason}`);
    statusShown = true;
  } catch {
    // 状态栏不可用不影响判定
  }
  if (announced.has(reason)) return "";
  announced.add(reason);

  const message = `命令审核事实层不可用：${describeUnavailable(reason, detail)}\n${INSTALL_HINT}`;
  try {
    ui?.notify?.(message, "warning");
  } catch {
    // 通知失败不影响判定
  }
  if (DESKTOP_REASONS.has(reason)) {
    const short = `命令审核事实层不可用：${describeUnavailable(reason, detail)}；审核已退回旧规则，装法见 pi 里的提示`;
    try {
      if (deps.desktopNotify) deps.desktopNotify("命令审核事实层不可用", short);
      else void notify("命令审核事实层不可用", short).catch(() => {});
    } catch {
      // 同上
    }
  }
  return message;
}

/** 事实层恢复可用时把状态栏收掉（只在之前设过时才动） */
export function clearFactLayerStatus(ui: FactLayerUi | undefined): void {
  if (!statusShown) return;
  statusShown = false;
  try {
    ui?.setStatus?.(STATUS_KEY, undefined);
  } catch {
    // 同上
  }
}

/** 检查结果 → 提醒/收状态：调用方（bash-guard、sandbox-allow、bash_background）共用 */
export function reportFactLayerState(
  ui: FactLayerUi | undefined,
  factsUnavailable: string | undefined,
  deps: FactLayerNotifyDeps = {},
): void {
  if (factsUnavailable) {
    notifyFactLayerUnavailable(ui, factsUnavailable as PreshellUnavailableReason, undefined, deps);
    return;
  }
  clearFactLayerStatus(ui);
}

/** 测试用：清掉「已弹过」记录 */
export function resetFactLayerNotices(): void {
  announced.clear();
  statusShown = false;
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
