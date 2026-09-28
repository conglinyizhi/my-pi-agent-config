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
  ADVISORY_CAPABILITIES,
  analyzeCommand,
  BREAKER_TRANSIENT_THRESHOLD,
  capabilityFailureDetail,
  checkCapabilities,
  clearPreshellCache,
  compatVersion,
  describeUnavailable,
  EXPECTED_VERSION,
  formatFacts,
  INSTALL_HINT,
  KNOWN_VERSION,
  knownVersionOf,
  loadPreshellConfig,
  notifyFactLayerUnavailable,
  preshellBreakerState,
  preshellSpecState,
  queryPreshellSpec,
  reportFactLayerState,
  REQUIRED_CAPABILITIES,
  resetFactLayerNotices,
  resetPreshellBreaker,
  resetPreshellSpecCache,
  resolvePath,
  resolvePreshellBin,
  substituteVariables,
  type PreshellConfig,
} from "./preshell.ts";

const dir = mkdtempSync(join(tmpdir(), "preshell-stub-"));
// 模块级状态（缓存/能力探测/熔断/提示去重）在用例之间必须清干净，否则互相带节奏
beforeEach(() => {
  clearPreshellCache();
  resetPreshellSpecCache();
  resetPreshellBreaker();
  resetFactLayerNotices();
  // 测试里不许真往桌面弹：默认路径也可能被走到（比如 checkCommand 的降级分支）
  process.env.PI_NO_DESKTOP_NOTIFY = "1";
});
after(() => {
  clearPreshellCache();
  resetPreshellSpecCache();
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

/**
 * --spec 替身（默认是 v0.6.0 那份能力齐全的清单）：
 *   drop 里写要删掉的位置（顶层键 "tool"，或点号路径 "paths.candidates"），
 *   "modes.stream" 特指把 stream 那条模式从 modes 里拿掉。
 * 只答 --spec，不再答 --version：可用性判据已经是能力清单，不是版本号。
 */
function specJson(version = "0.6.0", drop: string[] = []): string {
  const spec: Record<string, unknown> = {
    tool: "preshell",
    version,
    doc: "https://example.invalid/integration.md",
    one_line: "Reports what a shell command touches. Facts, not a verdict.",
    modes: [
      { name: "single", stdin: "one shell command", stdout: "exactly one JSON report" },
      { name: "stream", flag: "--stream", stdin: "one request per line", stdout: "one answer per line" },
    ],
    exit_codes: { "0": "the answers were produced", "2": "usage error", other: "the tool itself failed", note: "…" },
    refusal: { shape: '{"error":"...","line":N}', means: "the line was not a request", note: "…" },
    client_obligations: ["serialize writes to stdin"],
    paths: {
      base: "pass --cwd=PATH (absolute)",
      vars: "every effect carries vars",
      required: "--cwd is required by this contract",
      always_absolute: "paths are reported absolute",
      cd_scope: "cd affects the rest of the same command line",
      no_base: "after a cd whose destination cannot be modelled…",
      origin: "an effect whose target came from a value the command line set…",
      payload: "an Exec/Spawn may carry payload…",
      candidates: "an effect may carry candidates…",
    },
  };
  if (drop.includes("modes.stream")) {
    spec.modes = (spec.modes as Array<{ name?: string }>).filter((mode) => mode.name !== "stream");
  }
  // refusal.error / refusal.line 是「shape 里写了这个字段」：模拟缺项要改写那句描述，
  // 不是删一个叫 error 的键（真产物里 shape 是字符串）
  const refusal = spec.refusal as { shape: string };
  if (drop.includes("refusal.error")) refusal.shape = refusal.shape.replace('"error"', '"reason"');
  if (drop.includes("refusal.line")) refusal.shape = refusal.shape.replace(',"line":N', "");
  for (const path of drop) {
    if (path === "modes.stream" || path.startsWith("refusal.")) continue;
    const [head, tail] = path.split(".");
    if (tail === undefined) delete spec[head];
    else delete (spec[head] as Record<string, unknown>)[tail];
  }
  return JSON.stringify(spec);
}

/** 替身脚本里那段答 --spec 的 case 分支 */
function specCase(version = "0.6.0", drop: string[] = []): string {
  return `case "$1" in --spec) printf '%s' '${specJson(version, drop)}'; exit 0 ;; esac`;
}

const SPEC_OK = specCase();
// 同一能力的另一个修订号：版本号不再影响判定，也不该影响
const SPEC_061 = specCase("0.6.1");

function configFor(bin: string, over: Partial<PreshellConfig> = {}): PreshellConfig {
  return { enabled: true, bin, timeoutMs: 2000, knownVersion: "0.6", ...over };
}

describe("analyzeCommand", () => {
  it("正常报告 → facts（效果/未建模/网络/cwd/uncertain）", () => {
    const bin = stub("ok.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const outcome = analyzeCommand("cat providers.toml", { config: configFor(bin) });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.version, "0.6.0");
    assert.equal(outcome.facts.status, "Complete");
    assert.equal(outcome.facts.uncertain, true);
    assert.equal(outcome.facts.cwd, "/work");
    assert.deepEqual(outcome.facts.unmodeled, ["node"]);
    assert.deepEqual(outcome.facts.net, ["https://example.com"]);
    assert.equal(outcome.facts.effects.length, 4);
  });

  it("把调用方给的 cwd 传成 --cwd=<绝对路径>", () => {
    const log = join(dir, "args.log");
    const bin = stub("args.sh", `${SPEC_OK}\nprintf '%s\\n' "$*" >> "${log}"\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    analyzeCommand("cat providers.toml", { config: configFor(bin), cwd: "/work" });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "只应起一次子进程（--version 那次不走这条分支）");
    assert.match(lines[0], /--shell=probe/);
    assert.match(lines[0], /--cwd=\/work/);
  });

  it("没给 cwd 就不传 --cwd：工具会自己推演基准并置 uncertain（我们不替它编一个）", () => {
    const log = join(dir, "nocwd.log");
    const bin = stub("nocwd.sh", `${SPEC_OK}\nprintf '%s\\n' "$*" >> "${log}"\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    analyzeCommand("ls", { config: configFor(bin) });
    assert.ok(!/--cwd/.test(readFileSync(log, "utf8")), "没给基准就不能替调用方编一个");
  });

  it("cwd 不是绝对路径：不塞给工具（那会直接是用法错误、退出码 2），原值记进 cwdRejected", () => {
    const log = join(dir, "relcwd.log");
    const bin = stub("relcwd.sh", `${SPEC_OK}\nprintf '%s\\n' "$*" >> "${log}"\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const outcome = analyzeCommand("ls", { config: configFor(bin), cwd: "lib/sub" });
    assert.ok(!/--cwd/.test(readFileSync(log, "utf8")), "相对值不能塞给工具");
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.facts.cwdRejected, "lib/sub");
  });

  it("缓存按 cwd 分辨：同一条命令在不同目录里跑要各问一次", () => {
    const log = join(dir, "bothcwd.log");
    const bin = stub("bothcwd.sh", `${SPEC_OK}\nprintf '%s\\n' "$*" >> "${log}"\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
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
    const bin = stub("settle.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
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

  it("v0.4.0 的候选集原样带进 facts；旧报告没有这个字段就是 undefined", () => {
    const report = JSON.stringify({
      version: 1,
      status: "Complete",
      impact: {
        effects: [
          { kind: "Exec", target: "rm", vars: [], candidates: [], dynamic: false, modeled: true, line: 1 },
          {
            kind: "Delete",
            target: "$x",
            vars: ["x"],
            candidates: ["/a", "/b"],
            dynamic: true,
            modeled: true,
            line: 1,
          },
        ],
        write_roots: [],
        uncertain: true,
        vars: ["x"],
        cwd: "/work",
      },
    });
    const bin = stub("candidates.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const outcome = analyzeCommand("if c; then x=/a; else x=/b; fi; rm $x", { config: configFor(bin) });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.facts.effects[0].candidates, [], "空数组 = 无候选（字段在，但没得选）");
    assert.deepEqual(outcome.facts.effects[1].candidates, ["/a", "/b"]);
    // 候选是可能性不是事实：路径收尾依旧按 target 走（x 不在环境里就保留原值）
    assert.deepEqual(
      outcome.facts.settledPaths.map((item) => [item.path, item.known]),
      [["$x", false]],
    );

    // 旧版二进制（≤0.3.0）不报 candidates：字段就是 undefined，不是空数组
    const legacy = stub("candidates-legacy.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${JSON.stringify({
      status: "Complete",
      impact: { effects: [{ kind: "Delete", target: "$x", vars: ["x"], dynamic: true, line: 1 }], write_roots: [], uncertain: true, vars: ["x"], cwd: "/work" },
    })}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const old = analyzeCommand("rm $x", { config: configFor(legacy) });
    assert.equal(old.ok, true);
    if (old.ok) assert.equal(old.facts.effects[0].candidates, undefined);
  });

  it("v0.4.1 的 origin 原样带进 facts；旧报告（≤v0.4.0）没有这个字段就是 undefined", () => {
    const report = JSON.stringify({
      version: 1,
      status: "Complete",
      impact: {
        effects: [
          { kind: "Exec", target: "/usr/bin/jq", vars: [], candidates: [], origin: "$x", dynamic: false, modeled: false, line: 1 },
          { kind: "Exec", target: "cat", vars: [], candidates: [], dynamic: false, modeled: true, line: 1 },
        ],
        write_roots: [],
        uncertain: true,
        vars: [],
        cwd: "/tmp",
      },
    });
    const bin = stub("origin.sh", `${SPEC_061}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const outcome = analyzeCommand("x=/usr/bin/jq; $x -n 1", { config: configFor(bin) });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.version, "0.6.1", "能力齐全就放行，实测的修订号原样带出来");
    assert.equal(outcome.facts.effects[0].origin, "$x", "引用原文要原样带过来（对命令文本是纯文本比较）");
    assert.equal(outcome.facts.effects[0].target, "/usr/bin/jq", "target 仍是解出来的值，不是引用");
    assert.equal(outcome.facts.effects[1].origin, undefined, "target 就是词面本身时没有这个字段");

    // 旧版二进制（≤v0.4.0）不报 origin：字段就是 undefined，收窄那一侧要能当「没这回事」处理
    const legacy = stub("origin-legacy.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${JSON.stringify({
      status: "Complete",
      impact: { effects: [{ kind: "Exec", target: "$x", vars: ["x"], candidates: [], dynamic: true, line: 1 }], write_roots: [], uncertain: true, vars: ["x"], cwd: "/tmp" },
    })}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const old = analyzeCommand("x=/usr/bin/jq; $x -n 1", { config: configFor(legacy) });
    assert.equal(old.ok, true);
    if (old.ok) assert.equal(old.facts.effects[0].origin, undefined);
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
    const bin = stub("pwd.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
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
    const bin = stub("nopwd.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
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
    const bin = stub("count.sh", `${SPEC_OK}\necho x >> "${log}"\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const config = configFor(bin);
    analyzeCommand("echo cached", { config });
    analyzeCommand("echo cached", { config });
    analyzeCommand("echo cached", { config });
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
  });

  // 本次改动的核心价值：能力在就能用，不再因为版本号没见过而拒（上游每次加法都会升次版本号）
  it("能力清单齐全就放行，哪怕版本号从没见过（0.7.0 / 1.2.3 / 9.9.9）", () => {
    for (const version of ["0.7.0", "1.2.3", "9.9.9"]) {
      clearPreshellCache();
      resetPreshellSpecCache();
      const bin = stub(`spec-${version}.sh`, `${specCase(version)}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
      const outcome = analyzeCommand("ls", { config: configFor(bin) });
      assert.equal(outcome.ok, true, `${version} 能力齐全就该能用`);
      if (outcome.ok) assert.equal(outcome.version, version, "实测版本原样带出来（只作展示）");
    }
  });

  it("缺必需契约项 → capability 不可用，detail 点名缺了什么", () => {
    const cases = [
      "tool",
      "version",
      "modes.stream",
      "exit_codes.0",
      "exit_codes.2",
      "refusal.error",
      "refusal.line",
      "paths.base",
      "paths.required",
      "paths.vars",
      "paths.always_absolute",
      "paths.cd_scope",
      "paths.no_base",
      "paths.origin",
      "paths.candidates",
    ];
    for (const drop of cases) {
      clearPreshellCache();
      resetPreshellSpecCache();
      resetPreshellBreaker(); // 缺能力是确定性失败，会立刻熔断：每轮先把熔断清掉
      const bin = stub(`missing-${drop.replace(".", "-")}.sh`, `${specCase("0.6.0", [drop])}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
      const outcome = analyzeCommand("ls", { config: configFor(bin) });
      assert.equal(outcome.ok, false, `缺 ${drop} 就该判不可用`);
      if (!outcome.ok) {
        assert.equal(outcome.reason, "capability");
        assert.match(outcome.detail ?? "", new RegExp(drop.replace(".", "\\.")), `detail 要点名缺了 ${drop}`);
        assert.match(outcome.detail ?? "", /已知版本 0\.6/, "同时要写明已知版本（只作提示）");
      }
    }
  });

  it("缺多项时一次说完，不挑一个报", () => {
    const drop = ["paths.candidates", "exit_codes.2", "modes.stream"];
    const bin = stub("missing-many.sh", `${specCase("0.6.0", drop)}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const outcome = analyzeCommand("ls", { config: configFor(bin) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.reason, "capability");
      for (const id of drop) assert.match(outcome.detail ?? "", new RegExp(id.replace(".", "\\.")));
    }
  });

  it("只缺提示级的 paths.payload → 照旧可用，缺口在 preshellSpecState 里记一笔", () => {
    const bin = stub("no-payload.sh", `${specCase("0.5.0", ["paths.payload"])}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const config = configFor(bin);
    const outcome = analyzeCommand("ls", { config });
    assert.equal(outcome.ok, true, "payload 本侧只解析未接线，缺了不该判不可用");
    const state = preshellSpecState(config);
    assert.deepEqual([...state.advisoryGaps], ["paths.payload"]);
    assert.equal(state.measuredVersion, "0.5.0");
    assert.equal(state.knownVersion, "0.6");
    assert.equal(state.compatibleWithKnown, false, "0.5 与已知 0.6 不同主次版号：只是提示，不影响可用性");
  });

  it("不认识 --spec 的旧二进制（用法错误、退出码 2）→ capability，不当成「没依赖」", () => {
    const bin = stub("no-spec.sh", `printf 'unknown option: --spec\\n' >&2\nexit 2`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const outcome = analyzeCommand("ls", { config: configFor(bin) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.reason, "capability");
      assert.match(outcome.detail ?? "", /不认识 --spec/);
    }
  });

  it("--spec 输出不是 JSON 对象 → bad-json（探测失败一律归保守兜底）", () => {
    for (const body of [`printf '这不是 JSON'; exit 0`, `printf '[1,2]'; exit 0`]) {
      const bin = stub(`bad-spec-${body.includes("[") ? "array" : "text"}.sh`, body);
      clearPreshellCache();
      resetPreshellSpecCache();
      const outcome = analyzeCommand("ls", { config: configFor(bin) });
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.reason, "bad-json");
    }
  });

  it("缺二进制 → missing（调用方据此走保守兜底）", () => {
    clearPreshellCache();
    resetPreshellSpecCache();
    const outcome = analyzeCommand("ls", { config: configFor(join(dir, "没有这个文件")) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "missing");
  });

  it("stdout 不是 JSON → bad-json", () => {
    const bin = stub("badjson.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '这不是 JSON'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const outcome = analyzeCommand("ls", { config: configFor(bin) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "bad-json");
  });

  it("退出码非 0 → exit", () => {
    const bin = stub("exit.sh", `${SPEC_OK}\ncat >/dev/null\nexit 3`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const outcome = analyzeCommand("ls", { config: configFor(bin) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "exit");
  });

  it("卡住的子进程被超时切断，不当成放行", () => {
    const bin = stub("slow.sh", `${SPEC_OK}\ncat >/dev/null\nsleep 5\nprintf '{}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
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
    const bin = stub("breaker.sh", `${SPEC_OK}\necho x >> "${log}"\ncat >/dev/null\nexit 1`);
    clearPreshellCache();
    resetPreshellSpecCache();
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

  it("确定性失败（缺件/缺能力）一次就断，不再白白 spawn", () => {
    clearPreshellCache();
    resetPreshellSpecCache();
    resetPreshellBreaker();
    const config = configFor(join(dir, "根本没有这个文件"));
    const first = analyzeCommand("echo a", { config });
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.reason, "missing");
    assert.equal(preshellBreakerState().broken, "missing");
    const second = analyzeCommand("echo b", { config });
    if (!second.ok) assert.match(second.detail ?? "", /熔断/);
    resetPreshellBreaker();

    // 缺能力也是确定性失败：一次就断
    clearPreshellCache();
    resetPreshellSpecCache();
    const bin = stub("missing-cap.sh", `${specCase("0.6.0", ["paths.candidates"])}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    const third = analyzeCommand("echo c", { config: configFor(bin) });
    assert.equal(third.ok, false);
    if (!third.ok) assert.equal(third.reason, "capability");
    assert.equal(preshellBreakerState().broken, "capability");
    resetPreshellBreaker();
    resetPreshellSpecCache();
  });

  it("成功一次就把失败计数清零（偶发超时不该熔断）", () => {
    const bin = stub("flaky.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    resetPreshellBreaker();
    const outcome = analyzeCommand("cat providers.toml", { config: configFor(bin) });
    assert.equal(outcome.ok, true);
    assert.deepEqual(preshellBreakerState(), { broken: undefined, failures: 0 });
  });
});

describe("能力清单（--spec 探测的判据）", () => {
  it("清单本身自洽：id 唯一、每项都写了 why、能对齐全项 spec", () => {
    const all = [...REQUIRED_CAPABILITIES, ...ADVISORY_CAPABILITIES];
    const ids = all.map((item) => item.id);
    assert.deepEqual(ids, [...new Set(ids)], "id 要唯一（detail 里靠它点名）");
    assert.ok(REQUIRED_CAPABILITIES.length > 0 && REQUIRED_CAPABILITIES.every((item) => item.level === "required"));
    assert.ok(ADVISORY_CAPABILITIES.every((item) => item.level === "advisory"));
    const full = JSON.parse(specJson("0.6.0")) as Parameters<typeof checkCapabilities>[0];
    for (const item of all) {
      assert.ok(item.why.length > 8, `${item.id} 要注明对应 pi 侧哪处依赖`);
      assert.equal(item.check(full), true, `${item.id} 应能从齐全的 spec 里读到`);
    }
  });

  it("v0.6.0 那种齐全的 --spec：必需项与提示项一个不缺", () => {
    const check = checkCapabilities(JSON.parse(specJson("0.6.0")));
    assert.equal(check.ok, true);
    assert.deepEqual(check.missing, []);
    assert.deepEqual(check.missingAdvisory, []);
  });

  it("v0.4.1 那种没有 paths.payload 的 spec：必需项仍齐，提示级缺一项", () => {
    const check = checkCapabilities(JSON.parse(specJson("0.4.1", ["paths.payload"])));
    assert.equal(check.ok, true, "payload 本侧还没接线，缺了不影响可用性");
    assert.deepEqual(check.missingAdvisory, ["paths.payload"]);
  });

  it("check 抛异常算缺项（宁可保守，不放过）", () => {
    const hostile = {
      tool: "preshell",
      get version(): never {
        throw new Error("boom");
      },
    };
    const check = checkCapabilities(hostile);
    assert.equal(check.ok, false);
    assert.ok(check.missing.includes("version"));
  });

  it("queryPreshellSpec：一次 --spec 拿到身份 + 版本 + 能力，缓存到进程结束", () => {
    const log = join(dir, "spec-calls.log");
    const bin = stub("spec-once.sh", `echo x >> "${log}"\n${SPEC_OK}`);
    resetPreshellSpecCache();
    const first = queryPreshellSpec(bin);
    assert.equal("error" in first, false);
    if (!("error" in first)) {
      assert.equal(first.version, "0.6.0");
      assert.equal(first.spec.tool, "preshell");
      assert.deepEqual(checkCapabilities(first.spec).missing, []);
    }
    queryPreshellSpec(bin);
    queryPreshellSpec(bin);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "--spec 只该起一次");
  });

  it("capabilityFailureDetail：点名缺项，并带上实测版本（已知版本由调用方补）", () => {
    const check = checkCapabilities(JSON.parse(specJson("9.9.9", ["paths.candidates", "exit_codes.2"])));
    const detail = capabilityFailureDetail(check, "9.9.9");
    assert.match(detail, /缺必需契约项 exit_codes\.2、paths\.candidates/);
    assert.match(detail, /实测 version=9\.9\.9/);
    assert.doesNotMatch(detail, /已知版本/, "探测层不知道配置里的已知版本，由调用方补上");
    assert.match(capabilityFailureDetail(check, undefined), /实测 version=读不出/);
  });

  it("queryPreshellSpec：缺二进制 / 卡住 → missing / timeout（都走保守兜底）", () => {
    resetPreshellSpecCache();
    const missing = queryPreshellSpec(join(dir, "没有这个文件-spec"), 200);
    assert.equal("error" in missing && missing.error, "missing");
    resetPreshellSpecCache();
    const slow = stub("slow-spec.sh", `case "$1" in --spec) sleep 5 ;; esac`);
    const timedOut = queryPreshellSpec(slow, 200);
    assert.equal("error" in timedOut && timedOut.error, "timeout");
  });

  it("compatVersion 只用于提示（读不出版号也不抛）", () => {
    assert.equal(compatVersion("0.6.1"), "0.6");
    assert.equal(compatVersion("0.6"), "0.6");
    assert.equal(compatVersion("v1.2.3"), undefined);
    assert.equal(compatVersion(""), undefined);
  });
});

describe("缺件提示（人看的）", () => {
  it("describeUnavailable 说清是什么毛病", () => {
    assert.match(describeUnavailable("missing"), /未安装或路径不对/);
    assert.match(
      describeUnavailable("capability", "缺必需契约项 paths.candidates；实测 version=9.9.9，已知版本 0.6"),
      /契约能力不足（缺必需契约项 paths\.candidates/,
    );
    assert.match(describeUnavailable("disabled"), /enabled=false/);
  });

  it("INSTALL_HINT 给出可粘贴的安装命令，并写明没装也能用", () => {
    // 版本号写死在提示里，所以升级的时候这里会红：这是故意的，提示里那串命令必须是真的
    assert.match(INSTALL_HINT, /gh release download v0\.6\.0 -R conglinyizhi\/preshell/);
    assert.match(INSTALL_HINT, /install -Dm755 \/tmp\/p\/preshell-v0\.6\.0-x86_64-linux/);
    assert.match(INSTALL_HINT, /moon build --release --target native/);
    assert.match(INSTALL_HINT, /退回旧的匹配规则/);
    // v0.4.1 起的两条事实要写在提示里：origin 与「候选集只在穷尽时给」
    assert.match(INSTALL_HINT, /origin/);
    assert.match(INSTALL_HINT, /候选集只在穷尽时才给/);
    // 判据也变了：能力探测取代版本号门禁，提示里要说清
    assert.match(INSTALL_HINT, /看能力不看版本号/);
    assert.match(INSTALL_HINT, /--spec/);
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
    assert.equal(cfg.knownVersion, "0.6");
  });

  it("配置读 `version` 键（现在含义是「已知版本」）；老的 `schema = 1` 不再读", () => {
    const path = join(dir, "config-version.toml");
    writeFileSync(path, `[preshell]\nenabled = true\nschema = 1\n`, "utf8");
    assert.equal(loadPreshellConfig(path).knownVersion, "0.6", "老键不该被当成版本号");
    writeFileSync(path, `[preshell]\nversion = "0.6"\n`, "utf8");
    assert.equal(loadPreshellConfig(path).knownVersion, "0.6");
    writeFileSync(path, `[preshell]\nversion = "0.7"\n`, "utf8");
    assert.equal(loadPreshellConfig(path).knownVersion, "0.7", "配置只改「已知版本」，不影响可用性判定");
  });

  // 老调用方（与外面的脚本）还按 expectedVersion 传配置：名称换过，但要仍然能读
  it("老字段名 expectedVersion 仍然认，它只是 knownVersion 的别名", () => {
    assert.equal(loadPreshellConfig("/nonexistent/extensions.toml").knownVersion, KNOWN_VERSION);
    assert.equal(KNOWN_VERSION, EXPECTED_VERSION, "KNOWN_VERSION 就是 EXPECTED_VERSION 的语义名");
    const bin = stub("alias-config.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const outcome = analyzeCommand("ls", {
      config: { enabled: true, bin, timeoutMs: 2000, expectedVersion: "0.6" } as PreshellConfig,
    });
    assert.equal(outcome.ok, true, "老字段名不该让可用性判定挂掉");
    assert.equal(knownVersionOf({ expectedVersion: "0.6" }), "0.6", "别名要认得出来");
    assert.equal(knownVersionOf({}), EXPECTED_VERSION, "都没有就回退到已知版本的缺省值");
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
    const bin = stub("facts.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
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
    const bin = stub("facts-var.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
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
    const bin = stub("facts-var-unknown.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${report}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
    const outcome = analyzeCommand("P=$(which jq) && $P --version", { config: configFor(bin) });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const text = formatFacts(outcome.facts);
    assert.match(text, /- 程序：\$P（渲不出：值里含命令替换/);
    assert.match(text, /- 变量：P（渲不出：值里含命令替换/);
  });

  it("命令里没有变量引用时不出变量表（旧输出的其余部分不变）", () => {
    const bin = stub("facts-novar.sh", `${SPEC_OK}\ncat >/dev/null\nprintf '%s' '${OK_REPORT}'`);
    clearPreshellCache();
    resetPreshellSpecCache();
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
