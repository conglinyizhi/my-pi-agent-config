import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { askHubQuestion, createHubThenLocalChannel } from "./hub-channel.ts";
import { resetGuiFallbackNotices, type GuiDiagnosis } from "./gui-diagnosis.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-hub-channel-"));
after(() => {
	rmSync(dir, { recursive: true, force: true });
});

// 回退提示按原因在进程内去重，用例之间必须清一遍，否则后一个用例看不到 notify
afterEach(() => {
	resetGuiFallbackNotices();
});

/** 诊断存根：真跑 collectGuiDiagnosis 会起 systemctl / pkg-config，单测里不碰 */
function diag(overrides: Partial<GuiDiagnosis> = {}): GuiDiagnosis {
	return {
		binary: null,
		candidates: [],
		repoRoot: "/repo",
		hasHubSocket: true,
		hubUnitActive: true,
		hasWailsCli: false,
		hasGo: false,
		hasFrontendDist: false,
		hasWebkit2Gtk41: null,
		hasDisplayEnv: true,
		...overrides,
	};
}

function ctx() {
	return { sessionManager: { getSessionId: () => "sess-1" }, hasUI: false, ui: undefined } as never;
}

/** 要接 notify 的用这个：回退说明走通知，标题走 select */
function ctxWithNotify(notices: string[]) {
	return {
		sessionManager: { getSessionId: () => "sess-1" },
		hasUI: true,
		ui: { select: async () => undefined, notify: (message: string) => void notices.push(message) },
	} as never;
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

// ---------------------------------------------------------------------------
// ask-ok 里的 adapters：hub 在线但没人能应答时不要挂满 TTL
// ---------------------------------------------------------------------------

describe("createHubThenLocalChannel 的提前回退", () => {
	const abortCount = (received: unknown[]) => received.filter(m => (m as { type?: string }).type === "abort").length;

	/** 只会回一句 ask-ok 的假 hub；没人能应答时不会再有 settled */
	async function askOkOnly(name: string, adapters: number) {
		return fakeHub(name, (msg, conn) => {
			hello(msg, conn);
			if (msg.type !== "ask") return;
			conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId, adapters })}\n`);
		});
	}

	it("adapters:0 且本机拉不起窗：提前回退本地，并给 hub 发 abort", { timeout: 5000 }, async () => {
		const hub = await askOkOnly("a-nogui.sock", 0);
		let localHits = 0;
		try {
			const channel = createHubThenLocalChannel({
				socketPath: hub.sock,
				hasLocalGui: () => false,
				local: async () => {
					localHits += 1;
					return { action: "deny" };
				},
			});
			const decision = await channel(request, ctx());
			assert.equal(decision.action, "deny");
			assert.equal(localHits, 1, "没人能应答就该回退本地，而不是等 1 小时 TTL");
			assert.ok(
				await waitFor(() => hub.received.some(m => (m as { type?: string }).type === "abort")),
				"回退前必须发 abort，否则 hub 侧这条 ask 只能挂到超时",
			);
		} finally {
			await hub.close();
		}
	});

	it("adapters:0 但本机能拉窗：不提前回退，等 hub 结算", { timeout: 5000 }, async () => {
		const hub = await fakeHub("a-localgui.sock", (msg, conn) => {
			hello(msg, conn);
			if (msg.type !== "ask") return;
			conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId, adapters: 0 })}\n`);
			// 闸门窗要人来点，结算一定晚于 ask-ok：只写在同一块里的话，
			// 错误的提前回退会先判完，这条用例就验不出东西了
			setTimeout(() => {
				conn.write(`${JSON.stringify({ v: 1, type: "settled", requestId: msg.requestId, action: "allow", comment: "本机窗" })}\n`);
			}, 150);
		});
		let localHits = 0;
		try {
			const channel = createHubThenLocalChannel({
				socketPath: hub.sock,
				hasLocalGui: () => true,
				local: async () => {
					localHits += 1;
					return { action: "deny" };
				},
			});
			const decision = await channel(request, ctx());
			assert.equal(decision.action, "allow");
			assert.equal(decision.comment, "本机窗");
			assert.equal(localHits, 0, "hub 自己能拉窗，回退掉就是白问一遍");
			assert.equal(abortCount(hub.received), 0, "能拉窗就不能撤回这条 ask");
		} finally {
			await hub.close();
		}
	});

	it("adapters 在线：本机没窗也不提前回退，等适配器", { timeout: 5000 }, async () => {
		const hub = await fakeHub("a-adapter.sock", (msg, conn) => {
			hello(msg, conn);
			if (msg.type !== "ask") return;
			conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId, adapters: 1 })}\n`);
			setTimeout(() => {
				conn.write(`${JSON.stringify({ v: 1, type: "settled", requestId: msg.requestId, action: "deny", comment: "IM 拒了" })}\n`);
			}, 150);
		});
		try {
			const channel = createHubThenLocalChannel({ socketPath: hub.sock, hasLocalGui: () => false });
			const decision = await channel(request, ctx());
			// 适配器能答就不能撤回：用户拒绝不是「没人能应」，回退 TUI 会把同一个请求再问一遍
			assert.equal(decision.action, "deny");
			assert.equal(decision.comment, "IM 拒了");
			assert.equal(abortCount(hub.received), 0);
		} finally {
			await hub.close();
		}
	});

	it("提前回退报的是 hub-no-channel，不推给 wails-gui", { timeout: 5000 }, async () => {
		const hub = await askOkOnly("a-chain.sock", 0);
		const notices: string[] = [];
		const titles: string[] = [];
		try {
			const channel = createHubThenLocalChannel({
				socketPath: hub.sock,
				hasLocalGui: () => false,
				diagnosis: diag(),
				runGui: async () => ({ ok: false, reason: "unavailable" }),
				selectApproval: async (title) => {
					titles.push(title);
					return "❌ 拒绝";
				},
			});
			const decision = await channel(request, ctxWithNotify(notices));
			assert.equal(decision.action, "deny");
			assert.match(titles[0], /hub 在跑，但本机 GUI 和 IM 适配器都不在线/);
			assert.match(notices[0], /接一个 IM 适配器/);
			// hub 明明在跑，不能反过来劝人去装 hub
			assert.doesNotMatch(notices[0], /起 hub/);
		} finally {
			await hub.close();
		}
	});
});

