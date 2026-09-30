// jobs-panel.test.ts — 面板纯逻辑测试（合并视图 / 取消分流 / 尾部截断）
//
// 跑法：node --test --experimental-strip-types extensions/dsh-jobs/jobs-panel.test.ts

import { spawn } from "node:child_process";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { cancelRow, collectRows, REFRESH_MS, rowText, TAIL_CHARS, tailOf, type PanelRow } from "./jobs-panel.ts";
import type { JobRegistry, JobSnapshot } from "./registry.ts";
import { readKillRequests, type OwnerInfo } from "./snapshot.ts";

/** 测试用 agent 目录：快照层按 PI_CODING_AGENT_DIR 定位 job-state，指到临时目录即隔离 */
const agentDir = mkdtempSync(join(tmpdir(), "jobs-panel-test-"));
const stateDir = join(agentDir, "job-state");
process.env.PI_CODING_AGENT_DIR = agentDir;

// 快照层拿 pid 探活（ESRCH 判死），所以测试里的 pid 必须是真实存在的进程：
// owner 借一个 spawn 出来的 sleep（与 worker 区分开），worker 用测试进程自己。
// 假 pid 会被当成死进程的残留直接跳过，那样测的是过滤而不是合并视图。
const ownerChild = spawn("sleep", ["30"], { stdio: "ignore" });
const owner: OwnerInfo = { kind: "main", pid: ownerChild.pid ?? 1, cwd: "/tmp", label: "主进程" };
const worker: OwnerInfo = { kind: "worker", pid: process.pid, taskId: "batch-x-w1", cwd: "/tmp", label: "worker batch-x-w1" };

function snapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
	return {
		id: "bash-1",
		kind: "bash",
		label: "sleep 60",
		status: "running",
		startedAt: Date.now() - 5_000,
		reported: false,
		...overrides,
	};
}

/** 只实现面板用到的那几个方法；kill 记录调用以便断言 */
function fakeRegistry(own: JobSnapshot[], outputs: Record<string, string> = {}, killResult: "requested" | "already-finished" = "requested") {
	const killed: string[] = [];
	const registry = {
		list: () => own,
		peekOutput: (id: string) => outputs[id] ?? "",
		kill: (id: string) => {
			killed.push(id);
			return killResult;
		},
	} as unknown as JobRegistry;
	return { registry, killed };
}

/** 按 snapshot.ts 的文件名规则落一份快照：owner-<kind>[-<taskId>]-<pid>.json */
function writeOwnerFile(who: OwnerInfo, jobs: unknown[]): void {
	const parts = ["owner", who.kind, ...(who.kind === "worker" && who.taskId ? [who.taskId] : []), String(who.pid)];
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(
		join(stateDir, `${parts.join("-")}.json`),
		JSON.stringify({ version: 1, owner: who, updatedAt: Date.now(), jobs }),
		"utf8",
	);
}

before(() => {
	rmSync(stateDir, { recursive: true, force: true });
	mkdirSync(stateDir, { recursive: true });
});

// 每个用例从干净的 job-state 开始：用例之间共享同一个 agent 目录，
// 上一个用例写下的快照会混进下一个用例的合并视图（排序后 rows[0] 就不是被测那条了）
beforeEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

after(() => {
	ownerChild.kill();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("tailOf", () => {
	it("短输出原样返回", () => {
		assert.equal(tailOf("hello"), "hello");
	});

	it("超长只留尾部 TAIL_CHARS 个字符", () => {
		// 用两段不同字符区分头尾：全是同一个字符的话「留尾部」和「留头部」在结果上分不出来
		const tail = tailOf("a".repeat(100) + "b".repeat(TAIL_CHARS + 100));
		assert.equal(tail.length, TAIL_CHARS);
		assert.ok(tail.startsWith("b"), "保留的是尾部");
		assert.ok(!tail.includes("a"), "头部那段被切掉");
	});
});

describe("collectRows", () => {
	it("本进程任务走实时 registry，输出来自 peekOutput（不消费增量）", () => {
		const { registry } = fakeRegistry([snapshot()], { "bash-1": "line1\nline2" });
		const rows = collectRows(registry, owner);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].live, true);
		assert.equal(rows[0].record.tail, "line1\nline2");
	});

	it("合并别的进程的快照，且本 pid 的快照不重复计入", () => {
		const { registry } = fakeRegistry([snapshot()]);
		// 自己的快照（同 pid）应被忽略，worker 的快照应计入
		writeOwnerFile(owner, [snapshot({ id: "bash-99" })]);
		writeOwnerFile(worker, [snapshot({ id: "bash-7", label: "npm run dev" })]);
		const rows = collectRows(registry, owner);
		const ids = rows.map((r) => r.record.id).sort();
		assert.deepStrictEqual(ids, ["bash-1", "bash-7"]);
		assert.equal(rows.find((r) => r.record.id === "bash-7")?.live, false);
	});

	// 死进程残留的过滤由 snapshot.test.ts 覆盖（那里能构造真实的已退出 pid），
	// 这里不重复：面板测试拿不到「刚死的真实 pid」这个条件。

	it("活跃任务排在终态之前", () => {
		const { registry } = fakeRegistry([
			snapshot({ id: "bash-1", status: "completed", startedAt: 1000, finishedAt: 2000 }),
			snapshot({ id: "bash-2", status: "running", startedAt: 1500 }),
		]);
		const rows = collectRows(registry, owner);
		assert.deepStrictEqual(rows.map((r) => r.record.id), ["bash-2", "bash-1"]);
	});
});

describe("cancelRow", () => {
	it("本进程任务直接走 registry.kill，不写请求文件", () => {
		const { registry, killed } = fakeRegistry([snapshot()]);
		const rows = collectRows(registry, owner);
		assert.equal(cancelRow(registry, owner, rows[0]), "local-requested");
		assert.deepStrictEqual(killed, ["bash-1"]);
	});

	it("别的进程的任务写 kill 请求文件（由对方自己消费）", () => {
		const { registry, killed } = fakeRegistry([]);
		writeOwnerFile(worker, [snapshot({ id: "bash-42" })]);
		const row = collectRows(registry, owner).find((r) => r.record.id === "bash-42") as PanelRow;
		assert.ok(row, "worker 的任务应出现在合并视图里");
		assert.equal(cancelRow(registry, owner, row), "remote-requested");
		assert.deepStrictEqual(killed, [], "跨进程不能直接动别人的 registry");
		// 请求文件确实落盘，且读走即删（readKillRequests 读后删除）
		assert.deepStrictEqual(readKillRequests(worker), ["bash-42"]);
		assert.deepStrictEqual(readKillRequests(worker), []);
	});

	it("registry.kill 抛错（任务刚结算）算失败，不炸面板", () => {
		const registry = {
			list: () => [snapshot()],
			peekOutput: () => "",
			kill: () => {
				throw new Error("job bash-1 not found");
			},
		} as unknown as JobRegistry;
		const row = collectRows(registry, owner)[0];
		assert.equal(cancelRow(registry, owner, row), "failed");
	});
});

describe("rowText", () => {
	const theme = { fg: (_token: string, text: string) => text };

	it("含 id、状态、时长与来源进程标记", () => {
		const { registry } = fakeRegistry([snapshot({ status: "running" })]);
		const row = collectRows(registry, owner)[0];
		const text = rowText(row, 100, theme);
		assert.ok(text.includes("bash-1"));
		assert.ok(text.includes("running"));
		assert.ok(text.includes("[主]"));
		assert.ok(text.includes("sleep 60"));
	});

	it("长命令压成一行并截断（列表逐行渲染不能被换行破坏）", () => {
		const long = "echo " + "a".repeat(200);
		const { registry } = fakeRegistry([snapshot({ label: `line1\n${long}` })]);
		const row = collectRows(registry, owner)[0];
		const text = rowText(row, 60, theme);
		assert.ok(!text.includes("\n"), "不能带换行");
		assert.ok(text.includes("…"), "超宽应截断");
	});

	it("worker 任务标记为 w:<taskId>", () => {
		const row: PanelRow = {
			owner: worker,
			live: false,
			record: { id: "bash-9", kind: "bash", label: "npm run dev", status: "running", startedAt: Date.now() },
		};
		assert.ok(rowText(row, 100, theme).includes("w:batch-x-w1"));
	});
});

describe("常量", () => {
	it("刷新节拍是秒级（面板依赖它跟跨进程状态）", () => {
		assert.ok(REFRESH_MS > 0 && REFRESH_MS <= 5000);
	});
});
