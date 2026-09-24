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
import { after, describe, it } from "node:test";
import {
  analyzeCommand,
  clearPreshellCache,
  formatFacts,
  loadPreshellConfig,
  resetPreshellVersionCache,
  resolvePreshellBin,
  type PreshellConfig,
} from "./preshell.ts";

const dir = mkdtempSync(join(tmpdir(), "preshell-stub-"));
after(() => {
  clearPreshellCache();
  resetPreshellVersionCache();
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

describe("配置与二进制解析", () => {
  it("读 extensions.toml 的 [preshell]，读不到用缺省（启用 + ~/.pi/runtime/preshell）", () => {
    const cfg = loadPreshellConfig("/nonexistent/extensions.toml");
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.bin, "~/.pi/runtime/preshell");
    assert.equal(cfg.schema, 1);
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
