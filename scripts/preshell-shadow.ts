// scripts/preshell-shadow.ts — step 0：拿真实会话命令对比 preshell 事实层与现行 checkCommand
//
// 目的：回答「换成 preshell 之后，判定会怎么变」。不动任何生产代码，只读会话记录。
//
// 用法：
//   node --experimental-strip-types scripts/preshell-shadow.ts --n 1500
//
//   --bin PATH   缺省依次取：--bin > $PRESHELL_BIN > ~/.pi/runtime/preshell > PATH 上的 preshell
//   --n 0        跑全部（去重后的全量；4 万条量级大约 5 分钟）
//   --dump DIR   把每类转移的样例写成 jsonl（默认不写盘）
//   --seed N     抽样种子（默认 7，可复现）
//   --policy P   报告里逐条样例用哪一档（strict | moderate | hybrid，缺省 hybrid）
//
// 报告开头会打出现用二进制的 version / schema / sha256，跟 PINNED_SHA256 对比——
// 结论必须能归到哪个具体产物上，不然下次改版就说不清是它变了还是我们的策略变了。
//
// v0.1 实测（2026-09-24）：version 0.1.0 · schema 1 ·
//   sha256 e569f0c76c0c9e4b762225b35fadb4c1ed91011e44e05c55ba8bce24579af102

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { checkCommand, detectSensitivePaths } from "../lib/sandbox-check.ts";
import { commandBlocked, loadBlacklist, pathBlocked } from "../extensions/sandbox-permissions/guard.ts";
import { isDirInside, loadSandboxPaths } from "../extensions/sandbox-permissions/paths.ts";

type Kind = "bash" | "allow";
type Verdict = "allow" | "ask" | "deny" | "unavailable";
/** 草拟策略档位：step 0 就是拿来比这三档分别会走向哪里 */
type Policy = "strict" | "moderate" | "hybrid";

interface Sample {
  kind: Kind;
  cmd: string;
  cwd: string;
}

interface PreshellEffect {
  kind: string;
  target: string;
  dynamic?: boolean;
  modeled?: boolean;
  line?: number;
}

interface PreshellReport {
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

// ── 参数 ──

function arg(name: string, fallback = ""): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const BIN = arg("bin", process.env.PRESHELL_BIN ?? (fs.existsSync(join(homedir(), ".pi", "runtime", "preshell")) ? join(homedir(), ".pi", "runtime", "preshell") : "preshell"));
/** v0.1 发布物的 sha256（发布方带 SHA256SUMS；不一致时报告要说得出来） */
const PINNED_SHA256 = "e569f0c76c0c9e4b762225b35fadb4c1ed91011e44e05c55ba8bce24579af102";
/** transitions = 三档策略对比；blacklist = 只看敏感路径这一维（旧子串匹配 vs 新事实层+token 兼底） */
const MODE = arg("mode", "transitions");
const N = Number(arg("n", "1500"));
const DUMP = arg("dump", "");
const SEED = Number(arg("seed", "7"));
const POLICY = (arg("policy", "hybrid") as Policy);
const SESSIONS = arg("sessions", join(homedir(), ".pi", "agent", "sessions"));

/** 可复现抽样：xorshift32（跟随机源无关，换机器同 seed 同结果） */
function makeRandom(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── 语料：会话记录里的 bash / sandbox-allow 命令 ──

function collect(): { files: number; commands: Map<string, { kinds: Set<Kind>; cwd: string }> } {
  const files: string[] = [];
  const stack = [SESSIONS];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".jsonl")) files.push(full);
    }
  }

  const commands = new Map<string, { kinds: Set<Kind>; cwd: string }>();
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let cwd = process.cwd();
    const header = /^\{"type":"session".*$/m.exec(text);
    if (header) {
      try {
        const parsed = JSON.parse(header[0]) as { cwd?: string };
        if (parsed.cwd) cwd = parsed.cwd;
      } catch { /* 头坏了就用默认 cwd */ }
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"toolCall"')) continue;
      let record: { message?: { content?: unknown } };
      try {
        record = JSON.parse(line) as { message?: { content?: unknown } };
      } catch {
        continue;
      }
      const content = record.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const call = part as { type?: string; name?: string; arguments?: { command?: unknown } };
        if (call.type !== "toolCall") continue;
        const kind: Kind | undefined = call.name === "bash" ? "bash" : call.name === "sandbox-allow" ? "allow" : undefined;
        const cmd = call.arguments?.command;
        if (!kind || typeof cmd !== "string" || cmd.trim().length === 0) continue;
        const existing = commands.get(cmd);
        if (existing) existing.kinds.add(kind);
        else commands.set(cmd, { kinds: new Set([kind]), cwd });
      }
    }
  }
  return { files: files.length, commands };
}

// ── 现行判定（checkCommand）→ 三档 ──

function currentVerdict(cmd: string, cwd: string): { verdict: Verdict; detail: string } {
  const result = checkCommand(cmd, { cwd });
  if (result.allow) return { verdict: "allow", detail: "allow" };
  const rules = result.rules ?? [];
  if ((result.sensitive?.length ?? 0) > 0) return { verdict: "deny", detail: `blacklist:${result.sensitive?.[0]?.pattern}` };
  if (rules.length === 0) return { verdict: "deny", detail: "no-rules(内联脚本等)" };
  if (rules.every((rule) => rule.autoReject)) return { verdict: "deny", detail: `rules:${rules.map((r) => r.name).join(",")}` };
  return { verdict: "ask", detail: `rules:${rules.map((r) => r.name).join(",")}` };
}

// ── preshell 侧：一次调用 + 一份「还没定稿」的草拟策略 ──

function runPreshell(cmd: string): { report?: PreshellReport; error?: string; ms: number } {
  const started = process.hrtime.bigint();
  const proc = spawnSync(BIN, ["--shell=probe"], { input: cmd, encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (proc.error) return { error: `spawn:${(proc.error as NodeJS.ErrnoException).code ?? proc.error.message}`, ms };
  if (proc.status !== 0) return { error: `exit:${proc.status}`, ms };
  try {
    return { report: JSON.parse(proc.stdout) as PreshellReport, ms };
  } catch {
    return { error: "bad-json", ms };
  }
}

/**
 * 草拟策略。step 0 只用来量方向，不是定稿。三档：
 *
 *   strict   unmodeled / unknown / 动态变更 / Net 一律问人。噪声上限的参照点
 *   moderate 黑名单与语法错拒绝，动态变更与 Net 问人，unmodeled/unknown 不管
 *   hybrid   事实层能拿定主意时用它（黑名单 / 出根写入 / 动态变更 / Net），
 *            拿不定主意（unmodeled / unknown / Unsupported）时回退到现行 checkCommand
 *
 * 「问人」在现行管线里会先过 LLM 预审（auto 模式下 safe 直接放行），
 * 所以 ask 的体量对应「多走一道审核」，不等于「多弹一次窗」。
 */
function draftVerdict(
  report: PreshellReport,
  cwd: string,
  policy: Policy,
  fallback: () => { verdict: Verdict; detail: string },
): { verdict: Verdict; detail: string } {
  const status = report.status ?? "?";
  if (status === "Invalid") return { verdict: "deny", detail: "Invalid(语法错)" };
  const impact = report.impact ?? {};
  const effects = impact.effects ?? [];
  const base = impact.cwd ?? cwd;
  const rules = loadBlacklist();

  const blacklisted = effects.find(
    (e) => ["Read", "Write", "Delete"].includes(e.kind) && typeof e.target === "string" && pathBlocked(e.target, base, rules),
  );
  if (blacklisted) return { verdict: "deny", detail: `blacklist:${blacklisted.target}` };

  const dynamicMutation = effects.find((e) => (e.kind === "Write" || e.kind === "Delete") && e.dynamic === true);
  const net = effects.find((e) => e.kind === "Net");
  const unmodeled = effects.find((e) => (e.kind === "Exec" || e.kind === "Spawn") && e.modeled === false);
  const unknown = effects.find((e) => e.kind === "Unknown");

  if (policy === "strict") {
    if (dynamicMutation) return { verdict: "deny", detail: `dynamic-${dynamicMutation.kind}` };
    if (net) return { verdict: "ask", detail: `net:${net.target}` };
    if (unmodeled) return { verdict: "ask", detail: `unmodeled:${unmodeled.target}` };
    if (unknown) return { verdict: "ask", detail: `unknown:${unknown.target}` };
    if (status !== "Complete") return { verdict: "ask", detail: `status:${status}` };
    return { verdict: "allow", detail: "allow" };
  }

  if (policy === "moderate") {
    if (dynamicMutation) return { verdict: "ask", detail: `dynamic-${dynamicMutation.kind}` };
    if (net) return { verdict: "ask", detail: `net:${net.target}` };
    return { verdict: "allow", detail: "allow" };
  }
  // hybrid：事实清楚且触到风险维度才拦/问；拿不准就交给现行规则
  // 动态变更分两种：目标里带 $ / ` / * / ? 的「根都定不下」（真需要问），
  // 与目标本身是具体路径、只是 preshell 标了 dynamic 的（git 写 .git 就属这类，占了绝大多数）
  const dynMutation = effects.find((e) => (e.kind === "Write" || e.kind === "Delete") && e.dynamic === true);
  if (dynMutation && isUnboundTarget(dynMutation.target)) {
    return { verdict: "ask", detail: `dynamic-root-${dynMutation.kind}:${String(dynMutation.target).slice(0, 40)}` };
  }
  if (net) return { verdict: "ask", detail: `net:${net.target}` };
  const outOfRoot = effects.find(
    (e) =>
      (e.kind === "Write" || e.kind === "Delete") &&
      typeof e.target === "string" &&
      !isUnboundTarget(e.target) &&
      isOutsideRoots(e.target, base, cwd),
  );
  if (outOfRoot) return { verdict: "ask", detail: `write-outside-roots:${outOfRoot.target}` };
  if (unmodeled || unknown || status !== "Complete") return fallback();
  return { verdict: "allow", detail: "allow" };
}

/** 目标里含变量/反引号/通配：根定不下来，静态判断到此为止 */
function isUnboundTarget(target: unknown): boolean {
  return typeof target === "string" && /[$`*?]/.test(target);
}

// ── 出根写入：写/删目标落到 cwd / /tmp / allowDirs 之外 ──

function resolveTarget(target: string, base: string): string | undefined {
  if (!target || target.startsWith("~") === false && !target.startsWith("/") && !target.includes("/")) return undefined;
  let path = target;
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (!path.startsWith("/")) path = join(base, path);
  return path;
}

function isOutsideRoots(target: string, base: string, cwd: string): boolean {
  const abs = resolveTarget(target, base);
  if (!abs) return false;
  const roots = [cwd, "/tmp", "/dev/null", ...loadSandboxPaths().allowDirs];
  return !roots.some((root) => abs === root || isDirInside(abs, root));
}

// ── 主流程 ──

const rand = makeRandom(SEED);

// ── blacklist 模式：只看敏感路径这一维，旧子串匹配 vs 新判定 ──

if (MODE === "blacklist") {
  const { files, commands } = collect();
  const all = [...commands.entries()].map(([cmd, meta]) => ({
    kind: meta.kinds.has("bash") ? ("bash" as Kind) : ("allow" as Kind),
    cmd,
    cwd: meta.cwd,
  }));
  const sample = N > 0 ? shuffle(all, rand).slice(0, N) : all;
  console.log(`会话文件 ${files} 个，去重命令 ${commands.size} 条，本次 ${sample.length} 条\n`);

  const rules = loadBlacklist();
  const oldOnly: string[] = [];
  const oldOnlyStillBlocked: string[] = [];
  const newOnly: string[] = [];
  let both = 0;
  let neither = 0;
  let oldOnlySilentlyAllowed = 0;
  const viaCount = new Map<string, number>();
  const reason = new Map<string, number>();
  const started = Date.now();

  for (const item of sample) {
    const oldHit = commandBlocked(item.cmd, rules);
    const detected = detectSensitivePaths(item.cmd, { cwd: item.cwd });
    const newHit = detected.hits.length > 0;
    for (const hit of detected.hits) viaCount.set(hit.via ?? "?", (viaCount.get(hit.via ?? "?") ?? 0) + 1);
    if (detected.unavailable) reason.set(detected.unavailable, (reason.get(detected.unavailable) ?? 0) + 1);
    if (oldHit && newHit) both++;
    else if (oldHit) {
      // 关键的一列：路径这一维不再命中，但整条判定是否仍然拦着（内联脚本/危险规则/动态构造）
      const ended = checkCommand(item.cmd, { cwd: item.cwd }).allow;
      const line = item.cmd.replace(/\s+/g, " ").slice(0, 110);
      if (ended) {
        oldOnlySilentlyAllowed++;
        if (oldOnly.length < 60) oldOnly.push(line);
      } else if (oldOnlyStillBlocked.length < 5) {
        oldOnlyStillBlocked.push(line);
      }
    } else if (newHit) {
      if (newOnly.length < 20) newOnly.push(item.cmd.replace(/\s+/g, " ").slice(0, 110));
    } else neither++;
  }

  console.log("敏感路径判定（旧：子串匹配 vs 新：preshell 目标 ∪ 未引号 token）");
  console.log(`  两边都命中：${both}`);
  console.log(`  只旧命中：${oldOnly.length >= 20 ? "≥20" : oldOnly.length + oldOnlyStillBlocked.length} 条，其中`);
  console.log(`    路径维不再命中但整条仍被拦（内联脚本/规则/动态构造）：${oldOnlyStillBlocked.length >= 5 ? "≥5" : oldOnlyStillBlocked.length}`);
  console.log(`    路径维不再命中且整条放行（真退化）：${oldOnlySilentlyAllowed}`);
  console.log(`  只新命中（补上的漏报）：${newOnly.length >= 20 ? "≥20" : newOnly.length} 条`);
  console.log(`  都不命中：${neither}`);
  console.log(`  新命中的来源：${[...viaCount.entries()].map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  if (reason.size > 0) console.log(`  事实层不可用：${[...reason.entries()].map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  console.log(`  耗时：${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log("\n只旧命中且整条放行的样例（真退化，要逐条看）：");
  for (const example of oldOnly) console.log(`  · ${example}`);
  if (DUMP) {
    fs.mkdirSync(DUMP, { recursive: true });
    fs.writeFileSync(join(DUMP, "old-only-allowed.txt"), oldOnly.join("\n") + "\n", "utf8");
    fs.writeFileSync(join(DUMP, "new-only-blocked.txt"), newOnly.join("\n") + "\n", "utf8");
    console.log(`  清单：${DUMP}/old-only-allowed.txt、${DUMP}/new-only-blocked.txt`);
  }
  console.log("\n只旧命中但仍被其它维度拦下的样例：");
  for (const example of oldOnlyStillBlocked) console.log(`  · ${example}`);
  console.log("\n只新命中的样例（旧漏、新拦）：");
  for (const example of newOnly) console.log(`  · ${example}`);
  process.exit(0);
}

// 先交代「这串数字是哪个产物跑出来的」：version/schema 由工具自己报，sha 由本地算
const toolVersion = spawnSync(BIN, ["--version"], { encoding: "utf8", timeout: 2000 });
let binSha = "unknown";
try {
  binSha = createHash("sha256").update(fs.readFileSync(BIN)).digest("hex");
} catch {
  binSha = "（读不到二进制）";
}
console.log(`preshell：${BIN}`);
console.log(`  --version → ${toolVersion.status === 0 ? toolVersion.stdout.trim() : `退出码 ${toolVersion.status} / ${(toolVersion.stderr ?? "").trim().slice(0, 80)}`}`);
console.log(`  sha256 → ${binSha}${binSha === PINNED_SHA256 ? "（与 pin 一致）" : "⚠ 与 pin 不一致，结论不能直接跨版本比较"}`);

const { files, commands } = collect();
console.log(`会话文件 ${files} 个，去重命令 ${commands.size} 条`);

const all: Sample[] = [...commands.entries()].map(([cmd, meta]) => ({
  kind: meta.kinds.has("bash") ? "bash" : "allow",
  cmd,
  cwd: meta.cwd,
}));
const bash = shuffle(all.filter((s) => s.kind === "bash"), rand);
const allow = shuffle(all.filter((s) => s.kind === "allow"), rand);
const take = (items: Sample[]) => (N > 0 ? items.slice(0, N) : items);
const sample = [...take(bash), ...take(allow)];
console.log(`本次对比 ${sample.length} 条（bash ${take(bash).length} / allow ${take(allow).length}）\n`);

const transitions = new Map<string, { count: number; examples: string[] }>();
const bump = (key: string, cmd: string) => {
  const entry = transitions.get(key) ?? { count: 0, examples: [] };
  entry.count++;
  if (entry.examples.length < 5) entry.examples.push(cmd.replace(/\s+/g, " ").slice(0, 110));
  transitions.set(key, entry);
};

/** 三个档位一次跑完：同一份 preshell 报告只解析一次，策略只是不同的读数方式 */
const POLICIES: Policy[] = ["strict", "moderate", "hybrid"];
const perPolicy = new Map<Policy, Map<string, { count: number; examples: string[] }>>(
  POLICIES.map((p) => [p, new Map()]),
);
function bumpPolicy(policy: Policy, key: string, cmd: string) {
  const bucket = perPolicy.get(policy) as Map<string, { count: number; examples: string[] }>;
  const entry = bucket.get(key) ?? { count: 0, examples: [] };
  entry.count++;
  if (entry.examples.length < 3) entry.examples.push(cmd.replace(/\s+/g, " ").slice(0, 110));
  bucket.set(key, entry);
}

let unavailable = 0;
let parseMs: number[] = [];
const statusCount = new Map<string, number>();
let uncertain = 0;
let noteBlacklistMissedByUs = 0; // preshell 报出黑名单目标，而现行放行
const blacklistMissExamples: string[] = [];
let noteBlacklistFalsePositive = 0; // 现行因黑名单拦下，preshell 目标里没有黑名单
const falsePositiveExamples: string[] = [];
let outsideWrite = 0;
let outsideWriteAllowed = 0;
const outsideWriteExamples: string[] = [];
const dynShapes = new Map<string, { count: number; example: string }>();
const order = ["allow → allow", "allow → ask", "allow → deny", "ask → allow", "ask → ask", "ask → deny", "deny → allow", "deny → ask", "deny → deny"];
const dumpFile = DUMP ? (fs.mkdirSync(DUMP, { recursive: true }), fs.createWriteStream(join(DUMP, `preshell-shadow-${Date.now()}.jsonl`), { flags: "a" })) : undefined;

for (const item of sample) {
  const current = currentVerdict(item.cmd, item.cwd);
  const { report, error, ms } = runPreshell(item.cmd);
  parseMs.push(ms);
  if (error || !report) {
    unavailable++;
    bump(`preshell 不可用（${error ?? "?"}）`, item.cmd);
    continue;
  }
  statusCount.set(report.status ?? "?", (statusCount.get(report.status ?? "?") ?? 0) + 1);
  if (report.impact?.uncertain) uncertain++;
  for (const policy of POLICIES) {
    const draft = draftVerdict(report, item.cwd, policy, () => current);
    const key = `${current.verdict} → ${draft.verdict}`;
    bumpPolicy(policy, current.verdict !== draft.verdict ? `${key}（${draft.detail}）` : key, item.cmd);
  }
  const draft = draftVerdict(report, item.cwd, POLICY, () => current);

  const key = `${current.verdict} → ${draft.verdict}`;
  if (current.verdict !== draft.verdict) bump(`${key}（${draft.detail}）`, item.cmd);
  else bump(key, item.cmd);

  // 黑名单两个方向的交叉核对
  const effects = report.impact?.effects ?? [];
  const rules = loadBlacklist();
  const base = report.impact?.cwd ?? item.cwd;
  const preshellBlacklisted = effects.some(
    (e) => ["Read", "Write", "Delete"].includes(e.kind) && typeof e.target === "string" && pathBlocked(e.target, base, rules),
  );
  const oursBlacklisted = (current.detail ?? "").startsWith("blacklist:");
  if (preshellBlacklisted && current.verdict === "allow") {
    noteBlacklistMissedByUs++;
    if (blacklistMissExamples.length < 5) blacklistMissExamples.push(item.cmd.replace(/\s+/g, " ").slice(0, 110));
  }
  if (oursBlacklisted && !preshellBlacklisted) {
    noteBlacklistFalsePositive++;
    if (falsePositiveExamples.length < 5) falsePositiveExamples.push(item.cmd.replace(/\s+/g, " ").slice(0, 110));
  }
  const outOfRoot = effects.some(
    (e) => (e.kind === "Write" || e.kind === "Delete") && typeof e.target === "string" && isOutsideRoots(e.target, base, item.cwd),
  );
  if (outOfRoot) {
    outsideWrite++;
    if (current.verdict === "allow") outsideWriteAllowed++;
    if (outsideWriteExamples.length < 5) outsideWriteExamples.push(item.cmd.replace(/\s+/g, " ").slice(0, 110));
  }
  const dynMutation = effects.find((e) => (e.kind === "Write" || e.kind === "Delete") && e.dynamic === true);
  if (dynMutation) {
    const shape = `${dynMutation.kind} ${dynMutation.target}`.slice(0, 70);
    const entry = dynShapes.get(shape) ?? { count: 0, example: item.cmd.replace(/\s+/g, " ").slice(0, 90) };
    entry.count++;
    dynShapes.set(shape, entry);
  }
  dumpFile?.write(JSON.stringify({ kind: item.kind, current: current.verdict, draft: draft.verdict, detail: draft.detail, cmd: item.cmd }) + "\n");
}

dumpFile?.end();

// ── 报告：先按「转移对」聚合，再把详细原因作为子项 ──

const pairs = new Map<string, number>();
const detailOf = new Map<string, Map<string, number>>();
for (const [key, value] of transitions.entries()) {
  if (key.startsWith("preshell 不可用")) continue;
  const pair = key.includes("（") ? key.slice(0, key.indexOf("（")) : key;
  const reason = key.includes("（") ? key.slice(key.indexOf("（") + 1, -1) : key;
  pairs.set(pair, (pairs.get(pair) ?? 0) + value.count);
  const inner = detailOf.get(pair) ?? new Map<string, number>();
  inner.set(reason.replace(/:.*$/, ""), (inner.get(reason.replace(/:.*$/, "")) ?? 0) + value.count);
  detailOf.set(pair, inner);
}

const sorted = parseMs.slice().sort((a, b) => a - b);
const pct = (p: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
console.log(`策略档位：${POLICY}`);
console.log("preshell 解析状态：", [...statusCount.entries()].map(([k, v]) => `${k}=${v}`).join(" · "));
console.log(`uncertain 占比：${((uncertain / Math.max(1, sample.length)) * 100).toFixed(1)}%`);
console.log(`单次调用耗时：p50 ${pct(0.5).toFixed(1)}ms · p95 ${pct(0.95).toFixed(1)}ms · max ${(sorted[sorted.length - 1] ?? 0).toFixed(1)}ms`);
if (unavailable > 0) console.log(`不可用：${unavailable} 条`);

console.log("\n判定转移（现行 → preshell 草拟）：");
for (const policy of POLICIES) {
  const bucket = perPolicy.get(policy) as Map<string, { count: number; examples: string[] }>;
  const pairsOf = new Map<string, number>();
  const detailPairs = new Map<string, Map<string, number>>();
  for (const [raw, value] of bucket.entries()) {
    const pair = raw.includes("（") ? raw.slice(0, raw.indexOf("（")) : raw;
    const reason = raw.includes("（") ? raw.slice(raw.indexOf("（") + 1, -1).replace(/:.*$/, "") : "（同档）";
    pairsOf.set(pair, (pairsOf.get(pair) ?? 0) + value.count);
    const inner = detailPairs.get(pair) ?? new Map<string, number>();
    inner.set(reason, (inner.get(reason) ?? 0) + value.count);
    detailPairs.set(pair, inner);
  }
  console.log(`\n  ── ${policy} ──`);
  for (const pk of order) {
    const count = pairsOf.get(pk) ?? 0;
    if (count === 0) continue;
    const inner = [...(detailPairs.get(pk) ?? new Map<string, number>()).entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([reason, n]) => `${reason}=${n}`).join(" · ");
    console.log(`    ${pk}: ${count}${inner ? `   （${inner}）` : ""}`);
  }
}

console.log("\n需要逐条看的样例（hybrid 档，按转移对聚合）：");
const hybridBucket = perPolicy.get("hybrid") as Map<string, { count: number; examples: string[] }>;
for (const key of ["deny → allow", "ask → allow", "allow → deny", "allow → ask"]) {
  const examples: string[] = [];
  for (const [raw, value] of hybridBucket.entries()) {
    if (!raw.startsWith(key)) continue;
    for (const example of value.examples) if (examples.length < 5) examples.push(example);
  }
  if (examples.length === 0) continue;
  console.log(`  [${key}]`);
  for (const example of examples) console.log(`    · ${example}`);
}

console.log("\n动态写/删目标的形状（top 12，看「问人」是不是都问在该问的地方）：");
for (const [shape, entry] of [...dynShapes.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12)) {
  console.log(`  ${String(entry.count).padStart(4)}  ${shape}`);
  console.log(`       例：${entry.example}`);
}

console.log("\n出根写入（写/删目标不在 cwd / /tmp / allowDirs 之内）：");
console.log(`  共 ${outsideWrite} 条，其中现行判定为放行的 ${outsideWriteAllowed} 条`);
for (const example of outsideWriteExamples) console.log(`    · ${example}`);

console.log("\n黑名单交叉核对（现行是拿模式对原始命令子串匹配）：");
console.log(`  现行漏掉、preshell 报出黑名单目标：${noteBlacklistMissedByUs} 条`);
for (const example of blacklistMissExamples) console.log(`    · ${example}`);
console.log(`  现行误伤、preshell 目标里没有黑名单：${noteBlacklistFalsePositive} 条`);
for (const example of falsePositiveExamples) console.log(`    · ${example}`);
if (DUMP) console.log(`\n逐条结果：${DUMP}`);
