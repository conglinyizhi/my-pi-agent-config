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

/** 命中规则对外形态 */
export interface TokenRule {
  name: string;
  tip: string;
  autoReject?: boolean;
}

interface RuleDef {
  name: string;
  /** 命令名（段内第一个非 env 前缀 token）精确匹配 */
  cmd: string | string[];
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

function matchRule(tokens: string[], rule: RuleDef): boolean {
  const cmdIdx = findCommandIndex(tokens);
  const cmds = Array.isArray(rule.cmd) ? rule.cmd : [rule.cmd];
  if (!cmds.includes(tokens[cmdIdx])) return false;
  if (rule.subcmd) {
    for (let i = 0; i < rule.subcmd.length; i++) {
      if (tokens[cmdIdx + 1 + i] !== rule.subcmd[i]) return false;
    }
  }
  if (rule.anyFlags && !rule.anyFlags.some((f) => tokens.includes(f))) return false;
  if (rule.anyArgs && !rule.anyArgs.some((a) => tokens.includes(a))) return false;
  return true;
}

/** 命中所有危险规则（跨段聚合、去重） */
export function matchDangerous(cmd: string): TokenRule[] {
  const seen = new Set<string>();
  const result: TokenRule[] = [];
  for (const seg of splitCommands(cmd)) {
    for (const r of RULES) {
      if (matchRule(seg, r) && !seen.has(r.name)) {
        seen.add(r.name);
        result.push({ name: r.name, tip: r.tip, autoReject: r.autoReject });
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
    const dangerous = RULES.filter((r) => matchRule(seg, r));
    if (dangerous.length > 0) {
      const pipOnly = dangerous.every((r) => r.name === "bare-pip" || r.name === "python-m-pip" || r.name === "uv-system");
      if (venvActive && pipOnly && isPipInstall(seg)) continue;
      return false;
    }
  }
  return true;
}

/** 检测 bash 动态构造：命中则不应自动裁决，降级为人工确认 */
export function hasDynamicConstructs(cmd: string): boolean {
  return splitCommands(cmd).some((tokens) => {
    const i = findCommandIndex(tokens);
    const cmdToken = tokens[i];
    if (!cmdToken) return false;
    // 1. 命令名是变量/替换/ANSI-C 引号/含转义（r\m、$VAR、$'...'）
    if (cmdToken.startsWith("$") || /\\[A-Za-z0-9_]/.test(cmdToken)) return true;
    // 2. 显式执行字符串：eval xxx、bash/sh -c 'xxx'
    if (cmdToken === "eval") return true;
    if (
      (cmdToken === "bash" || cmdToken === "sh" || cmdToken === "zsh" || cmdToken === "dash") &&
      tokens.slice(i + 1).includes("-c")
    ) {
      return true;
    }
    // 3. 别名/函数定义：alias xxx=...、f() {...}
    if (cmdToken === "alias" || cmdToken === "function" || tokens.some((t) => t.endsWith("()"))) return true;
    // 4. 命令替换/进程替换出现在任意位置
    if (tokens.some((t) => t.includes("$(") || t.includes("`") || t.includes("<(") || t.includes(">("))) return true;
    return false;
  });
}
