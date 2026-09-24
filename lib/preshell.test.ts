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
  resolvePreshellBin,
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
    assert.match(INSTALL_HINT, /gh release download v0\.1 -R conglinyizhi\/preshell/);
    assert.match(INSTALL_HINT, /install -Dm755/);
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
});
