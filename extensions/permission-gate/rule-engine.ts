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
  pythonDangerous,
} from "./scanner";
import type { SegWithSep, MaskedCommand } from "./scanner";
// re-export：测试与外部调用从 rule-engine 导入的路径保持不变
export {
  splitWithSeparators,
  maskShellBlindZones,
  pythonDangerous,
} from "./scanner";
export type { SegWithSep, MaskedCommand } from "./scanner";

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
  tip: string;
  autoReject?: boolean;
}

const RULES: RuleDef[] = [
  {
    name: "sudo",
    cmd: "sudo",
    tip: "请避免使用 sudo，考虑是否有不需要提权的替代方案",
  },
  {
    name: "rm-recursive",
    cmd: "rm",
    anyFlags: ["-rf", "-r", "--recursive"],
    tip: "避免递归删除，请先确认目标路径",
  },
  {
    name: "chmod-777",
    cmd: ["chmod", "chown"],
    anyArgs: ["777"],
    tip: "777 权限过于宽松，请使用更严格的权限设置",
  },
  {
    name: "uv-system",
    cmd: "uv",
    anyFlags: ["--system"],
    tip: "严禁 uv 使用 --system 标志，会污染系统 Python 环境。正确做法：先 uv venv 创建虚拟环境，再 uv pip install",
    autoReject: true,
  },
  {
    name: "bare-pip",
    cmd: ["pip", "pip3"],
    subcmd: ["install"],
    tip: "请使用 uv 代替 pip。正确做法：先 uv venv 创建虚拟环境，再 uv pip install",
    autoReject: true,
  },
  {
    name: "python-m-pip",
    cmd: ["python", "python3"],
    subcmd: ["-m", "pip", "install"],
    tip: "请使用 uv 代替 python -m pip。正确做法：先 uv venv 创建虚拟环境，再 uv pip install",
    autoReject: true,
  },
  {
    name: "find-delete",
    cmd: "find",
    anyFlags: ["-delete", "-exec", "-ok"],
    tip: "find 配合 -delete/-exec/-ok 会删除或执行任意匹配文件，请改为显式确认后的操作",
  },
  {
    name: "write-redirect",
    // cmd 省略 = 任意命令：输出重定向写入（> 覆盖、>> 追加）可能改动系统文件
    anyArgs: [">", ">>"],
    tip: "命令输出重定向写入文件，可能覆盖系统或项目文件，请确认目标路径",
  },
  {
    name: "dd",
    cmd: "dd",
    tip: "dd 可直写块设备（of= 指向磁盘/分区），请确认输入输出路径",
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
    if (!cmds.includes(tokens[cmdIdx])) return null;
    matched.push(tokens[cmdIdx]);
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
    const hit = rule.anyArgs.filter((a) => tokens.includes(a));
    if (hit.length === 0) return null;
    matched.push(...hit);
  }
  return matched;
}

/** 命中所有危险规则（跨段聚合、去重） */
export function matchDangerous(cmd: string): TokenRule[] {
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

/** 命令是否安全：危险段均被 venv 白名单覆盖则放行 */
export function isCommandSafe(cmd: string): boolean {
  const segments = splitCommands(cmd);
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

/** 检测 bash 动态构造，返回命中的特性 token（空数组 = 无动态构造） */
export function dynamicConstructTokens(cmd: string): string[] {
  const hits: string[] = [];
  const pushHit = (t: string) => {
    if (!hits.includes(t)) hits.push(t);
  };
  for (const tokens of splitCommands(cmd)) {
    const i = findCommandIndex(tokens);
    const cmdToken = tokens[i];
    if (!cmdToken) continue;
    // 1. 命令名是变量/替换/ANSI-C 引号/含转义（r\m、$VAR、$'...'）
    if (cmdToken.startsWith("$") || /\\[A-Za-z0-9_]/.test(cmdToken)) pushHit(cmdToken);
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
    if (cmdToken === "alias") pushHit("alias");
    if (cmdToken === "function") pushHit("function");
    const fnDef = tokens.find((t) => t.endsWith("()"));
    if (fnDef) pushHit(fnDef);
    // 4. 命令替换/进程替换出现在任意位置
    const subst = tokens.find((t) => t.includes("$(") || t.includes("`") || t.includes("<(") || t.includes(">("));
    if (subst) pushHit(subst);
  }
  return hits;
}

/** 是否存在动态构造（dynamicConstructTokens 的便捷布尔形式） */
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
}

/** 迭代剥洋葱：最内层替换内容跑与顶层相同的判定，安全则占位继续，危险则记录原文 */
export function auditSubstitutions(cmd: string): SubstitutionAudit {
  let peeled = cmd;
  const dangerous: string[] = [];
  let guard = 0;
  while (guard++ < 100) {
    const sub = findInnerSubst(peeled);
    if (!sub) break;
    const isSafeInner =
      isCommandSafe(sub.inner) &&
      !hasDynamicConstructs(sub.inner) &&
      findPipeExec(sub.inner).length === 0;
    if (!isSafeInner) {
      dangerous.push(sub.inner);
      break;
    }
    peeled = peeled.slice(0, sub.start) + SUBST_PLACEHOLDER + peeled.slice(sub.end + 1);
  }
  return { peeled, dangerous };
}

// ═══════════════════════════════════════════════════
// 分级审核统一入口
// ═══════════════════════════════════════════════════

export interface AuditResult {
  /** 是否放行（无危险规则、无残余动态、无危险替换/Python/管道信号） */
  allow: boolean;
  /** 危险规则是否命中（含 venv 白名单覆盖前的原始判定） */
  safe: boolean;
  /** 命中的危险规则（含 autoReject 标志） */
  rules: TokenRule[];
  /** 剥完后仍有动态构造（eval/bash -c/变量命令等） */
  dynamic: boolean;
  dynamicTokens: string[];
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
  const { peeled, dangerous } = auditSubstitutions(masked);
  const pipeExec = findPipeExec(peeled);
  const rules = matchDangerous(peeled);
  const safe = isCommandSafe(peeled);
  const dynamic = hasDynamicConstructs(peeled);
  const dynamicTokens = dynamicConstructTokens(peeled);
  const allow =
    safe && !dynamic && dangerous.length === 0 && pyDanger.length === 0 && pipeExec.length === 0;
  return { allow, safe, rules, dynamic, dynamicTokens, dangerous, pyDanger, pipeExec, masked };
}
