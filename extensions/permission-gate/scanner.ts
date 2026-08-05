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

  // 1. heredoc：引号定界的内容遮为空格；python heredoc 内容收集
  const heredocs = findHeredocs(cmd);
  for (const hd of heredocs) {
    // 内容区不含定界符行首的换行（\n 保留，只遮内容行）
    let maskEnd = hd.contentEnd;
    if (maskEnd > hd.contentStart && cmd[maskEnd - 1] === "\n") maskEnd--;
    if (hd.isQuoted) {
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
