// lib/preshell.test.ts — 事实层适配（子进程调用、契约校验、缓存、失败降级）
//
// 跑法：node --experimental-strip-types lib/preshell.test.ts
//
// 这里用替身脚本而不是真二进制：真实产物换版本时这些用例不该跟着红。
// 真二进制的行为由 lib/sandbox-check.test.ts 与 scripts/preshell-shadow.ts 覆盖。

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  analyzeCommand,
  BREAKER_TRANSIENT_THRESHOLD,
  clearPreshellCache,
  describeUnavailable,
  formatFacts,
  INSTALL_HINT,
  loadPreshellConfig,
  notifyFactLayerUnavailable,
  preshellBreakerState,
  reportFactLayerState,
  resetFactLayerNotices,
  resetPreshellBreaker,
  resetPreshellVersionCache,
  resolvePath,
  resolvePreshellBin,
  substituteVariables,
  type PreshellConfig,
} from "./preshell.ts";

const dir = mkdtempSync(join(tmpdir(), "preshell-stub-"));
// 模块级状态（缓存/版本探测/熔断/提示去重）在用例之间必须清干净，否则互相带节奏
beforeEach(() => {
  clearPreshellCache();
  resetPreshellVersionCache();
  resetPreshellBreaker();
  resetFactLayerNotices();
  // 测试里不许真往桌面弹：默认路径也可能被走到（比如 checkCommand 的降级分支）
  process.env.PI_NO_DESKTOP_NOTIFY = "1";
});
after(() => {
  clearPreshellCache();
  resetPreshellVersionCache();
  resetPreshellBreaker();
  resetFactLayerNotices();
});

/** 造一个替身脚本；body 里能用 $PRESHELL_STUB_LOG 记调用次数 */
function stub(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

const OK_REPORT = JSON.stringify({
  version: 1,
  status: "Complete",
  impact: {
    effects: [
      { kind: "Exec", target: "cat", modeled: true, dynamic: false, line: 1 },
      { kind: "Read", target: "providers.toml", modeled: true, dynamic: false, line: 1 },
      { kind: "Exec", target: "node", modeled: false, dynamic: false, line: 1 },
      { kind: "Net", target: "https://example.com", modeled: true, dynamic: false, line: 2 },
    ],
    write_roots: [],
    uncertain: true,
    cwd: "/work",
  },
});

const VERSION_OK = `case "$1" in --version) printf '%s' '{"tool":"preshell","version":"9.9.9","schema":1}'; exit 0 ;; esac`;

function configFor(bin: string, over: Partial<PreshellConfig> = {}): PreshellConfig {
  return { enabled: true, bin, timeoutMs: 2000, schema: 1, ...over };
}

describe("analyzeCommand", () => {
  it("正常报告 → facts（效果/未建模/网络/cwd/uncertain）", () => {
    const bin = stub("ok.sh", `${VERSION_OK}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("cat providers.toml", { config: configFor(bin) });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.version, "9.9.9");
    assert.equal(outcome.facts.status, "Complete");
    assert.equal(outcome.facts.uncertain, true);
    assert.equal(outcome.facts.cwd, "/work");
    assert.deepEqual(outcome.facts.unmodeled, ["node"]);
    assert.deepEqual(outcome.facts.net, ["https://example.com"]);
    assert.equal(outcome.facts.effects.length, 4);
  });

  it("把调用方给的 cwd 传成 --cwd=<绝对路径>", () => {
    const log = join(dir, "args.log");
    const bin = stub("args.sh", `${VERSION_OK}\nprintf '%s\\n' "$*" >> "${log}"\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    analyzeCommand("cat providers.toml", { config: configFor(bin), cwd: "/work" });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "只应起一次子进程（--version 那次不走这条分支）");
    assert.match(lines[0], /--shell=probe/);
    assert.match(lines[0], /--cwd=\/work/);
  });

  it("没给 cwd 就不传 --cwd：工具会自己推演基准并置 uncertain（我们不替它编一个）", () => {
    const log = join(dir, "nocwd.log");
    const bin = stub("nocwd.sh", `${VERSION_OK}\nprintf '%s\\n' "$*" >> "${log}"\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    analyzeCommand("ls", { config: configFor(bin) });
    assert.ok(!/--cwd/.test(readFileSync(log, "utf8")), "没给基准就不能替调用方编一个");
  });

  it("cwd 不是绝对路径：不塞给工具（那会直接是用法错误、退出码 2），原值记进 cwdRejected", () => {
    const log = join(dir, "relcwd.log");
    const bin = stub("relcwd.sh", `${VERSION_OK}\nprintf '%s\\n' "$*" >> "${log}"\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("ls", { config: configFor(bin), cwd: "lib/sub" });
    assert.ok(!/--cwd/.test(readFileSync(log, "utf8")), "相对值不能塞给工具");
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.facts.cwdRejected, "lib/sub");
  });

  it("缓存按 cwd 分辨：同一条命令在不同目录里跑要各问一次", () => {
    const log = join(dir, "bothcwd.log");
    const bin = stub("bothcwd.sh", `${VERSION_OK}\nprintf '%s\\n' "$*" >> "${log}"\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const config = configFor(bin);
    analyzeCommand("ls", { config, cwd: "/a" });
    analyzeCommand("ls", { config, cwd: "/b" });
    analyzeCommand("ls", { config, cwd: "/a" });
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
  });

  it("facts 里能拿到 vars 并集与每条路径的收尾结果", () => {
    const report = JSON.stringify({
      version: 1,
      status: "Complete",
      impact: {
        effects: [
          { kind: "Exec", target: "cat", vars: [], dynamic: false, modeled: true, line: 1 },
          { kind: "Read", target: "$HOME/.ssh/id_rsa", vars: ["HOME"], dynamic: true, modeled: true, line: 1 },
          { kind: "Read", target: "providers.toml", vars: [], dynamic: false, modeled: true, line: 1 },
          { kind: "Read", target: "$1/x", vars: [], dynamic: true, modeled: true, line: 1 },
        ],
        write_roots: [],
        uncertain: true,
        vars: ["HOME"],
        cwd: "/work",
      },
    });
    const bin = stub("settle.sh", `${VERSION_OK}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("cat $HOME/.ssh/id_rsa providers.toml $1/x", {
      config: configFor(bin),
      cwd: "/work",
      env: { HOME: "/home/u" },
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.facts.vars, ["HOME"]);
    assert.deepEqual(
      outcome.facts.settledPaths.map((item) => [item.path, item.known]),
      [
        ["/home/u/.ssh/id_rsa", true],
        ["/work/providers.toml", true],
        ["$1/x", false],
      ],
    );
    assert.match(outcome.facts.settledPaths[2].reason ?? "", /补不上/);
  });

  it("$PWD / ~+ 用报告回的基准（命令内部 cd 过就是 cd 之后那个），不用 pi 进程的 PWD", () => {
    const report = JSON.stringify({
      version: 1,
      status: "Complete",
      impact: {
        effects: [
          { kind: "Exec", target: "cat", vars: [], dynamic: false, modeled: true, line: 1 },
          { kind: "Read", target: "~+/x", vars: ["PWD"], dynamic: true, modeled: true, line: 1 },
          { kind: "Read", target: "$PWD/y", vars: ["PWD"], dynamic: true, modeled: true, line: 1 },
        ],
        write_roots: [],
        uncertain: true,
        vars: ["PWD"],
        cwd: "/cd-base",
        effects_dropped: 0,
      },
    });
    const bin = stub("pwd.sh", `${VERSION_OK}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("cd /cd-base && cat ~+/x $PWD/y", {
      config: configFor(bin),
      cwd: "/start",
      env: { PWD: "/pi-process" },
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(
      outcome.facts.settledPaths.map((item) => item.path),
      ["/cd-base/x", "/cd-base/y"],
    );
  });

  it("工具没给出基准时 $PWD 当未设：保留原值，不拿 pi 进程的 PWD 冒名", () => {
    const report = JSON.stringify({
      version: 1,
      status: "Complete",
      impact: {
        effects: [{ kind: "Read", target: "$PWD/x", vars: ["PWD"], dynamic: true, modeled: true, line: 1 }],
        write_roots: [],
        uncertain: true,
        vars: ["PWD"],
        effects_dropped: 0,
      },
    });
    const bin = stub("nopwd.sh", `${VERSION_OK}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("cd $DIR && cat $PWD/x", {
      config: configFor(bin),
      cwd: "/start",
      env: { PWD: "/pi-process" },
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.facts.settledPaths[0], {
      effect: outcome.facts.settledPaths[0].effect,
      path: "$PWD/x",
      known: false,
      reason: "PWD 未设",
    });
  });

  it("同一条命令只起一次子进程（缓存）", () => {
    const log = join(dir, "calls.log");
    const bin = stub("count.sh", `${VERSION_OK}\necho x >> "${log}"\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const config = configFor(bin);
    analyzeCommand("echo cached", { config });
    analyzeCommand("echo cached", { config });
    analyzeCommand("echo cached", { config });
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
  });

  it("契约版本不符 → schema 不可用（不猜）", () => {
    const bin = stub("schema.sh", `printf '%s' '{"tool":"preshell","version":"9.9.9","schema":7}'; exit 0`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("ls", { config: configFor(bin, { schema: 1 }) });
    assert.deepEqual(outcome, { ok: false, reason: "schema", detail: "工具报 schema=7，期望 1" });
  });

  it("缺二进制 → missing（调用方据此走保守兜底）", () => {
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("ls", { config: configFor(join(dir, "没有这个文件")) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "missing");
  });

  it("stdout 不是 JSON → bad-json", () => {
    const bin = stub("badjson.sh", `${VERSION_OK}\ncat >/dev/null\nprintf '这不是 JSON'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("ls", { config: configFor(bin) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "bad-json");
  });

  it("退出码非 0 → exit", () => {
    const bin = stub("exit.sh", `${VERSION_OK}\ncat >/dev/null\nexit 3`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("ls", { config: configFor(bin) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "exit");
  });

  it("卡住的子进程被超时切断，不当成放行", () => {
    const bin = stub("slow.sh", `${VERSION_OK}\ncat >/dev/null\nsleep 5\nprintf '{}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("ls", { config: configFor(bin, { timeoutMs: 200 }) });
    assert.equal(outcome.ok, false, "超时必须算不可用");
    if (!outcome.ok) assert.ok(["timeout", "exit"].includes(outcome.reason), `实际 ${outcome.reason}`);
  });

  it("配置关闭 / 非有限值：enabled=false 直接返回 disabled", () => {
    clearPreshellCache();
    const outcome = analyzeCommand("ls", { config: configFor("preshell", { enabled: false }) });
    assert.deepEqual(outcome, { ok: false, reason: "disabled" });
  });
});

describe("熔断：卡住或崩掉的二进制不能把每次审计都拖成超时", () => {
  it("瞬时失败（非零退出）要连续到阈值才断，原因保留首次的", () => {
    const log = join(dir, "breaker.log");
    const bin = stub("breaker.sh", `${VERSION_OK}\necho x >> "${log}"\ncat >/dev/null\nexit 1`);
    clearPreshellCache();
    resetPreshellVersionCache();
    resetPreshellBreaker();
    const config = configFor(bin);

    // 阈值之前：每次都会去 spawn
    for (let i = 1; i < BREAKER_TRANSIENT_THRESHOLD; i++) {
      const outcome = analyzeCommand(`echo cmd-${i}`, { config });
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.reason, "exit");
      assert.equal(preshellBreakerState().broken, undefined, `第 ${i} 次不该已熔断`);
    }
    const beforeTrip = readFileSync(log, "utf8").trim().split("\n").length;

    // 第 5 次：断
    analyzeCommand("echo cmd-trip", { config });
    assert.equal(preshellBreakerState().broken, "exit");
    const afterTrip = readFileSync(log, "utf8").trim().split("\n").length;
    assert.equal(afterTrip, beforeTrip + 1);

    // 断后不再 spawn
    const after = analyzeCommand("echo another", { config });
    assert.equal(after.ok, false);
    if (!after.ok) assert.match(after.detail ?? "", /熔断/);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, afterTrip);

    // 重置后重试
    resetPreshellBreaker();
    analyzeCommand("echo retry", { config });
    assert.ok(readFileSync(log, "utf8").trim().split("\n").length > afterTrip);
    resetPreshellBreaker();
  });

  it("确定性失败（缺件/schema）一次就断，不再白白 spawn", () => {
    clearPreshellCache();
    resetPreshellVersionCache();
    resetPreshellBreaker();
    const config = configFor(join(dir, "根本没有这个文件"));
    const first = analyzeCommand("echo a", { config });
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.reason, "missing");
    assert.equal(preshellBreakerState().broken, "missing");
    const second = analyzeCommand("echo b", { config });
    if (!second.ok) assert.match(second.detail ?? "", /熔断/);
    resetPreshellBreaker();
  });

  it("成功一次就把失败计数清零（偶发超时不该熔断）", () => {
    const bin = stub("flaky.sh", `${VERSION_OK}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    resetPreshellBreaker();
    const outcome = analyzeCommand("cat providers.toml", { config: configFor(bin) });
    assert.equal(outcome.ok, true);
    assert.deepEqual(preshellBreakerState(), { broken: undefined, failures: 0 });
  });
});

describe("缺件提示（人看的）", () => {
  it("describeUnavailable 说清是什么毛病", () => {
    assert.match(describeUnavailable("missing"), /未安装或路径不对/);
    assert.match(describeUnavailable("schema", "工具报 schema=7"), /契约版本不符（工具报 schema=7）/);
    assert.match(describeUnavailable("disabled"), /enabled=false/);
  });

  it("INSTALL_HINT 给出可粘贴的安装命令，并写明没装也能用", () => {
    // 版本号写死在提示里，所以升级的时候这里会红：这是故意的，提示里那串命令必须是真的
    assert.match(INSTALL_HINT, /gh release download v0\.3\.0 -R conglinyizhi\/preshell/);
    assert.match(INSTALL_HINT, /install -Dm755 \/tmp\/p\/preshell-v0\.3\.0-x86_64-linux/);
    assert.match(INSTALL_HINT, /moon build --release --target native/);
    assert.match(INSTALL_HINT, /退回旧的匹配规则/);
  });

  it("同一个原因只弹一次，但状态标一直挂着；恢复后收掉", () => {
    const notified: string[] = [];
    const statuses: Array<[string, string | undefined]> = [];
    const desktops: Array<[string, string]> = [];
    const ui = {
      notify: (message: string) => void notified.push(message),
      setStatus: (key: string, text?: string) => void statuses.push([key, text]),
    };
    const deps = { desktopNotify: (title: string, message: string) => void desktops.push([title, message]) };
    resetFactLayerNotices();

    const first = notifyFactLayerUnavailable(ui, "missing", undefined, deps);
    assert.match(first, /命令审核事实层不可用/);
    assert.match(first, /未安装或路径不对/);
    assert.equal(notified.length, 1);
    assert.deepEqual(statuses.at(-1), ["preshell", "✗ 事实层 missing"]);
    assert.equal(desktops.length, 1, "可动手解决的原因要弹一条桌面通知");
    assert.match(desktops[0][1], /退回旧规则/);

    notifyFactLayerUnavailable(ui, "missing", undefined, deps);
    assert.equal(notified.length, 1, "同一原因不重复弹");
    assert.equal(desktops.length, 1, "桌面也只要一条");

    notifyFactLayerUnavailable(ui, "timeout", "2s", deps);
    assert.equal(notified.length, 2, "换了原因应当再说一次");
    assert.equal(desktops.length, 1, "瞬时超时不打扰桌面");

    reportFactLayerState(ui, undefined);
    assert.deepEqual(statuses.at(-1), ["preshell", undefined], "恢复后收掉状态");
    resetFactLayerNotices();
  });

  it("reportFactLayerState：带原因就提醒，不带就只收状态", () => {
    const notified: string[] = [];
    const statuses: Array<string | undefined> = [];
    const ui = {
      notify: (message: string) => void notified.push(message),
      setStatus: (_key: string, text?: string) => void statuses.push(text),
    };
    resetFactLayerNotices();
    reportFactLayerState(ui, "bad-json");
    assert.equal(notified.length, 1);
    assert.equal(statuses.at(-1), "✗ 事实层 bad-json");
    reportFactLayerState(ui, undefined);
    assert.equal(statuses.at(-1), undefined);
    resetFactLayerNotices();
  });
});

describe("配置与二进制解析", () => {
  it("读 extensions.toml 的 [preshell]，读不到用缺省（启用 + ~/.pi/runtime/preshell）", () => {
    const cfg = loadPreshellConfig("/nonexistent/extensions.toml");
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.bin, "~/.pi/runtime/preshell");
    assert.equal(cfg.schema, 1);
  });

  it("超时阈值：默认 100ms，够跑完病态输入（实测 1MB heredoc 18ms）", () => {
    assert.equal(loadPreshellConfig().timeoutMs, 100);
  });

  it("读本仓真实配置：启用且指向 runtime 下的二进制", () => {
    const cfg = loadPreshellConfig();
    assert.equal(cfg.enabled, true);
    assert.match(cfg.bin, /preshell$/);
    assert.ok(resolvePreshellBin(cfg).startsWith("/"), "解析后应是绝对路径");
  });

  it("PRESHELL_BIN 覆盖配置（他们的文档推荐这个变量名）", () => {
    const saved = process.env.PRESHELL_BIN;
    process.env.PRESHELL_BIN = "/tmp/stub-preshell";
    try {
      assert.equal(resolvePreshellBin(configFor("~/.pi/runtime/preshell")), "/tmp/stub-preshell");
    } finally {
      if (saved === undefined) delete process.env.PRESHELL_BIN;
      else process.env.PRESHELL_BIN = saved;
    }
  });
});

describe("formatFacts", () => {
  it("把事实压成短文本：程序/读/写/网络/未建模/解析状态", () => {
    const bin = stub("facts.sh", `${VERSION_OK}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("cat providers.toml", { config: configFor(bin) });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const text = formatFacts(outcome.facts);
    assert.match(text, /- 程序：cat node/);
    assert.match(text, /- 读：providers\.toml/);
    assert.match(text, /- 网络：https:\/\/example\.com/);
    assert.match(text, /未建模程序/);
    assert.match(text, /uncertain/);
  });

  // 变量渲染：命令名位置上的 `$P` 单看判不出跑的是什么，模型看不到展开那一步
  it("程序行就地标注渲染值，并附一张变量表", () => {
    const report = JSON.stringify({
      version: 1,
      status: "Complete",
      impact: {
        effects: [
          { kind: "Exec", target: "$P", vars: ["P"], dynamic: true, modeled: true, line: 1 },
          { kind: "Read", target: "/tmp/f.json", vars: [], dynamic: false, modeled: true, line: 1 },
        ],
        write_roots: [],
        uncertain: true,
        effects_dropped: 0,
        vars: ["P"],
        cwd: "/tmp",
      },
      issues: [],
      issues_dropped: 0,
    });
    const bin = stub("facts-var.sh", `${VERSION_OK}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const command = "cd /tmp && P=/usr/bin/jq && $P --version";
    const outcome = analyzeCommand(command, { config: configFor(bin) });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    // 命令原文随事实一起带出：变量渲染要它（调用方不必再传一遍）
    assert.equal(outcome.facts.command, command);
    const text = formatFacts(outcome.facts);
    assert.match(text, /- 程序：\$P（\/usr\/bin\/jq）/);
    assert.match(text, /- 变量：P=\/usr\/bin\/jq（本命令内赋值）/);
  });

  it("渲不出来时在程序行里给出原因，变量表同样带原因", () => {
    const report = JSON.stringify({
      version: 1,
      status: "Complete",
      impact: {
        effects: [{ kind: "Exec", target: "$P", vars: ["P"], dynamic: true, modeled: true, line: 1 }],
        write_roots: [],
        uncertain: true,
        effects_dropped: 0,
        vars: ["P"],
        cwd: "/tmp",
      },
      issues: [],
      issues_dropped: 0,
    });
    const bin = stub("facts-var-unknown.sh", `${VERSION_OK}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("P=$(which jq) && $P --version", { config: configFor(bin) });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const text = formatFacts(outcome.facts);
    assert.match(text, /- 程序：\$P（渲不出：值里含命令替换/);
    assert.match(text, /- 变量：P（渲不出：值里含命令替换/);
  });

  it("命令里没有变量引用时不出变量表（旧输出的其余部分不变）", () => {
    const bin = stub("facts-novar.sh", `${VERSION_OK}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellVersionCache();
    const outcome = analyzeCommand("cat providers.toml", { config: configFor(bin) });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.doesNotMatch(formatFacts(outcome.facts), /- 变量：/);
  });
});

// v0.3.0：工具把「要替换哪些名字」交出来，替换由我们做（环境在我们手上）。
// 这一组是纯函数，不碰子进程：边界都在这儿定，调用侧只管把 vars 报出来的名字查一遍。
describe("变量收尾（substituteVariables / resolvePath）", () => {
  const env = { HOME: "/home/u", PWD: "/work/a", OLDPWD: "/old" };

  it("$HOME/x、${HOME}y、~/x、单独的 ~ 都补成绝对路径", () => {
    assert.deepEqual(resolvePath({ target: "$HOME/x", vars: ["HOME"], dynamic: true }, env, "/work"), {
      known: true,
      path: "/home/u/x",
    });
    assert.deepEqual(resolvePath({ target: "${HOME}y", vars: ["HOME"], dynamic: true }, env, "/work"), {
      known: true,
      path: "/home/uy",
    });
    assert.deepEqual(resolvePath({ target: "~/x", vars: ["HOME"], dynamic: true }, env, "/work"), {
      known: true,
      path: "/home/u/x",
    });
    assert.deepEqual(resolvePath({ target: "~", vars: ["HOME"], dynamic: true }, env, "/work"), {
      known: true,
      path: "/home/u",
    });
  });

  it("~+/x 用 PWD、~-/x 用 OLDPWD（名字由报告给）", () => {
    assert.deepEqual(resolvePath({ target: "~+/x", vars: ["PWD"], dynamic: true }, env, "/work"), {
      known: true,
      path: "/work/a/x",
    });
    assert.deepEqual(resolvePath({ target: "~-/x", vars: ["OLDPWD"], dynamic: true }, env, "/work"), {
      known: true,
      path: "/old/x",
    });
  });

  it("~someone/x、~3、~+3：走口令库与目录栈，环境里没有，保持原样", () => {
    for (const target of ["~someone/x", "~3", "~+3"]) {
      const resolved = resolvePath({ target, vars: [], dynamic: true }, env, "/work");
      assert.equal(resolved.known, false, `${target} 不该被补成路径`);
      if (!resolved.known) assert.match(resolved.reason, /补不上/);
    }
    // 即便环境里恰好有同名变量也不动它：替换只认 vars 报出来的名字
    const sneaky = resolvePath({ target: "~someone/x", vars: [], dynamic: true }, { ...env, someone: "/s" }, "/work");
    assert.equal(sneaky.known, false);
  });

  it("$1 / $@：位置参数不在环境里", () => {
    for (const target of ["$1/x", "$@"]) {
      const resolved = resolvePath({ target, vars: [], dynamic: true }, env, "/work");
      assert.equal(resolved.known, false, `${target} 补不上就是补不上`);
    }
  });

  it("dynamic: false（带引号的 '$HOME/x' 这种字面量）不做替换", () => {
    assert.deepEqual(resolvePath({ target: "/work/$HOME/x", vars: [], dynamic: false }, env, "/work"), {
      known: true,
      path: "/work/$HOME/x",
    });
  });

  it("变量没设 → 保留原样并说清原因（不拿空串拼一个出来）", () => {
    assert.deepEqual(resolvePath({ target: "$FOO/x", vars: ["FOO"], dynamic: true }, env, "/work"), {
      known: false,
      reason: "FOO 未设",
    });
    assert.deepEqual(resolvePath({ target: "~/x", vars: ["HOME"], dynamic: true }, {}, "/work"), {
      known: false,
      reason: "HOME 未设",
    });
  });

  it("值本身是相对路径：先替换、再拿基准收一下（顺序不能反）", () => {
    assert.deepEqual(resolvePath({ target: "$HOME/x", vars: ["HOME"], dynamic: true }, { HOME: "rel" }, "/work"), {
      known: true,
      path: "/work/rel/x",
    });
  });

  it("替换是字面的：值里的 $ 与反斜杠原样落地，不当替换模板", () => {
    // 字符串形式的替换值会把 $& / $` 展开成「匹配到的那段」与「匹配之后的那段」：
    // 那等于把环境变量的内容当模板跑，所以实现里一律传函数
    assert.deepEqual(substituteVariables("$HOME/x", ["HOME"], { HOME: "/a/$&/b" }), { ok: true, text: "/a/$&/b/x" });
    assert.deepEqual(substituteVariables("${HOME}/x", ["HOME"], { HOME: "/a/$`/b" }), { ok: true, text: "/a/$`/b/x" });
    assert.deepEqual(substituteVariables("$HOME/x", ["HOME"], { HOME: "/a/$1/b" }), { ok: true, text: "/a/$1/b/x" });
    assert.deepEqual(substituteVariables("$HOME/x", ["HOME"], { HOME: "/a\\b" }), { ok: true, text: "/a\\b/x" });
    // 值里带 $ 的收尾结果是不确定（那是个补不上的洞），不是我们编出来的路径
    const resolved = resolvePath({ target: "$HOME/x", vars: ["HOME"], dynamic: true }, { HOME: "/a/$&/b" }, "/work");
    assert.equal(resolved.known, false);
  });

  it("只认 vars 里的名字：$HOMEfoo 不会被当成 $HOME 加个 foo", () => {
    assert.deepEqual(substituteVariables("$HOMEfoo/x", ["HOMEfoo"], { HOMEfoo: "/h" }), { ok: true, text: "/h/x" });
    const resolved = resolvePath(
      { target: "$HOMEfoo/x", vars: ["HOMEfoo"], dynamic: true },
      { HOME: "/home/u", HOMEfoo: "/h" },
      "/work",
    );
    assert.deepEqual(resolved, { known: true, path: "/h/x" });
  });
});
