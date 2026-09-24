// lib/sandbox-check.test.ts — 命令判定层的敏感路径处置（block / ask）与路径判定的两个来源
//
// 跑法：node --experimental-strip-types lib/sandbox-check.test.ts
//
// 背景：
//   1 敏感路径黑名单过去在所有调用方都是硬拒；sandbox-allow 是唯一有「问人」出口的通道，
//     所以它声明 ask：命中项交给审批窗，但绝不静默放行。普通 bash 与 worker bash 仍 block。
//   2 路径判定原先拿黑名单模式对整条命令做子串匹配，误伤三类（引号内字符串、词内片段、
//     模板文件名），又漏掉相对路径（cd 到某目录后读 providers.toml 一次都没被拦）。
//     现在改成：preshell 解析出的读/写/删目标（事实）∪ 未引号路径 token（兜底）。

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkCommand, isInterpreterProgram, unquotedPathTokens } from "./sandbox-check.ts";
import { clearPreshellCache, resetPreshellBreaker, resetPreshellVersionCache } from "./preshell.ts";

/** 起一个假 preshell：回答 --version，正文报告由调用方给 */
function stubPreshell(report: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "preshell-stub-"));
  const path = join(dir, "preshell");
  const body = [
    "#!/bin/sh",
    `case "$1" in --version) printf '%s' '{"tool":"preshell","version":"9.9.9","schema":1}'; exit 0 ;; esac`,
    "cat >/dev/null",
    `printf '%s' '${JSON.stringify(report)}'`,
  ].join("\n");
  writeFileSync(path, `${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function withStubPreshell<T>(bin: string, run: () => T): T {
  const saved = process.env.PRESHELL_BIN;
  process.env.PRESHELL_BIN = bin;
  clearPreshellCache();
  resetPreshellVersionCache();
  resetPreshellBreaker();
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.PRESHELL_BIN;
    else process.env.PRESHELL_BIN = saved;
    clearPreshellCache();
    resetPreshellVersionCache();
    resetPreshellBreaker();
  }
}

describe("checkCommand：敏感路径黑名单", () => {
  it("默认 block：直接拒，且不带可放行的命中项", () => {
    const result = checkCommand("cat /work/project/.env", { cwd: "/work/project" });
    assert.equal(result.allow, false);
    assert.match(result.reason ?? "", /敏感路径黑名单/);
    assert.equal(result.sensitive, undefined);
  });

  it("ask：不在判定层拒，把命中项交给上层弹审批", () => {
    const command = "cat /work/project/.env && ls -la";
    const result = checkCommand(command, { cwd: "/work/project", sensitivePaths: "ask" });
    assert.equal(result.allow, false);
    const hits = result.sensitive ?? [];
    assert.ok(hits.length > 0, "应至少有一条命中");
    assert.match(hits[0].pattern, /env/);
    assert.match(hits[0].token, /\.env$/);
    assert.ok(["preshell", "token"].includes(hits[0].via ?? ""), `via 应标注来源，实际 ${hits[0].via}`);
    // 不并进 rules：rules 是「命令写法有风险」的语义，会连带影响目录长期授权
    assert.equal(result.rules, undefined);
  });

  it("ask 不影响不含敏感路径的普通命令", () => {
    const result = checkCommand("ls -la", { cwd: "/work/project", sensitivePaths: "ask" });
    assert.equal(result.allow, true);
  });

  it("ask 只放敏感路径那一关：危险规则照旧走规则链", () => {
    const result = checkCommand("sudo rm -rf /work/project/out", { cwd: "/work/project", sensitivePaths: "ask" });
    assert.equal(result.allow, false);
    assert.ok((result.rules?.length ?? 0) > 0, "sudo/rm 这类规则仍要命中");
  });
});

describe("路径判定：误伤那一侧（子串匹配改 token 化之后）", () => {
  it("引号里的字符串不再当路径：grep 模式含 .env 也放行", () => {
    // 旧实现：命令文本 includes(".env") → 拦。实测语料里这类误伤 14 条
    for (const command of [
      'grep -rn "process.env" src/',
      "grep -rn '\\.env' --include=*.ts extensions/",
      'rg -n "\\.env" README.md',
    ]) {
      const result = checkCommand(command, { cwd: "/work/project" });
      assert.equal(result.allow, true, `不该拦：${command}`);
    }
  });

  it("词内片段不再当路径：env-prep.sh / .env.example 都不拦", () => {
    for (const command of ["bash scripts/env-prep.sh", "cat .env.example", "git add .env.sample"]) {
      const result = checkCommand(command, { cwd: "/work/project" });
      assert.equal(result.allow, true, `不该拦：${command}`);
    }
  });

  it("真路径照旧拦：相对、绝对、带引号都要拦", () => {
    for (const command of [
      "cat .env",
      "cat /work/project/.env",
      'cat "/work/project/.env"',
      "sed -n '1,3p' .env",
    ]) {
      const result = checkCommand(command, { cwd: "/work/project" });
      assert.equal(result.allow, false, `该拦：${command}`);
    }
  });
});

describe("路径判定：漏报那一侧（相对路径）", () => {
  it("cwd 下的相对路径凭据文件被拦下（旧子串匹配漏掉的那类）", () => {
    // 历史上这条命令真的跑过：cd ~/.pi/agent && sed -n '610,630p' providers.toml
    const result = checkCommand("sed -n '610,630p' providers.toml", { cwd: `${homedir()}/.pi/agent` });
    assert.equal(result.allow, false);
    assert.match(result.reason ?? "", /敏感路径黑名单/);
  });
});

describe("解释器载荷与事实层不可用", () => {
  it("heredoc 交给解释器的脚本里的路径仍然被拦（preshell 不建模这类程序）", () => {
    const command = [
      "node --input-type=module <<'EOF'",
      "import { readFileSync } from 'node:fs';",
      "const key = readFileSync('/home/clyzhi/.pi/agent/auth.json', 'utf8');",
      "EOF",
    ].join("\n");
    const result = checkCommand(command, { cwd: "/tmp" });
    assert.equal(result.allow, false);
    assert.match(result.reason ?? "", /敏感路径黑名单/);
  });

  it("管道喂给解释器的 heredoc 正文照样拦", () => {
    const command = ["cat <<'EOF' | bash", "head -3 ~/.pi/agent/auth.json", "EOF"].join("\n");
    const result = checkCommand(command, { cwd: "/tmp" });
    assert.equal(result.allow, false, result.reason ?? "");
  });

  it("包装器不算程序名：sudo / timeout 后面的解释器仍认出来", () => {
    for (const command of [
      `sudo node -e "process.stdout.write(require('fs').readFileSync('/home/clyzhi/.pi/agent/auth.json','utf8'))"`,
      `timeout 30 python3 -c "print(open('/home/clyzhi/.pi/agent/auth.json').read())"`,
    ]) {
      const result = checkCommand(command, { cwd: "/tmp" });
      assert.equal(result.allow, false, `该拦：${command}`);
    }
  });

  it("python 字符串里的路径同样被拦", () => {
    const command = `python3 -c "import json; print(json.load(open('/home/clyzhi/.pi/agent/auth.json')))"`;
    const result = checkCommand(command, { cwd: "/tmp" });
    assert.equal(result.allow, false);
  });

  it("自己写的脚本正文不当载荷：之后用 node 跑它也不拦", () => {
    // 实测踩到的误伤：探针脚本正文里有一行正则提到 .env，整条命令就被拦了
    const command = [
      "cd /tmp && cat > probe.ts <<'EOF'",
      "const hits = /[^\\s;|'\"()]*(?:\\.ssh|\\.env)[^\\s;|'\"()]*/g;",
      "console.log(hits.source);",
      "EOF",
      "timeout 300 node --experimental-strip-types /tmp/probe.ts",
    ].join("\n");
    const result = checkCommand(command, { cwd: "/tmp" });
    assert.equal(result.allow, true, `不该拦：${result.reason ?? ""}`);
  });

  it("不喂给解释器的 heredoc 正文也不当路径", () => {
    const command = ["cat > notes.md <<'EOF'", "把 ~/.ssh 的配置抄过来", "EOF"].join("\n");
    const result = checkCommand(command, { cwd: "/work/project" });
    assert.equal(result.allow, true, `不该拦：${result.reason ?? ""}`);
  });

  // 这一条是误伤那一侧的护栏：git 不是解释器，提交信息里提到 .env 不该被拦
  it("git 提交信息里提到 .env 不拦（git 不算解释器）", () => {
    const command = `git commit -m "fix(sandbox): 对 .env 的处理改成问人"`;
    const result = checkCommand(command, { cwd: "/work/project" });
    assert.equal(result.allow, true, result.reason ?? "");
  });

  it("报告被截断时不拿它当完备集合：整条退回旧匹配", () => {
    // 正文里提到凭据路径，本该被正文遮蔽那条规则放行；
    // 但工具说「effects 被截掉 7 条」→ 这份影响面不完整，宁可多问一次
    const command = ["cat > notes.md <<'EOF'", "cp ~/.ssh/id_rsa /tmp/leak", "EOF"].join("\n");
    const complete = stubPreshell({
      version: 1,
      status: "Complete",
      impact: { effects: [], write_roots: [], uncertain: true, cwd: "/tmp", effects_dropped: 0 },
      issues_dropped: 0,
    });
    const truncated = stubPreshell({
      version: 1,
      status: "Complete",
      impact: { effects: [], write_roots: [], uncertain: true, cwd: "/tmp", effects_dropped: 7 },
      issues_dropped: 0,
    });
    const invalid = stubPreshell({
      version: 1,
      status: "Invalid",
      impact: { effects: [], write_roots: [], uncertain: true, cwd: "/tmp", effects_dropped: 0 },
      issues_dropped: 0,
    });

    withStubPreshell(complete, () => {
      assert.equal(checkCommand(command, { cwd: "/tmp" }).allow, true, "完整报告时正文不当路径");
    });
    withStubPreshell(truncated, () => {
      const result = checkCommand(command, { cwd: "/tmp" });
      assert.equal(result.allow, false, "截断时不能当完备集合");
      assert.match(result.reason ?? "", /敏感路径黑名单/);
    });
    withStubPreshell(invalid, () => {
      assert.equal(checkCommand(command, { cwd: "/tmp" }).allow, false, "语法错时同理");
    });
  });

  it("uncertain 单独不降级：它在真实命令里占 65%", () => {
    const command = ["cat > notes.md <<'EOF'", "把 ~/.ssh 的配置抄过来", "EOF"].join("\n");
    const bin = stubPreshell({
      version: 1,
      status: "Complete",
      impact: { effects: [], write_roots: [], uncertain: true, cwd: "/tmp", effects_dropped: 0 },
      issues_dropped: 0,
    });
    withStubPreshell(bin, () => {
      assert.equal(checkCommand(command, { cwd: "/tmp" }).allow, true);
    });
  });

  it("缺二进制时整条退回旧匹配（不因缺工具而变宽），并带上不可用原因", () => {
    const saved = process.env.PRESHELL_BIN;
    process.env.PRESHELL_BIN = "/nonexistent/preshell-binary";
    try {
      const result = checkCommand("cat /work/project/.env", { cwd: "/work/project" });
      assert.equal(result.allow, false, "旧匹配会拦，不能因为事实层不在就放行");
      assert.equal(result.factsUnavailable, "missing");
      assert.equal(result.facts, undefined);
    } finally {
      if (saved === undefined) delete process.env.PRESHELL_BIN;
      else process.env.PRESHELL_BIN = saved;
    }
  });
});

describe("isInterpreterProgram", () => {
  it("认版本后缀与路径，不把 git/ssh 当解释器", () => {
    assert.equal(isInterpreterProgram("python3.12"), true);
    assert.equal(isInterpreterProgram("/usr/bin/node"), true);
    assert.equal(isInterpreterProgram("bash"), true);
    // 本地脚本也算：它的命令行字符串里可能是代码或路径
    assert.equal(isInterpreterProgram("/tmp/tmp.x/rs22.sh"), true);
    assert.equal(isInterpreterProgram("probe.mjs"), true);
    // 这两个刻意排除：远端路径与已被 preshell 建模的 git
    assert.equal(isInterpreterProgram("git"), false);
    assert.equal(isInterpreterProgram("ssh"), false);
    assert.equal(isInterpreterProgram("docker"), false);
    assert.equal(isInterpreterProgram("make"), false);
  });
});

describe("unquotedPathTokens", () => {
  it("只收未引号、像路径的 token", () => {
    assert.deepEqual(unquotedPathTokens("cat .env"), [".env"]);
    assert.deepEqual(unquotedPathTokens('grep "a.env" b.txt'), ["b.txt"]);
    assert.deepEqual(unquotedPathTokens("ls -la /tmp/x"), ["/tmp/x"]);
    assert.deepEqual(unquotedPathTokens("echo hi"), []);
  });

  it("引号混在 token 里时整体丢弃（quoted 的路径交给事实层）", () => {
    assert.deepEqual(unquotedPathTokens('cat "/work/x.env"'), []);
    assert.deepEqual(unquotedPathTokens("cat '/work/x.env'"), []);
  });

  it("不算路径的 token 不进候选：flag、纯单词、单字符", () => {
    for (const token of unquotedPathTokens("-rf . x foo")) {
      assert.ok(token !== "-rf" && token !== "." && token !== "x" && token !== "foo", `不该收：${token}`);
    }
  });
});
