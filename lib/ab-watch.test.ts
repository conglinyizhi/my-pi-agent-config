// lib/ab-watch.test.ts
// 跑法：node --test --experimental-strip-types lib/ab-watch.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	classifyAuditOutcome,
	classifyWindowOutcome,
	noteGateRoundTrip,
	resolveRuntimeRoot,
	watchRoundTrip,
	writeNotice,
} from "./ab-watch.ts";

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

describe("闸门往返：两个组件的共用观察点", () => {
	it("窗口给了结论、审核有 verdict：两侧各记一次干净", () => {
		const root = setup();
		const watched = noteGateRoundTrip({
			windowResult: { ok: true, data: { action: "allow" } },
			review: { verdict: "safe" },
			runtimeRoot: root,
		});
		assert.equal(watched.gui.noted, true);
		assert.equal(watched.gui.clean, 1);
		assert.equal(watched.audit?.noted, true);
		assert.equal(watched.audit?.clean, 1);
	});

	it("叉掉窗口：两侧都算失败，audit 的理由里说明是这次没走完", () => {
		const root = setup();
		const watched = noteGateRoundTrip({
			windowResult: { ok: false, reason: "exited" },
			review: { verdict: "safe" },
			runtimeRoot: root,
		});
		assert.equal(watched.gui.clean, 0);
		assert.equal(watched.audit?.clean, 0);
		assert.match(readFileSync(join(root, "audit", "streak.json"), "utf8"), /这次没走完/);
	});

	it("链自己报错：gui 算干净、audit 算失败", () => {
		const root = setup();
		const watched = noteGateRoundTrip({
			windowResult: { ok: true, data: { action: "allow" } },
			review: { verdict: "error" },
			runtimeRoot: root,
		});
		assert.equal(watched.gui.clean, 1);
		assert.equal(watched.audit?.clean, 0);
	});

	it("没有 review 说明这次没跑审核，就不记 audit 的账", () => {
		const root = setup();
		const watched = noteGateRoundTrip({ windowResult: { ok: true, data: { action: "deny" } }, runtimeRoot: root });
		assert.equal(watched.gui.noted, true);
		assert.equal(watched.audit, undefined);
		assert.equal(existsSync(join(root, "audit", "streak.json")), false);
	});

	it("攒够阈值时给出带组件的提示（用来自动晋升那一下）", () => {
		const root = setup();
		let last;
		for (let index = 0; index < 2; index += 1) {
			last = noteGateRoundTrip({
				windowResult: { ok: true, data: { action: "allow" } },
				review: { verdict: "risky" },
				runtimeRoot: root,
				threshold: 2,
			});
		}
		assert.equal(last?.notices.length, 2, "gui 与 audit 各一条");
		assert.deepEqual(last?.notices.map((notice) => notice.component).sort(), ["audit", "gui"]);
		assert.match(last?.notices[0].text ?? "", /已自动晋升/);
	});

	it("未初始化时两侧都不记，也不造目录", () => {
		const runtimeRoot = join(mkdtempSync(join(tmpdir(), "ab-watch-")), "runtime");
		const watched = noteGateRoundTrip({
			windowResult: { ok: true, data: { action: "allow" } },
			review: { verdict: "safe" },
			runtimeRoot,
		});
		assert.equal(watched.gui.noted, false);
		assert.equal(watched.audit?.noted, false);
		assert.deepEqual(watched.notices, []);
		assert.equal(existsSync(runtimeRoot), false);
	});
});

describe("提示落地", () => {
	it("写进运行时目录的 notice.txt；目录不在就静默跳过", () => {
		const root = setup();
		writeNotice(root, "gui", "gui 已自动晋升", "2026-10-05T10:00:00Z");
		assert.match(readFileSync(join(root, "gui", "notice.txt"), "utf8"), /已自动晋升/);
		writeNotice(join(root, "不存在"), "gui", "不该写进去");
	});
});

