// lib/ab-watch.test.ts
// 跑法：node --test --experimental-strip-types lib/ab-watch.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	classifyWindowOutcome,
	noteGateRoundTrip,
	resolveRuntimeRoot,
	watchRoundTrip,
	writeNotice,
} from "./ab-watch.ts";

/**
 * 新模型：一条产品线一个 tag。真跑时 tag/dir/candidate 都由 deploy 侧写好，
 * 这里照一份：生效的 live111（目录 dev）、回退目标 old000、待验的 cand222。
 */
function setup(): string {
	const root = mkdtempSync(join(tmpdir(), "ab-watch-"));
	for (const component of ["gui"]) {
		const at = join(root, component);
		mkdirSync(join(at, "dev"), { recursive: true });
		writeFileSync(join(at, "tag"), "live111\n", { mode: 0o600 });
		writeFileSync(join(at, "prev-tag"), "old000\n", { mode: 0o600 });
		writeFileSync(join(at, "candidate"), "cand222\n", { mode: 0o600 });
		writeFileSync(join(at, "dir"), "dev\n", { mode: 0o600 });
	}
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
		assert.equal(last?.clean, 0, "切完计数归零，下一轮重新攒");
		assert.match(readFileSync(join(root, "gui", "promote.log"), "utf8"), /"event":"update"/);
	});

	it("没有候选时攒满也不晋升，只报干净（踩过的坑）", () => {
		const root = setup();
		rmSync(join(root, "gui", "candidate"), { force: true });
		let last;
		for (let index = 0; index < 5; index += 1) {
			last = watchRoundTrip({ component: "gui", outcome: "clean", runtimeRoot: root, threshold: 5 });
		}
		assert.equal(last?.promoted, false);
		assert.equal(last?.action, "keep");
		assert.equal(readFileSync(join(root, "gui", "tag"), "utf8").trim(), "live111", "生效的 tag 不许被动");
	});

	it("测试进程不写运行时状态（不给 runtimeRoot 时）", () => {
		const before = watchRoundTrip({ component: "gui", outcome: "clean" });
		assert.equal(before.noted, false);
		assert.match(before.skipped ?? "", /测试进程/);
	});

	it("失败清零，不晋升", () => {
		const root = setup();
		for (let index = 0; index < 4; index += 1) watchRoundTrip({ component: "gui", outcome: "clean", runtimeRoot: root });
		const failed = watchRoundTrip({ component: "gui", outcome: "failure", reason: "窗口被叉掉", runtimeRoot: root });
		assert.equal(failed.noted, true);
		assert.equal(failed.clean, 0);
		assert.equal(failed.promoted, false);
		assert.match(readFileSync(join(root, "gui", "promote.log"), "utf8"), /窗口被叉掉/);
	});

	it("关掉自动晋升只给 notify", () => {
		const root = setup();
		let last;
		for (let index = 0; index < 5; index += 1) {
			last = watchRoundTrip({ component: "gui", outcome: "clean", runtimeRoot: root, autoPromote: false });
		}
		assert.equal(last?.action, "keep", "关掉自动晋升就只攒着");
		assert.equal(last?.promoted, false);
	});
});

describe("从结果判干净", () => {
	it("窗口给了结论就算干净", () => {
		assert.equal(classifyWindowOutcome({ ok: true, data: { action: "allow" } }).outcome, "clean");
	});

	it("点拒绝也算走完：结论就是结论，与答不答应无关", () => {
		const verdict = classifyWindowOutcome({ ok: true, data: { action: "deny" } });
		assert.equal(verdict.outcome, "clean");
		assert.match(verdict.reason, /给出结论/);
	});

	it("叉掉窗口算失败（那是机制没走通）", () => {
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

});

describe("闸门往返：窗口是唯一要记账的那一半", () => {
	// 阈值现在是 1：第一次干净往返就晋升，所以 clean 归零、promoted 为真
	it("窗口走完即记一次干净，并立刻晋升到候选", () => {
		const root = setup();
		const watched = noteGateRoundTrip({
			windowResult: { ok: true, data: { action: "allow" } },
			runtimeRoot: root,
		});
		assert.equal(watched.gui.noted, true);
		assert.equal(watched.gui.promoted, true, "阈值 1：一次就切");
		assert.equal(watched.gui.clean, 0, "晋升之后计数归零");
	});

	it("叉掉窗口算失败", () => {
		const root = setup();
		const watched = noteGateRoundTrip({ windowResult: { ok: false, reason: "exited" }, runtimeRoot: root });
		assert.equal(watched.gui.clean, 0);
		assert.match(readFileSync(join(root, "gui", "promote.log"), "utf8"), /窗口被关掉/);
	});

	it("攒够阈值时给出带组件的提示（用来自动晋升那一下）", () => {
		const root = setup();
		let last;
		for (let index = 0; index < 2; index += 1) {
			last = noteGateRoundTrip({
				windowResult: { ok: true, data: { action: "allow" } },
				runtimeRoot: root,
				threshold: 2,
			});
		}
		assert.equal(last?.notices.length, 1, "只剩 gui 一条产线");
		assert.deepEqual(last?.notices.map((notice) => notice.component), ["gui"]);
		assert.match(last?.notices[0].text ?? "", /已自动晋升/);
	});

	it("未初始化时不记账，也不造目录", () => {
		const runtimeRoot = join(mkdtempSync(join(tmpdir(), "ab-watch-")), "runtime");
		const watched = noteGateRoundTrip({
			windowResult: { ok: true, data: { action: "allow" } },
			runtimeRoot,
		});
		assert.equal(watched.gui.noted, false);
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


describe("看门狗：连续失败自动回退", () => {
	it("连续三次失败就退回 prev-tag，并清掉连胜", () => {
		const root = setup();
		let last;
		for (let index = 0; index < 3; index += 1) {
			last = watchRoundTrip({ component: "gui", outcome: "failure", reason: "窗口被叉掉", runtimeRoot: root, failThreshold: 3 });
		}
		assert.equal(last?.rolledBack, true);
		assert.equal(readFileSync(join(root, "gui", "tag"), "utf8").trim(), "old000", "退回 prev-tag");
		assert.equal(readFileSync(join(root, "gui", "fail"), "utf8").trim(), "0", "失败计数清零");
		assert.match(readFileSync(join(root, "gui", "promote.log"), "utf8"), /"event":"rollback"/);
	});

	it("中间干净一次就重新数", () => {
		const root = setup();
		const options = { runtimeRoot: root, failThreshold: 3 } as const;
		watchRoundTrip({ component: "gui", outcome: "failure", ...options });
		watchRoundTrip({ component: "gui", outcome: "failure", ...options });
		watchRoundTrip({ component: "gui", outcome: "clean", ...options });
		watchRoundTrip({ component: "gui", outcome: "failure", ...options });
		const last = watchRoundTrip({ component: "gui", outcome: "failure", ...options });
		assert.equal(last.rolledBack, false, "只连续失败两次，不该回退");
	});

	it("没有 prev-tag 时不退，只记账", () => {
		const root = setup();
		rmSync(join(root, "gui", "prev-tag"), { force: true });
		let last;
		for (let index = 0; index < 4; index += 1) {
			last = watchRoundTrip({ component: "gui", outcome: "failure", runtimeRoot: root, failThreshold: 3 });
		}
		assert.equal(last?.rolledBack, false);
		assert.match(String(last?.watchdog), /失败/);
	});

	it("闸门往返里回退的提示排在晋升前面（回退更该被看见）", () => {
		const root = setup();
		let last;
		for (let index = 0; index < 3; index += 1) {
			last = noteGateRoundTrip({
				windowResult: { ok: false, reason: "exited" },
				runtimeRoot: root,
				failThreshold: 3,
			});
		}
		const texts = (last?.notices ?? []).map((notice) => notice.text);
		assert.ok(texts.some((text) => /自动回退/.test(text)), JSON.stringify(texts));
	});
});

