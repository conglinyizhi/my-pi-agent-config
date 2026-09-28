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
//   --version → {"tool":"preshell","version":"0.5.0"}：**兼容性只跟版本号走**
//   拿不到报告（缺二进制/超时/坏 JSON/版本不符）时默认动作是保守兜底，绝不因此放行
//
// 本文件按 v0.5.0 适配。v0.5.0 是次要版本变更（0.4 → 0.5，按约定不兼容），但也只是加法：
// 新增 opt-in 的 effect.payload（第 5 条），并修了 wrapper（uv / docker run / conda run 这类）
// 的 Spawn 目标解析。前面几条自 v0.4.0 起就成立：
//   0 破坏性：schema 号删掉了。判定「这次升级会不会打挂我」只看版本号——次版本号变即
//     不兼容（0.5 起要重新适配），修订号变是兼容的（0.4.x 互通）。旧版（≤0.3.0）的
//     --version 还带 schema 字段，读的时候要能两种都吃（见 queryPreshellVersion）
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
  /** flag = 来自选项的值；heredoc = 来自 here-document 正文 */
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
   * 只给「参数就是自己源码」的那几个程序（awk / sed 不在表里）。
   *
   * **本侧目前只解析、还没接线**：拿到手后可以扫黑名单、可以送预审。
   * 现有那个 interpreter 层（lib/sandbox-check.ts）今天是从命令文本里自己抠的，
   * 等上游版本稳定再换成用这个字段
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

export type PreshellUnavailableReason = "disabled" | "missing" | "timeout" | "exit" | "bad-json" | "version";

export type PreshellOutcome =
  | { ok: true; facts: PreshellFacts; version: string }
  | { ok: false; reason: PreshellUnavailableReason; detail?: string };

export interface PreshellConfig {
  enabled: boolean;
  bin: string;
  timeoutMs: number;
  /**
   * 期望的契约版本（主次版号，如 "0.4"）；次版本号不一致就按「事实层不可用」处理。
   *
   * v0.4.0 起 preshell 删掉了 schema 号，兼容性只跟版本号走（见文件头）。扩展配置里的
   * 新键名是 `version`（extensions.toml 的 [preshell] 段）；旧配置里那个 `schema = 1`
   * 已经没意义，读了也不参与判定（它只是留在文件里，不报错）。
   */
  expectedVersion: string;
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
 * 我们适配过的契约版本（主次版号）。比较只看这两个数：次版本号变了就是不兼容，
 * 修订号变了是兼容的（0.5.x 互通；0.4.x 及更早的旧二进制一律走保守兜底）。
 * 当前是 0.5.0（payload 字段已解析但尚未接线使用，见 PreshellEffect.payload）。
 */
export const EXPECTED_VERSION = "0.5";

/**
 * 版本号 → 主次版号（"0.4.1" → "0.4"）；读不出版号时 undefined。
 * 多出来的东西（预发布后缀之类）不管：兼容性只看前两段。
 */
export function compatVersion(version: string): string | undefined {
  const m = /^(\d+)\.(\d+)/.exec(String(version).trim());
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/**
 * 契约是否兼容：主次版号一致。
 *
 * 任何一个读不出来（工具没报版本号、配置写坏）都算不兼容——保守兜底，不猜。
 */
export function versionsCompatible(toolVersion: string, expectedVersion: string): boolean {
  const tool = compatVersion(toolVersion);
  const expected = compatVersion(expectedVersion);
  return tool !== undefined && expected !== undefined && tool === expected;
}

/**
 * 安装说明：通知、配置注释、文档共用一份，避免三处各写一句、各有出入。
 * 工具本身不回传安装方式（它只是个静态分析器），所以这段文字只能由调用方给。
 */
export const INSTALL_HINT = [
  "preshell 是命令审核的事实层（独立子进程，GPL-3.0-or-later，仓库 conglinyizhi/preshell）",
  "装它：gh release download v0.5.0 -R conglinyizhi/preshell -D /tmp/p && sha256sum -c /tmp/p/SHA256SUMS",
  "      install -Dm755 /tmp/p/preshell-v0.5.0-x86_64-linux ~/.pi/runtime/preshell",
  "v0.2 起支持 --stream：批量场景一个子进程跑多条命令，见 lib/preshell-stream.ts",
  "v0.3 起 --cwd 事实上必填（单条与流式都是进程级参数）；词首带变量/~/~+ 的路径由调用方收尾",
  "v0.4 起兼容性只看版本号（次版本号变即不兼容）；条件分支的候选值走 effect.candidates",
  "v0.4.1 起：赋值解出来的目标带 origin（它原来写的那处引用），候选集只在穷尽时才给",
  "v0.5.0 起：--payload（opt-in）在 Exec/Spawn 上带载荷原文；wrapper 的 Spawn 目标修正",
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
    case "version":
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
    expectedVersion: EXPECTED_VERSION,
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
      // 老配置里的 `schema = 1` 到此为止：v0.4.0 起它没有对照物了，读也不读，免得把
      // 「一个数字」误当成版本号。要钉版本写 `version = "0.4"`（缺省就是它）
      expectedVersion: typeof section.version === "string" && section.version.trim() ? section.version.trim() : fallback.expectedVersion,
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

// ── 调用与缓存 ──

/** 有界缓存：同一条命令在一次会话里会被问好几遍（bash、审计、升权、重试） */
const MAX_CACHE = 200;
const cache = new Map<string, PreshellOutcome>();

/**
 * 熔断：失败到阈值就不再试。
 *
 * 分两类，因为两类失败的代价不一样：
 *   - 确定性失败（缺件、契约版本不符）：不会自愈，一次就断（但每进程只试一次）
 *   - 瞬时失败（超时、坏 JSON、非零退出）：可能只是机器忙了一下。
 *     超时 100ms 之后这类更容易碰上，而误熔断的代价是整个会话退回旧匹配（误报全回来），
 *     所以要求连续 5 次。真卡死的二进制最多担误 5 × 100ms。
 * `/reload` 或重启后重试。
 */
export const BREAKER_IMMEDIATE: ReadonlySet<PreshellUnavailableReason> = new Set(["missing", "version"]);
export const BREAKER_TRANSIENT_THRESHOLD = 5;

/**
 * 熔断与提示去重状态。这一层挂在 globalThis 上（见 lib/process-singleton.ts）：
 * preshell 的调用方散在多个扩展（bash-guard、dsh-jobs、sandbox-permissions），
 * 当成模块级状态就是每扩展一份 —— 一个扩展试出「缺二进制」而熔断，另几个扩展照样
 * 每次审计都去 spawn 一个不存在的进程、各弹一次同样的通知。
 *
 * 缓存的 cache / versionCache 不在共享范围内：那只是同一份事实的重复查询，各存一份不影响正确性。
 */
interface PreshellSharedState {
  consecutiveFailures: number;
  breakerReason: PreshellUnavailableReason | undefined;
  /** 已弹过通知的原因（按进程去重，见 notifyFactLayerUnavailable） */
  announced: Set<PreshellUnavailableReason>;
  /** 状态栏的「事实层不可用」目前是否已设上 */
  statusShown: boolean;
}

const shared = processSingleton<PreshellSharedState>("preshell", () => ({
  consecutiveFailures: 0,
  breakerReason: undefined,
  announced: new Set<PreshellUnavailableReason>(),
  statusShown: false,
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
 * 每次进程只问一次 --version（版本是产物属性，不随命令变）；流式客户端也用这份缓存。
 *
 * 两个版都要能读：v0.4.0 是 `{"tool":"preshell","version":"0.4.0"}`（没有 schema 了），
 * 旧版（≤0.3.0）多一个 `schema` 字段。多出来的字段一律忽略——**版本号才是兼容性依据**；
 * 读不出 `version` 字符串（字符串以外的类型也算）就当坏 JSON。
 */
const versionCache = new Map<string, { version: string } | { error: PreshellUnavailableReason }>();

export function queryPreshellVersion(
  bin: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): { version: string } | { error: PreshellUnavailableReason } {
  const hit = versionCache.get(bin);
  if (hit) return hit;
  let result: { version: string } | { error: PreshellUnavailableReason };
  try {
    const proc = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: timeoutMs });
    if (proc.error) {
      result = { error: (proc.error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "exit" };
    } else if (proc.status !== 0) {
      result = { error: "exit" };
    } else {
      const parsed = JSON.parse(proc.stdout) as { version?: unknown; schema?: unknown };
      result = typeof parsed.version === "string" ? { version: parsed.version } : { error: "bad-json" };
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
    const version = queryPreshellVersion(bin, config.timeoutMs);
    if ("error" in version) return { ok: false, reason: version.error };
    if (!versionsCompatible(version.version, config.expectedVersion)) {
      return {
        ok: false,
        reason: "version",
        detail: `工具报 version=${version.version}，期望 ${config.expectedVersion}.x`,
      };
    }
    try {
      const proc = spawnSync(bin, ["--shell=probe", ...(cwd ? [`--cwd=${cwd}`] : [])], {
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
      return { ok: true, facts: cwdRejected ? { ...facts, cwdRejected } : facts, version: version.version };
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
const DESKTOP_REASONS: ReadonlySet<PreshellUnavailableReason> = new Set(["missing", "version", "disabled"]);

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
  const byKind = (kinds: string[]) =>
    facts.effects
      .filter((e) => kinds.includes(e.kind))
      .slice(0, limit)
      .map(label);
  const lines: string[] = [];
  const read = byKind(["Read"]);
  const write = byKind(["Write", "Delete"]);
  const exec = [...new Set(facts.effects.filter((e) => e.kind === "Exec" || e.kind === "Spawn").map((e) => e.target))].slice(0, limit).map(annotate);
  if (exec.length > 0) lines.push(`- 程序：${exec.join(" ")}`);
  if (read.length > 0) lines.push(`- 读：${read.join(" ")}`);
  if (write.length > 0) lines.push(`- 写/删：${write.join(" ")}`);
  if (facts.net.length > 0) lines.push(`- 网络：${facts.net.slice(0, limit).join(" ")}`);
  if (facts.unmodeled.length > 0) lines.push(`- 未建模程序（它们碰什么不由命令行决定）：${facts.unmodeled.join(" ")}`);
  if (renders.length > 0) {
    // 变量表：命令里用到的变量各自渲成了什么（或为什么渲不出来），一条一行
    const table = renders
      .slice(0, limit)
      .map((r) =>
        r.known
          ? `${r.name}=${r.value}（${r.source === "assignment" ? "本命令内赋值" : "环境变量"}）`
          : `${r.name}（渲不出：${r.reason}）`,
      );
    lines.push(`- 变量：${table.join("；")}`);
  }
  lines.push(`- 解析：${facts.status}${facts.cwd ? ` · cwd=${facts.cwd}` : ""}${facts.uncertain ? " · uncertain（影响面不封闭，「没报写」不等于「不写」）" : ""}`);
  return lines.join("\n");
}
