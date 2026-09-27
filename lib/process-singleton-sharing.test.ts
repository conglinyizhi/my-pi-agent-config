// lib/process-singleton-sharing.test.ts — 回归：需要跨扩展共享的模块级状态必须真的共享
//
// 跑法：node --test --experimental-strip-types lib/process-singleton-sharing.test.ts
//
// 背景见 lib/process-singleton.ts：pi 给每个扩展单独建 jiti 实例（moduleCache: false），
// 同一个 lib 模块在每个扩展里各求值一份，模块级变量**不共享**。所以注册表、总线、开关、
// 熔断器、提示去重集、写入串行化链这类「必须进程内唯一」的状态写成模块级变量就是错的。
//
// 复现手法与 lib/process-singleton.test.ts 一致：同一路径带不同 query 加载两次，Node 会
// 当成两个模块分别求值（等价于两个扩展各自的 jiti）。每个模块一组用例，断言另一边看得见。
//
// 注意：这里不用 resetProcessSingleton —— 模块在导入时就把 processSingleton 的结果存进
// 常量了，丢掉 globalThis 那一份只会让两边各指一份新的，反而测不出东西。清状态一律走
// 模块自己的 reset/clear（它们清内容、不换引用）。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** 把同一个文件当成两个互不相干的模块加载（模拟 pi 的两个 jiti 实例） */
async function loadTwice(file: string): Promise<[Record<string, any>, Record<string, any>]> {
	const a = (await import(new URL(`${file}?instance=a`, import.meta.url).href)) as Record<string, any>;
	const b = (await import(new URL(`${file}?instance=b`, import.meta.url).href)) as Record<string, any>;
	assert.notEqual(a, b, `${file} 两次加载应当是不同模块实例`);
	return [a, b];
}

describe("status-bus：扩展与输出侧共用一条总线", () => {
	it("一个实例 attach 的写入，另一个实例的快照与订阅者都看得到", async () => {
		const [a, b] = await loadTwice("./status-bus.ts");
		assert.equal(a.statusBus, b.statusBus, "两个实例必须是同一条总线");

		const calls: Array<[string, string | undefined]> = [];
		const ui = {
			setStatus: (key: string, text: string | undefined) => void calls.push([key, text]),
			setWidget: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
		};
		a.statusBus.attach(ui);

		const changes: any[] = [];
		const unsubscribe = b.statusBus.subscribe((c: any) => void changes.push(c));

		ui.setStatus("probe", "\x1b[36m林汐\x1b[0m");
		assert.equal(b.statusBus.getSnapshot().statuses["probe"].text, "林汐", "写入侧的记录，输出侧必须查得到");
		assert.equal(changes.length, 1, "变更流也是同一份");
		assert.deepEqual(calls, [["probe", "\x1b[36m林汐\x1b[0m"]], "转发原生实现不受影响");

		// reset 清的是内容、不换引用：清完两边仍指着同一份
		a.statusBus.reset();
		assert.deepEqual(b.statusBus.getSnapshot().statuses, {});
		ui.setStatus("after-reset", "ok");
		assert.equal(b.statusBus.getSnapshot().statuses["after-reset"].text, "ok", "清空后仍要继续共享");

		unsubscribe();
		a.statusBus.reset();
	});
});

describe("continuation-guard：写方（自动续跑）与读方（任务完成通知）是两个扩展", () => {
	it("抑制标志与连续计数跨实例共享", async () => {
		const [a, b] = await loadTwice("./continuation-guard.ts");
		a.resetContinuationGuard();

		a.markSuppressTaskComplete();
		assert.equal(b.shouldSuppressTaskComplete(), true, "写进 A 的标志，B 必须看得到（否则抑制完全失效）");

		assert.equal(a.recordContinueAttempt(), 1);
		assert.equal(b.recordContinueAttempt(), 2, "计数也是同一份");
		assert.equal(a.getContinueAttempts(), 2);

		b.resetContinueAttempts();
		assert.equal(a.getContinueAttempts(), 0, "B 的重置对 A 生效");
		assert.equal(a.shouldSuppressTaskComplete(), true, "只重置计数，不动抑制标志");

		a.markSuppressTaskComplete();
		b.resetContinuationGuard();
		assert.equal(a.shouldSuppressTaskComplete(), false, "全量复位改的是共享那份的字段");
		assert.equal(a.getContinueAttempts(), 0);
	});
});

describe("prompt-sections：注册方与装配方是两个扩展", () => {
	const baseCtx = () => ({
		cwd: "/tmp/workspace",
		model: "probe-model",
		date: "2026-08-15",
		time: "10:00",
		prompt: "do the thing",
		defaultSystemPrompt: "[DEFAULT PROMPT]",
	});

	it("A 注册的段/变量，B 装配得到", async () => {
		const [a, b] = await loadTwice("./prompt-sections.ts");
		a.resetRegistry();

		a.registerSection({ name: "share:probe", order: 120, text: "PROBE" });
		assert.deepEqual(
			b.getSections().map((s: any) => s.name),
			["share:probe"],
			"注册方与装配方的注册表必须是同一份",
		);

		a.registerVariable("probe_var", () => "V");
		const assembly = await b.assemble(baseCtx());
		assert.equal(assembly.variables.probe_var, "V", "变量 provider 也共享");
		const text = b.renderPrompt(assembly);
		assert.match(text, /PROBE/);
		assert.match(text, /\[DEFAULT PROMPT\]/, "隐式 pi:default 段仍按 order 0 参与");

		// disposer 身份比较作用在共享那份上
		const dispose = b.registerSection({ name: "share:tmp", order: 130, text: "TMP" });
		assert.ok(a.getSections().some((s: any) => s.name === "share:tmp"));
		dispose();
		assert.equal(a.getSections().some((s: any) => s.name === "share:tmp"), false);

		// 开关：写方是 prompt-sections 扩展，读方是别的扩展
		a.setPromptSectionsEnabled(true);
		assert.equal(b.isPromptSectionsEnabled(), true);
		b.setPromptSectionsEnabled(false);
		assert.equal(a.isPromptSectionsEnabled(), false);

		// reset 清内容不换引用：清完 A 仍与 B 共享
		b.resetRegistry();
		assert.deepEqual(a.getSections(), []);
		assert.deepEqual(a.getVariables(), []);
		b.registerSection({ name: "share:after", order: 200, text: "AFTER" });
		assert.equal(a.getSections().length, 1, "清空后仍要继续共享");
		a.resetRegistry();
	});
});

describe("approval-channel：全局通道覆盖是三条闸共用的出口", () => {
	it("A 装的 IM/桩通道，B resolve 时也走它", async () => {
		const [a, b] = await loadTwice("./approval-channel.ts");
		a.setApprovalChannel(undefined);
		assert.equal(b.getApprovalChannel(), undefined, "起点是干净的");

		const channel = async () => ({ action: "deny" });
		a.setApprovalChannel(channel);
		assert.equal(b.getApprovalChannel(), channel, "装上通道的扩展与发起审批的扩展常常不是同一个");
		assert.equal(b.resolveApprovalChannel(), channel, "resolve 也要走覆盖通道");

		b.setApprovalChannel(undefined);
		assert.equal(a.getApprovalChannel(), undefined, "清空是改共享那份的字段，两边一起恢复默认");
	});
});

describe("gui-diagnosis：回退提示按进程去重", () => {
	it("A 弹过一次的原因，B 不再弹（同一条通知不重复）", async () => {
		const [a, b] = await loadTwice("./gui-diagnosis.ts");
		a.resetGuiFallbackNotices();

		const diag = {
			binary: null,
			candidates: a.guiBinaryCandidates().map((p: string) => ({ path: p, exists: false, executable: false })),
			repoRoot: "/repo",
			hasHubSocket: true,
			hubUnitActive: true,
			hasWailsCli: true,
			hasGo: true,
			hasFrontendDist: true,
			hasWebkit2Gtk41: true,
			hasDisplayEnv: true,
		};
		const seen: string[] = [];
		const ctx = { ui: { notify: (m: string) => void seen.push(m) } };

		assert.notEqual(a.announceGuiFallback(ctx, "no-binary", { diagnosis: diag }), "");
		assert.equal(
			b.announceGuiFallback(ctx, "no-binary", { diagnosis: diag }),
			"",
			"另一个实例必须看到同一条去重记录（否则每个扩展各弹一次）",
		);
		assert.equal(seen.length, 1, "同一原因整进程只弹一次");

		b.resetGuiFallbackNotices();
		assert.notEqual(a.announceGuiFallback(ctx, "no-binary", { diagnosis: diag }), "", "reset 后可再提示");
		a.resetGuiFallbackNotices();
	});
});

describe("model-selection：偏好文件的写入串行化队列", () => {
	it("两个实例排同一条链，A 挂起的写入挡住 B 的读", async () => {
		const [a, b] = await loadTwice("./model-selection.ts");
		assert.equal(
			a.preferenceWriteQueueForTest.tail(),
			b.preferenceWriteQueueForTest.tail(),
			"同一文件被两个扩展写，必须排同一条队列（各排各的等于没排队）",
		);

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const gated = a.preferenceWriteQueueForTest.enqueue(() => gate);

		// B 的读要等共享队列上的写入落完（读的是真实的偏好文件，只读）
		let readSettled = false;
		const read = b.readModelPreferences().then(
			() => void (readSettled = true),
			() => void (readSettled = true),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(readSettled, false, "队列上还挂着写入，B 的读不该结束");

		release();
		await gated;
		await read;
		assert.equal(readSettled, true, "闸门放开后读正常完成");
	});
});

describe("preshell：熔断器与提示去重跨扩展共享", () => {
	it("A 试出缺件熔断后，B 不再去 spawn 也弹一次", async () => {
		const [a, b] = await loadTwice("./preshell.ts");
		a.resetPreshellBreaker();
		a.resetFactLayerNotices();

		const config = { enabled: true, bin: "/nonexistent/preshell-probe-for-test", timeoutMs: 100, expectedVersion: "0.4" };
		const first = a.analyzeCommand("echo probe", { config });
		assert.equal(first.ok, false);
		assert.equal(b.preshellBreakerState().broken, "missing", "一个扩展试出熔断，其它扩展必须知道");

		const second = b.analyzeCommand("echo probe-other", { config });
		assert.equal(second.ok, false);
		assert.match(second.detail ?? "", /熔断/, "熔断后不再尝试，直接走保守兜底");

		// 提示去重与状态栏标志
		const statusCalls: Array<[string, string | undefined]> = [];
		const ui = {
			setStatus: (key: string, text?: string) => void statusCalls.push([key, text]),
			notify: () => {},
		};
		const deps = { desktopNotify: () => {} };

		assert.notEqual(a.notifyFactLayerUnavailable(ui, "missing", undefined, deps), "");
		assert.equal(
			b.notifyFactLayerUnavailable(ui, "missing", undefined, deps),
			"",
			"同一原因在别的扩展里也必须算已弹过",
		);
		b.clearFactLayerStatus(ui);
		assert.deepEqual(statusCalls.at(-1), ["preshell", undefined], "状态栏标志也是共享的，B 能收掉 A 设的状态");

		a.resetFactLayerNotices();
		a.resetPreshellBreaker();
	});
});
