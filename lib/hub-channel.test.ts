import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { askHubQuestion, createHubThenLocalChannel } from "./hub-channel.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-hub-channel-"));
after(() => {
	rmSync(dir, { recursive: true, force: true });
});

function ctx() {
	return { sessionManager: { getSessionId: () => "sess-1" }, hasUI: false, ui: undefined } as never;
}

const request = {
	kind: "audit" as const,
	command: "sudo ls",
	reason: "sudo",
};

describe("createHubThenLocalChannel", () => {
	it("hub 在线时走 socket 决断，不回退本地", async () => {
		const sock = join(dir, "hub.sock");
		const server = createServer(conn => {
			let buf = "";
			conn.on("data", chunk => {
				buf += chunk.toString("utf8");
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line.trim()) continue;
					const msg = JSON.parse(line) as { type?: string; requestId?: string };
					if (msg.type === "hello") {
						conn.write(`${JSON.stringify({ v: 1, type: "hello-ok", role: "pi" })}\n`);
					}
					if (msg.type === "ask") {
						conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId })}\n`);
						conn.write(`${JSON.stringify({
							v: 1,
							type: "settled",
							requestId: msg.requestId,
							action: "allow",
							comment: "hub",
						})}\n`);
					}
				}
			});
		});
		await new Promise<void>(resolve => server.listen(sock, resolve));
		try {
			const channel = createHubThenLocalChannel({ socketPath: sock });
			const decision = await channel(request, ctx());
			assert.equal(decision.action, "allow");
			assert.equal(decision.comment, "hub");
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("hub 不在时回退本地通道，不弹真窗口", async () => {
		let localHits = 0;
		const channel = createHubThenLocalChannel({
			socketPath: join(dir, "missing.sock"),
			local: async () => {
				localHits += 1;
				return { action: "deny" };
			},
		});
		const decision = await channel(request, ctx());
		assert.equal(decision.action, "deny");
		assert.equal(localHits, 1);
	});
});

// ---------------------------------------------------------------------------
// askHubQuestion：提问扇出。「没人能答」与「用户拒绝」必须分开
// ---------------------------------------------------------------------------

/** 起一个只会说固定几句话的假 hub；received 收集它收到的每一行 */
async function fakeHub(
	name: string,
	reply: (msg: { type?: string; requestId?: string }, conn: { write(chunk: string): void }, srv: { received: unknown[] }) => void,
) {
	const sock = join(dir, name);
	const received: unknown[] = [];
	const server = createServer(conn => {
		let buf = "";
		conn.on("data", chunk => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				const msg = JSON.parse(line) as { type?: string; requestId?: string };
				received.push(msg);
				reply(msg, conn, { received });
			}
		});
	});
	await new Promise<void>(resolve => server.listen(sock, resolve));
	return { sock, received, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** 等到假 hub 那边真的收到某条消息。客户端 resolve 与数据抵达是两个异步阶段，
 *  直接断言会跑在数据到达之前（撤回那行就是这样丢过的） */
async function waitFor(pred: () => boolean, ms = 500): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return pred();
}

const hello = (msg: { type?: string }, conn: { write(c: string): void }) => {
	if (msg.type === "hello") conn.write(`${JSON.stringify({ v: 1, type: "hello-ok", role: "pi" })}\n`);
};

describe("askHubQuestion", () => {
	it("适配器作答：把 answers 带回来", async () => {
		const answers = [{ id: "q1", value: "worktree", label: "用 git worktree 隔离" }];
		const hub = await fakeHub("q-answered.sock", (msg, conn) => {
			hello(msg, conn);
			if (msg.type !== "ask") return;
			conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId, adapters: 1 })}\n`);
			conn.write(`${JSON.stringify({ v: 1, type: "settled", requestId: msg.requestId, action: "allow", answers, by: "adapter" })}\n`);
		});
		try {
			const outcome = await askHubQuestion([{ id: "q1" }], ctx(), { socketPath: hub.sock });
			assert.equal(outcome.status, "answered");
			assert.deepEqual(outcome.status === "answered" ? outcome.answers : [], answers);
		} finally {
			await hub.close();
		}
	});

	it("没有适配器在线：撤回请求并报 unavailable，别让提问挂在超时上", async () => {
		const hub = await fakeHub("q-no-adapter.sock", (msg, conn, srv) => {
			hello(msg, conn);
			if (msg.type !== "ask") return;
			conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId, adapters: 0 })}\n`);
			// 撤回后不该再有 settled 之类的东西
			void srv;
		});
		try {
			const outcome = await askHubQuestion([{ id: "q1" }], ctx(), { socketPath: hub.sock });
			assert.equal(outcome.status, "unavailable");
			assert.match(outcome.status === "unavailable" ? outcome.reason : "", /没有适配器在线/);
			assert.ok(
				await waitFor(() => hub.received.some(m => (m as { type?: string }).type === "abort")),
				"必须发 abort，否则这条 ask 会在 hub 里挂到超时",
			);
		} finally {
			await hub.close();
		}
	});

	it("用户取消：settled 是 deny，报 denied 而不是 unavailable（不该回退 TUI 再问一遍）", async () => {
		const hub = await fakeHub("q-denied.sock", (msg, conn) => {
			hello(msg, conn);
			if (msg.type !== "ask") return;
			conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId, adapters: 1 })}\n`);
			conn.write(`${JSON.stringify({ v: 1, type: "settled", requestId: msg.requestId, action: "deny", comment: "现在不方便", by: "adapter" })}\n`);
		});
		try {
			const outcome = await askHubQuestion([{ id: "q1" }], ctx(), { socketPath: hub.sock });
			assert.equal(outcome.status, "denied");
			assert.equal(outcome.status === "denied" ? outcome.comment : "", "现在不方便");
		} finally {
			await hub.close();
		}
	});

	it("socket 不存在：unavailable，不抛异常", async () => {
		const outcome = await askHubQuestion([{ id: "q1" }], ctx(), { socketPath: join(dir, "missing.sock") });
		assert.equal(outcome.status, "unavailable");
	});
});
