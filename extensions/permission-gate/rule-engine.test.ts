/**
 * 规则引擎（token 化）行为测试 —— TDD 驱动
 *
 * 取代基于正则的 dangerous-patterns + helpers 方案：
 * 命令按分隔符分段，段内按空白 token 化（去引号），
 * 规则用「命令名 + 子命令 + flag/参数精确匹配」结构化判断。
 */
import assert from "node:assert";
import { splitCommands, matchDangerous, isAutoReject, isCommandSafe, hasDynamicConstructs, dynamicConstructTokens } from "./rule-engine";

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`✗ ${name}: ${(e as Error).message}`);
  }
}

const safe = (name: string, cmd: string) =>
  check(name, () => {
    assert.strictEqual(isCommandSafe(cmd), true, `期望放行: ${cmd}`);
  });
const blocked = (name: string, cmd: string) =>
  check(name, () => {
    assert.strictEqual(isCommandSafe(cmd), false, `期望拦截: ${cmd}`);
  });
const autoRejected = (name: string, cmd: string) =>
  check(name, () => {
    assert.strictEqual(isCommandSafe(cmd), false, `期望拦截: ${cmd}`);
    assert.strictEqual(isAutoReject(cmd), true, `期望自动拒绝: ${cmd}`);
  });

// ═══════════════════════════════════════════════════
// A. 分段与 token 化
// ═══════════════════════════════════════════════════
check("A1 && 分段", () => {
  assert.deepStrictEqual(splitCommands("uv venv && pip install x"), [
    ["uv", "venv"],
    ["pip", "install", "x"],
  ]);
});
check("A2 分号分段", () => {
  assert.deepStrictEqual(splitCommands("a;b"), [["a"], ["b"]]);
});
check("A3 管道分段", () => {
  assert.deepStrictEqual(splitCommands("a | b"), [["a"], ["b"]]);
});
check("A4 双管道分段", () => {
  assert.deepStrictEqual(splitCommands("a || b"), [["a"], ["b"]]);
});
check("A5 换行分段", () => {
  assert.deepStrictEqual(splitCommands("a\nb"), [["a"], ["b"]]);
});
check("A6 引号 token 去引号", () => {
  assert.deepStrictEqual(splitCommands(`echo "a b"`), [["echo", "a b"]]);
});
check("A7 单引号 token", () => {
  assert.deepStrictEqual(splitCommands("echo 'x y'"), [["echo", "x y"]]);
});
check("A8 空段过滤", () => {
  assert.deepStrictEqual(splitCommands("a &&"), [["a"]]);
});
check("A9 env 前缀保留为独立 token", () => {
  assert.deepStrictEqual(splitCommands("FOO=1 cmd"), [["FOO=1", "cmd"]]);
});
check("A10 点号激活 token", () => {
  assert.deepStrictEqual(splitCommands("cd /tmp && . .venv/bin/activate"), [
    ["cd", "/tmp"],
    [".", ".venv/bin/activate"],
  ]);
});

// ═══════════════════════════════════════════════════
// B. 危险规则
// ═══════════════════════════════════════════════════
blocked("B1 sudo", "sudo apt update");
blocked("B2 rm -rf", "rm -rf /tmp/x");
blocked("B3 rm -r", "rm -r x");
blocked("B4 rm --recursive", "rm --recursive x");
safe("B5 rm -f 非递归放行", "rm -f x");
blocked("B6 chmod 777", "chmod 777 f");
safe("B7 chmod 755 放行", "chmod 755 f");
blocked("B8 chown 777", "chown 777 f");
autoRejected("B9 system 在包名后", "uv pip install requests --system");
autoRejected("B10 system 在包名前", "uv pip install --system requests");
autoRejected("B11 system 插中间", "uv pip --system install requests");
autoRejected("B12 system 在 uv 前缀", "uv --system pip install requests");
autoRejected("B13 裸 pip install", "pip install requests");
autoRejected("B14 裸 pip3 install", "pip3 install requests");
autoRejected("B15 python -m pip", "python -m pip install requests");
autoRejected("B16 python3 -m pip", "python3 -m pip install x");
safe("B17 uv pip install 放行", "uv pip install requests");
safe("B18 uv pip install 复合命令", "cd /tmp && uv pip install requests -q");
blocked("B19 env 前缀 + pip install", "FOO=--system pip install x");
autoRejected("B20 python -m pip --system", "python -m pip install --system x");
blocked("B21 sudo 嵌套复杂命令", "cd /tmp && sudo rm -rf x");
safe("B22 git rm 放行", "git rm -rf x");
blocked("B23 chmod -R 777", "chmod -R 777 dir");
safe("B24 grep --system 放行", "grep --system file");
blocked("B25 sudo systemctl", "sudo systemctl restart docker");

// ═══════════════════════════════════════════════════
// C. venv 白名单
// ═══════════════════════════════════════════════════
safe("C1 uv venv 后 uv pip install", "uv venv && uv pip install requests");
safe("C2 uv venv 带目录", "uv venv .venv && uv pip install x");
safe("C3 . 激活简写后 pip install", ". .venv/bin/activate && pip install x");
safe("C4 source 激活后 pip install", "source .venv/bin/activate && pip install x");
safe("C5 python -m venv 后 pip install", "python -m venv .venv && pip install x");
autoRejected("C6 venv 后 uv pip --system 仍拦", "uv venv && uv pip install requests --system");
autoRejected("C7 venv 后 pip --system 仍拦", ". .venv/bin/activate && pip install --system x");
autoRejected("C8 无 venv 裸 pip 仍拦", "pip install x");
blocked("C9 venv 激活后 sudo 仍拦", "uv venv && sudo rm -rf x");

// ═══════════════════════════════════════════════════
// D. 边界与上下文隔离
// ═══════════════════════════════════════════════════
safe("D1 echo --system 放行", "echo --system");
safe("D2 echo 引号 --system 放行", `echo "--system"`);
safe("D3 管道隔离 uv 与 --system", "uv venv | grep --system");
safe("D4 && 隔离 uv 与 --system", "uv venv && echo --system");
autoRejected("D5 段内 system + 重定向管道", "uv pip install requests --system 2>&1 | tail -1");
safe("D6 空命令放行", "");
safe("D7 纯注释放行", "# just a comment");
check("D8 matchDangerous 返回规则名", () => {
  const names = matchDangerous("uv pip install requests --system").map((r) => r.name);
  assert.ok(names.includes("uv-system"), `期望命中 uv-system，实际: ${names.join(",")}`);
});
check("D9 matchDangerous 空命令无规则", () => {
  assert.deepStrictEqual(matchDangerous("echo hi"), []);
});

// ═══════════════════════════════════════════════════
// E. 动态构造检测（命中应降级为人工确认）
// ═══════════════════════════════════════════════════
const dyn = (name: string, cmd: string, expect: boolean) =>
  check(name, () => {
    assert.strictEqual(hasDynamicConstructs(cmd), expect, `期望 hasDynamicConstructs=${expect}: ${cmd}`);
  });

dyn("E1 字面量命令非动态", "rm -rf /tmp", false);
dyn("E2 命令替换", "$(rm -rf /tmp)", true);
dyn("E3 命令替换任意位置", "echo $(date)", true);
dyn("E4 反引号替换", "`rm -rf /tmp`", true);
dyn("E5 eval 字符串执行", "eval \"rm -rf /tmp\"", true);
dyn("E6 bash -c 字符串执行", "bash -c 'rm -rf /tmp'", true);
dyn("E7 sh -c 字符串执行", "sh -c 'echo hi'", true);
dyn("E8 反斜杠拼接命令名", "r\\m -rf /tmp", true);
dyn("E9 变量作命令名", "$C -rf /tmp", true);
dyn("E10 ANSI-C 引号命令名", "$'\\x72m' -rf /tmp", true);
dyn("E11 别名定义", "alias rm='rm -rf'", true);
dyn("E12 函数定义", "f() { rm -rf x; }", true);
dyn("E13 进程替换", "diff <(rm -rf x) y", true);
dyn("E14 正常 uv 命令非动态", "uv pip install requests", false);
dyn("E15 正常复合命令非动态", "cd /tmp && uv pip install x -q", false);
dyn("E16 bash 执行脚本非动态", "bash script.sh", false);
dyn("E17 参数变量展开非动态", "ls $HOME", false);
dyn("E18 引号内转义非动态", "echo \"a\\nb\"", false);
dyn("E19 env 前缀非动态", "FOO=1 cmd", false);

// ═══════════════════════════════════════════════════
// F. matched tokens（GUI 高亮数据）
// ═══════════════════════════════════════════════════
const matchedHas = (name: string, cmd: string, ruleName: string, tokens: string[]) =>
  check(name, () => {
    const rules = matchDangerous(cmd);
    const r = rules.find((x) => x.name === ruleName);
    assert.ok(r, `期望命中规则 ${ruleName}: ${cmd}`);
    for (const t of tokens) {
      assert.ok(r.matched?.includes(t), `期望 matched 含 ${t}，实际: ${r.matched?.join(",")}`);
    }
  });

matchedHas("F1 rm 递归 matched", "rm -rf /tmp", "rm-recursive", ["rm", "-rf"]);
matchedHas("F2 system matched", "uv pip install requests --system", "uv-system", ["uv", "--system"]);
matchedHas("F3 裸 pip matched", "pip install x", "bare-pip", ["pip", "install"]);
matchedHas("F4 sudo matched", "sudo apt update", "sudo", ["sudo"]);
matchedHas("F5 777 matched", "chmod 777 f", "chmod-777", ["777"]);
matchedHas("F6 python -m matched", "python -m pip install x", "python-m-pip", ["python", "-m", "pip", "install"]);
check("F7 matched 不含无关参数", () => {
  const rules = matchDangerous("rm -rf /tmp");
  const r = rules.find((x) => x.name === "rm-recursive");
  assert.ok(r);
  assert.ok(!r.matched?.includes("/tmp"), "matched 不应含路径参数");
});
check("F8 放行命令 matched 为空", () => {
  assert.deepStrictEqual(matchDangerous("uv pip install x"), []);
});

// ═══════════════════════════════════════════════════
// G. 动态构造 token（GUI 高亮动态点）
// ═══════════════════════════════════════════════════
const dynTokens = (name: string, cmd: string, expect: string[]) =>
  check(name, () => {
    assert.deepStrictEqual(dynamicConstructTokens(cmd), expect, `期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(dynamicConstructTokens(cmd))}`);
  });

dynTokens("G1 命令替换 token", "echo $(date)", ["$(date)"]);
dynTokens("G2 命令替换作命令", "$(rm -rf /tmp)", ["$(rm"]);
dynTokens("G3 eval token", "eval \"rm -rf x\"", ["eval"]);
dynTokens("G4 bash -c tokens", "bash -c 'x'", ["bash", "-c"]);
dynTokens("G5 反斜杠拼接 token", "r\\m -rf /tmp", ["r\\m"]);
dynTokens("G6 变量作命令 token", "$C -rf /tmp", ["$C"]);
dynTokens("G7 别名定义 token", "alias rm='rm -rf'", ["alias"]);
dynTokens("G8 函数定义 token", "f() { rm -rf x; }", ["f()"]);
dynTokens("G9 进程替换 token", "diff <(rm -rf x) y", ["<(rm"]);
dynTokens("G10 参数变量非动态", "ls $HOME", []);
dynTokens("G11 引号内转义非动态", "echo \"a\\nb\"", []);
dynTokens("G12 bash 无 -c 非动态", "bash script.sh", []);
dynTokens("G13 正常 uv 非动态", "uv pip install requests", []);
dynTokens("G14 重复特性去重", "eval a && eval b", ["eval"]);
dynTokens("G15 字面量非动态", "rm -rf /tmp", []);
dynTokens("G16 多特性同段", "eval \"$(x)\"", ["eval", "$(x)"]);

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
  assert.deepStrictEqual(segs, [{ seg: "curl x", sep: "|" }, { seg: "sh", sep: null }]);
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

// ═══════════════════════════════════════════════════
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
