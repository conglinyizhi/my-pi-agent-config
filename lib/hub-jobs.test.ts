// hub-jobs.test.ts — dsh-jobs 的 hub 加速通道（假 hub server，不碰真 socket）
//
// 跑法：node --test --experimental-strip-types lib/hub-jobs.test.ts

import assert from "node:assert";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pushJobUpdate, watchJobUpdates } from "./hub-jobs.ts";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const s of servers.splice(0)) {
		await new Promise<void>((r) => s.close(() => r()));
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sockPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "hub-jobs-"));
	dirs.push(dir);
	return join(dir, "hub.sock");
}

/** 起一个假 hub：记录收到的消息，按脚本应答 */
function fakeHub(
	path: string,
	onLine: (line: any, conn: Socket) => void,
): Promise<void> {
	const server = createServer((conn) => {
		let buf = "";
		conn.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const raw = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!raw.trim()) continue;
				try {
					onLine(JSON.parse(raw), conn);
				} catch {}
			}
		});
		conn.on("error", () => {});
	});
	servers.push(server);
	return new Promise((resolve) => server.listen(path, resolve));
}

function send(conn: Socket, msg: unknown) {
	conn.write(`${JSON.stringify(msg)}\n`);
}

describe("pushJobUpdate", () => {
	it("hub 在线：握手后推 payload，收到 jobpush-ok 返回 true", async () => {
		const path = sockPath();
		const seen: any[] = [];
		await fakeHub(path, (line, conn) => {
			seen.push(line);
			if (line.type === "hello") send(conn, { v: 1, type: "hello-ok", role: "pi" });
			if (line.type === "jobpush") send(conn, { v: 1, type: "jobpush-ok", id: line.id });
		});

		const ok = await pushJobUpdate({ file: "owner-main-1.json" }, { socketPath: path });
		assert.equal(ok, true);
		assert.deepEqual(seen.map((m) => m.type), ["hello", "jobpush"]);
		assert.equal(seen[0].role, "pi");
		assert.deepEqual(seen[1].payload, { file: "owner-main-1.json" });
	});

	it("hub 不在（socket 不存在）：静默返回 false，不抛", async () => {
		const ok = await pushJobUpdate({ n: 1 }, { socketPath: join(tmpdir(), `no-such-hub-${Date.now()}.sock`) });
		assert.equal(ok, false);
	});

	it("hub 收了但不回执：超时返回 false，不挂住", async () => {
		const path = sockPath();
		await fakeHub(path, (line, conn) => {
			if (line.type === "hello") send(conn, { v: 1, type: "hello-ok" });
			// jobpush 故意不回
		});
		const ok = await pushJobUpdate({ n: 1 }, { socketPath: path, timeoutMs: 100 });
		assert.equal(ok, false);
	});

	it("sessionId 随推送带上（多 session 时供 hub 转发）", async () => {
		const path = sockPath();
		const seen: any[] = [];
		await fakeHub(path, (line, conn) => {
			seen.push(line);
			if (line.type === "hello") send(conn, { v: 1, type: "hello-ok" });
			if (line.type === "jobpush") send(conn, { v: 1, type: "jobpush-ok" });
		});
		await pushJobUpdate({ n: 1 }, { socketPath: path, sessionId: "sess-42" });
		assert.equal(seen.find((m) => m.type === "jobpush").sessionId, "sess-42");
	});
});

describe("watchJobUpdates", () => {
	it("hub 在线：订阅后收到 jobupdate，回调拿到 payload", async () => {
		const path = sockPath();
		let connRef: Socket | undefined;
		await fakeHub(path, (line, conn) => {
			if (line.type === "hello") {
				connRef = conn;
				send(conn, { v: 1, type: "hello-ok" });
			}
			if (line.type === "jobwatch") send(conn, { v: 1, type: "jobwatch-ok" });
		});

		const got: Record<string, unknown>[] = [];
		const cancel = await watchJobUpdates((p) => got.push(p), { socketPath: path });
		assert.ok(cancel, "hub 在线应当返回取消函数");

		// 等 hello/jobwatch 走完再推
		await new Promise((r) => setTimeout(r, 50));
		send(connRef!, { v: 1, type: "jobupdate", payload: { file: "a.json" } });
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(got.length, 1);
		assert.deepEqual(got[0], { file: "a.json" });
		cancel!();
	});

	it("hub 不在：返回 undefined（调用方据此保持轮询）", async () => {
		const cancel = await watchJobUpdates(() => {}, {
			socketPath: join(tmpdir(), `no-such-hub-${Date.now()}.sock`),
		});
		assert.equal(cancel, undefined);
	});

	it("回调抛错不影响后续通知", async () => {
		const path = sockPath();
		let connRef: Socket | undefined;
		await fakeHub(path, (line, conn) => {
			if (line.type === "hello") {
				connRef = conn;
				send(conn, { v: 1, type: "hello-ok" });
			}
			if (line.type === "jobwatch") send(conn, { v: 1, type: "jobwatch-ok" });
		});

		let calls = 0;
		const cancel = await watchJobUpdates(() => {
			calls += 1;
			if (calls === 1) throw new Error("消费方炸了");
		}, { socketPath: path });

		await new Promise((r) => setTimeout(r, 50));
		send(connRef!, { v: 1, type: "jobupdate", payload: { n: 1 } });
		await new Promise((r) => setTimeout(r, 30));
		send(connRef!, { v: 1, type: "jobupdate", payload: { n: 2 } });
		await new Promise((r) => setTimeout(r, 30));

		assert.equal(calls, 2, "第一次抛错不该断掉订阅");
		cancel!();
	});

	it("取消后再收到通知不再回调", async () => {
		const path = sockPath();
		let connRef: Socket | undefined;
		await fakeHub(path, (line, conn) => {
			if (line.type === "hello") {
				connRef = conn;
				send(conn, { v: 1, type: "hello-ok" });
			}
			if (line.type === "jobwatch") send(conn, { v: 1, type: "jobwatch-ok" });
		});

		let calls = 0;
		const cancel = await watchJobUpdates(() => { calls += 1; }, { socketPath: path });
		await new Promise((r) => setTimeout(r, 50));
		cancel!();
		send(connRef!, { v: 1, type: "jobupdate", payload: { n: 1 } });
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(calls, 0);
	});
});
