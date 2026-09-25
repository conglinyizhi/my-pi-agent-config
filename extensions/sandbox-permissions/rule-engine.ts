/**
 * 规则引擎（token 化）——取代基于正则的 dangerous-patterns + helpers
 *
 * 设计：
 * - 命令按分隔符（&& | || ; 换行）分段
 * - 每段按空白 token 化（去引号、保留 env 前缀为独立 token）
 * - 规则用「命令名 + 子命令 + flag/参数精确匹配」结构化判断，零回溯
 *
 * 相比正则方案的收益：
 * - FOO=--system 不再误判（token 精确等于 --system 才命中）
 * - uv pip install 前缀排除是天然结果（cmd 精确匹配），无需 lookbehind
 * - 管道/&& 分段后上下文天然隔离，无需 [^;]* 兜底
 */

import {
  splitWithSeparators,
  findInnerSubst,
  maskShellBlindZones,
  maskNonShellHeredocBodies,
  pythonDangerous,
} from "./scanner.ts";
import type { SegWithSep, MaskedCommand } from "./scanner.ts";
import { staticProgramValues, type StaticValue } from "../../lib/var-render.ts";
import * as fs from "node:fs";
import * as path from "node:path";
// re-export：测试与外部调用从 rule-engine 导入的路径保持不变
export {
  splitWithSeparators,
  maskShellBlindZones,
  pythonDangerous,
} from "./scanner.ts";
export type { SegWithSep, MaskedCommand } from "./scanner.ts";

/** 命中规则对外形态 */
export interface TokenRule {
  name: string;
  tip: string;
  autoReject?: boolean;
  /** 命中的 token（命令名/子命令/flag/参数），供 GUI 高亮 */
  matched?: string[];
}

interface RuleDef {
  name: string;
  /** 命令名（段内第一个非 env 前缀 token）精确匹配；省略 = 任意命令 */
  cmd?: string | string[];
  /** 命令名之后必须依次匹配的子命令 token */
  subcmd?: string[];
  /** 段内至少出现一个（精确 token 匹配） */
  anyFlags?: string[];
  /** 段内至少出现一个参数（精确 token 匹配） */
  anyArgs?: string[];
  /** 命中的 arg 后紧跟这些 token 时不视为命中（如 > /dev/null 只是丢弃输出） */
  exceptNextArgs?: string[];
  /** 命中的 arg 后紧跟以这些前缀开头的 token 时不视为命中（如 > /tmp/x 写临时目录）；含 .. 路径段的前缀匹配除外（防穿越） */
  exceptNextPrefixes?: string[];
  /** 命中 arg 且处于此上下文时不视为命中（如 > 是比较/移位运算符而非重定向） */
  skip?: (tokens: string[], idx: number) => boolean;
  tip: string;
  autoReject?: boolean;
}

const RULES: RuleDef[] = [
  {
    name: "rm-recursive",
    cmd: "rm",
    anyFlags: ["-rf", "-r", "--recursive"],
    tip: "避免递归删除，请先确认目标路径",
  },
  {
    name: "find-delete",
    cmd: "find",
    anyFlags: ["-delete", "-exec", "-ok"],
    tip: "find 配合 -delete/-exec/-ok 会删除或执行任意匹配文件，请改为显式确认后的操作",
  },
  {
    name: "sudo",
    cmd: "sudo",
    tip: "提权命令：沙箱 no_new_privs 已禁 setuid 提权，但 sudo 前缀的破坏命令（如 sudo rm -rf）仍以普通权限执行，请确认",
  },
  {
    name: "dd",
    cmd: "dd",
    tip: "dd 可直读块设备（if=/dev/sda 把磁盘原始内容读到 /tmp 外传）；沙箱 --ro / 允许读 /dev（写盘 of= 已被沙箱 --rw 不含 /dev 拒绝），读盘是绕过沙箱的唯一手段，请确认",
  },
];

// ═══════════════════════════════════════════════════
// 分段与 token 化
// ═══════════════════════════════════════════════════

/** 命令 → 分段 → 每段 tokens（去引号、过滤空段） */
export function splitCommands(cmd: string): string[][] {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((seg) => tokenize(seg))
    .filter((tokens) => tokens.length > 0);
}

/** 段内 token 化：双引号/单引号内容保留为一个 token（去引号），其余按空白切 */
function tokenize(seg: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/** 段内命令名索引：跳过开头的 NAME=value 环境变量前缀 */
function findCommandIndex(tokens: string[]): number {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return i;
}

// ═══════════════════════════════════════════════════
// 规则匹配
// ═══════════════════════════════════════════════════

/** 匹配规则：命中返回命中的 token 列表（供 GUI 高亮），否则 null */
function matchRule(tokens: string[], rule: RuleDef): string[] | null {
  const cmdIdx = findCommandIndex(tokens);
  const matched: string[] = [];
  if (rule.cmd) {
    const cmds = Array.isArray(rule.cmd) ? rule.cmd : [rule.cmd];
    const cmdToken = tokens[cmdIdx];
    if (cmdToken === undefined) return null;
    // 带路径命令（node_modules/.bin/tsx）取 basename 匹配，防路径调用绕过规则
    const basename = cmdToken.includes("/") ? cmdToken.slice(cmdToken.lastIndexOf("/") + 1) : cmdToken;
    if (!cmds.includes(cmdToken) && !cmds.includes(basename)) return null;
    matched.push(cmdToken);
  }
  if (rule.subcmd) {
    for (let i = 0; i < rule.subcmd.length; i++) {
      if (tokens[cmdIdx + 1 + i] !== rule.subcmd[i]) return null;
    }
    matched.push(...rule.subcmd);
  }
  if (rule.anyFlags) {
    const hit = rule.anyFlags.filter((f) => tokens.includes(f));
    if (hit.length === 0) return null;
    matched.push(...hit);
  }
  if (rule.anyArgs) {
    // 逐位置检查：全部出现都被 exceptNextArgs/exceptNextPrefixes/skip 覆盖才算不命中
    const hit = rule.anyArgs.filter((a) => {
      let idx = tokens.indexOf(a);
      while (idx !== -1) {
        if (!(rule.skip && rule.skip(tokens, idx))) {
          const next = tokens[idx + 1];
          const exactExcept = rule.exceptNextArgs && rule.exceptNextArgs.includes(next);
          // 前缀豁免：目标以允许前缀开头，且不含 .. 路径段（防 /tmp/../etc 穿越）
          const prefixExcept =
            !!next &&
            !!rule.exceptNextPrefixes &&
            rule.exceptNextPrefixes.some(
              (p) => next.startsWith(p) && !next.split("/").includes(".."),
            );
          if (!exactExcept && !prefixExcept) {
            return true;
          }
        }
        idx = tokens.indexOf(a, idx + 1);
      }
      return false;
    });
    if (hit.length === 0) return null;
    matched.push(...hit);
  }
  return matched;
}

/**
 * 命中所有危险规则（跨段聚合、去重）。
 *
 * 先遮掉「不会被 shell 执行」的 heredoc 正文：`splitCommands` 按 `\n` 切段，正文里的每一行
 * 都会被当成一条命令，于是 `cat > x.sh <<EOF` 里写的 `rm -rf` 也被当成要执行 rm。
 * 而 `bash <<EOF` / `cat <<EOF | bash` 那种正文确实会被当命令跑，要照旧扫。
 * 命令替换不归这里管：`$(...)` 写入时就会展开执行，那条路径由 auditSubstitutions 负责，
 * 它在遮罩之前就把内容摘出来了
 */
export function matchDangerous(cmd: string): TokenRule[] {
  return matchDangerousSegments(maskNonShellHeredocBodies(cmd));
}

function matchDangerousSegments(cmd: string): TokenRule[] {
  const seen = new Set<string>();
  const result: TokenRule[] = [];
  for (const seg of splitCommands(cmd)) {
    for (const r of RULES) {
      const matched = matchRule(seg, r);
      if (matched && !seen.has(r.name)) {
        seen.add(r.name);
        result.push({ name: r.name, tip: r.tip, autoReject: r.autoReject, matched });
      }
    }
  }
  return result;
}

/** 是否存在自动拒绝规则命中 */
export function isAutoReject(cmd: string): boolean {
  return matchDangerous(cmd).some((r) => r.autoReject);
}

/** 提取被 /tmp/ 前缀豁免的重定向目标（纯 token 分析，不碰文件系统） */
export function extractTmpRedirectTargets(cmd: string): string[] {
  const targets: string[] = [];
  // 同一件事：正文里的 `> /path` 是写给文件的内容，不是这条命令的重定向
  for (const seg of splitCommands(maskNonShellHeredocBodies(cmd))) {
    for (let i = 0; i < seg.length; i++) {
      const t = seg[i];
      if (t !== ">" && t !== ">>" && t !== "&>" && t !== "&>>") continue;
      const next = seg[i + 1];
      if (!next) continue;
      // 与被豁免的 exceptNextPrefixes 条件一致：/tmp/ 前缀 + 无 .. 路径段
      if (next.startsWith("/tmp/") && !next.split("/").includes("..")) {
        targets.push(next);
      }
    }
  }
  return targets;
}

/** 动态校验：重定向目标 realpath 后仍在 /tmp 内才算安全（防软链穿透） */
export function isTmpRedirectTargetSafe(target: string): boolean {
  const real = resolveExistingPath(target);
  if (!real) return true; // 无法解析，保守放行（静态已确认 /tmp/ 前缀）
  const tmpReal = fs.realpathSync("/tmp");
  return real === tmpReal || real.startsWith(tmpReal + "/");
}

/** 找到路径链上最近的存在祖先并返回其 realpath；全链不存在返回 null */
function resolveExistingPath(p: string): string | null {
  let cur = p;
  for (let i = 0; i < 64; i++) {
    try {
      return fs.realpathSync(cur);
    } catch {
      /* 不存在，向上 */
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

// ═══════════════════════════════════════════════════
// venv 白名单
// ═══════════════════════════════════════════════════

/** 段是否为 venv 激活/创建（uv venv / source|x 激活 / python -m venv） */
function isVenvActivation(tokens: string[]): boolean {
  const i = findCommandIndex(tokens);
  const cmd = tokens[i];
  if (cmd === "uv" && tokens[i + 1] === "venv") return true;
  if ((cmd === "source" || cmd === ".") && typeof tokens[i + 1] === "string") {
    const target = tokens[i + 1];
    return target.includes("venv") && target.endsWith("/activate");
  }
  if ((cmd === "python" || cmd === "python3") && tokens[i + 1] === "-m" && tokens[i + 2] === "venv") return true;
  return false;
}

/** 段是否为 venv 保护下的安装命令（--system 永远不算） */
function isPipInstall(tokens: string[]): boolean {
  if (tokens.includes("--system")) return false;
  const i = findCommandIndex(tokens);
  const cmd = tokens[i];
  if (cmd === "uv" && tokens[i + 1] === "pip" && tokens[i + 2] === "install") return true;
  if ((cmd === "pip" || cmd === "pip3") && tokens[i + 1] === "install") return true;
  return false;
}

/** 命令是否安全：危险段均被 venv 白名单覆盖则放行。
 *
 * 同样先遮掉不会被 shell 执行的 heredoc 正文：写文件时正文里那些 `rm -rf` 不算执行 */
export function isCommandSafe(cmd: string): boolean {
  const segments = splitCommands(maskNonShellHeredocBodies(cmd));
  let venvActive = false;
  for (const seg of segments) {
    if (isVenvActivation(seg)) {
      venvActive = true;
      continue;
    }
    const dangerous = RULES.filter((r) => matchRule(seg, r) !== null);
    if (dangerous.length > 0) {
      const pipOnly = dangerous.every((r) => r.name === "bare-pip" || r.name === "python-m-pip" || r.name === "uv-system");
      if (venvActive && pipOnly && isPipInstall(seg)) continue;
      return false;
    }
  }
  return true;
}

/**
 * 「渲染得出来也不收窄」的护栏：渲染值落在这些程序上时照旧算动态构造。
 *
 * 收窄之后仍要过 LLM 预审（见 narrowedProgramTokens），但命中的规则名/tip 会从
 * dynamic-construct 换成 dynamic-construct-narrowed，提示文字也不同——而规则匹配看的是
 * token 原文，看不到 `$A` 背后的值：`A=rm && $A -rf ~/x` 这种命令名被渲染成危险程序时，
 * 收窄会让审核模型与人都只看到「已静态确定为 rm」这条提示，绕过 rm-recursive 那条明确规则。
 * 渲染成解释器/脚本时同理：lib/sandbox-check.ts 的「解释器载荷」那一层也是拿
 * effect.target（还是 `$A`）判的。所以这几类一律保动态构造，连带明确的规则一起报。
 */
const NON_NARROWABLE_PROGRAMS = new Set<string>([
  // 规则会拦的命令名（RULES 里 cmd 精确匹配的那些）
  ...RULES.flatMap((r) => (typeof r.cmd === "string" ? [r.cmd] : (r.cmd ?? []))),
  // 包装器：后面的程序名才是真正要跑的
  "eval",
  "exec",
  "command",
  "builtin",
  "source",
  ".",
  "xargs",
  "env",
  "timeout",
  "nohup",
  "setsid",
  "nice",
  "su",
  "doas",
  "pkexec",
  "busybox",
  "strace",
  // 解释器：与 lib/sandbox-check.ts 的 INTERPRETER_PROGRAMS 同源
  // （那个文件 import 本文件，不能反向依赖；两边改动要一起看）
  "python",
  "python2",
  "python3",
  "node",
  "nodejs",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
  "lua",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "base64",
  "xxd",
  "openssl",
]);

/** 脚本类后缀：与 lib/sandbox-check.ts 的 SCRIPT_SUFFIX 同源 */
const SCRIPT_SUFFIX = /\.(?:sh|bash|zsh|ksh|dash|py|py3|rb|pl|php|lua|js|mjs|cjs|ts)$/i;

/**
 * 收窄门槛：只有「已知程序」才收窄。
 *
 * 允许的两种写法：
 *   - 裸命令名（值里不含 `/`，由 PATH 解析）：`jq`
 *   - 系统 bin 目录下的直接子项：`/bin/jq` `/usr/bin/jq` `/usr/local/bin/jq` `/sbin/x` `/usr/sbin/x`
 * 其余一律不收窄——`/tmp/mytool`、`./tool`、`~/bin/tool`、`/opt/x/tool`、`bin/jq`、
 * 以及带 `/../` 的绕行写法：那些位置的程序是谁写的、会不会被换掉，规则层看不见；
 * 多收窄一步就少一层提示，收益抵不上。
 */
const NARROWABLE_BIN_DIRS = ["/bin/", "/usr/bin/", "/usr/local/bin/", "/sbin/", "/usr/sbin/"];

/**
 * 渲染出来的命令名能不能当「普通程序名」用。
 * 带空白/展开字符的值不能：命令行会按词拆开、还会走通配（`A='rm -rf' && $A /`），
 * 那种情形不叫「知道跑的是什么程序」，再往下算就容易把判定放过去。
 */
function isPlainProgramName(value: string): boolean {
  if (value === "" || !/^[A-Za-z0-9_./+:@%^,=-]+$/.test(value)) return false;
  const base = value.slice(value.lastIndexOf("/") + 1).toLowerCase();
  if (base === "") return false;
  return !NON_NARROWABLE_PROGRAMS.has(base) && !SCRIPT_SUFFIX.test(base);
}

/** 值的目录部分是不是系统 bin 目录（裸命令名单独放宽，见 NARROWABLE_BIN_DIRS） */
function isKnownProgramPath(value: string): boolean {
  const slash = value.lastIndexOf("/");
  // 裸命令名，交给 PATH —— 那也是「已知程序」。`.` / `..` 不是程序（`.` 本来就在
  // NON_NARROWABLE_PROGRAMS 里，这里再兜一道，免得 `A=.. && $A` 被当成已知程序）
  if (slash === -1) return value !== "." && value !== "..";
  const base = value.slice(slash + 1);
  if (base === "" || base === "." || base === "..") return false;
  // 目录带结尾 `/`，与 NARROWABLE_BIN_DIRS 的写法同形：`/usr/bin/../tmp/x` 的目录是
  // `/usr/bin/../tmp/`，列表里没有，自然不收窄（要的是「这一层」。子目录也不收）
  return NARROWABLE_BIN_DIRS.includes(value.slice(0, slash + 1));
}

/**
 * 渲染值 → 能不能收窄成「已知程序」。
 * 收窄不等于放行：调用方拿到 narrowed 之后仍要出一条 autoReject:false 的规则，
 * 把命令送去 LLM 预审。收窄只决定「这条命令按已知程序报，而不是按未知动态构造报」。
 */
function narrowableProgramName(value: string): boolean {
  return isPlainProgramName(value) && isKnownProgramPath(value);
}

/** 命令名位置上的静态渲染值是否收窄；收窄时给出渲染出来的程序（引不出来 / 不收窄 = undefined） */
function narrowedProgramValue(cmdToken: string, values: Map<string, StaticValue>): string | undefined {
  const value = values.get(cmdToken);
  if (value?.known !== true) return undefined;
  return narrowableProgramName(value.value) ? value.value : undefined;
}

/** 一条被收窄的命令名变量：token 是引用原文，program 是静态确定的程序 */
export interface NarrowedProgram {
  token: string;
  program: string;
}

/** dynamicConstructTokens 与 narrowedProgramTokens 共用的一次扫描结果 */
export interface DynamicAnalysis {
  /** 残余动态构造的 token（与改动前同义：渲染不出来或该保动态构造的那些） */
  dynamic: string[];
  /** 命令名变量静态确定成已知程序、已收窄的那些（仍要过 LLM 预审，见调用方） */
  narrowed: NarrowedProgram[];
}

/**
 * 动态构造分析：一次扫描同时给出「残余动态构造」与「已收窄的命令名变量」。
 *
 * 命令名位置的变量渲染（`P=/usr/bin/jq && $P -n 1` 里的 $P）：静态知道跑什么程序时，
 * 它不再算动态构造（dynamic 里没有它），但归入 narrowed——规则层看不到 `$P` 背后是 jq，
 * 由 lib/sandbox-check.ts 转成 dynamic-construct-narrowed 规则送 LLM 预审。
 * 渲染不出来、或渲染成 NON_NARROWABLE_PROGRAMS 里那几类时，照旧算动态构造。
 */
export function analyzeDynamicConstructs(cmd: string): DynamicAnalysis {
  const hits: string[] = [];
  const narrowed: NarrowedProgram[] = [];
  const pushHit = (t: string) => {
    if (!hits.includes(t)) hits.push(t);
  };
  const pushNarrowed = (token: string, program: string) => {
    if (!narrowed.some((n) => n.token === token)) narrowed.push({ token, program });
  };
  const programValues = staticProgramValues(cmd);
  for (const tokens of splitCommands(cmd)) {
    const i = findCommandIndex(tokens);
    const cmdToken = tokens[i];
    if (!cmdToken) continue;
    // 1. 命令名是变量/替换/ANSI-C 引号/含转义（r\m、$VAR、$'...'）
    if (cmdToken.startsWith("$")) {
      const program = narrowedProgramValue(cmdToken, programValues);
      if (program === undefined) pushHit(cmdToken);
      else pushNarrowed(cmdToken, program);
    } else if (/\\[A-Za-z0-9_]/.test(cmdToken)) {
      pushHit(cmdToken);
    }
    // 2. 显式执行字符串：eval xxx、bash/sh -c 'xxx'
    if (cmdToken === "eval") pushHit("eval");
    if (
      (cmdToken === "bash" || cmdToken === "sh" || cmdToken === "zsh" || cmdToken === "dash") &&
      tokens.slice(i + 1).includes("-c")
    ) {
      pushHit(cmdToken);
      pushHit("-c");
    }
    // 3. 别名/函数定义：alias xxx=...、f() {...}
    // 函数定义形态是 `f() { ... }`——`f()` 在命令名位置；
    // 不能扫全段 token（参数位如 grep -E "foo()"、python 代码 f() 都会误判）
    if (cmdToken === "alias") pushHit("alias");
    if (cmdToken === "function") pushHit("function");
    if (tokens[i].endsWith("()") && tokens.slice(i + 1).includes("{")) pushHit(tokens[i]);
    // 4. 命令替换/进程替换出现在任意位置
    const subst = tokens.find((t) => t.includes("$(") || t.includes("`") || t.includes("<(") || t.includes(">("));
    if (subst) pushHit(subst);
  }
  // 同一处引用不可能既命中又收窄（查表按 token 一次定值），这里只做防御：
  // 真出现同名 token 落在两边时，按「残余动态构造」报，别让窄的盖住宽的
  return { dynamic: hits, narrowed: narrowed.filter((n) => !hits.includes(n.token)) };
}

/** 检测 bash 动态构造，返回命中的特性 token（空数组 = 无残余动态构造） */
export function dynamicConstructTokens(cmd: string): string[] {
  return analyzeDynamicConstructs(cmd).dynamic;
}

/** 已收窄的命令名变量（供 lib/sandbox-check.ts 出 dynamic-construct-narrowed 规则） */
export function narrowedProgramTokens(cmd: string): NarrowedProgram[] {
  return analyzeDynamicConstructs(cmd).narrowed;
}

/** 是否存在残余动态构造（dynamicConstructTokens 的便捷布尔形式） */
export function hasDynamicConstructs(cmd: string): boolean {
  return dynamicConstructTokens(cmd).length > 0;
}

// 管道右侧执行器命令（执行任意代码/提权）
const PIPE_EXECUTORS = ["sh", "bash", "zsh", "dash", "python", "python3", "perl", "node", "sudo"];

export function findPipeExec(cmd: string): string[] {
  const hits: string[] = [];
  const segs = splitWithSeparators(cmd);
  for (let i = 1; i < segs.length; i++) {
    if (segs[i - 1].sep === "|") {
      const tokens = tokenize(segs[i].seg);
      const cmdIdx = findCommandIndex(tokens);
      const cmdName = tokens[cmdIdx];
      if (cmdName && PIPE_EXECUTORS.includes(cmdName) && !hits.includes(cmdName)) hits.push(cmdName);
    }
  }
  return hits;
}

// ═══════════════════════════════════════════════════
// 剥洋葱：命令替换内部审核
// ═══════════════════════════════════════════════════

const SUBST_PLACEHOLDER = "__pi_subst__";

export interface SubstitutionAudit {
  /** 安全替换占位后的命令（危险层则保留原样截断） */
  peeled: string;
  /** 危险替换的原文列表（首个危险层停止） */
  dangerous: string[];
  /**
   * 剥洋葱时各层里被收窄过的命令名变量（`$(P=/usr/bin/jq && $P -n 1)` 里的 $P）。
   * 那一层算「安全」，会被占位符替掉；但收窄说的是「程序名静态确定了、规则层看不到」，
   * 替掉之后外层看着干净，这条命令就再没人提这件事了。所以把它单独交出去，
   * 由 auditCommand 并进 narrowed，让整条命令过 LLM 预审。
   */
  narrowed: NarrowedProgram[];
}

/** 迭代剥洋葱：最内层替换内容跑与顶层相同的判定，安全则占位继续，危险则记录原文 */
export function auditSubstitutions(cmd: string): SubstitutionAudit {
  let peeled = cmd;
  const dangerous: string[] = [];
  const narrowed: NarrowedProgram[] = [];
  let guard = 0;
  while (guard++ < 100) {
    const sub = findInnerSubst(peeled);
    if (!sub) break;
    const inner = analyzeDynamicConstructs(sub.inner);
    const isSafeInner =
      isCommandSafe(sub.inner) &&
      inner.dynamic.length === 0 &&
      findPipeExec(sub.inner).length === 0;
    if (!isSafeInner) {
      dangerous.push(sub.inner);
      break;
    }
    // 安全层：占位继续剥，但把它里面的收窄记下来（替掉之后就看不到了）
    for (const item of inner.narrowed) {
      if (!narrowed.some((n) => n.token === item.token && n.program === item.program)) narrowed.push(item);
    }
    peeled = peeled.slice(0, sub.start) + SUBST_PLACEHOLDER + peeled.slice(sub.end + 1);
  }
  return { peeled, dangerous, narrowed };
}

// ═══════════════════════════════════════════════════
// 分级审核统一入口
// ═══════════════════════════════════════════════════

export interface AuditResult {
  /**
   * 是否放行（无危险规则、无残余动态、无危险替换/Python/管道信号，
   * 且没有被收窄的命令名变量）。
   *
   * 被收窄的命令名变量（narrowed 非空）也算在这里：它是「程序名静态确定了、但规则层
   * 看不到那一步」的信号，调用方要把它转成 dynamic-construct-narrowed 规则送 LLM 预审。
   * 若 allow 在这里仍为 true，任何一个拿 allow 当最终结果的调用方（包括
   * lib/sandbox-check.ts 的提前放行分支）都会跳过预审——那是本字段要堵的洞。
   */
  allow: boolean;
  /** 危险规则是否命中（含 venv 白名单覆盖前的原始判定） */
  safe: boolean;
  /** 命中的危险规则（含 autoReject 标志） */
  rules: TokenRule[];
  /** 剥完后仍有动态构造（eval/bash -c/变量命令等） */
  dynamic: boolean;
  dynamicTokens: string[];
  /**
   * 命令名变量已静态确定成已知程序、因此从动态构造里收窄出来的那些。
   * 不计入 dynamic（它们不再是残余动态），但仍需 LLM 预审：
   * 由 lib/sandbox-check.ts 转成一条 autoReject:false 的 dynamic-construct-narrowed 规则。
   */
  narrowed: NarrowedProgram[];
  /** 剥洋葱命中的危险替换原文 */
  dangerous: string[];
  /** Python 段命中的危险调用子串 */
  pyDanger: string[];
  /** 管道右侧执行器 */
  pipeExec: string[];
  /** mask 盲区后的命令（供放行备注判定） */
  masked: string;
}

/** 分级审核入口：mask → 剥洋葱 → Python 段 → 管道 → 规则，合并判定 */
export function auditCommand(cmd: string): AuditResult {
  const { masked, pySegments } = maskShellBlindZones(cmd);
  const pyDanger = pythonDangerous(pySegments);
  const { peeled, dangerous, narrowed: substNarrowed } = auditSubstitutions(masked);
  // 规则 / 白名单 / 管道这三件事问的都是「这条命令会执行什么」：
  // 先遮掉不会被 shell 执行的 heredoc 正文。动态构造仍看 peeled——
  // 未引号正文里的 $VAR 与 $(...) 写入时就会展开，那是真的会发生的事
  const executable = maskNonShellHeredocBodies(peeled);
  const pipeExec = findPipeExec(executable);
  const rules = matchDangerous(executable);
  const safe = isCommandSafe(executable);
  // 一次扫描出「残余动态」与「已收窄的命令名变量」：后者也让 allow 变 false（要过 LLM 预审）。
  // 剥洋葱里各层收窄过的也要并进来：那几层已被换成占位符，peeled 上已经看不到它们了
  const { dynamic: dynamicTokens, narrowed: topNarrowed } = analyzeDynamicConstructs(peeled);
  const narrowed = [...topNarrowed];
  for (const item of substNarrowed) {
    if (!narrowed.some((n) => n.token === item.token && n.program === item.program)) narrowed.push(item);
  }
  const dynamic = dynamicTokens.length > 0;
  const allow =
    safe && !dynamic && narrowed.length === 0 && dangerous.length === 0 && pyDanger.length === 0 && pipeExec.length === 0;
  return { allow, safe, rules, dynamic, dynamicTokens, narrowed, dangerous, pyDanger, pipeExec, masked };
}
