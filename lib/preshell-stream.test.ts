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
	resetStreamSupportCache,
	streamSupported,
	type PreshellStream,
	type PreshellStreamOptions,
} from "./preshell-stream.ts";
import { resetPreshellVersionCache, type PreshellReport } from "./preshell.ts";

/** 替身把命令原样回显在 echo 里，真实报告没有这个字段：只用于把应答对上请求 */
function echoOf(report: PreshellReport): string | undefined {
	return (report as unknown as { echo?: string }).echo;
}

/**
 * 替身：说 preshell v0.2 的流式协议。
 *
 * 模式写在同目录的 mode 文件里（而不是环境变量）：能力探测那条路径是
 * `spawnSync(bin, ["--help"])`，带不上调用方的 env，模式落在文件里两条路径都能读。
 * 顺带断言调用方真的传了 --stream 与 --shell=probe：传错就退出码 3。
 */
const STUB_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const mode = fs.readFileSync(path.join(__dirname, "mode"), "utf8").trim();
const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write(mode === "no-stream" ? "options:\\n  --pretty\\n" : "options:\\n  --stream   many commands\\n");
  process.exit(0);
}
if (argv.includes("--version")) {
  const old = mode === "old-schema";
  process.stdout.write(JSON.stringify({ tool: "preshell", version: old ? "9.9.9" : "0.2.0", schema: old ? 2 : 1 }) + "\\n");
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
  if (mode === "silent") return;
  if (mode === "reject") { out({ id: req.id, error: "unknown key: timeout", line: 1 }); return; }
  if (mode === "orphan") { out({ id: req.id + 1000, report: report(req.command) }); return; }
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
	resetPreshellVersionCache();
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
	it("v0.1 那种不认 --stream 的二进制：不起进程，报明白原因", async () => {
		const bin = stub("no-stream");
		resetStreamSupportCache();
		assert.equal(streamSupported(bin), false);
		const client = open(bin);
		const result = await client.analyze("ls");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, "exit");
			assert.match(result.detail ?? "", /--stream/);
		}
		assert.equal(client.stats().spawns, 0);
		await client.close();
	});

	it("schema 不符按事实层不可用处理", async () => {
		const client = open(stub("old-schema"));
		const result = await client.analyze("ls");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, "schema");
			assert.match(result.detail ?? "", /schema=2/);
		}
		assert.equal(client.stats().spawns, 0);
		await client.close();
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
