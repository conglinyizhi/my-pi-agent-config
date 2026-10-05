// scripts/gui-canary.test.ts — 金丝雀的判定（注入假进程，不起真 Electron）
// 跑法：node --test --experimental-strip-types scripts/gui-canary.test.ts

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { runGuiCanary } from "./gui-canary.ts";

interface FakeConfig {
	/** 起手就吐出来的日志 */
	startLog?: string;
	/** 宽限期内自己退掉（起不来） */
	dieEarly?: boolean;
	/** 收到 TERM 之后吐出来的日志（退出路径） */
	quitLog?: string;
	/** 收到 TERM 之后退不退 */
	quit?: "clean" | "never";
	quitCode?: number;
}

function fakeSpawn(config: FakeConfig = {}) {
	const calls: string[] = [];
	const spawn = ((_file: string, args: string[]) => {
		calls.push(args.join(" "));
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			kill: (signal: string) => void;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = (signal: string) => {
			if (config.quitLog) child.stdout.emit("data", Buffer.from(config.quitLog));
			if (config.quit === "never") return;
			setImmediate(() => child.emit("exit", config.quitCode ?? 0, null));
		};
		setImmediate(() => {
			if (config.startLog) child.stdout.emit("data", Buffer.from(config.startLog));
			if (config.dieEarly) child.emit("exit", 1, null);
		});
		return child;
	}) as never;
	return { spawn, calls };
}

const fastSleep = () => new Promise<void>((resolve) => setImmediate(resolve));
const withDisplay = () => true;

function run(config: FakeConfig, display = true) {
	const fake = fakeSpawn(config);
	return runGuiCanary(
		{ repoRoot: process.cwd(), graceMs: 1, quitWaitMs: 1 },
		{ spawn: fake.spawn, sleep: fastSleep, hasDisplay: () => display },
	);
}

describe("切换前金丝雀", () => {
	it("没有图形会话：算没验（不是通过）", async () => {
		const result = await run({}, false);
		assert.equal(result.ok, false);
		assert.match(String(result.skipped), /没有图形会话/);
	});

	it("宽限期内就退了：起不来，拦下", async () => {
		const result = await run({ dieEarly: true });
		assert.equal(result.ok, false);
		assert.match(result.reason, /宽限期内就退了/);
	});

	it("日志里有崩溃标记：拦下", async () => {
		const result = await run({ startLog: "ReferenceError: flowsBridge is not defined\n" });
		assert.equal(result.ok, false);
		assert.match(result.reason, /ReferenceError/);
	});

	it("退出路径上崩了：拦下（flowsBridge 那次就是这条）", async () => {
		const result = await run({ quitLog: "A JavaScript error occurred in the main process\nReferenceError: flowsBridge is not defined\n" });
		assert.equal(result.ok, false);
		assert.match(result.reason, /退出路径上崩了/);
	});

	it("TERM 之后不退：拦下", async () => {
		const result = await run({ quit: "never" });
		assert.equal(result.ok, false);
		assert.match(result.reason, /没退/);
	});

	it("活了、退了、日志干净：通过", async () => {
		const result = await run({ startLog: "打开：权限闸门（审批对话框）\n" });
		assert.equal(result.ok, true, result.reason);
		assert.match(result.reason, /退出干净/);
	});
});
