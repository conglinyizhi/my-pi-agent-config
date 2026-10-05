// lib/ab-watch.test.ts
// 跑法：node --test --experimental-strip-types lib/ab-watch.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyAuditOutcome, classifyWindowOutcome, resolveRuntimeRoot, watchRoundTrip } from "./ab-watch.ts";

function setup(): string {
	const root = mkdtempSync(join(tmpdir(), "ab-watch-"));
	for (const component of ["gui", "audit"]) mkdirSync(join(root, component), { recursive: true });
	return root;
}

describe("未初始化时什么都不做", () => {
	it("运行时目录不存在：跳过，且不凭空造目录", () => {
		const root = join(mkdtempSync(join(tmpdir(), "ab-watch-")), "runtime");
		const result = watchRoundTrip({ component: "gui", outcome: "clean", runtimeRoot: root });
		assert.equal(result.noted, false);
		assert.match(String(result.skipped), /未初始化/);
		assert.equal(existsSync(join(root, "gui")), false, "不该创建任何目录");
	});

	it("路径被占成文件时也不抛，只报跳过原因", () => {
		const root = mkdtempSync(join(tmpdir(), "ab-watch-"));
		writeFileSync(join(root, "gui"), "我不是目录");
		const result = watchRoundTrip({ component: "gui", outcome: "clean", runtimeRoot: root });
		assert.equal(result.noted, false);
		assert.ok(result.skipped);
	});

	it("运行时根来自环境变量", () => {
		const previous = process.env.PI_RUNTIME_ROOT;
		process.env.PI_RUNTIME_ROOT = "/tmp/from-env";
		assert.equal(resolveRuntimeRoot(), "/tmp/from-env");
		assert.equal(resolveRuntimeRoot("/tmp/explicit"), "/tmp/explicit");
		if (previous === undefined) delete process.env.PI_RUNTIME_ROOT;
		else process.env.PI_RUNTIME_ROOT = previous;
	});
});

describe("计数与自动晋升", () => {
	it("攒够五次自动晋升", () => {
		const root = setup();
		let last;
		for (let index = 0; index < 5; index += 1) {
			last = watchRoundTrip({ component: "gui", outcome: "clean", runtimeRoot: root, threshold: 5 });
			assert.equal(last.noted, true);
		}
		assert.equal(last?.promoted, true);
		assert.equal(last?.clean, 5);
		assert.match(readFileSync(join(root, "gui", "promote.log"), "utf8"), /"event":"promote"/);
	});

	it("失败清零，不晋升", () => {
		const root = setup();
		for (let index = 0; index < 4; index += 1) watchRoundTrip({ component: "gui", outcome: "clean", runtimeRoot: root });
		const failed = watchRoundTrip({ component: "gui", outcome: "failure", reason: "窗口被叉掉", runtimeRoot: root });
		assert.equal(failed.noted, true);
		assert.equal(failed.clean, 0);
		assert.equal(failed.promoted, false);
		assert.match(readFileSync(join(root, "gui", "streak.json"), "utf8"), /窗口被叉掉/);
	});

	it("关掉自动晋升只给 notify", () => {
		const root = setup();
		let last;
		for (let index = 0; index < 5; index += 1) {
			last = watchRoundTrip({ component: "audit", outcome: "clean", runtimeRoot: root, autoPromote: false });
		}
		assert.equal(last?.action, "notify");
		assert.equal(last?.promoted, false);
	});
});

describe("从结果判干净", () => {
	it("窗口给了结论就算干净", () => {
		assert.equal(classifyWindowOutcome({ ok: true, data: { action: "allow" } }).outcome, "clean");
	});

	it("叉掉窗口算失败（对结果不满意就等于投反对票）", () => {
		const verdict = classifyWindowOutcome({ ok: false, reason: "exited" });
		assert.equal(verdict.outcome, "failure");
		assert.match(verdict.reason, /叉掉|关掉/);
	});

	it("超时、起不来、找不到都算失败，且各有说人话的理由", () => {
		for (const reason of ["timeout", "aborted", "spawn", "unavailable"]) {
			const verdict = classifyWindowOutcome({ ok: false, reason });
			assert.equal(verdict.outcome, "failure", reason);
			assert.ok(verdict.reason.length > 2);
		}
	});

	it("审计：安全与有风险都算走完，链报错才算失败", () => {
		assert.equal(classifyAuditOutcome("safe").outcome, "clean");
		assert.equal(classifyAuditOutcome("risky").outcome, "clean");
		assert.equal(classifyAuditOutcome("dangerous").outcome, "clean");
		assert.equal(classifyAuditOutcome("error").outcome, "failure");
		assert.equal(classifyAuditOutcome(undefined).outcome, "failure");
	});
});
