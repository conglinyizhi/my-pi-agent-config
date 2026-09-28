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
import {
  checkCommand,
  isInterpreterProgram,
  preshellProgramValues,
  splitProgramCandidates,
  summarizeTokens,
  unquotedPathTokens,
} from "./sandbox-check.ts";
import { loadBlacklist, pathBlocked } from "../extensions/sandbox-permissions/guard.ts";
import { clearPreshellCache, resetPreshellBreaker, resetPreshellVersionCache } from "./preshell.ts";

/** 起一个假 preshell：回答 --version，正文报告由调用方给 */
function stubPreshell(report: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "preshell-stub-"));
  const path = join(dir, "preshell");
  const body = [
    "#!/bin/sh",
    `case "$1" in --version) printf '%s' '{"tool":"preshell","version":"0.6.0"}'; exit 0 ;; esac`,
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

  it("dynamic-construct 的 tip 带出命中的 token（人不用自己在命令里找）", () => {
    withStubPreshell(stubPreshell(varProgramReport("$P")), () => {
      const result = checkCommand("P=/usr/bin/jq $P --version", { cwd: "/tmp" });
      const rule = (result.rules ?? []).find((r) => r.name === "dynamic-construct");
      assert.ok(rule, JSON.stringify(result.rules));
      assert.equal(rule.tip, "命令含动态构造（$P），请人工确认");
      // matched 仍然原样带着，供审批窗高亮用
      assert.deepEqual(rule.matched, ["$P"]);
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

// v0.4.0：条件分支让命令名位置的名字有多个取值时，Exec/Spawn 上多一份 candidates。
// 候选全落在已知程序上就摘到 narrowed（仍是 autoReject:false，仍要过 LLM 预审）；
// 有一个过不了窄门槛就留在 dynamic-construct（保守）。
describe("动态构造收窄：preshell 的命令名候选集（v0.4.0）", () => {
  /** 命令名变量 `$x` 的 Exec 效果，带候选集 */
  const programCandidatesReport = (candidates: string[]) => ({
    version: 1,
    status: "Complete",
    impact: {
      effects: [{ kind: "Exec", target: "$x", vars: ["x"], candidates, dynamic: true, modeled: true, line: 1 }],
      write_roots: [],
      uncertain: true,
      effects_dropped: 0,
      vars: ["x"],
      cwd: "/tmp",
    },
    issues: [],
    issues_dropped: 0,
  });

  it("候选全可收窄 → dynamic-construct-narrowed（不是放行）", () => {
    const bin = stubPreshell(programCandidatesReport(["/usr/bin/jq", "/usr/bin/ripgrep"]));
    withStubPreshell(bin, () => {
      const result = checkCommand("if c; then x=/usr/bin/jq; else x=/usr/bin/ripgrep; fi; $x -n 1", { cwd: "/tmp" });
      assert.equal(result.allow, false, `收窄后仍要交预审，实际 reason=${result.reason}`);
      const rules = result.rules ?? [];
      assert.deepEqual(rules.map((r) => r.name), ["dynamic-construct-narrowed"], JSON.stringify(rules));
      assert.equal(rules[0].autoReject, false);
      // tip 要把候选摆出来：审核模型得看到可能跑哪几个程序，而不是只知道「有动态构造」
      assert.match(rules[0].tip, /\$x = \/usr\/bin\/jq、\/usr\/bin\/ripgrep/);
      assert.match(rules[0].tip, /其中之一/);
      assert.deepEqual(rules[0].matched, ["$x"]);
      // 候选是可能性，不是事实：规则不能写成「已确定」
      assert.doesNotMatch(rules[0].tip, /已静态确定/);
    });
  });

  it("${x} 这种花括号写法与 $x 是同一处引用（preshell 报的是 $x）", () => {
    const bin = stubPreshell(programCandidatesReport(["/usr/bin/jq", "/usr/bin/ripgrep"]));
    withStubPreshell(bin, () => {
      const result = checkCommand("if c; then x=/usr/bin/jq; else x=/usr/bin/ripgrep; fi; ${x} -n 1", { cwd: "/tmp" });
      const rules = result.rules ?? [];
      assert.deepEqual(rules.map((r) => r.name), ["dynamic-construct-narrowed"], JSON.stringify(rules));
      assert.deepEqual(rules[0].matched, ["${x}"], "高亮用的 token 保持命令里的原样");
    });
  });

  it("候选里有一个过不了窄门槛 → 保持 dynamic-construct（候选是其中之一，不能部分担保）", () => {
    for (const candidates of [
      ["/usr/bin/jq", "/usr/bin/rm"],
      ["/usr/bin/jq", "/tmp/mytool"],
      ["/usr/bin/jq", "/tmp/probe.sh"],
      ["/usr/bin/jq", "python3"],
    ]) {
      const bin = stubPreshell(programCandidatesReport(candidates));
      withStubPreshell(bin, () => {
        const result = checkCommand("if c; then x=/usr/bin/jq; else x=/tmp/mytool; fi; $x -n 1", { cwd: "/tmp" });
        const names = (result.rules ?? []).map((r) => r.name);
        assert.ok(names.includes("dynamic-construct"), `${candidates} 应仍命中 dynamic-construct，实际 ${names}`);
        assert.ok(!names.includes("dynamic-construct-narrowed"), `${candidates} 不该收窄，实际 ${names}`);
        assert.match((result.rules ?? [])[0].tip, /\$x/);
      });
    }
  });

  it("旧版二进制没有 candidates：行为与接入前一致（仍旧动态构造）", () => {
    // 与上面同一张报告，只是没有 candidates 字段——v0.3.0 及更早就是这样
    const bin = stubPreshell({
      version: 1,
      status: "Complete",
      impact: {
        effects: [{ kind: "Exec", target: "$x", vars: ["x"], dynamic: true, modeled: true, line: 1 }],
        write_roots: [],
        uncertain: true,
        effects_dropped: 0,
        vars: ["x"],
        cwd: "/tmp",
      },
      issues: [],
      issues_dropped: 0,
    });
    withStubPreshell(bin, () => {
      const result = checkCommand("if c; then x=/usr/bin/jq; else x=/usr/bin/ripgrep; fi; $x -n 1", { cwd: "/tmp" });
      const names = (result.rules ?? []).map((r) => r.name);
      assert.deepEqual(names, ["dynamic-construct"], JSON.stringify(result.rules));
      assert.equal(result.audit?.dynamicTokens.includes("$x"), true);
    });
  });

  it("解析层：只有 Exec/Spawn 上带取值的引用才算；确定值与候选集分得清", () => {
    const bin = stubPreshell({
      version: 1,
      status: "Complete",
      impact: {
        effects: [
          { kind: "Exec", target: "$x", vars: ["x"], candidates: ["/usr/bin/jq", "/usr/bin/jq", "/usr/bin/rg"], dynamic: true, line: 1 },
          { kind: "Exec", target: "/usr/bin/jq", vars: [], candidates: [], origin: "$y", dynamic: false, line: 1 },
          { kind: "Delete", target: "$p", vars: ["p"], candidates: ["/a", "/b"], dynamic: true, line: 1 },
          { kind: "Exec", target: "cat", vars: [], candidates: [], dynamic: false, line: 1 },
          { kind: "Exec", target: "$z", vars: ["z"], candidates: [], dynamic: true, line: 1 },
          // dynamic: true 时 target 是引用原文，origin 不是这回事（旧报告里没有这个字段，这里是防备）
          { kind: "Exec", target: "$w", vars: ["w"], candidates: ["/usr/bin/curl", "/usr/bin/wget"], origin: "$other", dynamic: true, line: 1 },
        ],
        write_roots: [],
        uncertain: true,
        effects_dropped: 0,
        cwd: "/tmp",
      },
      issues: [],
      issues_dropped: 0,
    });
    withStubPreshell(bin, () => {
      // 借 checkCommand 走一遍事实层拿到 facts（拿不到就直接调 analyzeCommand）
      const result = checkCommand("if c; then x=/usr/bin/jq; fi; $x -n 1", { cwd: "/tmp" });
      const map = preshellProgramValues(result.facts);
      assert.deepEqual([...map.keys()], ["$x", "$y", "$w"], "路径效果与空候选不进这张表");
      assert.deepEqual(map.get("$x"), { programs: ["/usr/bin/jq", "/usr/bin/rg"], certain: false }, "同值要去重");
      assert.deepEqual(map.get("$y"), { programs: ["/usr/bin/jq"], certain: true }, "dynamic:false + origin 是确定值");
      assert.deepEqual(
        map.get("$w"),
        { programs: ["/usr/bin/curl", "/usr/bin/wget"], certain: false },
        "dynamic 的那条只看 target、不看 origin",
      );
      const split = splitProgramCandidates(["$x", "$y", "$z", "$(echo jq)"], map);
      assert.deepEqual(split.keep, ["$z", "$(echo jq)"], "没取值的与不是变量引用的都留在动态里");
      assert.deepEqual(split.narrowed, [
        { token: "$x", programs: ["/usr/bin/jq", "/usr/bin/rg"], certain: false },
        { token: "$y", programs: ["/usr/bin/jq"], certain: true },
      ]);
    });
  });

  it("同一个引用在两处使用点各报一条：取并集，`certain` 宁紧不宽", () => {
    const bin = stubPreshell({
      version: 1,
      status: "Complete",
      impact: {
        effects: [
          { kind: "Exec", target: "/usr/bin/jq", vars: [], candidates: [], origin: "$x", dynamic: false, line: 1 },
          { kind: "Exec", target: "$x", vars: ["x"], candidates: ["/usr/bin/rg", "/usr/bin/curl"], dynamic: true, line: 1 },
        ],
        write_roots: [],
        uncertain: true,
        vars: ["x"],
        cwd: "/tmp",
      },
      issues: [],
      issues_dropped: 0,
    });
    withStubPreshell(bin, () => {
      const result = checkCommand("x=/usr/bin/jq; $x; if c; then $x; fi", { cwd: "/tmp" });
      const map = preshellProgramValues(result.facts);
      // 并集是可能取值的超集，往大了算是保守那侧；mixed 时不叫「确定值」
      assert.deepEqual(map.get("$x"), { programs: ["/usr/bin/jq", "/usr/bin/rg", "/usr/bin/curl"], certain: false });
    });
  });
});

// v0.4.1：命令自己赋值解出来的效果带 origin（它原来写的那处引用）。命令文本里没有解出来的
// 程序名这个串，pi 侧过去对不上命令名位置的 token，只能保守报 dynamic-construct——明明
// 信息比候选集更强。拿 origin 对上之后，两类事实走同一道窄门槛、同一条预审规则。
describe("动态构造收窄：事实层解出的确定值（v0.4.1 的 origin）", () => {
  /** 命令名变量 `$x` 已被解出确定值：target 是程序名，origin 是引用原文 */
  const certainReport = (target: string) => ({
    version: 1,
    status: "Complete",
    impact: {
      effects: [{ kind: "Exec", target, vars: [], candidates: [], origin: "$x", dynamic: false, modeled: false, line: 1 }],
      write_roots: [],
      uncertain: true,
      effects_dropped: 0,
      vars: [],
      cwd: "/tmp",
    },
    issues: [],
    issues_dropped: 0,
  });

  it("两路设置同一个值 → 能收窄了（改前只能报 dynamic-construct）", () => {
    // 这条命令 pi 自己的静态渲染器解不出（条件分支里两个赋值，它不敢确定）——
    // 改前事实层报的是 Exec "/usr/bin/jq"（origin: "$x"），在旧解析里 `$x` 这个键对不上，
    // 于是留在 dynamic-construct；现在按 origin 对上，改报 narrowed
    const command = "if c; then x=/usr/bin/jq; else x=/usr/bin/jq; fi; $x -n 1";
    withStubPreshell(stubPreshell(certainReport("/usr/bin/jq")), () => {
      const result = checkCommand(command, { cwd: "/tmp" });
      assert.equal(result.allow, false, `收窄后仍要交预审，实际 reason=${result.reason}`);
      const rules = result.rules ?? [];
      assert.deepEqual(rules.map((r) => r.name), ["dynamic-construct-narrowed"], JSON.stringify(rules));
      assert.equal(rules[0].autoReject, false, "收窄不是放行：它只把命令送进 LLM 预审");
      // tip 要把解出来的程序摆出来，且措辞与「已静态确定」区分开（来源不同）
      assert.match(rules[0].tip, /事实层已解出它是 \$x = \/usr\/bin\/jq/);
      assert.doesNotMatch(rules[0].tip, /已静态确定/, "静态渲染是另一个来源，不能写反");
      assert.doesNotMatch(rules[0].tip, /已确定安全/);
      assert.deepEqual(rules[0].matched, ["$x"]);
      // 收窄过的 token 不再算残余动态构造
      assert.deepEqual(result.audit?.dynamicTokens, ["$x"]);
    });
  });

  it("单赋值那条命令（pi 自己就能静态渲染）不因新来源重复报一遍", () => {
    // `x=/usr/bin/jq; $x -n 1` 的静态渲染走的是 pi 自己的 var-render（audit.narrowed），
    // 事实层同时也会报 origin——同一件事的两个来源只报一次
    withStubPreshell(stubPreshell(certainReport("/usr/bin/jq")), () => {
      const result = checkCommand("x=/usr/bin/jq; $x -n 1", { cwd: "/tmp" });
      const rules = result.rules ?? [];
      assert.deepEqual(rules.map((r) => r.name), ["dynamic-construct-narrowed"], JSON.stringify(rules));
      assert.deepEqual(rules[0].matched, ["$x"]);
      assert.match(rules[0].tip, /已静态确定为 \$x = \/usr\/bin\/jq/);
      assert.equal((rules[0].tip.match(/\$x/g) ?? []).length, 1, `tip 里只应该出现一份 $x：${rules[0].tip}`);
    });
  });

  it("${x} 这种花括号写法与 $x 是同一处引用（事实层报的 origin 是 $x）", () => {
    withStubPreshell(stubPreshell(certainReport("/usr/bin/jq")), () => {
      const result = checkCommand("if c; then x=/usr/bin/jq; else x=/usr/bin/jq; fi; ${x} -n 1", { cwd: "/tmp" });
      const rules = result.rules ?? [];
      assert.deepEqual(rules.map((r) => r.name), ["dynamic-construct-narrowed"], JSON.stringify(rules));
      assert.deepEqual(rules[0].matched, ["${x}"], "高亮用的 token 保持命令里的原样");
      assert.match(rules[0].tip, /\$\{x\} = \/usr\/bin\/jq/, "tip 也跟着命令文本写，与 matched 对得上号");
    });
  });

  it("确定值过不了窄门槛 → 保持 dynamic-construct（信息更强不等于门槛更松）", () => {
    for (const [target, command] of [
      ["/tmp/tool", "x=/tmp/tool; $x"],
      ["python3", "x=python3; $x -c 'print(1)'"],
      ["/usr/bin/rm", "x=/usr/bin/rm; $x -rf /tmp/build"],
      ["/opt/x/tool", "x=/opt/x/tool; $x"],
      ["tool.sh", "x=tool.sh; $x"],
    ] as const) {
      withStubPreshell(stubPreshell(certainReport(target)), () => {
        const result = checkCommand(command, { cwd: "/tmp" });
        const names = (result.rules ?? []).map((r) => r.name);
        assert.ok(names.includes("dynamic-construct"), `${target} 应仍命中 dynamic-construct，实际 ${names}`);
        assert.ok(!names.includes("dynamic-construct-narrowed"), `${target} 不该收窄，实际 ${names}`);
      });
    }
  });

  it("旧报告（没有 origin 字段）行为与改动前一致：仍旧 dynamic-construct", () => {
    // v0.4.0 及更早的报告就是这个形状：确定的情况只给 target，命令名位置对不上
    const bin = stubPreshell({
      version: 1,
      status: "Complete",
      impact: {
        effects: [
          { kind: "Exec", target: "c", vars: [], candidates: [], dynamic: false, modeled: false, line: 1 },
          { kind: "Exec", target: "/usr/bin/jq", vars: [], candidates: [], dynamic: false, modeled: false, line: 1 },
        ],
        write_roots: [],
        uncertain: true,
        effects_dropped: 0,
        vars: [],
        cwd: "/tmp",
      },
      issues: [],
      issues_dropped: 0,
    });
    withStubPreshell(bin, () => {
      const result = checkCommand("if c; then x=/usr/bin/jq; else x=/usr/bin/jq; fi; $x -n 1", { cwd: "/tmp" });
      assert.deepEqual((result.rules ?? []).map((r) => r.name), ["dynamic-construct"], JSON.stringify(result.rules));
      assert.equal(result.audit?.dynamicTokens.includes("$x"), true);
    });
  });

  it("tip 区分两个来源：确定值写「已解出它是」，候选集写「候选全落在已知程序上」", () => {
    const bin = stubPreshell({
      version: 1,
      status: "Complete",
      impact: {
        effects: [
          { kind: "Exec", target: "/usr/bin/jq", vars: [], candidates: [], origin: "$a", dynamic: false, line: 1 },
          { kind: "Exec", target: "$b", vars: ["b"], candidates: ["/usr/bin/rg", "/usr/bin/curl"], dynamic: true, line: 1 },
        ],
        write_roots: [],
        uncertain: true,
        vars: ["b"],
        cwd: "/tmp",
      },
      issues: [],
      issues_dropped: 0,
    });
    withStubPreshell(bin, () => {
      const command =
        "if c; then a=/usr/bin/jq; else a=/usr/bin/jq; fi; $a -n; if d; then b=/usr/bin/rg; else b=/usr/bin/curl; fi; $b -x";
      const result = checkCommand(command, { cwd: "/tmp" });
      const rules = result.rules ?? [];
      assert.deepEqual(rules.map((r) => r.name), ["dynamic-construct-narrowed"], JSON.stringify(rules));
      assert.match(rules[0].tip, /事实层已解出它是 \$a = \/usr\/bin\/jq/);
      assert.match(rules[0].tip, /候选全落在已知程序上（\$b = \/usr\/bin\/rg、\/usr\/bin\/curl，跑的是其中之一）/);
      assert.doesNotMatch(rules[0].tip, /已确定安全/);
      assert.deepEqual(rules[0].matched, ["$a", "$b"]);
      assert.equal(rules[0].autoReject, false);
    });
  });

  it("确定值那一侧也走不通时（取值含空白/展开字符）不当确定值用", () => {
    // `A='rm -rf' && $A /` 这种：值里有空白，命令行会按词拆开，不算「知道跑什么程序」
    withStubPreshell(stubPreshell(certainReport("rm -rf")), () => {
      const result = checkCommand("A='rm -rf' && $A /", { cwd: "/tmp" });
      const names = (result.rules ?? []).map((r) => r.name);
      assert.ok(names.includes("dynamic-construct"), JSON.stringify(result.rules));
      assert.ok(!names.includes("dynamic-construct-narrowed"), JSON.stringify(result.rules));
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

// v0.4.0：动态目标的候选集也要当路径判。`cats $x` 这种目标（target 是 `$x`，补不出路径）
// 以前只能漏；候选里明明写着 `~/.ssh/id_rsa` 就写在眼前。逐个候选跑同一套黑名单规则，
// 命中就拦——方向只会更严：候选是「其中之一」，不是在拿可能性当事实。
describe("路径判定：动态目标的候选集（v0.4.0）", () => {
  const candidateReport = (kind: string, candidates: string[]) => ({
    version: 1,
    status: "Complete",
    impact: {
      effects: [
        { kind: "Exec", target: "cat", vars: [], candidates: [], dynamic: false, modeled: true, line: 1 },
        { kind, target: "$x", vars: ["x"], candidates, dynamic: true, modeled: true, line: 1 },
      ],
      write_roots: [],
      uncertain: true,
      effects_dropped: 0,
      vars: ["x"],
      cwd: "/tmp",
    },
    issues: [],
    issues_dropped: 0,
  });

  it("候选里有敏感路径 → 命中（改动前只拿 $x 判，什么都看不见）", () => {
    // 改动前的行为先摆出来：`$x` 这个原值配不上任何一条黑名单规则，所以只有它的时候是漏的
    assert.equal(pathBlocked("$x", "/tmp", loadBlacklist()), false, "原值本来就匹配不上（不是回归）");
    // 赋值那一段带引号：未引号 token 层不看它（那是引号里的字符串），所以这条命令里
    // 敏感路径只有 preshell 的候选集一个来源——命中与否全是这一条改动的功劳
    const command = "if c; then x='/work/project/.env'; else x=/tmp/ok; fi; cat $x";
    assert.deepEqual(unquotedPathTokens(command), ["x=/tmp/ok"], "引号里的那个不当 token（给下面的结论当基准）");
    const bin = stubPreshell(candidateReport("Read", ["/work/project/.env", "/tmp/ok"]));
    withStubPreshell(bin, () => {
      // 默认 block：直接拒
      const blocked = checkCommand(command, { cwd: "/tmp" });
      assert.equal(blocked.allow, false, "候选里的 .env 得拦下来");
      assert.match(blocked.reason ?? "", /敏感路径黑名单/);
      // ask：命中项交给审批窗，token 是那个候选值（让人一眼看到是哪个候选命中的）
      const asked = checkCommand(command, { cwd: "/tmp", sensitivePaths: "ask" });
      const hits = asked.sensitive ?? [];
      assert.equal(hits.length, 1, JSON.stringify(hits));
      assert.equal(hits[0].token, "/work/project/.env");
      assert.equal(hits[0].via, "preshell");
      assert.match(hits[0].pattern, /env/);
    });
  });

  it("候选全安全 → 不报（候选不会凭空造出误报）", () => {
    const command = "if c; then x=/tmp/a; else x=/tmp/b; fi; cat $x";
    const bin = stubPreshell(candidateReport("Read", ["/tmp/a", "/tmp/b"]));
    withStubPreshell(bin, () => {
      const result = checkCommand(command, { cwd: "/tmp" });
      assert.equal(result.allow, true, `不该拦：${result.reason ?? ""}`);
    });
  });

  it("候选命中写/删目标同样算（不只读）", () => {
    const command = "if c; then x='/work/project/.env'; else x=/tmp/ok; fi; rm $x";
    const bin = stubPreshell(candidateReport("Delete", ["/work/project/.env", "/tmp/ok"]));
    withStubPreshell(bin, () => {
      const result = checkCommand(command, { cwd: "/tmp" });
      assert.equal(result.allow, false);
      assert.match(result.reason ?? "", /敏感路径黑名单/);
      const asked = checkCommand(command, { cwd: "/tmp", sensitivePaths: "ask" });
      assert.equal((asked.sensitive ?? []).length, 1, JSON.stringify(asked.sensitive));
    });
  });

  it("旧版二进制没有 candidates：行为与接入前一致（$x 照旧匹配不上）", () => {
    const bin = stubPreshell({
      version: 1,
      status: "Complete",
      impact: {
        effects: [{ kind: "Read", target: "$x", vars: ["x"], dynamic: true, modeled: true, line: 1 }],
        write_roots: [],
        uncertain: true,
        effects_dropped: 0,
        vars: ["x"],
        cwd: "/tmp",
      },
      issues: [],
      issues_dropped: 0,
    });
    withStubPreshell(bin, () => {
      const result = checkCommand("cat $x", { cwd: "/tmp" });
      assert.equal(result.facts?.effects[0]?.candidates, undefined, "旧报告连字段都没有");
      assert.equal(result.allow, true, "没有候选可供判定时保持原样（不凭一个 $x 造命中）");
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

describe("summarizeTokens：审批提示里的 token 摘要", () => {
  it("少量且短的照原样列出来", () => {
    assert.equal(summarizeTokens(["$P", "eval"]), "$P、eval");
  });

  it("条数封顶，剩下的用总数交代", () => {
    assert.equal(summarizeTokens(["a", "b", "c", "d", "e"]), "a、b、c、d 等 5 项");
  });

  it("单个 token 超长要截断，多行要折平", () => {
    const out = summarizeTokens([`$(printf '%s\n' ${"x".repeat(60)})`], 4, 20);
    assert.ok(out.endsWith("…"), `应截断，实得 ${out}`);
    assert.ok(out.length <= 21, `长度应受限，实得 ${out.length}`);
    assert.ok(!out.includes("\n"), "不该把换行带进提示");
  });
});
