/**
 * 规则引擎（token 化）行为测试 —— TDD 驱动
 *
 * 取代基于正则的 dangerous-patterns + helpers 方案：
 * 命令按分隔符分段，段内按空白 token 化（去引号），
 * 规则用「命令名 + 子命令 + flag/参数精确匹配」结构化判断。
 */
import assert from "node:assert";
import { splitCommands, matchDangerous, isAutoReject, isCommandSafe } from "./rule-engine";

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
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
