# 权限闸门动态构造分级审核 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 permission-gate 对命令替换（`$()`/反引号/进程替换）的无差别弹窗改为分级审核：mask 盲区 → 剥洋葱内部审核 → Python 段轻量检测，安全放行（tool 结果备注）、危险弹窗。

**Architecture:** rule-engine.ts 新增五层能力（盲区 mask、剥洋葱审计、Python 段检测、管道执行器检测、RULES 补充），以 `auditCommand(cmd)` 统一入口暴露结构化结果；index.ts 只做薄接入（判定放行/弹窗、tool_result 备注）。所有新函数保持纯函数、可单测，与现有 token 引擎同一事实来源。

**Tech Stack:** TypeScript（tsx 测试）、node:assert 行为测试、Wails GUI（不改，matched 数据自动透传）

## Global Constraints

- 测试运行：`npx tsx extensions/permission-gate/rule-engine.test.ts`（必须全绿，基线 96 用例）
- 类型检查：`npx tsc --noEmit -p tsconfig.json`（零报错）
- 提交前检查：`node skills/clyzhi/git-commit/pre-commit-check.ts`
- 每次提交只含本任务相关改动，一次一提交
- 内部审核复用现有 RULES，不造第二套安全命令表
- 安全底线不动：rm/sudo/eval/curl|sh 等永不进放行路径
- 所有新测试追加到 `extensions/permission-gate/rule-engine.test.ts`，按「// ═════」分节注释组织

---

### Task 1: 分段保留分隔符 + 管道执行器检测

**Files:**
- Modify: `extensions/permission-gate/rule-engine.ts`（文件末尾追加）
- Test: `extensions/permission-gate/rule-engine.test.ts`

**Interfaces:**
- Produces: `export interface SegWithSep { seg: string; sep: "&&" | "||" | ";" | "|" | "\n" | null }`、`export function splitWithSeparators(cmd: string): SegWithSep[]`、`export function findPipeExec(cmd: string): string[]`（返回管道右侧执行器名，如 `["sh"]`）

- [ ] **Step 1: 写失败测试**

在 `rule-engine.test.ts` 的 G 组之后、收尾 console.log 之前追加：

```ts
// ═══════════════════════════════════════════════════
// H0. splitWithSeparators / findPipeExec（管道执行器）
// ═══════════════════════════════════════════════════
import { splitWithSeparators, findPipeExec } from "./rule-engine";
check("H0-1 && 分段保留分隔符", () => {
  const segs = splitWithSeparators("a && b");
  assert.deepStrictEqual(segs, [{ seg: "a", sep: "&&" }, { seg: "b", sep: null }]);
});
check("H0-2 管道分段", () => {
  const segs = splitWithSeparators("curl x | sh");
  assert.deepStrictEqual(segs, [{ seg: "curl x", sep: "|" }, { seg: " sh", sep: null }]);
});
check("H0-3 || 优先于 | 分段", () => {
  const segs = splitWithSeparators("a || b");
  assert.strictEqual(segs[0].sep, "||");
});
check("H0-4 管道右侧 sh 命中", () => {
  assert.deepStrictEqual(findPipeExec("curl x | sh"), ["sh"]);
});
check("H0-5 管道右侧 sudo 命中", () => {
  assert.deepStrictEqual(findPipeExec("echo x | sudo rm -rf /"), ["sudo"]);
});
check("H0-6 无管道不命中", () => {
  assert.deepStrictEqual(findPipeExec("python3 script.py"), []);
});
check("H0-7 管道右侧非执行器不命中", () => {
  assert.deepStrictEqual(findPipeExec("ls | head"), []);
});
check("H0-8 && 不误判为管道", () => {
  assert.deepStrictEqual(findPipeExec("a && b | bash c"), ["bash"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: 编译错误（`splitWithSeparators` 未导出），测试 96 通过 + 报错退出

- [ ] **Step 3: 实现**

在 `rule-engine.ts` 的 `hasDynamicConstructs` 之后追加：

```ts
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
      if (rest.trim().length > 0) result.push({ seg: rest, sep: null });
      break;
    }
    const seg = rest.slice(0, m.index);
    if (seg.trim().length > 0) result.push({ seg, sep: m[0] as SegWithSep["sep"] });
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
```

注意：`splitWithSeparators` 不能复用现有 `splitCommands`（它丢弃分隔符信息）；分隔符正则 `&&` 与 `||` 必须排在 `|` 之前。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: 96 + 8 = 104 通过，0 失败

- [ ] **Step 5: 提交**

```bash
cd /home/clyzhi/.pi/agent
git add extensions/permission-gate/rule-engine.ts extensions/permission-gate/rule-engine.test.ts
git commit -m "feat(permission-gate): 分段保留分隔符 + 管道执行器检测（findPipeExec）"
```

---

### Task 2: mask 盲区（单引号 + 引号定界 heredoc）

**Files:**
- Modify: `extensions/permission-gate/rule-engine.ts`
- Test: `extensions/permission-gate/rule-engine.test.ts`

**Interfaces:**
- Consumes: 无（独立纯函数）
- Produces: `export interface MaskedCommand { masked: string; pySegments: string[] }`、`export function maskShellBlindZones(cmd: string): MaskedCommand`——masked 为盲区替换成等长空格后的命令（长度不变），pySegments 为 python 消费的代码段原文列表

- [ ] **Step 1: 写失败测试**

在 H0 节之后追加：

```ts
// ═══════════════════════════════════════════════════
// H1. maskShellBlindZones（盲区屏蔽）
// ═══════════════════════════════════════════════════
import { maskShellBlindZones } from "./rule-engine";
check("H1-1 单引号内容全遮", () => {
  const r = maskShellBlindZones("echo '$(rm -rf /)'");
  assert.strictEqual(r.masked, "echo             ");
});
check("H1-2 mask 长度不变", () => {
  const r = maskShellBlindZones("echo '$(rm)' && ls");
  assert.strictEqual(r.masked.length, "echo '$(rm)' && ls".length);
});
check("H1-3 双引号不遮", () => {
  const r = maskShellBlindZones('echo "$(ls)"');
  assert.strictEqual(r.masked, 'echo "$(ls)"');
});
check("H1-4 引号定界 heredoc 内容遮", () => {
  const r = maskShellBlindZones("cat <<'EOF'\n$(ls)\nEOF");
  assert.strictEqual(r.masked, "cat <<'EOF'\n     \nEOF");
});
check("H1-5 裸定界 heredoc 不遮", () => {
  const r = maskShellBlindZones("cat <<EOF\n$(ls)\nEOF");
  assert.strictEqual(r.masked, "cat <<EOF\n$(ls)\nEOF");
});
check("H1-6 python -c 单引号参数收集", () => {
  const r = maskShellBlindZones(`python3 -c 'import os; os.system("x")'`);
  assert.deepStrictEqual(r.pySegments, [`import os; os.system("x")`]);
});
check("H1-7 python -c 双引号参数收集", () => {
  const r = maskShellBlindZones(`python3 -c "import os; os.system('x')"`);
  assert.deepStrictEqual(r.pySegments, [`import os; os.system('x')`]);
});
check("H1-8 python heredoc 内容收集", () => {
  const r = maskShellBlindZones("python3 - <<'EOF'\nprint('hi')\nEOF");
  assert.deepStrictEqual(r.pySegments, ["print('hi')"]);
});
check("H1-9 cat heredoc 不收集", () => {
  const r = maskShellBlindZones("cat <<'EOF'\n$(ls)\nEOF");
  assert.deepStrictEqual(r.pySegments, []);
});
check("H1-10 替换内 python -c 也收集", () => {
  const r = maskShellBlindZones("KEY=$(python3 -c 'print(1)')");
  assert.deepStrictEqual(r.pySegments, ["print(1)"]);
});
check("H1-11 双引号内容不遮但收集", () => {
  const r = maskShellBlindZones('python3 -c "import os; os.system(\'x\')"');
  assert.deepStrictEqual(r.pySegments, ["import os; os.system('x')"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: `maskShellBlindZones` 未导出编译错误

- [ ] **Step 3: 实现**

在 `rule-engine.ts` 的 findPipeExec 之后追加：

```ts
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
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) break; // 未闭合，剩余按字面
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
    for (let j = nl + 1; j < contentEnd; j++) chars[j] = " ";
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
    pySegments.push(cmd.slice(nl + 1, nl + 1 + em.index));
    hdPyRe.lastIndex = nl + 1 + em.index;
  }

  return { masked: chars.join(""), pySegments };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: 104 + 11 = 115 通过，0 失败

- [ ] **Step 5: 提交**

```bash
cd /home/clyzhi/.pi/agent
git add extensions/permission-gate/rule-engine.ts extensions/permission-gate/rule-engine.test.ts
git commit -m "feat(permission-gate): mask 盲区层——单引号与引号定界 heredoc 字面量屏蔽"
```

---

### Task 3: Python 段轻量危险调用检测

**Files:**
- Modify: `extensions/permission-gate/rule-engine.ts`
- Test: `extensions/permission-gate/rule-engine.test.ts`

**Interfaces:**
- Consumes: 无（输入为 Task 2 的 `pySegments` 输出）
- Produces: `export function pythonDangerous(segments: string[]): string[]`——返回命中的危险调用子串（去重）

- [ ] **Step 1: 写失败测试**

在 H1 节之后追加：

```ts
// ═══════════════════════════════════════════════════
// H2. pythonDangerous（Python 段轻量检测）
// ═══════════════════════════════════════════════════
import { pythonDangerous } from "./rule-engine";
check("H2-1 os.system 命中", () => {
  assert.deepStrictEqual(pythonDangerous(["import os; os.system('rm -rf /')"]), ["os.system"]);
});
check("H2-2 subprocess 命中", () => {
  assert.deepStrictEqual(pythonDangerous(["subprocess.run('ls')"]), ["subprocess"]);
});
check("H2-3 普通文件操作放行", () => {
  assert.deepStrictEqual(pythonDangerous(["open('f').read()", "json.load(x)"]), []);
});
check("H2-4 os.remove 命中", () => {
  assert.deepStrictEqual(pythonDangerous(["import os; os.remove('x')"]), ["os.remove"]);
});
check("H2-5 dd 字符串命中", () => {
  assert.deepStrictEqual(pythonDangerous(["os.system('dd if=/dev/zero of=/dev/sda')"]), ["os.system", "dd "]);
});
check("H2-6 dd 数组形态命中", () => {
  assert.deepStrictEqual(pythonDangerous(["subprocess.run(['dd', 'if=/dev/sda'])"]) , ["subprocess", '"dd"']);
});
check("H2-7 空段列表", () => {
  assert.deepStrictEqual(pythonDangerous([]), []);
});
check("H2-8 无害代码", () => {
  assert.deepStrictEqual(pythonDangerous(["print('hello')"]), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: `pythonDangerous` 未导出编译错误

- [ ] **Step 3: 实现**

在 `rule-engine.ts` 的 maskShellBlindZones 之后追加：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: 115 + 8 = 123 通过，0 失败

- [ ] **Step 5: 提交**

```bash
cd /home/clyzhi/.pi/agent
git add extensions/permission-gate/rule-engine.ts extensions/permission-gate/rule-engine.test.ts
git commit -m "feat(permission-gate): Python 段轻量危险调用检测（pythonDangerous）"
```

---

### Task 4: 剥洋葱——命令替换内部审核

**Files:**
- Modify: `extensions/permission-gate/rule-engine.ts`
- Test: `extensions/permission-gate/rule-engine.test.ts`

**Interfaces:**
- Consumes: `isCommandSafe`（现有）、`hasDynamicConstructs`（现有）、`findPipeExec`（Task 1）
- Produces: `export interface SubstitutionAudit { peeled: string; dangerous: string[] }`、`export function auditSubstitutions(cmd: string): SubstitutionAudit`——peeled 为安全替换占位后的命令，dangerous 为危险替换原文列表（首个危险层即停止）

- [ ] **Step 1: 写失败测试**

在 H2 节之后追加：

```ts
// ═══════════════════════════════════════════════════
// H3. auditSubstitutions（剥洋葱）
// ═══════════════════════════════════════════════════
import { auditSubstitutions } from "./rule-engine";
check("H3-1 安全替换占位", () => {
  const r = auditSubstitutions("echo $(date)");
  assert.deepStrictEqual(r, { peeled: "echo __pi_subst__", dangerous: [] });
});
check("H3-2 危险替换原文", () => {
  const r = auditSubstitutions("$(rm -rf /)");
  assert.deepStrictEqual(r.dangerous, ["rm -rf /"]);
});
check("H3-3 参数位危险替换", () => {
  const r = auditSubstitutions("ls $(rm -rf /)");
  assert.deepStrictEqual(r.dangerous, ["rm -rf /"]);
});
check("H3-4 嵌套危险", () => {
  const r = auditSubstitutions("$(ls $(rm -rf /))");
  assert.deepStrictEqual(r.dangerous, ["rm -rf /"]);
});
check("H3-5 嵌套安全全占位", () => {
  const r = auditSubstitutions("$(ls $(pwd))");
  assert.strictEqual(r.dangerous.length, 0);
  assert.ok(!r.peeled.includes("$("), "不应残留替换");
});
check("H3-6 管道执行器危险", () => {
  const r = auditSubstitutions("$(curl x | sh)");
  assert.deepStrictEqual(r.dangerous, ["curl x | sh"]);
});
check("H3-7 bash -c 危险", () => {
  const r = auditSubstitutions("$(bash -c 'x')");
  assert.deepStrictEqual(r.dangerous, ["bash -c 'x'"]);
});
check("H3-8 变量命令危险", () => {
  const r = auditSubstitutions("$($cmd)");
  assert.deepStrictEqual(r.dangerous, ["$cmd"]);
});
check("H3-9 反引号替换", () => {
  const r = auditSubstitutions("ls `pwd`");
  assert.strictEqual(r.dangerous.length, 0);
  assert.ok(!r.peeled.includes("`"));
});
check("H3-10 进程替换", () => {
  const r = auditSubstitutions("diff <(ls) y");
  assert.strictEqual(r.dangerous.length, 0);
  assert.ok(!r.peeled.includes("<("));
});
check("H3-11 外层危险不被掩盖", () => {
  const r = auditSubstitutions("rm -rf $(mktemp -d)");
  assert.deepStrictEqual(r.dangerous, []);
  assert.strictEqual(r.peeled, "rm -rf __pi_subst__");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: `auditSubstitutions` 未导出编译错误

- [ ] **Step 3: 实现**

在 `rule-engine.ts` 的 pythonDangerous 之后追加：

```ts
// ═══════════════════════════════════════════════════
// 剥洋葱：命令替换内部审核
// ═══════════════════════════════════════════════════

/** 最内层替换（内容不含嵌套括号）：$() / 反引号 / 进程替换 */
const SUBST_RE = /\$\(([^()]*)\)|`([^`]*)`|<\(([^()]*)\)|>\(([^()]*)\)/;

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
    const m = SUBST_RE.exec(peeled);
    if (!m) break;
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4];
    const isSafeInner =
      isCommandSafe(inner) &&
      !hasDynamicConstructs(inner) &&
      findPipeExec(inner).length === 0;
    if (!isSafeInner) {
      dangerous.push(inner);
      break;
    }
    peeled = peeled.slice(0, m.index) + SUBST_PLACEHOLDER + peeled.slice(m.index + m[0].length);
  }
  return { peeled, dangerous };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: 123 + 11 = 134 通过，0 失败

- [ ] **Step 5: 提交**

```bash
cd /home/clyzhi/.pi/agent
git add extensions/permission-gate/rule-engine.ts extensions/permission-gate/rule-engine.test.ts
git commit -m "feat(permission-gate): 剥洋葱——命令替换内部逐层审核（auditSubstitutions）"
```

---

### Task 5: RULES 补充（find-delete / write-redirect / dd）+ RuleDef.cmd 可选

**Files:**
- Modify: `extensions/permission-gate/rule-engine.ts`（RuleDef 接口、matchRule 开头、RULES 数组）
- Test: `extensions/permission-gate/rule-engine.test.ts`

**Interfaces:**
- Consumes: `matchRule`（现有，需改 cmd 可选）、`RULES`（现有）
- Produces: 三条新规则：`find-delete`（cmd: "find"，anyFlags: ["-delete","-exec","-ok"]）、`write-redirect`（cmd 省略，anyArgs: [">",">>"]）、`dd`（cmd: "dd"，弹窗级）

- [ ] **Step 1: 写失败测试**

在 H3 节之后追加：

```ts
// ═══════════════════════════════════════════════════
// H4. RULES 补充（find-delete / write-redirect / dd）
// ═══════════════════════════════════════════════════
blocked("H4-1 find -delete", "find / -delete");
blocked("H4-2 find -exec", "find . -exec rm {} \\;");
blocked("H4-3 find -ok", "find . -ok rm {} \\;");
safe("H4-4 find 普通放行", "find / -name '*.log'");
blocked("H4-5 重定向 >", "echo a > /etc/passwd");
blocked("H4-6 重定向 >>", "echo a >> /etc/passwd");
safe("H4-7 2>&1 不误伤", "uv pip install x 2>&1 | tail -1");
blocked("H4-8 dd 设备写入", "dd if=/dev/zero of=/dev/sda bs=1M");
blocked("H4-9 dd 备份也拦", "dd if=/dev/sda of=/tmp/backup.img");
safe("H4-10 普通 echo 放行", "echo hello");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: H4-1/5/6/8/9 失败（规则未实现），H4-4/7/10 通过

- [ ] **Step 3: 实现**

`rule-engine.ts` 三处修改：

**3a. RuleDef.cmd 改可选（write-redirect 需要"任意命令"）：**

```ts
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
```

**3b. matchRule 开头适配（cmd 可选）：**

```ts
function matchRule(tokens: string[], rule: RuleDef): string[] | null {
  const cmdIdx = findCommandIndex(tokens);
  const matched: string[] = [];
  if (rule.cmd) {
    const cmds = Array.isArray(rule.cmd) ? rule.cmd : [rule.cmd];
    if (!cmds.includes(tokens[cmdIdx])) return null;
    matched.push(tokens[cmdIdx]);
  }
  // ...subcmd / anyFlags / anyArgs 逻辑不变
```

**3c. RULES 数组追加三条（放在 python-m-pip 之后）：**

```ts
  {
    name: "find-delete",
    cmd: "find",
    anyFlags: ["-delete", "-exec", "-ok"],
    tip: "find 的 -delete/-exec/-ok 会执行删除或任意命令，请确认目标与操作",
  },
  {
    name: "write-redirect",
    anyArgs: [">", ">>"],
    tip: "命令含输出重定向到文件，请确认目标路径",
  },
  {
    name: "dd",
    cmd: "dd",
    tip: "dd 是低级复制工具，of 指向设备或关键文件时可能造成不可逆破坏，请确认目标",
  },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: 134 + 10 = 144 通过，0 失败（含全部旧用例回归）

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /home/clyzhi/.pi/agent
npx tsc --noEmit -p tsconfig.json
git add extensions/permission-gate/rule-engine.ts extensions/permission-gate/rule-engine.test.ts
git commit -m "feat(permission-gate): RULES 补充 find-delete/write-redirect/dd，RuleDef.cmd 支持任意命令"
```

---

### Task 6: auditCommand 集成入口 + H/I 组行为测试

**Files:**
- Modify: `extensions/permission-gate/rule-engine.ts`
- Test: `extensions/permission-gate/rule-engine.test.ts`

**Interfaces:**
- Consumes: maskShellBlindZones、pythonDangerous、auditSubstitutions、findPipeExec、matchDangerous、isCommandSafe、hasDynamicConstructs、dynamicConstructTokens（全部就绪）
- Produces: `export interface AuditResult { allow: boolean; safe: boolean; rules: TokenRule[]; dynamic: boolean; dynamicTokens: string[]; dangerous: string[]; pyDanger: string[]; pipeExec: string[]; masked: string }`、`export function auditCommand(cmd: string): AuditResult`——index.ts 唯一入口

- [ ] **Step 1: 写失败测试**

在 H4 节之后追加：

```ts
// ═══════════════════════════════════════════════════
// H5. auditCommand 集成（H 组：盲区/剥洋葱 行为验收）
// ═══════════════════════════════════════════════════
import { auditCommand } from "./rule-engine";
const auditAllow = (name: string, cmd: string) =>
  check(name, () => {
    const r = auditCommand(cmd);
    assert.strictEqual(r.allow, true, `期望放行: ${cmd}\n${JSON.stringify(r, null, 2)}`);
  });
const auditBlock = (name: string, cmd: string) =>
  check(name, () => {
    const r = auditCommand(cmd);
    assert.strictEqual(r.allow, false, `期望拦截: ${cmd}\n${JSON.stringify(r, null, 2)}`);
  });

// 真实案例（sessions 8/1-8/4 共 87 条，抽代表）
auditAllow("H5-1 PKG=$(ls -d) 放行", "PKG=$(ls -d node_modules/.pnpm/@earendil-works+pi-coding-agent@*/node_modules/@earendil-works/pi-coding-agent 2>/dev/null | head -1) && echo $PKG");
auditAllow("H5-2 AI=$(ls -d) 放行", "cd ~/.pi/agent && AI=$(ls -d node_modules/.pnpm/@earendil-works+pi-ai@*/node_modules/@earendil-works/pi-ai 2>/dev/null | head -1) && grep -rn 'x' \"$AI/dist\"");
auditAllow("H5-3 python heredoc 脚本放行", "python3 - <<'EOF'\nimport re, html\nprint('ok')\nEOF");
auditAllow("H5-4 date 时间计算放行", "DUE=$(date -d '1 minute ago' +%Y-%m-%dT%H:%M:%S%:z)");
auditAllow("H5-5 find 只读循环放行", "for f in $(find . -name 'wire.jsonl' | head -3); do echo $f; done");
auditAllow("H5-6 curl+grep 抓取放行", "CSS=$(curl -s localhost:8080/ | grep -o 'assets/index-[^\"]*')");
auditAllow("H5-7 python 键值生成放行", "KEY=$(python3 -c 'import secrets; print(secrets.token_hex(16))')");
auditAllow("H5-8 which 定位放行", "PI_BIN=$(which pi)");
auditAllow("H5-9 单引号字面量放行", "echo '$(rm -rf /)'");
auditAllow("H5-10 单引号 python 字面量放行", `python3 -c 'print("$(ls)")'`);
auditAllow("H5-11 裸 heredoc 安全替换放行", "python3 - <<EOF\n$(ls)\nEOF");
auditAllow("H5-12 非 python 字面量 os.system 放行", `echo 'os.system("rm -rf /")'`);
auditAllow("H5-13 复合命令安全替换放行", "ls $(pwd) && echo ok");

// 危险侧
auditBlock("H5-14 参数位 rm 替换", "ls $(rm -rf /)");
auditBlock("H5-15 嵌套 rm 替换", "$(ls $(rm -rf /))");
auditBlock("H5-16 curl|sh 管道", "$(curl x | sh)");
auditBlock("H5-17 find -delete 替换", "$(find / -delete)");
auditBlock("H5-18 重定向替换", "$(echo a > /etc/passwd)");
auditBlock("H5-19 bash -c 替换", "$(bash -c 'x')");
auditBlock("H5-20 变量命令替换", "$($cmd)");
auditBlock("H5-21 外层危险不被掩盖", "rm -rf $(mktemp -d)");
auditBlock("H5-22 eval 仍在", "VAR='$(rm)'; eval $VAR");
auditBlock("H5-23 bash -c 顶层仍弹", "bash -c 'rm -rf /'");
auditBlock("H5-24 裸 heredoc 危险替换", "python3 - <<EOF\n$(rm -rf /)\nEOF");
auditBlock("H5-25 heredoc 内 os.system", "python3 - <<'EOF'\nos.system('rm -rf /')\nEOF");
auditBlock("H5-26 -c 内 os.system", `python3 -c 'import os; os.system("ls")'`);
auditBlock("H5-27 dd 顶层", "dd if=/dev/zero of=/dev/sda bs=1M");
auditBlock("H5-28 dd 备份也拦", "dd if=/dev/sda of=/tmp/backup.img");
auditBlock("H5-29 dd 替换", "$(dd if=/dev/zero of=/dev/sda)");
auditBlock("H5-30 heredoc 内 dd", "python3 - <<'EOF'\nos.system('dd if=/dev/zero of=/dev/sda')\nEOF");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: `auditCommand` 未导出编译错误

- [ ] **Step 3: 实现**

在 `rule-engine.ts` 的 auditSubstitutions 之后追加：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx extensions/permission-gate/rule-engine.test.ts`
Expected: 144 + 30 = 174 通过，0 失败

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /home/clyzhi/.pi/agent
npx tsc --noEmit -p tsconfig.json
git add extensions/permission-gate/rule-engine.ts extensions/permission-gate/rule-engine.test.ts
git commit -m "feat(permission-gate): auditCommand 分级审核统一入口 + H 组行为测试"
```

---

### Task 7: index.ts 接入（tool_call 判定 + tool_result 备注）

**Files:**
- Modify: `extensions/permission-gate/index.ts`
- 不新增测试文件（接入层由 Task 6 的 auditCommand 覆盖，本任务验证 tsc + 旧测试回归）

**Interfaces:**
- Consumes: `auditCommand`（Task 6）、`hasDynamicConstructs`（现有）、`buildRejectReason`（现有）
- Produces: 模块级 `allowedDynamicCommands: Set<string>`；`pi.on("tool_result")` handler

- [ ] **Step 1: 修改 import 与模块级记录**

`index.ts` 顶部 import 追加 `auditCommand`：

```ts
import { isCommandSafe, matchDangerous, hasDynamicConstructs, dynamicConstructTokens, auditCommand, type TokenRule } from "./rule-engine";
```

`DYNAMIC_RULE` 定义之后追加：

```ts
/** 安全动态放行记录：tool_result 命中则在结果前插备注（模型有知情权） */
const allowedDynamicCommands = new Set<string>();
```

- [ ] **Step 2: 重写 tool_call 判定段**

将 tool_call handler 中这一段：

```ts
    const command: string = event.input.command as string;

    // 安全判定：白名单覆盖（venv 保护）或无危险规则 → 字面量命令完全放行；含动态构造则降级人工确认
    const safe = isCommandSafe(command);
    const rules = matchDangerous(command);
    const dynamic = hasDynamicConstructs(command);
    if (safe && !dynamic) return undefined;
    if (dynamic && rules.length === 0) rules.push({ ...DYNAMIC_RULE, matched: dynamicConstructTokens(command) });
```

替换为：

```ts
    const command: string = event.input.command as string;

    // 分级审核：mask 盲区 → 剥洋葱内部审核 → Python 段检测 → 管道执行器 → 规则判定
    const audit = auditCommand(command);
    const { allow, safe, rules, dynamic, dynamicTokens, dangerous, pyDanger, pipeExec, masked } = audit;

    // 完全安全 → 放行；mask 后仍有动态（安全替换被审核放行）→ 记录，tool_result 插备注
    if (allow) {
      if (hasDynamicConstructs(masked)) allowedDynamicCommands.add(command);
      return undefined;
    }

    // 危险信号合并进动态规则（matched 带原文供 GUI 高亮）
    if (dynamic || dangerous.length > 0 || pyDanger.length > 0 || pipeExec.length > 0) {
      rules.push({
        ...DYNAMIC_RULE,
        matched: [...dynamicTokens, ...dangerous, ...pyDanger, ...pipeExec],
      });
    }
```

- [ ] **Step 3: 新增 tool_result handler**

在 `pi.on("tool_call", ...)` 之后追加：

```ts
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = event.input?.command as string | undefined;
    if (!command || !allowedDynamicCommands.has(command)) return undefined;
    allowedDynamicCommands.delete(command);
    // content 是 (TextContent | ImageContent)[]，返回新数组在结果前插备注
    return {
      content: [
        { type: "text" as const, text: "[权限闸门] 命令含命令替换，内部指令已通过规则审核，放行" },
        ...event.content,
      ],
    };
  });
```

- [ ] **Step 4: 验证**

```bash
cd /home/clyzhi/.pi/agent
npx tsc --noEmit -p tsconfig.json          # 零报错
npx tsx extensions/permission-gate/rule-engine.test.ts   # 174 全绿
node skills/clyzhi/git-commit/pre-commit-check.ts
```

Expected: tsc 零报错、174/174、pre-commit 检查通过（确认 index.ts 无残留 `isCommandSafe`/`matchDangerous` 未使用 import——若 tsc 报 unused，把 import 行里不再使用的名字删掉）

- [ ] **Step 5: 提交**

```bash
cd /home/clyzhi/.pi/agent
git add extensions/permission-gate/index.ts
git commit -m "feat(permission-gate): 接入分级审核管线，tool_result 安全动态放行插备注"
```

---

## 收尾清单（全部 Task 完成后）

- [ ] 全量验证：`npx tsc --noEmit -p tsconfig.json` + `npx tsx extensions/permission-gate/rule-engine.test.ts`（174/174）
- [ ] 运行中的扩展需 `/reload` 生效（本仓库即 pi 配置，扩展热加载）
- [ ] GUI 前端 GateView.vue 的改动（高亮默认激活、超时移除）需 `wails build` 才进二进制——与本次引擎改动无关，另行处理
- [ ] 提示用户 d6ec36c + 后续提交可 push
