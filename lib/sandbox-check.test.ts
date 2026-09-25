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
import { loadBlacklist, pathBlocked } from "../extensions/sandbox-permissions/guard.ts";
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

describe("动态构造收窄：变量渲染参与判定", () => {
  /** 一份把命令名报成 `$P`（带 vars）的报告：preshell 对变量作命令名就是这么报的 */
  const varProgramReport = (target: string) => ({
    version: 1,
    status: "Complete",
    impact: {
      effects: [{ kind: "Exec", target, vars: ["P"], dynamic: true, modeled: true, line: 1 }],
      write_roots: [],
      uncertain: true,
      effects_dropped: 0,
      vars: ["P"],
      cwd: "/tmp",
    },
    issues: [],
    issues_dropped: 0,
  });

  it("命令名变量的值能静态确定时→改命中 dynamic-construct-narrowed（仍走 LLM 预审）", () => {
    withStubPreshell(stubPreshell(varProgramReport("$P")), () => {
      const result = checkCommand("cd /tmp && P=/usr/bin/jq && $P --version", { cwd: "/tmp" });
      // 收窄不再等于放行：allow=true 会让 bash-guard 直接走官方 execute，LLM 那一道就没了
      assert.equal(result.allow, false, `收窄后仍要交预审，实际 reason=${result.reason}`);
      const rules = result.rules ?? [];
      assert.deepEqual(rules.map((r) => r.name), ["dynamic-construct-narrowed"], JSON.stringify(rules));
      // autoReject:false 是硬要求：它只把命令送进预审，不能让 LLM 判 safe 后还多要一次人工
      assert.equal(rules[0].autoReject, false);
      // tip 里要能看到渲染结果，审核模型/人才知道到底要跑什么
      assert.match(rules[0].tip, /\$P = \/usr\/bin\/jq/);
      assert.deepEqual(rules[0].matched, ["$P"]);
      // 不再是残余动态构造（那条规则的口子留给渲不出来的）
      assert.equal(result.audit?.dynamic, false);
      assert.deepEqual(result.audit?.narrowed, [{ token: "$P", program: "/usr/bin/jq" }]);
    });
  });

  it("裸命令名同样收窄，同样要预审", () => {
    withStubPreshell(stubPreshell(varProgramReport("$P")), () => {
      const result = checkCommand("cd /tmp && P=jq && $P --version", { cwd: "/tmp" });
      assert.equal(result.allow, false);
      const rules = result.rules ?? [];
      assert.deepEqual(rules.map((r) => r.name), ["dynamic-construct-narrowed"]);
      assert.match(rules[0].tip, /\$P = jq/);
    });
  });

  it("命令替换里的收窄不会随剥洋葱消失（外层仍要过预审）", () => {
    // 修复前：内层当安全层被 __pi_subst__ 替掉，外层看着干净 → allow=true 直接执行
    withStubPreshell(stubPreshell(varProgramReport("$P")), () => {
      const result = checkCommand("echo $(P=/usr/bin/jq && $P -n 1)", { cwd: "/tmp" });
      assert.equal(result.allow, false);
      const rules = result.rules ?? [];
      assert.deepEqual(rules.map((r) => r.name), ["dynamic-construct-narrowed"], JSON.stringify(rules));
      assert.match(rules[0].tip, /\$P = \/usr\/bin\/jq/);
    });
  });

  it("非系统路径不收窄：/tmp、相对路径、~/、/opt 仍命中 dynamic-construct", () => {
    for (const [cmd, target] of [
      ["cd /tmp && T=/tmp/mytool && $T --help", "$T"],
      ["cd /tmp && T=./tool && $T", "$T"],
      ["cd ~ && T=~/bin/tool && $T", "$T"],
      ["cd /tmp && T=/opt/x/tool && $T", "$T"],
    ] as const) {
      withStubPreshell(stubPreshell(varProgramReport(target)), () => {
        const result = checkCommand(cmd, { cwd: "/tmp" });
        assert.equal(result.allow, false, cmd);
        const names = (result.rules ?? []).map((r) => r.name);
        assert.ok(names.includes("dynamic-construct"), `${cmd} 应仍命中 dynamic-construct，实际 ${names}`);
        assert.ok(!names.includes("dynamic-construct-narrowed"), `${cmd} 不该收窄，实际 ${names}`);
      });
    }
  });

  it("渲染不出来时照旧命中（仍走 LLM 预审 → 人工确认）", () => {
    withStubPreshell(stubPreshell(varProgramReport("$P")), () => {
      // 前置赋值、环境里也没有 P：拿不到程序名，这一条不能收窄
      const result = checkCommand("P=/usr/bin/jq $P --version", { cwd: "/tmp" });
      assert.equal(result.allow, false);
      assert.ok((result.rules ?? []).some((r) => r.name === "dynamic-construct"), JSON.stringify(result.rules));
      assert.ok(!(result.rules ?? []).some((r) => r.name === "dynamic-construct-narrowed"));
      assert.equal(result.audit?.dynamicTokens.includes("$P"), true);
    });
  });

  it("渲染成 rm/sudo 这类程序时不收窄（否则能绕开规则层）", () => {
    withStubPreshell(stubPreshell(varProgramReport("$A")), () => {
      const result = checkCommand("A=rm && $A -rf /tmp/build", { cwd: "/tmp" });
      assert.equal(result.allow, false);
      const names = (result.rules ?? []).map((r) => r.name);
      assert.ok(names.includes("dynamic-construct"), JSON.stringify(names));
      assert.ok(!names.includes("dynamic-construct-narrowed"), JSON.stringify(names));
    });
  });

  it("收窄规则与硬拒判定不重叠：带 narrowed 的结果不是「全 autoReject」", () => {
    // isHardRejected 的定义是「allow=false 且无规则或全 autoReject」：
    // narrowed 是 autoReject:false，这里只需保证它不把规则集变成全 autoReject
    withStubPreshell(stubPreshell(varProgramReport("$P")), () => {
      const result = checkCommand("cd /tmp && P=/usr/bin/jq && $P --version", { cwd: "/tmp" });
      const rules = result.rules ?? [];
      assert.ok(rules.length > 0, "收窄必须留下规则，否则就是无规则硬拒");
      assert.equal(rules.every((r) => r.autoReject), false, "全部 autoReject 会被硬拒，narrowed 不能被当成硬拒");
      // 对照组：真硬拒走的是「没有规则」那条路（黑名单/内联脚本），与本改动无关
      const blocked = checkCommand("cat /work/project/.env", { cwd: "/work/project" });
      assert.equal(blocked.allow, false);
      assert.equal(blocked.rules, undefined, "黑名单命中不给可审批的规则");
    });
  });
});

// v0.3.0：工具对 `$HOME/x` / `~/x` 这类目标只交出名字（target 按原值保留、dynamic: true），
// 替换是调用方的事（integration.md「谁来替换那些变量」）。收尾之后，这类目标才进得了黑名单判定。
describe("路径判定：变量目标（v0.3.0 的收尾）", () => {
  it("$HOME 开头的敏感路径：收尾后能拦到（改动前拿原值去匹配，拦不到）", () => {
    const savedHome = process.env.HOME;
    process.env.HOME = homedir();
    // 旧路径的行为先摆出来：过滤后的事实层只拿到了 `$HOME/.ssh/id_rsa` 这个原值，
    // 它既不是绝对路径，~ 展开也碰不到，规则一条都命不中
    assert.equal(pathBlocked("$HOME/.ssh/id_rsa", "/tmp", loadBlacklist()), false, "原值本来就匹配不上（不是回归）");
    // 而这条命令里没有未引号 token（整个路径在引号里），token 层也不盖它：
    // 改动前唯一可能拦下它的就是收尾后的绝对路径
    assert.deepEqual(unquotedPathTokens('cat "$HOME/.ssh/id_rsa"'), []);

    const bin = stubPreshell({
      version: 1,
      status: "Complete",
      impact: {
        effects: [
          { kind: "Exec", target: "cat", vars: [], dynamic: false, modeled: true, line: 1 },
          { kind: "Read", target: "$HOME/.ssh/id_rsa", vars: ["HOME"], dynamic: true, modeled: true, line: 1 },
        ],
        write_roots: [],
        uncertain: true,
        effects_dropped: 0,
        vars: ["HOME"],
        cwd: "/tmp",
      },
      issues: [],
      issues_dropped: 0,
    });
    try {
      withStubPreshell(bin, () => {
        const result = checkCommand('cat "$HOME/.ssh/id_rsa"', { cwd: "/tmp" });
        assert.equal(result.allow, false, "收尾成 /home/u/.ssh/id_rsa 之后就该命中");
        assert.match(result.reason ?? "", /敏感路径黑名单/);
      });
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it("变量没设：保留原值、不猜（判定与接入前一致，不是放松）", () => {
    const bin = stubPreshell({
      version: 1,
      status: "Complete",
      impact: {
        effects: [{ kind: "Read", target: "$NOT_SET_ANYWHERE/.ssh/id_rsa", vars: ["NOT_SET_ANYWHERE"], dynamic: true, modeled: true, line: 1 }],
        write_roots: [],
        uncertain: true,
        effects_dropped: 0,
        vars: ["NOT_SET_ANYWHERE"],
        cwd: "/tmp",
      },
      issues: [],
      issues_dropped: 0,
    });
    withStubPreshell(bin, () => {
      const result = checkCommand("cat $NOT_SET_ANYWHERE/.ssh/id_rsa", { cwd: "/tmp" });
      assert.equal(result.facts?.settledPaths[0]?.known, false, "补不上就得说补不上");
      assert.equal(result.facts?.settledPaths[0]?.path, "$NOT_SET_ANYWHERE/.ssh/id_rsa", "保留原值");
      // 不变宽也不会变严：这条在接入前也是没拦住（token 层拿带 $ 的原值同样匹配不上）
      assert.equal(result.allow, true);
    });
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
