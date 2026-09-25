/**
 * scanner.ts —— 公共字符扫描库（状态机实现，不用正则做结构匹配）
 *
 * 原则：一切涉及转义/嵌套/配对的结构扫描（引号、heredoc、命令替换、管道分段）
 * 一律用逐字符状态机，避免正则转义在多层传递中出错。
 * 本文件只做字符级扫描，不依赖任何规则语义（RULES / isCommandSafe 等）。
 */

// ═══════════════════════════════════════════════════
// 字符工具
// ═══════════════════════════════════════════════════

function isWs(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function skipWs(cmd: string, i: number): number {
  while (i < cmd.length && isWs(cmd[i])) i++;
  return i;
}

function isIdentStart(c: string | undefined): boolean {
  if (!c) return false;
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isIdentChar(c: string | undefined): boolean {
  if (!c) return false;
  return isIdentStart(c) || (c >= "0" && c <= "9");
}

/**
 * 检查 cmd 从 i 起是否匹配 words 中某个完整单词。
 * 前置边界：i 前必须是行首 / 空白 / ; & | (（命令名起始位）
 * 后置边界：单词后必须是行尾 / 空白 / ; & | ( 或引号
 * 返回匹配长度，否则 -1。
 */
function matchWordAt(cmd: string, i: number, words: string[]): number {
  const before = cmd[i - 1];
  if (before !== undefined && !isWs(before) && before !== ";" && before !== "&" && before !== "|" && before !== "(") {
    return -1;
  }
  for (const w of words) {
    if (cmd.startsWith(w, i)) {
      const after = cmd[i + w.length];
      if (
        after === undefined ||
        isWs(after) ||
        after === ";" ||
        after === "&" ||
        after === "|" ||
        after === "(" ||
        after === "'" ||
        after === '"'
      ) {
        return w.length;
      }
    }
  }
  return -1;
}

// ═══════════════════════════════════════════════════
// 分段：保留分隔符（&& | || ; 换行）
// ═══════════════════════════════════════════════════

export interface SegWithSep {
  seg: string;
  sep: "&&" | "||" | ";" | "|" | "\n" | null;
}

export function splitWithSeparators(cmd: string): SegWithSep[] {
  const result: SegWithSep[] = [];
  let rest = cmd;
  while (rest.length > 0) {
    // 找下一个分隔符（按优先级：&& || ; | 换行）
    let idx = -1;
    let found: SegWithSep["sep"] | null = null;
    for (const sep of ["&&", "||", ";", "|", "\n"] as const) {
      const k = rest.indexOf(sep);
      if (k !== -1 && (idx === -1 || k < idx)) {
        idx = k;
        found = sep;
      }
    }
    if (idx === -1) {
      if (rest.trim().length > 0) result.push({ seg: rest.trim(), sep: null });
      break;
    }
    const seg = rest.slice(0, idx);
    if (seg.trim().length > 0) result.push({ seg: seg.trim(), sep: found });
    rest = rest.slice(idx + (found as string).length);
  }
  return result;
}

// ═══════════════════════════════════════════════════
// 最内层命令替换扫描：$() / 反引号 / <() / >()
// ═══════════════════════════════════════════════════

export interface InnerSubst {
  start: number;
  end: number;
  inner: string;
}

/**
 * 状态机 + 栈：返回最内层可剥的替换（内容不含嵌套替换）。
 * 普通括号也压栈，保证 $() 的闭合计数正确。
 */
export function findInnerSubst(cmd: string): InnerSubst | null {
  type Frame = { kind: "plain" | "subst"; start: number; subKind?: "$" | "<" | ">" | "`" };
  const stack: Frame[] = [];
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (ch === "$" && next === "(") {
      stack.push({ kind: "subst", start: i, subKind: "$" });
      i += 2;
    } else if (ch === "<" && next === "(") {
      stack.push({ kind: "subst", start: i, subKind: "<" });
      i += 2;
    } else if (ch === ">" && next === "(") {
      stack.push({ kind: "subst", start: i, subKind: ">" });
      i += 2;
    } else if (ch === "`") {
      const top = stack[stack.length - 1];
      if (top && top.kind === "subst" && top.subKind === "`") {
        stack.pop();
        return { start: top.start, end: i, inner: cmd.slice(top.start + 1, i) };
      }
      stack.push({ kind: "subst", start: i, subKind: "`" });
      i++;
    } else if (ch === "(") {
      stack.push({ kind: "plain", start: i });
      i++;
    } else if (ch === ")") {
      const top = stack.pop();
      if (top && top.kind === "subst") {
        const offset = top.subKind === "`" ? 1 : 2;
        return { start: top.start, end: i, inner: cmd.slice(top.start + offset, i) };
      }
      i++;
    } else {
      i++;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════
// heredoc 定界符扫描
// ═══════════════════════════════════════════════════

export interface HeredocInfo {
  /** << 的起始位置 */
  delimStart: number;
  /** 定界符结束位置（引号后 / 裸标识符后），单引号扫描用它跳过定界符引号 */
  delimEnd: number;
  /** 定界符文本（不带引号） */
  delim: string;
  /** 定界符是否带引号（带引号 → 内容为字面量，屏蔽；裸 → shell 会展开，不屏蔽） */
  isQuoted: boolean;
  /** 内容起始（定界符行后的 \n 之后） */
  contentStart: number;
  /** 定界符行首位置（内容区不含此位置；其前若有 \n 属于内容尾部） */
  contentEnd: number;
}

/**
 * 扫描所有 heredoc：<<[-]'delim' / <<[-]"delim" / <<[-]delim。
 * 排除 <<<（here-string）。状态机逐字符，不做正则结构匹配。
 */
export function findHeredocs(cmd: string): HeredocInfo[] {
  const res: HeredocInfo[] = [];
  let i = 0;
  while (i < cmd.length - 1) {
    if (cmd[i] === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      let p = i + 2;
      if (cmd[p] === "-") p++;
      p = skipWs(cmd, p);
      let isQuoted = false;
      let delim = "";
      const c = cmd[p];
      if (c === "'" || c === '"') {
        const end = cmd.indexOf(c, p + 1);
        if (end === -1) {
          i++;
          continue;
        }
        isQuoted = true;
        delim = cmd.slice(p + 1, end);
        p = end + 1;
      } else {
        // 裸定界符：标识符
        let q = p;
        while (q < cmd.length && isIdentChar(cmd[q])) q++;
        if (q === p) {
          i++;
          continue;
        }
        delim = cmd.slice(p, q);
        p = q;
      }
      if (!isIdentStart(delim[0]) || ![...delim].every(isIdentChar)) {
        i++;
        continue;
      }
      // 定界符后需有换行（内容从下一行开始）
      const nl = cmd.indexOf("\n", p);
      if (nl === -1) {
        i++;
        continue;
      }
      const contentStart = nl + 1;
      // 逐行找定界符行：行 trim 后 === delim
      let lineStart = contentStart;
      let contentEnd = -1;
      while (lineStart <= cmd.length) {
        const lineEnd = cmd.indexOf("\n", lineStart);
        const end = lineEnd === -1 ? cmd.length : lineEnd;
        if (cmd.slice(lineStart, end).trim() === delim) {
          contentEnd = lineStart;
          break;
        }
        if (lineEnd === -1) break;
        lineStart = end + 1;
      }
      if (contentEnd === -1) {
        i++;
        continue;
      }
      res.push({ delimStart: i, delimEnd: p, delim, isQuoted, contentStart, contentEnd });
      i = contentEnd;
    } else {
      i++;
    }
  }
  return res;
}

/** heredoc 所在命令段的第一个命令是否为 python/python3 */
function isPythonHeredoc(cmd: string, hd: HeredocInfo): boolean {
  let segStart = 0;
  for (let k = hd.delimStart - 1; k >= 0; k--) {
    const c = cmd[k];
    if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(") {
      segStart = k + 1;
      break;
    }
  }
  const w = skipWs(cmd, segStart);
  return matchWordAt(cmd, w, ["python3", "python"]) > 0;
}

// ═══════════════════════════════════════════════════
// heredoc 正文的归属：它到底是「数据」还是「交给解释器的代码」
// ═══════════════════════════════════════════════════

/** 包装器：自己不是解释器，但它后面那个词是真正要跑的程序 */
const WRAPPER_PROGRAMS = [
  "sudo", "doas", "env", "nohup", "time", "timeout", "xargs",
  "command", "exec", "nice", "ionice", "setsid", "stdbuf", "watch",
];

/**
 * 词法切分（引号感知）：引号内的整段算一个词，并把 quoted 标出来。
 * 程序名不能从引号里的词判定，否则 `git commit -m "跑 node 看看"` 会被当成解释器调用。
 */
function scanTokens(text: string): Array<{ text: string; quoted: boolean }> {
  const isBreak = (c: string) => c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">";
  const out: Array<{ text: string; quoted: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (isWs(ch) || isBreak(ch)) {
      i++;
      continue;
    }
    let buf = "";
    let quoted = false;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        buf += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        quoted = true;
        const end = text.indexOf(c, i + 1);
        if (end === -1) {
          buf += text.slice(i + 1);
          i = text.length;
          break;
        }
        buf += text.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (isWs(c) || isBreak(c)) break;
      buf += c;
      i++;
    }
    if (buf.length > 0) out.push({ text: buf, quoted });
  }
  return out;
}

/**
 * 一个命令段里真正要跑的程序名（跳过 env 赋值、包装器及其参数）。
 * 拿不到就返回空串（调用方当「不是解释器」处理，保持保守）。
 */
export function commandWordOf(seg: string): string {
  for (const token of scanTokens(seg)) {
    if (token.quoted) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)) continue;
    const base = token.text.split("/").pop() ?? "";
    if (WRAPPER_PROGRAMS.includes(base)) continue;
    if (token.text.startsWith("-") || /^\d/.test(token.text)) continue;
    return token.text;
  }
  return "";
}

/**
 * 这个 heredoc 的正文会不会被解释器消费。
 *
 * 看定界符所在那一行的每一段的首词：`node <<'EOF'`（前）与 `cat <<'EOF' | bash`（后）都算，
 * 而 `cat > x.ts <<'EOF'` 之后另一行再 `node x.ts` 不算：那一行的正文是数据，
 * 交给 node 的是文件名，不是正文。
 */
export function heredocFeedsInterpreter(cmd: string, hd: HeredocInfo, isInterpreter: (program: string) => boolean): boolean {
  const lineStart = cmd.lastIndexOf("\n", hd.delimStart - 1) + 1;
  const nl = cmd.indexOf("\n", hd.delimStart);
  const line = cmd.slice(lineStart, nl === -1 ? cmd.length : nl);
  return splitWithSeparators(line).some((s) => isInterpreter(commandWordOf(s.seg)));
}

/**
 * 会把 heredoc 正文当命令跑的程序：只有 shell。
 *
 * 与 lib/sandbox-check.ts 的 INTERPRETER_PROGRAMS 是两个用处：那边问「谁会解释这段载荷」
 * （node / python 也算），这里问「正文里的行会不会被当命令执行」——node 吃进去的是它自己的
 * 语法，正文里的 `rm -rf x` 是字符串而不是命令，所以不算。
 */
const SHELL_PROGRAMS = ["bash", "sh", "zsh", "dash", "ksh", "ash"];

export function isShellProgram(program: string): boolean {
  const base = program.split("/").pop()?.toLowerCase() ?? "";
  return SHELL_PROGRAMS.includes(base);
}

/** 正文不会被 shell 执行的那些 heredoc 正文：遮成空格，正是「正文是数据」这句话的落地 */
export function maskNonShellHeredocBodies(cmd: string): string {
  return maskHeredocBodies(cmd, (hd) => heredocFeedsInterpreter(cmd, hd, isShellProgram));
}

/** 正文换等长空格（长度不变，按原坐标对齐）。正文是数据，不是命令行的操作数 */
export function maskHeredocBodies(cmd: string, keep: (hd: HeredocInfo) => boolean = () => false): string {
  const chars = cmd.split("");
  for (const hd of findHeredocs(cmd)) {
    if (keep(hd)) continue;
    let end = hd.contentEnd;
    if (end > hd.contentStart && cmd[end - 1] === "\n") end--;
    for (let j = hd.contentStart; j < end; j++) chars[j] = " ";
  }
  return chars.join("");
}

/** 只留「会被解释器消费」的正文，其余正文遮掉（供解释器丰底那一层扫） */
export function maskNonInterpreterHeredocBodies(cmd: string, isInterpreter: (program: string) => boolean): string {
  return maskHeredocBodies(cmd, (hd) => heredocFeedsInterpreter(cmd, hd, isInterpreter));
}

/** 收集 python -c 'code' 的 code 段（单/双引号形态） */
function collectPyCArgs(cmd: string, pySegments: string[]): void {
  let i = 0;
  while (i < cmd.length) {
    const len = matchWordAt(cmd, i, ["python3", "python"]);
    if (len > 0) {
      let p = i + len;
      p = skipWs(cmd, p);
      if (cmd[p] === "-" && cmd[p + 1] === "c") {
        p += 2;
        p = skipWs(cmd, p);
        const q = cmd[p];
        if (q === "'" || q === '"') {
          const end = cmd.indexOf(q, p + 1);
          if (end !== -1) {
            pySegments.push(cmd.slice(p + 1, end));
            i = end + 1;
            continue;
          }
        }
      }
    }
    i++;
  }
}

// ═══════════════════════════════════════════════════
// 盲区屏蔽：单引号 / 引号定界 heredoc 是字面量，shell 不解析
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

  // 1. heredoc：默认把正文遮为空格（正文是数据），python heredoc 内容收集
  const heredocs = findHeredocs(cmd);
  for (const hd of heredocs) {
    // 内容区不含定界符行首的换行（\n 保留，只遮内容行）
    let maskEnd = hd.contentEnd;
    if (maskEnd > hd.contentStart && cmd[maskEnd - 1] === "\n") maskEnd--;
    // 引号定界也不等于安全：`bash <<'EOF'` 的正文会被 shell 当命令跑（rm -rf 那类规则
    // 遮掉就等于漏拦），所以先问一句「谁会吃这段正文」，只有数据才遮
    if (hd.isQuoted && !heredocFeedsInterpreter(cmd, hd, isShellProgram)) {
      for (let j = hd.contentStart; j < maskEnd; j++) chars[j] = " ";
    }
    if (isPythonHeredoc(cmd, hd)) {
      pySegments.push(cmd.slice(hd.contentStart, maskEnd));
    }
  }
  const delimRanges = heredocs.map((hd) => [hd.delimStart, hd.delimEnd] as const);

  // 2. 单引号区域 → 内容遮为空格（bash 单引号无转义，硬边界配对）
  //    heredoc 定界符引号（<<'EOF'）是语法不是盲区，跳过不遮
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) break; // 未闭合，剩余按字面
      const inDelim = delimRanges.some(([s, e]) => i > s && i < e);
      if (inDelim) {
        i = end + 1;
        continue;
      }
      for (let j = i + 1; j < end; j++) chars[j] = " ";
      i = end + 1;
    } else i++;
  }

  // 3. python -c 代码段收集（在原始 cmd 上）
  collectPyCArgs(cmd, pySegments);

  return { masked: chars.join(""), pySegments };
}

// ═══════════════════════════════════════════════════
// Python 段轻量检测（子串级，不解析语法）
// ═══════════════════════════════════════════════════

/** dd 的三种常见形态：os.system("dd if=...") / subprocess.run(["dd", ...]) / 字符串含 "dd " */
export const PY_DANGEROUS_SUBSTRINGS = [
  "os.system", "subprocess", "Popen", "eval(", "exec(",
  "shutil.rmtree", "os.remove", "os.unlink", "os.chmod", "os.chown",
  // dd 危险用法必有 if=/of= 参数；不能用裸 "dd "（会误伤 add/address 等英文词）
  "dd if=", "dd of=", '"dd"', "'dd'",
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
