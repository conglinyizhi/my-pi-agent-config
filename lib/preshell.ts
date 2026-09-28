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
//   --spec → 机读的能力清单（tool / version / modes / exit_codes / refusal / paths 各一句描述）
//   拿不到报告（缺二进制/超时/坏 JSON/缺契约项）时默认动作是保守兜底，绝不因此放行
//
// **兼容性看能力，不看版本号**：起一次 --spec（见 queryPreshellSpec），只检查本侧代码实际依赖
// 的契约项在不在（REQUIRED_CAPABILITIES 那份清单）。字段在就能用，哪怕版本号从没见过；
// 缺必需项，或者二进制根本不认识 --spec（v0.4.0 之前的旧版），一律判不可用、退回旧匹配。
// 版本号（--spec 自报的 version 与 EXPECTED_VERSION）降级为「已知版本」，只进提示与报告。
//
// 为什么不再比版本号：上游的约定是「次版本号变即不兼容」，而它加功能也升次版本号
// （v0.5.0 加 payload、v0.6.0 把 payload 的归属扩到 awk/sed）——每次加法都逼调用方改一行
// EXPECTED_VERSION、跑一轮 A/B。硬门禁的方向反了，改成能力探测。
//
// 本文件按 v0.6.0 的能力面适配（下面是历次契约变化的记录，判据都在能力清单里）：
//   0 契约形状：v0.2.1 起有 --spec；v0.4.0 删掉报告里的 schema 号；v0.4.1 加 effect.origin
//     与「候选集只在穷尽时给」；v0.5.0 加 opt-in 的 payload 并修了 wrapper（uv / docker run /
//     conda run 这类）的 Spawn 目标解析；v0.6.0 把 payload 的归属扩到 awk/sed。
//     每一次都是加法，能力探测吃得下：改清单只在**本侧真的开始读新字段**时才做
//   1 路径一律输出绝对路径。`--cwd=<绝对路径>` 事实上必填：它是「这条命令会在哪个目录里
//     跑」的断言，不是 cd（命令内部的 cd 优先）。不给时工具拿自己进程的当前目录推演，
//     报告附一条 Note 并置 uncertain: true
//   2 词首是运行时展开的目标（`$HOME/x`、`~/x`、`~+/x`）给不出绝对路径：原值原样保留、
//     dynamic: true，要替换的名字在 effect.vars / impact.vars 里。替换是调用方的事
//     ——环境在调用方手上，见下面「变量的收尾」一节
//   3 条件分支让一个名字可能有多个取值时，那条洞多一份 effect.candidates（候选集）。
//     它是**可能性**不是事实：候选里会有哪一个跑，工具不保证；判定拿它收紧（候选逐个判，
//     命中就拦），不拿它当「只有这几个值」。
//     v0.4.1 把口径收紧成「**只在穷尽时给**」：列表要么是完整的可能取值、要么整个不出现
//     （超 8 条、叫不出名字的路径一律撤掉，不再给半截）。所以空数组既不代表「只有一个
//     可能」，也不代表「这个洞解不出东西」——见到空数组照旧按未知处理（保守方向没变，
//     代价是 v0.4.0 那种半截候选能收紧的场合现在收不到了，见 lib/sandbox-check.ts）
//   4 命令自己写出来的赋值解出来的效果带 effect.origin（v0.4.1 起）：它是这个 target
//     原来写在命令里的那处引用。`x=/usr/bin/jq; $x -n 1` 报 target=/usr/bin/jq、
//     origin=$x——程序名在命令文本里根本没有这个串，要把它对回命令行只能靠 origin
//
// 本文件走的是「一条命令一个子进程」的单条模式：实时路径一次只问一条，起进程那 2ms 无所谓。
// 批量场景用 lib/preshell-stream.ts 的长驻子进程（--stream），那边省下的才是真开销。
// 两处共用同一份能力清单与同一个探测缓存（--spec 每个二进制只问一次）。
//
// 缺省二进制：~/.pi/runtime/preshell，可用 extensions.toml 的 [preshell] 覆盖。

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { notify } from "./notify-send.ts";
import { collectVarRenders, referenceAppearsIn } from "./var-render.ts";
import { processSingleton } from "./process-singleton.ts";

/**
 * 解释器载荷（v0.5.0 起，opt-in）：工具搬运的原文，不是对它求值的结果。
 * 它只说「这段文本被交给了这个程序」，不说文本会做什么。
 */
export interface PreshellPayload {
  /**
   * 这段文本是从命令行上哪一处拿到的：
   *   flag    = 选项的值（`python3 -c …` / `node -e …` / `sh -c …`）
   *   operand = 本来放文件名的那个位置（awk / sed 的程序本身就是参数）
   *   heredoc = here-document 正文
   */
  source: string;
  /** source 为 flag 时是那个选项（`-c` / `-e`） */
  flag?: string;
  /** source 为 heredoc 时是结束那段正文的词 */
  delimiter?: string;
  /** 原文；被截断时是前缀 */
  text: string;
  /** 全长（UTF-8 字节），即使 text 只是前缀 */
  bytes: number;
  /** text 是否只是前缀 */
  truncated?: boolean;
}

export interface PreshellEffect {
  kind: string;
  target: string;
  /** 这个 target 读了哪些变量名（v0.3.0 起）；dynamic 为假时是空 */
  vars?: string[];
  /** 目标不是封闭集合（有洞或通配）：`rm -rf $DIR/*` 报不出一份完整文件表 */
  dynamic?: boolean;
  /**
   * 这个目标的候选取值（v0.4.0 起）：条件分支让名字有多个可能取值时才有。
   *
   * 空数组 = 没有候选（非 dynamic 的效果一律是空数组），**不等于「没有这个字段」**——
   * 旧版二进制（≤0.3.0）根本不报 candidates，那才叫没有这个字段。
   * 语义是「这些值之一是它」，不是「都是」。v0.4.1 起口径是「**只在穷尽时给**」：
   * 要么是完整的可能取值、要么整个不出现（不截断），所以空数组也不等于「只有一个
   * 可能」——半截候选（v0.4.0 会给）在新版里被整个撤掉了
   */
  candidates?: string[];
  /**
   * 这个 target 是照命令里哪处引用解出来的（v0.4.1 起）：`x=/usr/bin/jq; $x -n 1`
   * 报 `target: "/usr/bin/jq"` 加 `origin: "$x"`——程序名在命令文本里根本不出现，
   * 要按文本把效果对回命令行就用这个字段。
   *
   * 渲染与 dynamic 目标的 target 同形（`rm -rf "$x"` 报 `$x`，不带引号），所以对
   * 命令文本是纯文本比较。没有值参与时（target 就是词面本身）不出现这个字段；
   * 旧版二进制（≤v0.4.0）一律不报，读到 undefined 是常态
   */
  origin?: string;
  /**
   * 这个程序把自己读的源码（v0.5.0 起，**opt-in**）：`python3 -c '<code>'`、`node -e '<code>'`、
   * `python3 - <<'PY' … PY` 里的那段文本。
   *
   * 默认不报——要起子进程时传 `--payload`（或 `--payload-max=N`）才会出现；每个 text 默认封顶
   * 4096 字节，超了给前缀并把 `truncated` 置真（`bytes` 始终是全长）。`text` 是原
   * 地搬运：引号与转义已解，`$HOME` 这类展开原样保留。
   *
   * 归属已经算对了：循环体里、wrapper 后（`env python3 -c …`）、runner 后
   * （`uv run --with X python3 -c …`）、容器后（`docker run --rm node -e …`）都算在这个程序名下。
   * v0.6.0 起 awk / sed 的程序参数也算载荷（source=operand）。
   *
   * **本侧现在把它接进展展示了**（formatFacts 的「解释器载荷」一段，审核模型与看审批的人
   * 都能看到这段原文）；判定层（lib/sandbox-check.ts 的 interpreter 那一层）仍旧从命令
   * 文本里自己抠，没换成这个字段——事实是事实，裁决还是本仓的事
   */
  payload?: PreshellPayload;
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
    /** 各 effect 的 vars 去重后的并集（v0.3.0 起）：需要准备好哪些环境变量看这一个字段 */
    vars?: string[];
  };
  issues?: unknown[];
  /** 被 max_issues 截掉的条数 */
  issues_dropped?: number;
}

/**
 * 工具自报的一条问题（报告 issues[] 的一格）。
 *   kind: Gap（解析器的缺口，bash 未必拒）/ Syntax（有证据 shell 也会拒）/
 *         Note（解析成功了，但这份报告不该被当成干净账单）
 *   message: 散文，文案会改，别按整句匹配
 *   line: 行号；0 = 不指向某一行
 * 这些是「它自己发现的问题」，不是裁决：展示出来，不外推成安全/危险
 */
export interface PreshellIssue {
  kind: string;
  message: string;
  line?: number;
}

/**
 * 把报告里 issues[] 的原始形状规整成可展示的形式。
 * 形状实测是 `{kind, message, line}`；对不认识的形状（字符串、缺字段的对象）
 * 保留原文而不是丢掉——「有问题但说不清形状」比「看起来没问题」更该让人看见
 */
export function parseIssues(raw: unknown): PreshellIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: PreshellIssue[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ kind: "?", message: item });
      continue;
    }
    if (typeof item === "object" && item !== null) {
      const shaped = item as { kind?: unknown; message?: unknown; line?: unknown };
      let message: string;
      if (typeof shaped.message === "string") message = shaped.message;
      else {
        try {
          message = JSON.stringify(item);
        } catch {
          message = String(item);
        }
      }
      out.push({
        kind: typeof shaped.kind === "string" ? shaped.kind : "?",
        message,
        ...(typeof shaped.line === "number" ? { line: shaped.line } : {}),
      });
      continue;
    }
    out.push({ kind: "?", message: String(item) });
  }
  return out;
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
  /**
   * 工具自己发现的问题（Gap / Syntax / Note），原样带出来给审核方看。
   * 它不影响本侧判定（判定只按 effects / status），展示用；空数组是常态
   */
  issues: PreshellIssue[];
  /** 命令内部 cd 过的目录：报告里的相对路径以它为基准 */
  cwd?: string;
  /**
   * 这条命令的原文。变量渲染（formatFacts 的变量表与就地标注）要它；
   * 老调用方不给时只是不出变量表，路径收尾照旧
   */
  command?: string;
  /**
   * 调用方给了一个不是绝对路径的 cwd，被拒用（原值记在这里）。
   * 拒用之后不给工具 --cwd：工具会拿自己的当前目录推演并置 uncertain，
   * 我们不猜——给相对值工具直接报用法错误（退出码 2）
   */
  cwdRejected?: string;
  effects: PreshellEffect[];
  /** 各 effect 的 vars 并集（impact.vars；老报告没有这个字段时由各 effect 的 vars 拼出来） */
  vars: string[];
  /** 需要按路径判定的那些效果的收尾结果，与 effects 分开存（见下面的 resolvePath） */
  settledPaths: SettledEffect[];
  /** Exec/Spawn 里 modeled: false 的程序名（git/node/... 它们碰什么不由命令行决定） */
  unmodeled: string[];
  /** Net 目标 */
  net: string[];
  writeRoots: string[];
}

export type PreshellUnavailableReason =
  | "disabled"
  | "missing"
  | "timeout"
  | "exit"
  | "bad-json"
  /**
   * 契约能力不足：--spec 读出来了，但本侧代码实际依赖的必需项缺了几样（detail 里点名）。
   * 旧版二进制不认识 --spec（用法错误）也归这类——能力清单都拿不到，就是能力不足。
   * 以前这里是 "version"（主次版号不相等）；版本号现在不参与判定，见文件头。
   */
  | "capability";

export type PreshellOutcome =
  | { ok: true; facts: PreshellFacts; version: string }
  | { ok: false; reason: PreshellUnavailableReason; detail?: string };

export interface PreshellConfig {
  enabled: boolean;
  bin: string;
  timeoutMs: number;
  /**
   * 已知版本（extensions.toml 的 [preshell] version 键）。**不参与门禁**：能不能用看
   * --spec 的能力探测（REQUIRED_CAPABILITIES），这个值只进提示与报告（实测报的是哪个、
   * 推荐的是哪个）。读不到就用 RECOMMENDED_VERSION 的缺省值。
   *
   * 旧配置里那个 `schema = 1` 已经没意义，读了也不参与任何判定（只是留在文件里，不报错）。
   */
  recommendedVersion?: string;
  /**
   * @deprecated 旧字段名，当时它是硬门禁（主次版号相等才可用）。老调用方还在传，
   * 读到就当 recommendedVersion 用（见 recommendedVersionOf）。新代码用 recommendedVersion。
   */
  expectedVersion?: string;
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
/**
 * 推荐版本：**装的时候建议装哪个**（开箱即用，与本机 pi 侧适配过的契约面对齐）。
 *
 * 它不参与任何可用性判定 —— 能不能用看 --spec 的能力探测（REQUIRED_CAPABILITIES）：
 * 字段在就能用，哪怕版本号没见过。所以这是「推荐」不是「要求」：更新或更旧的版本
 * 只要能过能力探测，照样直接用，不必等 pi 侧适配。
 *
 * 用途两处：安装提示（INSTALL_HINT）里给一条能直接粘的命令；报告里做「实测 vs 推荐」
 * 的对照，提醒有没有落后。scripts/preshell-install.mjs 拿正则从本文件读这个值。
 */
export const RECOMMENDED_VERSION = "0.6.0";
/** @deprecated 旧名（语义已改成「推荐版本」，见 RECOMMENDED_VERSION） */
export const EXPECTED_VERSION = RECOMMENDED_VERSION;
/** @deprecated 旧名（同上） */
export const KNOWN_VERSION = RECOMMENDED_VERSION;

/**
 * 版本号 → 主次版号（"0.6.1" → "0.6"）；读不出版号时 undefined。
 *
 * 现在只剩提示用途：实测版本与已知版本同不同主次版号，写进报告，但不决定可用性。
 */
export function compatVersion(version: string): string | undefined {
  const m = /^(\d+)\.(\d+)/.exec(String(version).trim());
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/**
 * 推荐版本：配置里可以钉一个（extensions.toml 的 [preshell] version）。
 * 名字换过（expectedVersion → knownVersion → recommendedVersion），老配置对象都认。
 * 都读不到时回退到 RECOMMENDED_VERSION —— 它只进提示与安装建议，读不出不影响可用性。
 */
export function recommendedVersionOf(config: {
  recommendedVersion?: string;
  knownVersion?: string;
  expectedVersion?: string;
}): string {
  const value = config.recommendedVersion ?? config.knownVersion ?? config.expectedVersion;
  return typeof value === "string" && value.trim() ? value.trim() : RECOMMENDED_VERSION;
}
/** @deprecated 旧名（= recommendedVersionOf） */
export const knownVersionOf = recommendedVersionOf;

/**
 * 安装说明：通知、配置注释、文档共用一份，避免三处各写一句、各有出入。
 * 工具本身不回传安装方式（它只是个静态分析器），所以这段文字只能由调用方给。
 */
export const INSTALL_HINT = [
  "preshell 是命令审核的事实层（独立子进程，GPL-3.0-or-later，仓库 conglinyizhi/preshell）",
  `装它（推荐 v${RECOMMENDED_VERSION}，开箱即用）：`,
  `  node ~/.pi/agent/scripts/preshell-install.mjs install --release v${RECOMMENDED_VERSION}`,
  "  换版本或回滚：同一个脚本 use <版本>；status 看当前装了什么",
  "  它会校验 sha256、过一遍契约门禁、跑影子对比再原子切链，坏了能退回去",
  "兼容性看能力不看版本号：起一次 --spec 逐项查 pi 依赖的契约面在不在，字段在就能用",
  "  —— 所以比推荐版本新或旧的版本，一般都不用等 pi 侧适配，装上就走",
  "没装也能用：路径判定退回旧的匹配规则（更严、误报更多），不会放行也不会崩",
  "自己编也行：moon build --release --target native，再按上面的流程装",
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
    case "capability":
      return `契约能力不足${suffix}`;
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
    recommendedVersion: RECOMMENDED_VERSION,
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
      // 老配置里的 `schema = 1` 到此为止：它没有对照物了，读也不读。`version` 仍然认，
      // 但含义已经换成「推荐版本」（只进提示/安装建议，不参与门禁）——键名不改，免得到处改配置
      recommendedVersion:
        typeof section.version === "string" && section.version.trim()
          ? section.version.trim()
          : fallback.recommendedVersion,
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

// ── 变量的收尾（v0.3.0 起由调用方做）──
//
// 工具对「词首是运行时展开」的目标（`$HOME/x`、`~/x`、`~+/x`）给不出绝对路径：它不读磁盘、
// 也不读环境，而 `$HOME/x` 配 `HOME=/home/u` 是 `/home/u/x`，把解析基准拼上去只会算错。它交出
// 的是一份「要替换哪些名字」的清单（每条效果自己的 `vars`，并集在 `impact.vars`），替换由
// 我们做——环境在我们手上。规则两条（docs/integration.md「谁来替换那些变量」）：
//
//   1 只替换 vars 报出来的名字。`dynamic: false` 的路径里那个 `$` 是字面量（`'$X/y'`），
//     而 `~someone/x` 的 `~` 走口令库、`$1`/`$@` 不在环境里，替换它们等于把命令的意思改了
//   2 替换完还要看结果。值可能本身就是相对的（`HOME=rel`），也可能没设（展开成空）。
//     拿不到确定值就保留原样，绝不凭一个空的或错的值推断出绝对路径

/** 替换结果：拿到绝对路径，或说清补不上什么 */
export type ResolvedPath = { known: true; path: string } | { known: false; reason: string };

/** 收尾需要的最小信息：工具给的 target 原值 + 它的 vars / dynamic */
export interface VariableTarget {
  target: string;
  vars?: string[];
  dynamic?: boolean;
}

/** 一条待判定路径的收尾结果（判定层直接读 path，不用再管变量） */
export interface SettledEffect {
  /** 报告里的原始效果（target 是工具给的原值） */
  effect: PreshellEffect;
  /** 喂给判定的文本：收尾成功是绝对路径，失败是工具给的原值 */
  path: string;
  /** true = path 是收尾出来的绝对路径 */
  known: boolean;
  /** known=false 时补不上的原因 */
  reason?: string;
}

/**
 * 哪些效果算「路径」：判定层（lib/sandbox-check.ts）只拿 Read/Write/Delete 去比对黑名单。
 * `Unknown` 的 target 不一定是路径——工具把「哪里看不懂」的说明也放在 target 里
 * （`cd $DIR` 会报一条 target 为 `cd to an unknown directory` 的 Unknown），拿它去收尾
 * 会凭空造出一个像路径的字符串；Exec/Spawn/Net 更明显（程序名、URL）。
 * 它的 vars 仍然会进 facts.vars（要准备哪些值看那个字段）。
 */
const PATH_KINDS: ReadonlySet<string> = new Set(["Read", "Write", "Delete"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 按 vars 列出的名字做字面替换（`${HOME}` 与 `$HOME` 两种写法）。
 *
 * 替换值一律用函数形式给 replace/replaceAll：字符串形式会把值里的 `$&`、`$1`、`` $` ``
 * 当模板展开（`"$HOME/x".replaceAll("$HOME", "/a/$&")` 得到的是 `/a/$HOME/x`），
 * 那等于把环境变量的内容当替换模板跑。值里的 `$` 与反斜杠必须原样落地。
 */
export function substituteVariables(
  text: string,
  vars: readonly string[],
  env: NodeJS.ProcessEnv,
): { ok: true; text: string } | { ok: false; reason: string } {
  let out = text;
  for (const name of vars) {
    const value = env[name];
    if (value === undefined) return { ok: false, reason: `${name} 未设` };
    out = out.replaceAll(`\${${name}}`, () => value);
    // 名字后面必须不是名字字符，否则 $XY 会被当成 $X 加个 Y（`$HOMEfoo` 是另一个变量名）
    out = out.replace(new RegExp(`\\$${escapeRegExp(name)}(?![A-Za-z0-9_])`, "g"), () => value);
  }
  return { ok: true, text: out };
}

/**
 * 一条效果的路径收尾（integration.md 里那个 resolvePath 示例的同款语义）。
 *
 * 吃整条效果而不是只吃 target：`dynamic` 与 `vars` 都是替换要用到的信息。
 * 替换成功只是第一步，最后那个 `path.resolve` 才是收尾：值本身是相对的（`HOME=rel`）时
 * 拿基准再收一下。顺序不能反——先替换、再看结果，才是参数值「按原样使用」的意思。
 */
export function resolvePath(effect: VariableTarget, env: NodeJS.ProcessEnv, cwd: string): ResolvedPath {
  const { target, vars = [], dynamic = true } = effect;
  if (typeof target !== "string" || target.length === 0) return { known: false, reason: "空的 target" };
  // dynamic 为假：这段文本没有运行时展开，`'$LIT/x'` 里的 `$` 是字面量，工具已锚定好了
  if (!dynamic) return { known: true, path: resolve(cwd, target) };

  let out = target;
  const tilde = out.startsWith("~+") ? "PWD" : out.startsWith("~-") ? "OLDPWD" : out.startsWith("~") ? "HOME" : null;
  if (tilde !== null && vars.includes(tilde)) {
    const value = env[tilde];
    if (value === undefined) return { known: false, reason: `${tilde} 未设` };
    out = value + out.slice(tilde === "HOME" ? 1 : 2);
  }
  const substituted = substituteVariables(out, vars, env);
  if (!substituted.ok) return { known: false, reason: substituted.reason };
  out = substituted.text;
  // 剩下的 `$` 是补不上的洞（`$1` / `$@` 不在环境里）；词首的 `~` 是 `~user`/`~N`，走口令库
  // 与目录栈，环境里也没有。路径中间的 `~` 是字面量（bash 只在词首展开），不算。
  if (out.includes("$") || out.startsWith("~")) {
    return { known: false, reason: "还有补不上的东西（$1 / $@ / ~user / ~N 这类不在环境里）" };
  }
  return { known: true, path: resolve(cwd, out) };
}

/**
 * 变量替换用的环境：变量表由调用方给（缺省 process.env），但「那条命令所在 shell 的目录」两条定死。
 *
 *   PWD   = 报告里的 `impact.cwd`（调用方传进来）。它才是那条命令所在目录的基准：命令自己
 *           `cd` 过就以 `cd` 之后的为准（`cd /tmp && cat ~+/x` 的 `~+` 是 `/tmp`，不是起始目录），
 *           工具给不出基准（`cd` 到未知目录）时当它未设。pi 进程自己的 PWD 是另一回事，
 *           留着它只会把 `$PWD/x` 补成一条错的绝对路径——所以除非有基准，一律删掉。
 *   OLDPWD：同样删掉。那条 shell 的上一个目录我们不知道，让 process.env 里的值冒名顶替
 *           只会把 `~-/x` 补成错的绝对路径——宁可保持原样（不确定）。
 */
export function resolutionEnv(pwd: string | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.OLDPWD;
  delete env.PWD;
  if (pwd) env.PWD = pwd;
  return env;
}

/** 收尾一份报告里所有需要按路径判定的效果（顺序与 effects 里的那些一致；base 是解析基准） */
export function settlePaths(
  effects: readonly PreshellEffect[],
  env: NodeJS.ProcessEnv,
  base: string,
): SettledEffect[] {
  const settled: SettledEffect[] = [];
  for (const effect of effects) {
    if (!effect || typeof effect.target !== "string" || !PATH_KINDS.has(effect.kind)) continue;
    const resolved = resolvePath(effect, env, base);
    settled.push(
      resolved.known
        ? { effect, path: resolved.path, known: true }
        : { effect, path: effect.target, known: false, reason: resolved.reason },
    );
  }
  return settled;
}

/** factsFromReport 的可选项：解析基准与替换用的环境 */
export interface FactsOptions {
  /** 调用方断言的 cwd（工具报的 impact.cwd 优先） */
  cwd?: string;
  /** 变量表；缺省 process.env。PWD / OLDPWD 两条仍由 resolutionEnv 定死 */
  env?: NodeJS.ProcessEnv;
  /** 命令原文：变量渲染要用（见 PreshellFacts.command） */
  command?: string;
}

/**
 * 从报告里挑出决策用得上的那几样，并把路径类型的 target 收尾成可判定的绝对路径。
 */
export function factsFromReport(report: PreshellReport, opts: FactsOptions = {}): PreshellFacts {
  const impact = report.impact ?? {};
  const effects = impact.effects ?? [];
  // 收尾的基准：工具自己报的 impact.cwd 优先（命令内部的 cd 会让它胜过我们传的 --cwd）。
  // 它也是 `$PWD` / `~+` 的值——同一条命令里 cd 过的话，PWD 是 cd 之后那个。
  const base = impact.cwd ?? opts.cwd ?? process.cwd();
  const settledPaths = settlePaths(effects, resolutionEnv(impact.cwd, opts.env ?? process.env), base);
  return {
    status: report.status ?? "?",
    // 收尾失败的（变量没设、$1 这类补不上）也算不确定：报告本身通常已经置了
    // uncertain，这里只是不再把缺口藏起来，方向只会更保守
    uncertain: impact.uncertain === true || settledPaths.some((item) => !item.known),
    effectsDropped: impact.effects_dropped ?? 0,
    issuesDropped: report.issues_dropped ?? 0,
    issues: parseIssues(report.issues),
    ...(impact.cwd ? { cwd: impact.cwd } : {}),
    ...(opts.command ? { command: opts.command } : {}),
    effects,
    vars: impact.vars ?? [...new Set(effects.flatMap((e) => e.vars ?? []))],
    settledPaths,
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

// ── 能力清单：本侧实际依赖的契约面（取代原来的版本号硬门禁）──
//
// 判据是「字段在不在」，不是版本号。清单里的每一项都注明 pi 侧哪一处代码在读它；只有本侧
// 真的开始依赖一个新字段时，才会往 required 里加一项（上游加功能、只是多给几个字段的加法，
// 在这里不需要改任何东西就吃得下）。
//
// 这份清单与 scripts/preshell-install.mjs 里的 GATE（安装时的门禁）同源但独立：
// 那边多一条 client_obligations（安装时看契约文本用，运行时不读），本侧不列；
// 两边都要的东西（tool / version / modes.stream / exit_codes / refusal / paths.*）保持一致。
//
// 只做存在性判断，不验语义（描述文案写成什么、行为对不对，这里看不出来），也拦不住
// 恶意二进制（它自己就能编一份漂亮的 --spec）。真正的防线是 sha256 + 影子对比 + 一条命令回滚。

/** --spec 的机读契约。每一项都是字符串描述，这里只看在不在，不解释内容 */
export interface PreshellSpec {
  tool?: unknown;
  version?: unknown;
  doc?: unknown;
  one_line?: unknown;
  modes?: unknown;
  exit_codes?: unknown;
  refusal?: unknown;
  client_obligations?: unknown;
  paths?: unknown;
  [key: string]: unknown;
}

export interface PreshellCapability {
  /** --spec 里的位置，也是 detail 里点名用的 id */
  id: string;
  /** required = 缺了判不可用；advisory = 缺了照旧跑，只记一笔 */
  level: "required" | "advisory";
  check: (spec: PreshellSpec) => boolean;
  /** pi 侧哪一处代码依赖它（改那处代码时这条要跟着改） */
  why: string;
}

function has(obj: unknown, key: string): boolean {
  return typeof obj === "object" && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

/** refusal.shape：描述拒绝回包形状的那句文本（如 `{"error":"...","line":N}`） */
function refusalShape(spec: PreshellSpec): string | undefined {
  const shape = (spec.refusal as { shape?: unknown } | undefined)?.shape;
  return typeof shape === "string" ? shape : undefined;
}

/**
 * 必需项：缺任何一条就按「事实层不可用」处理（退回旧匹配，不猜）。
 *
 * 这些是 lib/preshell.ts、lib/preshell-stream.ts、lib/sandbox-check.ts 真实读写的字段。
 */
export const REQUIRED_CAPABILITIES: readonly PreshellCapability[] = [
  {
    id: "tool",
    level: "required",
    check: (s) => s.tool === "preshell",
    why: "身份：queryPreshellSpec 只认它自报的名字。装错东西（别的工具也认 --spec）时立刻归到保守兜底",
  },
  {
    id: "version",
    level: "required",
    check: (s) => typeof s.version === "string" && s.version.trim() !== "",
    why: "PreshellOutcome.version / 提示与报告里的「实测版本」。注意：它不参与门禁（以前拿它比主次版号，见文件头）",
  },
  {
    id: "modes.stream",
    level: "required",
    check: (s) =>
      (Array.isArray(s.modes) ? s.modes : []).some((m) => {
        if (typeof m !== "object" || m === null) return false;
        const mode = m as { flag?: unknown; name?: unknown };
        return mode.flag === "--stream" || mode.name === "stream";
      }),
    why: "lib/preshell-stream.ts 的 ensureChild 起 `--stream` 长驻子进程；清单里没这一模式说明这个二进制没有它",
  },
  {
    id: "exit_codes.0",
    level: "required",
    check: (s) => has(s.exit_codes, "0"),
    why: "lib/preshell.ts analyzeCommand 只在退出码 0 时读 stdout 那份报告",
  },
  {
    id: "exit_codes.2",
    level: "required",
    check: (s) => has(s.exit_codes, "2"),
    why: "analyzeCommand 在 cwd 不是绝对路径时不给 --cwd——这条就是那个取舍的依据（给了就是用法错误，退出码 2）",
  },
  {
    id: "refusal.error",
    level: "required",
    check: (s) => refusalShape(s)?.includes('"error"') === true,
    why: "lib/preshell-stream.ts 的 handleLine 把应答里的 error 字段翻成 bad-json 失败；形状变了会被当成坏行",
  },
  {
    id: "refusal.line",
    level: "required",
    check: (s) => refusalShape(s)?.includes('"line"') === true,
    why: "同上：坏行要能定位到第几行（handleLine 那个分支就是冲着这个形状写的）",
  },
  {
    id: "paths.base",
    level: "required",
    check: (s) => has(s.paths, "base"),
    why: "analyzeCommand 传 --cwd=<绝对路径>；lib/sandbox-check.ts 的相对路径解析基准就是它",
  },
  {
    id: "paths.required",
    level: "required",
    check: (s) => has(s.paths, "required"),
    why: "analyzeCommand 的 cwdRejected：--cwd 缺失/非绝对路径时不给工具值，改由它自己推演——这条说清了不给的后果",
  },
  {
    id: "paths.vars",
    level: "required",
    check: (s) => has(s.paths, "vars"),
    why: "substituteVariables / resolvePath / facts.vars：洞里的变量名由本侧替换（环境在本侧手上）",
  },
  {
    id: "paths.always_absolute",
    level: "required",
    check: (s) => has(s.paths, "always_absolute"),
    why: "settlePaths 出来的路径直接拿去比黑名单（lib/sandbox-check.ts）；说好绝对路径才能这么用",
  },
  {
    id: "paths.cd_scope",
    level: "required",
    check: (s) => has(s.paths, "cd_scope"),
    why: "factsFromReport 的收尾基准优先用报告回的 impact.cwd（命令内部 cd 过就是 cd 之后那个）",
  },
  {
    id: "paths.no_base",
    level: "required",
    check: (s) => has(s.paths, "no_base"),
    why: "facts.uncertain；lib/sandbox-check.ts 一旦 incomplete 就不拿「没报写」当「不写」",
  },
  {
    id: "paths.origin",
    level: "required",
    check: (s) => has(s.paths, "origin"),
    why: "PreshellEffect.origin；lib/sandbox-check.ts 的 preshellProgramValues 拿它把效果对回命令行。v0.4.0 没有这条",
  },
  {
    id: "paths.candidates",
    level: "required",
    check: (s) => has(s.paths, "candidates"),
    why: "PreshellEffect.candidates；lib/sandbox-check.ts 候选逐个判（命中即拦）。没有它那档收紧收不到",
  },
];

/**
 * 提示级：缺了照旧跑，只记一笔（preshellSpecState().advisoryGaps）。
 */
export const ADVISORY_CAPABILITIES: readonly PreshellCapability[] = [
  {
    id: "paths.payload",
    level: "advisory",
    check: (s) => has(s.paths, "payload"),
    why: "PreshellEffect.payload——本侧起子进程时按这一项决定带不带 --payload（缺了就不带，照旧能跑；v0.4.1 就没有这条）",
  },
];

/** 全部能力项（必需 + 提示级），按清单顺序 */
export const PRESHELL_CAPABILITIES: readonly PreshellCapability[] = [...REQUIRED_CAPABILITIES, ...ADVISORY_CAPABILITIES];

export interface CapabilityCheck {
  /** 必需项齐不齐（只有它能决定可用性） */
  ok: boolean;
  /** 缺的必需项 id（ok=false 时非空） */
  missing: string[];
  /** 缺的提示项 id（不影响 ok） */
  missingAdvisory: string[];
}

/** 跑一遍能力清单。check 抛异常算缺项（宁可保守，不放过） */
export function checkCapabilities(spec: PreshellSpec): CapabilityCheck {
  const run = (item: PreshellCapability): boolean => {
    try {
      return item.check(spec) === true;
    } catch {
      return false;
    }
  };
  const missing = REQUIRED_CAPABILITIES.filter((item) => !run(item)).map((item) => item.id);
  const missingAdvisory = ADVISORY_CAPABILITIES.filter((item) => !run(item)).map((item) => item.id);
  return { ok: missing.length === 0, missing, missingAdvisory };
}

/**
 * 「缺能力」的 detail 文案（两处调用点共用一套措辞）：点名缺了什么，带上实测版本。
 * 错误文案说的是能力，不是版本——版本号已经只是提示了。
 * 已知版本由调用方补（只有它知道配置里写的是什么）：`${detail}；已知版本 ${known}`。
 */
export function capabilityFailureDetail(check: CapabilityCheck, measuredVersion: string | undefined): string {
  return `缺必需契约项 ${check.missing.join("、")}；实测 version=${measuredVersion ?? "读不出"}`;
}

// ── 调用与缓存 ──

/** 有界缓存：同一条命令在一次会话里会被问好几遍（bash、审计、升权、重试） */
const MAX_CACHE = 200;
const cache = new Map<string, PreshellOutcome>();

/**
 * 熔断：失败到阈值就不再试。
 *
 * 分两类，因为两类失败的代价不一样：
 *   - 确定性失败（缺件、契约能力不足）：不会自愈，一次就断（但每进程只试一次）
 *   - 瞬时失败（超时、坏 JSON、非零退出）：可能只是机器忙了一下。
 *     超时 100ms 之后这类更容易碰上，而误熔断的代价是整个会话退回旧匹配（误报全回来），
 *     所以要求连续 5 次。真卡死的二进制最多担误 5 × 100ms。
 * `/reload` 或重启后重试。
 */
export const BREAKER_IMMEDIATE: ReadonlySet<PreshellUnavailableReason> = new Set(["missing", "capability"]);
export const BREAKER_TRANSIENT_THRESHOLD = 5;

/**
 * 熔断与提示去重状态。这一层挂在 globalThis 上（见 lib/process-singleton.ts）：
 * preshell 的调用方散在多个扩展（bash-guard、dsh-jobs、sandbox-permissions），
 * 当成模块级状态就是每扩展一份 —— 一个扩展试出「缺二进制」而熔断，另几个扩展照样
 * 每次审计都去 spawn 一个不存在的进程、各弹一次同样的通知。
 *
 * 缓存的 cache / specCache 不在共享范围内：那只是同一份事实的重复查询，各存一份不影响正确性。
 */
interface PreshellSharedState {
  consecutiveFailures: number;
  breakerReason: PreshellUnavailableReason | undefined;
  /** 已弹过通知的原因（按进程去重，见 notifyFactLayerUnavailable） */
  announced: Set<PreshellUnavailableReason>;
  /** 状态栏的「事实层不可用」目前是否已设上 */
  statusShown: boolean;
  /** 实测 --spec 自报的版本（探测过才有）；只给报告/诊断看 */
  specMeasuredVersion: string | undefined;
  /** 提示级能力缺口（实测缺了哪些）：不影响判定，只记一笔 */
  capabilityGaps: string[];
}

const shared = processSingleton<PreshellSharedState>("preshell", () => ({
  consecutiveFailures: 0,
  breakerReason: undefined,
  announced: new Set<PreshellUnavailableReason>(),
  statusShown: false,
  specMeasuredVersion: undefined,
  capabilityGaps: [],
}));

export function preshellBreakerState(): { broken: PreshellUnavailableReason | undefined; failures: number } {
  return { broken: shared.breakerReason, failures: shared.consecutiveFailures };
}

/** 清的是共享那份的字段，不换引用 */
export function resetPreshellBreaker(): void {
  shared.consecutiveFailures = 0;
  shared.breakerReason = undefined;
}

export function clearPreshellCache(): void {
  cache.clear();
}

/**
 * 每次进程只探测一次 --spec（能力是产物属性，不随命令变）；流式客户端也用这份缓存。
 *
 * 只起这一个探测子进程：不再问 --version（--spec 里自带 version），也不去拿 --help 探
 * --stream（能力清单里的 modes.stream 就是干这个的）。
 *
 * 失败一律归到保守兜底：
 *   - 起不来 → missing / exit；跑超时 → timeout
 *   - 退出码 2（用法错误）→ capability：唯一的可能是它不认识 --spec（v0.4.0 之前没这个开关）。
 *     拿不到能力清单就是能力不足，不是「没依赖」也绝不能放行
 *   - 输出不是 JSON 对象 → bad-json
 *   - 是 JSON 对象但缺必需项 → capability（detail 点名缺了哪几项）
 */
export type PreshellSpecProbe =
  | { version: string; spec: PreshellSpec }
  | { error: PreshellUnavailableReason; detail?: string; measuredVersion?: string };

const specCache = new Map<string, PreshellSpecProbe>();

export function queryPreshellSpec(bin: string, timeoutMs = DEFAULT_TIMEOUT_MS): PreshellSpecProbe {
  const hit = specCache.get(bin);
  if (hit) return hit;
  let result: PreshellSpecProbe;
  try {
    const proc = spawnSync(bin, ["--spec"], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    if (proc.error) {
      const code = (proc.error as NodeJS.ErrnoException).code;
      result =
        code === "ENOENT"
          ? { error: "missing" }
          : code === "ETIMEDOUT"
            ? { error: "timeout", detail: `--spec 超过 ${timeoutMs}ms 没回` }
            : { error: "exit", detail: `--spec 没跑起来：${proc.error.message}` };
    } else if (proc.status === 2) {
      // 按契约，退出码 2 是用法错误：探测里唯一能触发它的就是不认识 --spec
      result = {
        error: "capability",
        detail: "这个二进制不认识 --spec（用法错误，退出码 2）：v0.4.0 之前没有能力清单，判不可用并退回旧匹配",
      };
    } else if (proc.status !== 0) {
      result = { error: "exit", detail: `--spec 退出码 ${proc.status}` };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(proc.stdout);
      } catch {
        parsed = undefined;
      }
      const spec =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as PreshellSpec) : undefined;
      if (!spec) {
        result = { error: "bad-json", detail: "--spec 的输出不是一份 JSON 对象" };
      } else {
        const check = checkCapabilities(spec);
        const measured = typeof spec.version === "string" ? spec.version.trim() : undefined;
        // 提示级缺口记一笔（只影响报告与诊断，不影响可用性）
        shared.capabilityGaps = [...check.missingAdvisory];
        shared.specMeasuredVersion = measured;
        result = check.ok
          ? { version: measured ?? "", spec }
          : { error: "capability", detail: capabilityFailureDetail(check, measured), ...(measured ? { measuredVersion: measured } : {}) };
      }
    }
  } catch (err) {
    result = { error: "bad-json", detail: err instanceof Error ? err.message : String(err) };
  }
  specCache.set(bin, result);
  return result;
}

/** 测试用：清掉能力探测缓存（连带它记下的能力缺口与实测版本） */
export function resetPreshellSpecCache(): void {
  specCache.clear();
  shared.capabilityGaps = [];
  shared.specMeasuredVersion = undefined;
}

/** 旧名（= resetPreshellSpecCache）：调用点还多，先留着 */
export function resetPreshellVersionCache(): void {
  resetPreshellSpecCache();
}

/**
 * 探测结果的展示层：实测版本、已知版本、两者是否同主次版号、提示级缺口。
 * 版本号不决定可用性，这里只是把「实测 vs 已知」摆出来（提示、报告、排障用）。
 */
export interface PreshellSpecState {
  /** 实测 --spec 自报的版本；没探测过就是 undefined */
  measuredVersion?: string;
  /** 推荐版本（extensions.toml 的 version / RECOMMENDED_VERSION）：只作提示 */
  recommendedVersion: string;
  /** 实测与推荐同主次版号；探测过才有。false 不代表不可用 */
  compatibleWithKnown?: boolean;
  /** 提示级能力缺口（实测缺了哪些） */
  advisoryGaps: readonly string[];
}

export function preshellSpecState(config: PreshellConfig = loadPreshellConfig()): PreshellSpecState {
  const recommended = recommendedVersionOf(config);
  const measured = shared.specMeasuredVersion;
  const tool = measured ? compatVersion(measured) : undefined;
  const want = compatVersion(recommended);
  return {
    ...(measured ? { measuredVersion: measured } : {}),
    recommendedVersion: recommended,
    ...(tool && want ? { compatibleWithKnown: tool === want } : {}),
    advisoryGaps: [...shared.capabilityGaps],
  };
}

/**
 * analyzeCommand 的可选项。
 */
export interface AnalyzeOptions {
  config?: PreshellConfig;
  /**
   * 这条命令会在哪个目录里跑（绝对路径）。传成 `--cwd=` 给工具当解析基准；
   * 变量替换里 `$PWD` / `~+` 用报告回的基准（命令内部 `cd` 过就是 `cd` 之后那个）。
   * 不是绝对路径时**不猜**：不给工具 --cwd（给相对值工具会直接报用法错误、退出码 2），
   * 改由工具拿自己进程的当前目录推演并在报告里置 uncertain，原值记进 facts.cwdRejected。
   */
  cwd?: string;
  /** 变量替换用的环境；缺省 process.env（PWD / OLDPWD 两条由 resolutionEnv 定死，见那里） */
  env?: NodeJS.ProcessEnv;
}

/**
 * 分析一条命令。任何异常都翻成 ok:false + reason，不抛：调用方据此走保守兜底。
 *
 * 可用性先过一遍能力探测（queryPreshellSpec，每个二进制只探一次）：缺必需契约项就
 * 返回 reason=capability（detail 点名缺了哪几项），调用方照旧退回旧匹配，绝不因探测失败而放行。
 * 版本号不参与判定；ok:true 时的 version 是 --spec 实测报的那个，只供展示。
 */
export function analyzeCommand(command: string, opts: AnalyzeOptions = {}): PreshellOutcome {
  const config = opts.config ?? loadPreshellConfig();
  if (!config.enabled) return { ok: false, reason: "disabled" };
  if (shared.breakerReason) return { ok: false, reason: shared.breakerReason, detail: "熔断中：本进程已连续失败，不再尝试（/reload 后重试）" };
  const bin = resolvePreshellBin(config);
  // v0.3.0：--cwd 事实上必填，且只能是绝对路径（相对值 = 用法错误，退出码 2）
  const cwd = opts.cwd !== undefined && isAbsolute(opts.cwd) ? opts.cwd : undefined;
  const cwdRejected = opts.cwd !== undefined && cwd === undefined ? opts.cwd : undefined;
  // 缓存键要把 cwd 算进去：同一条命令在不同目录里跑，事实不一样（v0.3.0 起更明显）。
  // env 不进键：缺省就是本进程的 process.env，会另给一份环境的调用方很少；真撞上就是这层取舍
  const key = `${bin}\u0000${cwd ?? ""}\u0000${command}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const outcome = ((): PreshellOutcome => {
    // 能力探测（--spec）：字段在就能用，不再比主次版号。版本号只进提示与报告
    const probe = queryPreshellSpec(bin, config.timeoutMs);
    if ("error" in probe) {
      if (probe.error !== "capability") return { ok: false, reason: probe.error, ...(probe.detail ? { detail: probe.detail } : {}) };
      // 缺能力的 detail 里把「推荐版本」也带上：它是提示值，不参与判定
      const recommended = recommendedVersionOf(config);
      return { ok: false, reason: "capability", detail: `${probe.detail}；推荐版本 ${recommended}` };
    }
    const version = probe.version;
    // 解释器载荷是提示级能力（v0.5.0 起）：有这一项才带 --payload。老二进制认不得这个开关，
    // 塞下去就是用法错误（退出码 2）→ 整条退回旧匹配，所以先看清单再决定
    const payloadSupported = !checkCapabilities(probe.spec).missingAdvisory.includes("paths.payload");
    try {
      const args = ["--shell=probe", ...(cwd ? [`--cwd=${cwd}`] : []), ...(payloadSupported ? ["--payload"] : [])];
      const proc = spawnSync(bin, args, {
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
      const facts = factsFromReport(report, { cwd, env: opts.env, command });
      return { ok: true, facts: cwdRejected ? { ...facts, cwdRejected } : facts, version };
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
    shared.consecutiveFailures = 0;
  } else if (outcome.reason !== "disabled") {
    shared.consecutiveFailures++;
    if (BREAKER_IMMEDIATE.has(outcome.reason) || shared.consecutiveFailures >= BREAKER_TRANSIENT_THRESHOLD) {
      shared.breakerReason = outcome.reason;
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

const STATUS_KEY = "preshell";

/**
 * 会往桌面弹通知的原因：能动手解决的那些。
 * 瞬时的超时/坏 JSON 不打扰，否则一次网络抖就弹一次。
 */
const DESKTOP_REASONS: ReadonlySet<PreshellUnavailableReason> = new Set(["missing", "capability", "disabled"]);

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
    shared.statusShown = true;
  } catch {
    // 状态栏不可用不影响判定
  }
  if (shared.announced.has(reason)) return "";
  shared.announced.add(reason);

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
  if (!shared.statusShown) return;
  shared.statusShown = false;
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

/** 测试用：清掉「已弹过」记录（清内容，不换引用） */
export function resetFactLayerNotices(): void {
  shared.announced.clear();
  shared.statusShown = false;
}

// ── 展示：事实 → 紧凑文本 ──
//
// 这一段只管「把事实摆给人/模型看」，不做任何裁决。三样东西以前没摆出来：
//   1. 解释器载荷（payload）：`python3 -c '<code>'` 里的那段源码。程序碰什么由它自己
//      决定，命令行上唯一看得见的就是这段原文——不摆出来，审核方只能看见「python3」两个字
//   2. 截断信号（effects_dropped / issues_dropped，以及本函数自己的 limit）：
//      清单不完整时必须说「不完整」，否则「只列了 12 条」会被读成「一共就这些」
//   3. 工具自报的 issues：它自己发现的问题（解析缺口、语法错、方言是猜的）

/** 单条载荷最多给多少行；超出的只给开头（首几行），并标注全文规模 */
export const PAYLOAD_PREVIEW_LINES = 12;
/** 单条载荷最多给多少字节；先按行截、再按字节截，切口落在字符边界上 */
export const PAYLOAD_PREVIEW_BYTES = 800;
/** 单条 issue 文案的展示上限：文案是散文，太长的那截多半是重复 */
export const ISSUE_MESSAGE_MAX = 240;

/** UTF-8 字节数（载荷的 bytes 字段按字节计，展示口径跟它对齐） */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 按 UTF-8 字节取前缀：切口落在字符边界上（宁可少一个字符，不切出半个） */
function utf8Prefix(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end > 0; end--) {
    try {
      return decoder.decode(buf.subarray(0, end));
    } catch {
      // 切在多字节字符中间：少一个字节再试（最多三次）
    }
  }
  return "";
}

/** 载荷原文的行数：末尾那个换行不算多一行（`a\nb\n` 是两行） */
function payloadLineCount(text: string): number {
  const raw = text.endsWith("\n") ? text.slice(0, -1) : text;
  return Math.max(raw.split("\n").length, 1);
}

interface PayloadPreview {
  /** 给出去的那段文本（可能是前缀） */
  body: string;
  shownLines: number;
  shownBytes: number;
  /** body 只是前缀（按行或按字节截过） */
  cut: boolean;
}

/** 载荷的展示前缀：先按行封顶，再按字节封顶 */
function previewPayload(text: string): PayloadPreview {
  const raw = text.endsWith("\n") ? text.slice(0, -1) : text;
  const all = raw.split("\n");
  let body = all.slice(0, PAYLOAD_PREVIEW_LINES).join("\n");
  let cut = all.length > PAYLOAD_PREVIEW_LINES;
  if (byteLength(body) > PAYLOAD_PREVIEW_BYTES) {
    body = utf8Prefix(body, PAYLOAD_PREVIEW_BYTES);
    cut = true;
  }
  return { body, shownLines: body.split("\n").length, shownBytes: byteLength(body), cut };
}

/** 载荷是从命令行哪儿拿到的：`-c` / `<<PY` / 程序参数 */
function payloadOrigin(payload: PreshellPayload): string {
  if (payload.source === "flag" && payload.flag) return payload.flag;
  if (payload.source === "heredoc" && payload.delimiter) return `<<${payload.delimiter}`;
  if (payload.source === "operand") return "程序参数";
  return payload.source || "来源未知";
}

/** 载荷的大小标注：全文多少行/字节；被 preshell 自己截过就明说只拿到了前缀 */
function describePayloadSize(payload: PreshellPayload): string {
  const prefixBytes = byteLength(payload.text);
  const fullBytes = typeof payload.bytes === "number" && Number.isFinite(payload.bytes) ? payload.bytes : prefixBytes;
  const lines = payloadLineCount(payload.text);
  if (payload.truncated) {
    return `全文 ${fullBytes} 字节，preshell 只给了前 ${prefixBytes} 字节${lines > 1 ? `（${lines} 行）` : ""}`;
  }
  return lines > 1 ? `共 ${lines} 行 / ${fullBytes} 字节` : `${fullBytes} 字节`;
}

/** 一条 issue 的一行展示：`Note: …（行 3）`；文案折成一行，免得撑破标题 */
function describeIssue(issue: PreshellIssue): string {
  const flat = issue.message.replace(/\s+/g, " ").trim();
  const body = flat.length > ISSUE_MESSAGE_MAX ? `${flat.slice(0, ISSUE_MESSAGE_MAX)}…` : flat;
  const where = typeof issue.line === "number" && issue.line > 0 ? `（行 ${issue.line}）` : "";
  return `${issue.kind}: ${body}${where}`;
}

/** 事实 → 给模型/人看的紧凑文本（LLM 预审与审计条目共用，措辞保持同一套） */
export function formatFacts(facts: PreshellFacts, limit = 12): string {
  // 变量渲染：命令名位置上的 `$P` 单看判不出跑的是什么，模型看不到展开那一步。
  // 命令原文在 facts.command 里（事实层收尾时一起带上）；没有就只是不出这一块
  const renders = facts.command ? collectVarRenders(facts.command) : [];
  const annotate = (target: string): string => {
    // 按引用片段或变量名认领：渲不出来时 target 指的是那处赋值的值文本（`$(which jq)`），
    // 在程序行里对上号得靠名字
    const hits = renders.filter(
      (r) =>
        referenceAppearsIn(target, r.target) ||
        referenceAppearsIn(target, `$${r.name}`) ||
        referenceAppearsIn(target, `${r.name}`),
    );
    if (hits.length === 0) return target;
    const notes = hits.map((r) =>
      r.known ? (target === r.target ? `${r.value}` : `${r.name}=${r.value}`) : `渲不出：${r.reason}`,
    );
    return `${target}（${notes.join("；")}）`;
  };
  // 路径类的效果带上收尾后的绝对路径：`$HOME/x` 这种原值单看判不出到哪，模型看不到替换这一步
  const settled = new Map(facts.settledPaths.map((item) => [item.effect, item]));
  const label = (e: PreshellEffect): string => {
    const done = settled.get(e);
    const shown = done && done.known && done.path !== e.target ? `${e.target} → ${done.path}` : e.target;
    const notes = [
      e.dynamic ? "目标不封闭" : "",
      e.modeled === false ? "未建模" : "",
      done && !done.known && done.reason ? `变量补不上：${done.reason}` : "",
    ].filter(Boolean);
    return `${shown}${notes.length > 0 ? `（${notes.join("；")}）` : ""}`;
  };
  const byKind = (kinds: string[]) => facts.effects.filter((e) => kinds.includes(e.kind)).map(label);
  // 一组条目的展示：limit 截断不再静默。以前列够 12 条就把剩下的丢掉、什么都不说，
  // 读的人会把「列出来的」当成「一共就这些」——那是误导
  const group = (items: string[], sep = " "): string => {
    const shown = items.slice(0, limit);
    if (shown.length === 0) return "";
    return items.length > shown.length
      ? `${shown.join(sep)}（共 ${items.length} 条，此处列 ${shown.length} 条）`
      : shown.join(sep);
  };
  const lines: string[] = [];
  // 清单完整性的信号放最前：effects/issues 被上限截过时，下面每一节都只是「列出来的那部分」，
  // 拿它当完整账单就是误判
  const incomplete: string[] = [];
  if (facts.effectsDropped > 0) incomplete.push(`effects 还有 ${facts.effectsDropped} 条未列出`);
  if (facts.issuesDropped > 0) incomplete.push(`issues 还有 ${facts.issuesDropped} 条未列出`);
  if (incomplete.length > 0) {
    lines.push(`- ⚠ 清单不完整：${incomplete.join("、")}（被事实层上限截断，未列出的部分未知）`);
  }
  const read = byKind(["Read"]);
  const write = byKind(["Write", "Delete"]);
  const exec = [...new Set(facts.effects.filter((e) => e.kind === "Exec" || e.kind === "Spawn").map((e) => e.target))].map(annotate);
  if (exec.length > 0) lines.push(`- 程序：${group(exec)}`);
  // 解释器载荷：`python3 -c '<code>'` / `node -e '<code>'` / `awk '{…}'` / heredoc 正文。
  // 只搬原文，不替它下结论（原文里写了什么就是什么，安全还是危险由审核方自己看）
  const payloads = facts.effects.filter((e) => e.payload && typeof e.payload.text === "string" && e.payload.text.length > 0);
  if (payloads.length > 0) {
    lines.push("- 解释器载荷（程序读到的源码原文，未求值）：");
    for (const effect of payloads.slice(0, limit)) {
      const payload = effect.payload as PreshellPayload;
      const preview = previewPayload(payload.text);
      lines.push(`  ${effect.target} ${payloadOrigin(payload)}（${describePayloadSize(payload)}）：`);
      for (const line of preview.body.split("\n")) lines.push(`    ${line}`);
      if (preview.cut) lines.push(`    …（此处只列前 ${preview.shownLines} 行 / ${preview.shownBytes} 字节）`);
    }
    if (payloads.length > limit) lines.push(`  …（另有 ${payloads.length - limit} 条载荷未列）`);
  }
  if (read.length > 0) lines.push(`- 读：${group(read)}`);
  if (write.length > 0) lines.push(`- 写/删：${group(write)}`);
  if (facts.net.length > 0) lines.push(`- 网络：${group(facts.net)}`);
  if (facts.unmodeled.length > 0) lines.push(`- 未建模程序（它们碰什么不由命令行决定）：${group(facts.unmodeled)}`);
  if (renders.length > 0) {
    // 变量表：命令里用到的变量各自渲成了什么（或为什么渲不出来），一条一行
    const table = renders.map((r) =>
      r.known
        ? `${r.name}=${r.value}（${r.source === "assignment" ? "本命令内赋值" : "环境变量"}）`
        : `${r.name}（渲不出：${r.reason}）`,
    );
    lines.push(`- 变量：${group(table, "；")}`);
  }
  // 工具自报的问题（Gap / Syntax / Note）：它说「这份报告哪里不该被当成干净账单」
  if (facts.issues.length > 0) {
    const shown = facts.issues.slice(0, limit).map(describeIssue);
    const suffix = facts.issues.length > shown.length ? `（共 ${facts.issues.length} 条，此处列 ${shown.length} 条）` : "";
    lines.push(`- 事实层问题：${shown.join("；")}${suffix}`);
  }
  lines.push(`- 解析：${facts.status}${facts.cwd ? ` · cwd=${facts.cwd}` : ""}${facts.uncertain ? " · uncertain（影响面不封闭，「没报写」不等于「不写」）" : ""}`);
  return lines.join("\n");
}
