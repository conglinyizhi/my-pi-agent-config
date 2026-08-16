// providers.test.ts — dsh-jobs bash 后台提供方集成测试（真实 spawn）
//
// 跑法：node --experimental-strip-types extensions/dsh-jobs/providers.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JobRegistry } from "./registry.ts";
import { bashBackground } from "./providers.ts";

describe("bashBackground provider（真实子进程）", () => {
	it("echo 完成：completed + 输出", async () => {
		const r = new JobRegistry();
		const id = r.start(bashBackground("echo hello-job", { cwd: "/tmp" }));
		const snap = await r.wait(id, 5000);
		assert.equal(snap.status, "completed");
		const read = r.read(id);
		assert.match(read.text, /hello-job/);
	});

	it("失败命令 → failed + exit code", async () => {
		const r = new JobRegistry();
		const id = r.start(bashBackground("exit 3", { cwd: "/tmp" }));
		const snap = await r.wait(id, 5000);
		assert.equal(snap.status, "failed");
		assert.match(snap.detail ?? "", /exit code: 3/);
	});

	it("kill 长任务 → killed", async () => {
		const r = new JobRegistry();
		const id = r.start(bashBackground("sleep 30", { cwd: "/tmp" }));
		assert.equal(r.get(id).status, "running");
		assert.equal(r.kill(id, "测试停止"), "requested");
		const snap = await r.wait(id, 5000);
		assert.equal(snap.status, "killed");
	});

	it("流式读取增量（sleep 分阶段输出）", async () => {
		const r = new JobRegistry();
		const id = r.start(
			bashBackground("echo first; sleep 0.3; echo second", { cwd: "/tmp" }),
		);
		// 等 first 出现
		await new Promise((res) => setTimeout(res, 300));
		const first = r.read(id);
		assert.match(first.text, /first/);
		const snap = await r.wait(id, 5000);
		assert.equal(snap.status, "completed");
		const rest = r.read(id); // 终态后全量
		assert.match(rest.text, /second/);
	});
});
