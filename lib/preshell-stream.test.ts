// lib/preshell-stream.test.ts — 流式客户端（一个子进程跑多条命令）
//
// 跑法：node --experimental-strip-types lib/preshell-stream.test.ts
//
// 用替身脚本而不是真二进制：这里要考的是父进程侧的契约（信封对 id、超时、崩溃、
// 无主应答、闲时回收），真实产物的行为由 scripts/preshell-shadow.ts 与
// lib/sandbox-check.test.ts 覆盖。

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	openPreshellStream,
	liveChildren,
	resetStreamSupportCache,
	streamSupported,
	type PreshellStream,
	type PreshellStreamOptions,
} from "./preshell-stream.ts";
import { resetPreshellSpecCache, type PreshellReport } from "./preshell.ts";

/** 替身把命令原样回显在 echo 里，真实报告没有这个字段：只用于把应答对上请求 */
function echoOf(report: PreshellReport): string | undefined {
	return (report as unknown as { echo?: string }).echo;
}

/**
 * 替身：说 preshell v0.6.0 的流式协议，并答 --spec（能力清单）。
 *
 * 模式写在同目录的 mode 文件里（而不是环境变量）：能力探测那条路径也是 spawnSync，
 * 带不上调用方的 env，模式落在文件里两条路径都能读。
 * 顺带断言调用方真的传了 --stream 与 --shell=probe：传错就退出码 3。
 *
 * 模式 ↔ 它模拟的产物：
 *   ok / diagnostic / bad-json / echo-id / silent / reject / orphan / crash-after-first
 *                     → 能力齐全的 0.6.0
 *   new-patch         → 能力齐全的 0.6.1（版本号不同不再是问题）
 *   future-version    → 能力齐全的 9.9.9（本侧没见过的版本）
 *   no-candidates     → 缺 paths.candidates（必需项）
 *   no-stream         → modes 里没有 --stream
 *   old-version       → 不认识 --spec（用法错误，退出码 2），旧契约（带 schema 的 0.3.0）那种
 */
const STUB_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const mode = fs.readFileSync(path.join(__dirname, "mode"), "utf8").trim();
const argv = process.argv.slice(2);
const spec = () => {
  const version = mode === "new-patch" ? "0.6.1" : mode === "future-version" ? "9.9.9" : "0.6.0";
  const base = {
    tool: "preshell",
    version,
    doc: "https://example.invalid/integration.md",
    one_line: "Reports what a shell command touches. Facts, not a verdict.",
    modes: [
      { name: "single", stdin: "one command", stdout: "one report" },
      { name: "stream", flag: "--stream", stdin: "one request per line", stdout: "one answer per line" },
    ],
    exit_codes: { "0": "answers produced", "2": "usage error", other: "tool failed", note: "…" },
    refusal: { shape: '{"error":"...","line":N}', means: "not a request", note: "…" },
    client_obligations: ["serialize writes to stdin"],
    paths: {
      base: "b", vars: "v", required: "r", always_absolute: "a", cd_scope: "c",
      no_base: "n", origin: "o", payload: "p", candidates: "cd",
    },
  };
  if (mode === "no-stream") base.modes = base.modes.filter((m) => m.name !== "stream");
  if (mode === "no-candidates") delete base.paths.candidates;
  return base;
};
if (argv.includes("--help")) {
  process.stdout.write(mode === "no-stream" ? "options:\\n  --pretty\\n" : "options:\\n  --stream   many commands\\n");
  process.exit(0);
}
if (argv.includes("--spec")) {
  // 旧契约（0.3 那种）根本不认识 --spec：用法错误 + 退出码 2
  if (mode === "old-version") {
    process.stderr.write("unknown option: --spec\\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(spec()) + "\\n");
  process.exit(0);
}
if (!argv.includes("--stream") || !argv.includes("--shell=probe")) process.exit(3);

let answered = 0;
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const report = (command) => ({ version: 1, status: "Complete", impact: { effects: [], write_roots: [], uncertain: false, cwd: "/tmp" }, echo: command });

if (mode === "bad-json") process.stdout.write("这不是 JSON\\n");
if (mode === "diagnostic") process.stderr.write("preshell: 2 reports, 1 lines refused\\n");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf("\\n");
    if (nl < 0) break;
    handle(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(line) {
  if (line.trim() === "") return;
  let req;
  try { req = JSON.parse(line); } catch { out({ error: "not valid JSON", line: 1 }); return; }
  if (mode === "echo-id") process.stderr.write(String(req.id) + "\\n");
  if (mode === "silent") return;
  if (mode === "reject") { out({ id: req.id, error: "unknown key: timeout", line: 1 }); return; }
  if (mode === "orphan") { out({ id: "伪造-" + req.id, report: report(req.command) }); return; }
  if (mode === "crash-after-first" && answered >= 1) process.exit(7);
  out({ id: req.id, report: report(req.command) });
  answered++;
}
`;

const dirs: string[] = [];

function stub(mode: string): string {
	const dir = mkdtempSync(join(tmpdir(), "preshell-stream-stub-"));
	dirs.push(dir);
	const path = join(dir, "preshell");
	writeFileSync(path, STUB_SOURCE, "utf8");
	chmodSync(path, 0o755);
	writeFileSync(join(dir, "mode"), `${mode}\n`, "utf8");
	return path;
}

function open(bin: string, options: Partial<PreshellStreamOptions> = {}): PreshellStream {
	return openPreshellStream({ bin, timeoutMs: 200, idleMs: 0, ...options });
}

/** 等一个条件成立，用来观察子进程的生死而不是硬 sleep 一个魔数 */
async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

after(() => {
	resetStreamSupportCache();
	resetPreshellSpecCache();
});

describe("preshell-stream：正常路径", () => {
	it("两条命令走同一个子进程，信封按 id 对上号", async () => {
		const client = open(stub("ok"));
		const first = await client.analyze("ls");
		const second = await client.analyze("rm -rf build");
		assert.equal(first.ok, true);
		assert.equal(second.ok, true);
		if (first.ok && second.ok) {
			assert.equal(echoOf(first.report), "ls");
			assert.equal(echoOf(second.report), "rm -rf build");
		}
		assert.equal(client.stats().spawns, 1);
		assert.equal(client.stats().requests, 2);
		assert.equal(client.stats().orphanAnswers, 0);
		assert.equal(typeof client.pid(), "number");
		await client.close();
	});

	it("并发请求也能各自拿到自己的报告", async () => {
		const client = open(stub("ok"));
		const results = await Promise.all([client.analyze("a"), client.analyze("b"), client.analyze("c")]);
		assert.deepEqual(
			results.map((r) => (r.ok ? echoOf(r.report) : `失败:${r.reason}`)),
			["a", "b", "c"],
		);
		assert.equal(client.stats().spawns, 1);
		await client.close();
	});

	it("stderr 的诊断走回调，不混进报告", async () => {
		const lines: string[] = [];
		const client = open(stub("diagnostic"), { onDiagnostic: (line) => lines.push(line) });
		const result = await client.analyze("ls");
		assert.equal(result.ok, true);
		await waitFor(() => lines.length > 0);
		assert.match(lines[0] ?? "", /2 reports/);
		await client.close();
	});

	it("读得出的坏行只记数，不影响同一批的请求", async () => {
		const client = open(stub("bad-json"));
		const result = await client.analyze("ls");
		assert.equal(result.ok, true);
		assert.equal(client.stats().badLines, 1);
		await client.close();
	});
});

describe("preshell-stream：拿不到应答", () => {
	it("请求 id 是随机串而不是自增整数", async () => {
		const ids: string[] = [];
		const client = openPreshellStream({
			bin: stub("echo-id"),
			timeoutMs: 500,
			idleMs: 0,
			// 替身把收到的 id 写到 stderr 送回来：这条只关心 id 的形状
			onDiagnostic: (line) => ids.push(line.trim()),
		});
		const [a, b] = await Promise.all([client.analyze("ls"), client.analyze("ls -la")]);
		assert.equal(a.ok && b.ok, true);
		await waitFor(() => ids.length >= 2);
		await client.close();
		assert.equal(ids.length, 2);
		for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		assert.notEqual(ids[0], ids[1]);
		assert.equal(client.stats().orphanAnswers, 0);
	});


	it("子进程不答就走超时，且不挂着等", async () => {
		const client = open(stub("silent"), { timeoutMs: 80 });
		const result = await client.analyze("ls");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "timeout");
		assert.equal(client.stats().timeouts, 1);
		// 超时只判这一条失败：进程还在，后面的请求仍可复用
		assert.equal(typeof client.pid(), "number");
		await client.close();
	});

	it("被拒的那一行只失败它自己", async () => {
		const client = open(stub("reject"));
		const result = await client.analyze("ls");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, "bad-json");
			assert.match(result.detail ?? "", /unknown key/);
		}
		await client.close();
	});

	it("id 对不上的应答绝不当成功", async () => {
		const client = open(stub("orphan"), { timeoutMs: 80 });
		const result = await client.analyze("ls");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "timeout");
		assert.equal(client.stats().orphanAnswers, 1);
		await client.close();
	});

	it("子进程半路死掉：未决请求全部判失败，之后不再重启，让调用方走保守兜底", async () => {
		const client = open(stub("crash-after-first"));
		const first = await client.analyze("ls");
		assert.equal(first.ok, true);
		const second = await client.analyze("rm -rf build");
		assert.equal(second.ok, false);
		if (!second.ok) {
			assert.equal(second.reason, "exit");
			assert.match(second.detail ?? "", /意外退出/);
		}
		const third = await client.analyze("ls -la");
		assert.equal(third.ok, false);
		if (!third.ok) assert.equal(third.reason, "exit");
		// 只起过一次：认死之后不再反复重启子进程
		assert.equal(client.stats().spawns, 1);
		assert.equal(client.stats().crashes, 1);
		await client.close();
	});

	it("kill：未决请求立刻失败，子进程带走", async () => {
		const client = open(stub("silent"), { timeoutMs: 10_000 });
		const pending = client.analyze("ls");
		await waitFor(() => client.stats().requests === 1);
		client.kill();
		const result = await pending;
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "exit");
		assert.equal(client.pid(), undefined);
	});
});

describe("preshell-stream：生命周期", () => {
	it("闲下来就收工，下次调用再起（对调用方透明）", async () => {
		const client = open(stub("ok"), { idleMs: 40 });
		const first = await client.analyze("ls");
		assert.equal(first.ok, true);
		const firstPid = client.pid();
		await waitFor(() => client.pid() === undefined);
		assert.equal(client.pid(), undefined);
		const second = await client.analyze("ls");
		assert.equal(second.ok, true);
		assert.equal(client.stats().spawns, 2);
		assert.notEqual(client.pid(), firstPid);
		await client.close();
	});

	it("close 之后子进程真的退了", async () => {
		const client = open(stub("ok"));
		await client.analyze("ls");
		const pid = client.pid();
		assert.equal(typeof pid, "number");
		await client.close();
		assert.equal(client.pid(), undefined);
		// 优雅收工走的是 stdin EOF，不是硬杀
		await waitFor(() => {
			try {
				process.kill(pid as number, 0);
				return false;
			} catch {
				return true;
			}
		});
	});

	it("close 之后还能再起一个（收工不是终态）", async () => {
		const client = open(stub("ok"));
		await client.analyze("ls");
		await client.close();
		const again = await client.analyze("ls");
		assert.equal(again.ok, true);
		assert.equal(client.stats().spawns, 2);
		await client.close();
	});
});

describe("preshell-stream：能力与契约探测", () => {
	it("modes 里没有 --stream 的产物：不起进程，报明白缺的是哪一项", async () => {
		const bin = stub("no-stream");
		resetStreamSupportCache();
		// streamSupported（--help 文本探）留着给调用方自己先用一眼，结论要与能力探测一致
		assert.equal(streamSupported(bin), false);
		const client = open(bin);
		const result = await client.analyze("ls");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, "capability");
			assert.match(result.detail ?? "", /modes\.stream/);
		}
		assert.equal(client.stats().spawns, 0);
		await client.close();
	});

	it("缺必需契约项（paths.candidates）：不起进程，reason=capability 且点名", async () => {
		const client = open(stub("no-candidates"));
		const result = await client.analyze("ls");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, "capability");
			assert.match(result.detail ?? "", /paths\.candidates/);
		}
		assert.equal(client.stats().spawns, 0);
		await client.close();
	});

	it("不认识 --spec 的旧产物（0.3 那种）：capability，不当成「没依赖」放行", async () => {
		const client = open(stub("old-version"));
		const result = await client.analyze("ls");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, "capability");
			assert.match(result.detail ?? "", /不认识 --spec/);
		}
		assert.equal(client.stats().spawns, 0);
		await client.close();
	});

	it("版本号没见过但能力齐全：照用（0.6.1 / 9.9.9 各一个进程）", async () => {
		for (const mode of ["new-patch", "future-version"]) {
			const client = open(stub(mode));
			const result = await client.analyze("ls");
			assert.equal(result.ok, true, `${mode} 能力齐全就该能用`);
			assert.equal(client.stats().spawns, 1);
			await client.close();
		}
	});

	it("二进制不在：报缺件，不反复重试", async () => {
		const client = open(join(tmpdir(), "没有这个文件-preshell"));
		const result = await client.analyze("ls");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "missing");
		assert.equal(client.stats().spawns, 0);
		await client.close();
	});
});

describe("两份 lib 同时活着（A/B 更新之后会真的同时存在）", () => {
	it("在跑的子进程集合跨实例是同一份：清场不会漏掉另一实例启的进程", async () => {
		// 同一个文件用不同查询串再 import 一次 = 第二个模块实例（换槽时的真实情形）
		// 说明符走变量：tsc 解析不了带查询串的模块，运行时才需要它
		const dupUrl = "./preshell-stream.ts?dup=1";
		const second = (await import(dupUrl)) as typeof import("./preshell-stream.ts");
		assert.equal(liveChildren(), second.liveChildren(), "两实例必须操作同一个集合");
	});
});

