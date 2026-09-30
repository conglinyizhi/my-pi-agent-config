// snapshot.test.ts — dsh-jobs 共享快照层测试（跨进程任务视图 + kill 请求）
//
// 跑法：node --test --experimental-strip-types extensions/dsh-jobs/snapshot.test.ts
//
// 隔离：把 PI_CODING_AGENT_DIR 指到临时目录，job-state 落在里面，不碰真实的 agent 目录。
// 注意 worker 里跑测试时 PI_SUBAGENT / PI_TASK_ID 是真值，身份相关用例得自己控制这两个变量。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
	currentOwner,
	JOB_STATE_DIR_NAME,
	jobStateDir,
	pruneStaleSnapshots,
	readAllSnapshots,
	readKillRequests,
	removeOwnerSnapshot,
	writeKillRequest,
	writeOwnerSnapshot,
	type JobRecord,
	type OwnerInfo,
} from "./snapshot.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-jobs-snapshot-"));
process.env.PI_CODING_AGENT_DIR = tmpRoot;

const savedEnv = {
	subagent: process.env.PI_SUBAGENT,
	taskId: process.env.PI_TASK_ID,
	sessionId: process.env.PI_SESSION_ID,
};

/** 清掉父进程带来的身份变量：默认按主进程语境跑 */
function clearOwnerEnv(): void {
	delete process.env.PI_SUBAGENT;
	delete process.env.PI_TASK_ID;
	delete process.env.PI_SESSION_ID;
}

beforeEach(() => {
	clearOwnerEnv();
	rmSync(jobStateDir(), { recursive: true, force: true });
});

after(() => {
	clearOwnerEnv();
	if (savedEnv.subagent !== undefined) process.env.PI_SUBAGENT = savedEnv.subagent;
	if (savedEnv.taskId !== undefined) process.env.PI_TASK_ID = savedEnv.taskId;
	if (savedEnv.sessionId !== undefined) process.env.PI_SESSION_ID = savedEnv.sessionId;
	rmSync(tmpRoot, { recursive: true, force: true });
});

function ownerOf(overrides: Partial<OwnerInfo> = {}): OwnerInfo {
	return { kind: "main", pid: process.pid, cwd: "/proj", label: "主进程", ...overrides };
}

function jobOf(overrides: Partial<JobRecord> = {}): JobRecord {
	return { id: "bash-1", kind: "bash", label: "pnpm test", status: "running", startedAt: 1_700_000_000_000, ...overrides };
}

/** 找一个确实不存在的 pid：pid_max 内从高位往下试，拿 ESRCH 即用（快照的 stale 判定靠它） */
function freePid(): number {
	for (let pid = 4_000_000; pid > 100_000; pid -= 1) {
		try {
			process.kill(pid, 0);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid;
		}
	}
	throw new Error("找不到空闲 pid 构造 stale 快照");
}

describe("jobStateDir / currentOwner", () => {
	it("共享目录挂在 agent 目录下的 job-state", () => {
		assert.equal(JOB_STATE_DIR_NAME, "job-state");
		assert.equal(jobStateDir(), join(tmpRoot, "job-state"));
	});

	it("主进程身份：没有 PI_SUBAGENT / PI_TASK_ID 时是 main", () => {
		const owner = currentOwner();
		assert.equal(owner.kind, "main");
		assert.equal(owner.pid, process.pid);
		assert.equal(owner.taskId, undefined);
		assert.equal(owner.label, "主进程");
		assert.equal(owner.cwd, process.cwd());
	});

	it("worker 身份：PI_SUBAGENT / PI_TASK_ID 存在时是 worker，标签带 task id", () => {
		process.env.PI_SUBAGENT = "1";
		process.env.PI_TASK_ID = "w2";
		const owner = currentOwner();
		assert.equal(owner.kind, "worker");
		assert.equal(owner.taskId, "w2");
		assert.equal(owner.label, "worker w2");
	});

	it("PI_SUBAGENT 为空串等于没设（环境变量赋空不该翻转身份）", () => {
		process.env.PI_SUBAGENT = "";
		assert.equal(currentOwner().kind, "main");
	});
});

describe("快照读写", () => {
	it("写/读往返：owner 与 jobs 原样读回，版本固定 1", () => {
		const owner = ownerOf({ pid: process.pid });
		const jobs = [jobOf(), jobOf({ id: "bash-2", status: "completed", finishedAt: 1_700_000_001_000, detail: "exit code: 0", tail: "last line" })];
		writeOwnerSnapshot(owner, jobs);

		const { owners, staleFiles } = readAllSnapshots();
		assert.deepEqual(staleFiles, []);
		assert.equal(owners.length, 1);
		assert.equal(owners[0].version, 1);
		assert.deepEqual(owners[0].owner, owner);
		assert.deepEqual(owners[0].jobs, jobs);
		assert.equal(typeof owners[0].updatedAt, "number");
	});

	it("多进程快照合并：主进程与 worker 各写一份，读方都看得到", () => {
		writeOwnerSnapshot(ownerOf(), [jobOf()]);
		writeOwnerSnapshot(ownerOf({ kind: "worker", taskId: "w1", label: "worker w1" }), [jobOf({ id: "bash-7" })]);
		writeOwnerSnapshot(ownerOf({ kind: "worker", taskId: "w2", label: "worker w2" }), []);

		const { owners } = readAllSnapshots();
		assert.equal(owners.length, 3);
		const labels = owners.map((s) => s.owner.label).sort();
		assert.deepEqual(labels, ["worker w1", "worker w2", "主进程"]);
		assert.deepEqual(owners.flatMap((s) => s.jobs.map((j) => j.id)).sort(), ["bash-1", "bash-7"]);
	});

	it("目录不存在时读操作不抛：空列表 + prune 返回 0", () => {
		assert.equal(existsSync(jobStateDir()), false);
		assert.deepEqual(readAllSnapshots(), { owners: [], staleFiles: [] });
		assert.deepEqual(readKillRequests(ownerOf()), []);
		assert.equal(pruneStaleSnapshots(), 0);
	});

	it("损坏 / 半写 / 缺字段的快照一律跳过，不拖垮其它文件", () => {
		writeOwnerSnapshot(ownerOf(), [jobOf()]);
		writeFileSync(join(jobStateDir(), "owner-main-999.json"), '{"version":1,"owner":{"kind":"ma');
		writeFileSync(join(jobStateDir(), "owner-worker-999.json"), "null");
		writeFileSync(join(jobStateDir(), "owner-worker-998.json"), JSON.stringify({ version: 1, jobs: [] }));

		const { owners, staleFiles } = readAllSnapshots();
		assert.equal(owners.length, 1);
		assert.equal(owners[0].owner.pid, process.pid);
		assert.deepEqual(staleFiles, []);
	});

	it("暂存文件（*.tmp）不参与读取", () => {
		writeOwnerSnapshot(ownerOf(), [jobOf()]);
		writeFileSync(join(jobStateDir(), "owner-main-424242.json.999.tmp"), JSON.stringify({ version: 1, owner: { kind: "main", pid: 424242 }, jobs: [] }));
		assert.equal(readAllSnapshots().owners.length, 1);
	});

	it("写快照先写 tmp 再 rename，目录里不留 tmp", () => {
		writeOwnerSnapshot(ownerOf(), [jobOf()]);
		writeOwnerSnapshot(ownerOf(), [jobOf(), jobOf({ id: "bash-2" })]);
		const names = readdirSync(jobStateDir());
		assert.deepEqual(names.filter((n) => n.endsWith(".tmp")), []);
		assert.equal(readAllSnapshots().owners[0].jobs.length, 2);
	});

	it("removeOwnerSnapshot 清掉自己那份", () => {
		const owner = ownerOf();
		writeOwnerSnapshot(owner, [jobOf()]);
		removeOwnerSnapshot(owner);
		assert.deepEqual(readAllSnapshots(), { owners: [], staleFiles: [] });
		removeOwnerSnapshot(owner); // 幂等：再删一次不抛
	});
});

describe("stale 判定与清理", () => {
	it("死进程的快照算 stale，pruneStaleSnapshots 删掉它并返回数量", () => {
		const dead = freePid();
		writeOwnerSnapshot(ownerOf(), [jobOf()]);
		writeOwnerSnapshot(ownerOf({ kind: "worker", taskId: "w9", pid: dead, label: "worker w9" }), [jobOf({ id: "bash-9" })]);

		const { owners, staleFiles } = readAllSnapshots();
		assert.equal(owners.length, 1);
		assert.equal(staleFiles.length, 1);
		assert.ok(staleFiles[0].includes(`-${dead}.json`));

		assert.equal(pruneStaleSnapshots(), 1);
		assert.equal(existsSync(staleFiles[0]), false);
		assert.deepEqual(readAllSnapshots().staleFiles, []);
		assert.equal(readAllSnapshots().owners.length, 1);
	});

	it("目标进程已死的 kill 请求也会被 prune 清掉（没人来消费的请求不该攒着）", () => {
		const dead = freePid();
		writeKillRequest(ownerOf({ pid: dead }), "bash-3");
		assert.deepEqual(readKillRequests(ownerOf()), []); // 不是发给我的

		assert.equal(pruneStaleSnapshots(), 1);
		assert.deepEqual(readdirSync(jobStateDir()).filter((n) => n.startsWith("kill-")), []);
	});

	it("pid 非法的快照按已死处理（负 pid 会命中进程组，不能当活进程）", () => {
		mkdirSync(jobStateDir(), { recursive: true });
		writeFileSync(
			join(jobStateDir(), "owner-worker-0.json"),
			JSON.stringify({ version: 1, owner: { kind: "worker", pid: 0, cwd: "", label: "worker" }, jobs: [] }),
		);
		assert.equal(readAllSnapshots().owners.length, 0);
		assert.equal(readAllSnapshots().staleFiles.length, 1);
	});
});

describe("kill 请求", () => {
	it("写请求 → 目标读走并删除（读后即删，不重复投递）", () => {
		const me = ownerOf();
		writeKillRequest(me, "bash-3");
		assert.deepEqual(readKillRequests(me), ["bash-3"]);
		assert.deepEqual(readKillRequests(me), []);
		assert.deepEqual(readdirSync(jobStateDir()).filter((n) => n.startsWith("kill-")), []);
	});

	it("不是发给我的请求读不到，留给目标进程", () => {
		const other = freePid();
		writeKillRequest(ownerOf({ pid: other }), "bash-4");
		assert.deepEqual(readKillRequests(ownerOf()), []);
		assert.deepEqual(readKillRequests(ownerOf({ pid: other, kind: "worker" })), ["bash-4"]);
	});

	it("同一 job 的重复请求只返回一次（去重后交给 registry.kill）", () => {
		const me = ownerOf();
		writeKillRequest(me, "bash-5");
		writeKillRequest(me, "bash-5");
		assert.deepEqual(readKillRequests(me), ["bash-5"]);
		assert.deepEqual(readdirSync(jobStateDir()).filter((n) => n.startsWith("kill-")), []);
	});

	it("jobId 里的路径分隔符不会把请求写到自己家门外", () => {
		const me = ownerOf();
		writeKillRequest(me, "../../etc/passwd");
		const files = readdirSync(jobStateDir()).filter((n) => n.startsWith("kill-"));
		assert.equal(files.length, 1);
		assert.ok(!files[0].includes("/"));
		assert.deepEqual(readKillRequests(me), ["../../etc/passwd"]);
	});

	it("损坏的请求文件读时被清掉，不卡住后续请求", () => {
		const me = ownerOf();
		mkdirSync(jobStateDir(), { recursive: true });
		writeFileSync(join(jobStateDir(), `kill-${process.pid}-broken.json`), "{not json");
		writeKillRequest(me, "bash-6");
		assert.deepEqual(readKillRequests(me), ["bash-6"]);
		assert.deepEqual(readdirSync(jobStateDir()).filter((n) => n.startsWith("kill-")), []);
	});
});
