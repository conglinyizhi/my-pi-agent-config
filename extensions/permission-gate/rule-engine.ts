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
  /** 命中的 token（命令名/子命令/flag/参数），供 GUI 高亮 */
  matched?: string[];
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

/** 匹配规则：命中返回命中的 token 列表（供 GUI 高亮），否则 null */
function matchRule(tokens: string[], rule: RuleDef): string[] | null {
  const cmdIdx = findCommandIndex(tokens);
  const cmds = Array.isArray(rule.cmd) ? rule.cmd : [rule.cmd];
  if (!cmds.includes(tokens[cmdIdx])) return null;
  const matched: string[] = [tokens[cmdIdx]];
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

// ═══════════════════════════════════════════════════
// 管道执行器检测（跨段组合，RULES 表达不了）
// ═══════════════════════════════════════════════════

/** 分段并保留分隔符（&& | || ; 换行），供管道右侧检测 */
export interface SegWithSep {
  seg: string;
  sep: "&&" | "||" | ";" | "|" | "\n" | null;
}

export function splitWithSeparators(cmd: string): SegWithSep[] {
  const result: SegWithSep[] = [];
  const re = /&&|\|\||;|\||\n/;
  let rest = cmd;
  while (rest.length > 0) {
    const m = re.exec(rest);
    if (!m) {
      if (rest.trim().length > 0) result.push({ seg: rest.trim(), sep: null });
      break;
    }
    const seg = rest.slice(0, m.index);
    if (seg.trim().length > 0) result.push({ seg: seg.trim(), sep: m[0] as SegWithSep["sep"] });
    rest = rest.slice(m.index + m[0].length);
  }
  return result;
}

/** 管道右侧执行器命令（执行任意代码/提权） */
const PIPE_EXECUTORS = ["sh", "bash", "zsh", "dash", "python", "python3", "perl", "node", "sudo"];

/** 检测管道右侧是否执行器命令，返回命中的执行器名（去重） */
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
// 盲区屏蔽（单引号 / 引号定界 heredoc 是字面量，shell 不解析）
// ═══════════════════════════════════════════════════

export interface MaskedCommand {
  /** 盲区替换为等长空格后的命令（长度不变，供后续检测） */
  masked: string;
  /** python 消费的代码段原文（-c 参数与 heredoc 内容），供 Python 段检测 */
  pySegments: string[];
}

export function maskShellBlindZones(cmd: string): MaskedCommand {
  const chars = cmd.split("");
  const pySegments: string[] = [];

  // 1. 单引号区域 → 内容遮为空格（bash 单引号无转义，硬边界配对）
  //    heredoc 定界符引号（<<'EOF'）是语法不是盲区，跳过不遮
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) break; // 未闭合，剩余按字面
      const before = cmd.slice(Math.max(0, i - 20), i);
      if (/<<-?\s*$/.test(before)) {
        i = end + 1;
        continue;
      }
      for (let j = i + 1; j < end; j++) chars[j] = " ";
      i = end + 1;
    } else i++;
  }

  // 2. 带引号定界符 heredoc → 内容遮为空格（裸定界符 shell 会展开，不遮）
  const hdRe = /<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = hdRe.exec(cmd)) !== null) {
    const delim = m[2];
    const nl = cmd.indexOf("\n", m.index);
    if (nl === -1) continue;
    const endRe = new RegExp(`^\\s*${delim}\\s*$`, "m");
    const em = endRe.exec(cmd.slice(nl + 1));
    if (!em) continue;
    const contentEnd = nl + 1 + em.index;
    // 内容区不含定界符行前的换行（\n 保留，只遮内容行）
    const maskEnd = contentEnd > nl + 1 && cmd[contentEnd - 1] === "\n" ? contentEnd - 1 : contentEnd;
    for (let j = nl + 1; j < maskEnd; j++) chars[j] = " ";
    hdRe.lastIndex = contentEnd;
  }

  // 3. python 代码段收集（在原始 cmd 上，不依赖 mask）
  const pyPrefix = "(?:^|[;&|(]|\\s)(?:python|python3)";
  const sqRe = new RegExp(pyPrefix + `\\s+-c\\s+'([^']*)'`, "g");
  let sm: RegExpExecArray | null;
  while ((sm = sqRe.exec(cmd)) !== null) pySegments.push(sm[1]);
  const dqRe = new RegExp(pyPrefix + `\\s+-c\\s+"([^"]*)"`, "g");
  let dm: RegExpExecArray | null;
  while ((dm = dqRe.exec(cmd)) !== null) pySegments.push(dm[1]);
  const hdPyRe = new RegExp(pyPrefix + `(?:\\s+-)?\\s*<<-?\\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\\1`, "g");
  let hm: RegExpExecArray | null;
  while ((hm = hdPyRe.exec(cmd)) !== null) {
    const delim = hm[2];
    const nl = cmd.indexOf("\n", hm.index);
    if (nl === -1) continue;
    const endRe = new RegExp(`^\\s*${delim}\\s*$`, "m");
    const em = endRe.exec(cmd.slice(nl + 1));
    if (!em) continue;
    const segEnd = em.index > 0 && cmd[nl + 1 + em.index - 1] === "\n" ? em.index - 1 : em.index;
    pySegments.push(cmd.slice(nl + 1, nl + 1 + segEnd));
    hdPyRe.lastIndex = nl + 1 + em.index;
  }

  return { masked: chars.join(""), pySegments };
}

// ═══════════════════════════════════════════════════
// Python 段轻量检测（子串级，不解析语法）
// ═══════════════════════════════════════════════════

/** dd 的三种常见形态：os.system("dd if=...") / subprocess.run(["dd", ...]) / 字符串含 "dd " */
const PY_DANGEROUS_SUBSTRINGS = [
  "os.system", "subprocess", "Popen", "eval(", "exec(",
  "shutil.rmtree", "os.remove", "os.unlink", "os.chmod", "os.chown",
  "dd ", '"dd"', "'dd'",
];

/** 对 python 代码段做危险调用子串检测，返回命中子串（去重） */
export function pythonDangerous(segments: string[]): string[] {
  const hits: string[] = [];
  for (const seg of segments) {
    for (const s of PY_DANGEROUS_SUBSTRINGS) {
      if (seg.includes(s) && !hits.includes(s)) hits.push(s);
    }
  }
  return hits;
}

// ═══════════════════════════════════════════════════
// 剥洋葱：命令替换内部审核
// ═══════════════════════════════════════════════════

/** 最内层替换扫描（状态机，逐字符）：$() / 反引号 / <() / >()，返回最内层可剥的替换 */
function findInnerSubst(cmd: string): { start: number; end: number; inner: string } | null {
  type Frame = { kind: "plain" | "subst"; start: number; subKind: "$" | "<" | ">" | "`" };
  const stack: Frame[] = [];
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (ch === "$" && next === "(") { stack.push({ kind: "subst", start: i, subKind: "$" }); i += 2; }
    else if (ch === "<" && next === "(") { stack.push({ kind: "subst", start: i, subKind: "<" }); i += 2; }
    else if (ch === ">" && next === "(") { stack.push({ kind: "subst", start: i, subKind: ">" }); i += 2; }
    else if (ch === "`") {
      const top = stack[stack.length - 1];
      if (top && top.kind === "subst" && top.subKind === "`") {
        stack.pop();
        return { start: top.start, end: i, inner: cmd.slice(top.start + 1, i) };
      }
      stack.push({ kind: "subst", start: i, subKind: "`" });
      i++;
    }
    else if (ch === "(") { stack.push({ kind: "plain", start: i }); i++; }
    else if (ch === ")") {
      const top = stack.pop();
      if (top && top.kind === "subst") {
        const offset = top.subKind === "`" ? 1 : 2;
        return { start: top.start, end: i, inner: cmd.slice(top.start + offset, i) };
      }
      i++;
    }
    else { i++; }
  }
  return null;
}

/** 安全替换的占位符（不在任何规则命令/flag/参数集合中） */
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
