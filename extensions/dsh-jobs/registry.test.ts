// registry.test.ts — dsh-jobs 注册表语义测试（DSH JobRegistry 逐条对照）
//
// 跑法：node --experimental-strip-types extensions/dsh-jobs/registry.test.ts

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { JobsError, JobRegistry, type JobHooks, type JobOutcome } from "./registry.ts";

/** 立即完成的 fake 任务 */
function immediateJob(outcome: JobOutcome, output?: string) {
	return {
		kind: "bash",
		label: "immediate",
		run(): JobHooks {
			return { cancel: () => {}, done: Promise.resolve(outcome), readOutput: () => output ?? "" };
		},
	};
}

/** 可控结算的 fake 任务 */
function controlledJob() {
	let resolveDone!: (o: JobOutcome) => void;
	const hooks: JobHooks = {
		cancel: () => {},
		done: new Promise<JobOutcome>((r) => (resolveDone = r)),
		readOutput: () => "",
	};
	return { hooks, settle: (o: JobOutcome) => resolveDone(o) };
}

describe("JobRegistry", () => {
	it("start：id = <kind>-N 注册序", () => {
		const r = new JobRegistry();
		const id1 = r.start(immediateJob({ status: "completed" }));
		const id2 = r.start(immediateJob({ status: "completed" }));
		assert.equal(id1, "bash-1");
		assert.equal(id2, "bash-2");
	});

	it("list/get：快照为新鲜对象（非活注册表状态）", async () => {
		const r = new JobRegistry();
		const id = r.start(immediateJob({ status: "completed" }));
		await r.wait(id, 1000);
		const snap1 = r.get(id);
		const snap2 = r.get(id);
		assert.notEqual(snap1, snap2);
		assert.equal(snap1.status, "completed");
		assert.equal(r.list().length, 1);
	});

	it("未知 id 抛 JobsError", () => {
		const r = new JobRegistry();
		assert.throws(() => r.get("bash-99"), (e: unknown) => e instanceof JobsError && e.code === "JOB_NOT_FOUND");
	});

	it("结算：status/detail/finishedAt + 终态读幂等返回输出，reported 终态置位", async () => {
		const r = new JobRegistry();
		const job = controlledJob();
		const id = r.start({ kind: "bash", label: "job", run: () => ({ ...job.hooks, readOutput: () => "hello output" }) });
		assert.equal(r.get(id).reported, false);
		job.settle({ status: "completed", detail: "exit code: 0" });
		await new Promise((res) => setTimeout(res, 0)); // 等 settle 微任务
		assert.equal(r.get(id).status, "completed");
		assert.equal(r.get(id).reported, false); // settle 本身不置 reported
		const read1 = r.read(id); // 终态读
		assert.equal(read1.text, "hello output");
		assert.equal(r.get(id).reported, true);
		const read2 = r.read(id); // 幂等
		assert.equal(read2.text, "hello output");
	});

	it("kill：running → stopping → 结算 killed；已终态返回 already-finished", async () => {
		const r = new JobRegistry();
		const job = controlledJob();
		const id = r.start({ kind: "bash", label: "slow", run: () => job.hooks });
		assert.equal(r.kill(id, "不再需要"), "requested");
		assert.equal(r.get(id).status, "stopping");
		job.settle({ status: "killed", detail: "killed by signal" });
		await r.wait(id, 1000);
		assert.equal(r.get(id).status, "killed");
		assert.equal(r.kill(id), "already-finished");
	});

	it("wait：超时返回 running（任务存活）；终态后立即返回", async () => {
		const r = new JobRegistry();
		const job = controlledJob();
		const id = r.start({ kind: "bash", label: "slow", run: () => job.hooks });
		const timedOut = await r.wait(id, 50);
		assert.equal(timedOut.status, "running");
		job.settle({ status: "completed" });
		const settled = await r.wait(id, 1000);
		assert.equal(settled.status, "completed");
	});

	it("wait：abort 取消等待本身", async () => {
		const r = new JobRegistry();
		const job = controlledJob();
		const id = r.start({ kind: "bash", label: "slow", run: () => job.hooks });
		const ac = new AbortController();
		const waited = r.wait(id, 5000, ac.signal);
		ac.abort();
		const snap = await waited;
		assert.equal(snap.status, "running");
	});

	it("onJobDone：first-wins 一次性通知", async () => {
		const r = new JobRegistry();
		const notified: string[] = [];
		r.onJobDone((snap) => {
			notified.push(snap.id);
		});
		const id = r.start(immediateJob({ status: "completed" }));
		await r.wait(id, 1000);
		assert.deepEqual(notified, [id]); // 恰好一次
	});

	it("onJobDone：结算前已报告（kill）则跳过通知（reported 去重）", async () => {
		const r = new JobRegistry();
		const notified: string[] = [];
		r.onJobDone((snap) => {
			notified.push(snap.id);
		});
		const job = controlledJob();
		const id = r.start({ kind: "bash", label: "slow", run: () => job.hooks });
		r.kill(id, "stop"); // 请求取消 → reported（照抄 DSH）
		job.settle({ status: "killed" });
		await r.wait(id, 1000);
		assert.deepEqual(notified, []); // 结算时已 reported → 无通知
	});

	it("生产者 done reject → failed", async () => {
		const r = new JobRegistry();
		const id = r.start({
			kind: "bash",
			label: "boom",
			run: () => ({ cancel: () => {}, done: Promise.reject(new Error("boom")) }),
		});
		const snap = await r.wait(id, 1000);
		assert.equal(snap.status, "failed");
	});

	it("流式 readOutput：只返回自上次以来的增量", async () => {
		const r = new JobRegistry();
		let buffer = "";
		const job = controlledJob();
		const id = r.start({
			kind: "bash",
			label: "stream",
			run: () => ({ ...job.hooks, readOutput: () => buffer }),
		});
		buffer = "line1\n";
		assert.equal(r.read(id).text, "line1\n");
		buffer = "line1\nline2\n";
		assert.equal(r.read(id).text, "line2\n"); // 增量
		job.settle({ status: "completed" });
		await r.wait(id, 1000);
		assert.equal(r.read(id).text, ""); // 终态 readOutput 已排空
	});

	after(() => {});
});
