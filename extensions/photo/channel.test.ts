// extensions/photo/channel.test.ts — lib/photo-channel 的协议客户端
//
// 跑法：node --experimental-strip-types extensions/photo/channel.test.ts
//
// 每个用例起一个真的 Unix socket 假守护（在 t.TempDir 里），不碰真 photo 守护。
// 这里要钉的是「有没有按契约说话」：v:1 信封、hello 握手、attach/busy/url/detach/ack 的形状、
// 推送回调、以及断线与错误时的行为。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PHOTO_PROTOCOL_V, connectPhoto, qrCodeText, type PhotoItem } from "../../lib/photo-channel.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-photo-channel-"));
after(() => {
	rmSync(dir, { recursive: true, force: true });
});

type Msg = Record<string, unknown> & { type?: string };

interface TestDaemon {
	socketPath: string;
	/** 守护收到的每一行，按到达顺序 */
	received: Msg[];
	receivedOn(type: string): Msg[];
	/** 往最新一条连接上推一条消息 */
	push(msg: Record<string, unknown>): void;
	/** 掐掉最新一条连接（模拟守护挂掉 / 被踢） */
	dropConnection(): void;
	connectionCount(): number;
	close(): Promise<void>;
}

type Reply = (msg: unknown) => void;
type RawReply = (line: string) => void;
type Hook = (msg: Msg, reply: Reply, raw: RawReply) => void;

/** 假守护：默认应答按契约走，单个用例可以用 hooks 改写某几种消息的回应 */
async function startDaemon(name: string, hooks: Partial<Record<string, Hook>> = {}): Promise<TestDaemon> {
	const socketPath = join(dir, name);
	const received: Msg[] = [];
	const sockets: Socket[] = [];
	let connections = 0;

	const server = createServer(conn => {
		connections += 1;
		sockets.push(conn);
		let buf = "";
		conn.on("data", chunk => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				const msg = JSON.parse(line) as Msg;
				received.push(msg);
				const reply: Reply = m => conn.write(`${JSON.stringify(m)}\n`);
				const raw: RawReply = text => conn.write(text);
				const hook = msg.type ? hooks[msg.type] : undefined;
				if (hook) {
					hook(msg, reply, raw);
					continue;
				}
				switch (msg.type) {
					case "hello":
						reply({ v: PHOTO_PROTOCOL_V, type: "hello-ok", role: "pi" });
						break;
					case "attach":
						reply({ v: PHOTO_PROTOCOL_V, type: "attach-ok", queued: 0 });
						break;
					case "detach":
						reply({ v: PHOTO_PROTOCOL_V, type: "detach-ok" });
						break;
					case "ping":
						reply({ v: PHOTO_PROTOCOL_V, type: "pong" });
						break;
					case "ack":
						reply({ v: PHOTO_PROTOCOL_V, type: "ack-ok", moved: Array.isArray(msg.ids) ? msg.ids.length : 0 });
						break;
					case "url":
						reply({ v: PHOTO_PROTOCOL_V, type: "url-ok", url: "http://192.168.1.20:8787/?k=tok" });
						break;
					default:
						break;
				}
			}
		});
	});
	await new Promise<void>(resolve => server.listen(socketPath, resolve));

	const latest = (): Socket | undefined => {
		for (let i = sockets.length - 1; i >= 0; i--) {
			const sock = sockets[i];
			if (sock && !sock.destroyed) return sock;
		}
		return undefined;
	};

	return {
		socketPath,
		received,
		receivedOn: type => received.filter(m => m.type === type),
		push: msg => latest()?.write(`${JSON.stringify(msg)}\n`),
		dropConnection: () => latest()?.destroy(),
		connectionCount: () => connections,
		close: async () => {
			for (const sock of sockets) sock.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

/** 等某个条件成立；超时抛错，避免断言挂死在永远不会到来的事件上 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.ok(predicate(), `等 ${timeoutMs}ms 条件仍未成立`);
}

describe("connectPhoto：握手与 attach", () => {
	it("连上先 hello，attach 成功带回 queued", async () => {
		const daemon = await startDaemon("attach.sock", {
			attach: (_msg, reply) => reply({ v: 1, type: "attach-ok", queued: 2 }),
		});
		try {
			const conn = await connectPhoto({ socketPath: daemon.socketPath });
			try {
				assert.deepEqual(daemon.received[0], { v: 1, type: "hello", role: "pi" });

				const result = await conn.attach("sess-1", "林汐", { force: false });
				assert.deepEqual(result, { ok: true, queued: 2 });

				const attach = daemon.receivedOn("attach")[0] as Record<string, unknown>;
				assert.equal(attach.v, 1);
				assert.equal(attach.sessionId, "sess-1");
				assert.equal(attach.name, "林汐");
				assert.equal(attach.force, false);
			} finally {
				conn.close();
			}
		} finally {
			await daemon.close();
		}
	});

	it("busy 是正常结局：带回持有者，不抛错", async () => {
		const holder = { sessionId: "sess-9", name: "别的会话", since: "2025-09-26T03:00:00Z" };
		const daemon = await startDaemon("busy.sock", {
			attach: (_msg, reply) => reply({ v: 1, type: "busy", holder }),
		});
		try {
			const conn = await connectPhoto({ socketPath: daemon.socketPath });
			try {
				assert.deepEqual(await conn.attach("sess-1", "林汐"), { ok: false, holder });
			} finally {
				conn.close();
			}
		} finally {
			await daemon.close();
		}
	});

	it("--force 把 force:true 原样传下去", async () => {
		const daemon = await startDaemon("force.sock");
		try {
			const conn = await connectPhoto({ socketPath: daemon.socketPath });
			try {
				assert.deepEqual(await conn.attach("s1", "n", { force: true }), { ok: true, queued: 0 });
				assert.equal((daemon.receivedOn("attach")[0] as Record<string, unknown>).force, true);
			} finally {
				conn.close();
			}
		} finally {
			await daemon.close();
		}
	});

	it("socket 不在：直接抛，不挂着等", async () => {
		await assert.rejects(
			() => connectPhoto({ socketPath: join(dir, "missing.sock") }),
			/ENOENT|no such file/i,
		);
	});

	it("hello-ok 分两块到达也能拼出一行（行缓冲）", async () => {
		const daemon = await startDaemon("split.sock", {
			hello: (_msg, reply, raw) => {
				const line = `${JSON.stringify({ v: 1, type: "hello-ok" })}\n`;
				raw(line.slice(0, 12));
				setTimeout(() => raw(line.slice(12)), 10);
			},
		});
		try {
			const conn = await connectPhoto({ socketPath: daemon.socketPath });
			conn.close();
		} finally {
			await daemon.close();
		}
	});

	it("守护版本不一致：握手就报错", async () => {
		const daemon = await startDaemon("ver.sock", {
			hello: (_msg, reply) => reply({ v: 9, type: "hello-ok" }),
		});
		try {
			await assert.rejects(() => connectPhoto({ socketPath: daemon.socketPath }), /协议版本不一致/);
		} finally {
			await daemon.close();
		}
	});
});

describe("connectPhoto：推送与请求", () => {
	it("arrived 推来就回调（没有 path 的项丢掉）", async () => {
		const daemon = await startDaemon("arrived.sock");
		const items: PhotoItem[][] = [];
		const conn = await connectPhoto({ socketPath: daemon.socketPath, events: { onArrived: list => items.push(list) } });
		try {
			daemon.push({
				v: 1,
				type: "arrived",
				items: [
					{ id: "a1", path: "/tmp/a.jpg", mime: "image/jpeg", bytes: 10, ts: "2025-09-26T03:00:00Z" },
					{ id: "a2", mime: "image/jpeg" },
				],
			});
			await waitFor(() => items.length === 1);
			assert.deepEqual(items[0], [{ id: "a1", path: "/tmp/a.jpg", mime: "image/jpeg", bytes: 10, ts: "2025-09-26T03:00:00Z" }]);
		} finally {
			conn.close();
			await daemon.close();
		}
	});

	it("finish / preempted 各回调一次，字段按契约解出来", async () => {
		const daemon = await startDaemon("push.sock");
		const finishes: Array<{ by: string; count: number }> = [];
		const preempts: string[] = [];
		const conn = await connectPhoto({
			socketPath: daemon.socketPath,
			events: {
				onFinish: info => finishes.push(info),
				onPreempted: reason => preempts.push(reason),
			},
		});
		try {
			daemon.push({ v: 1, type: "finish", by: "web", count: 3 });
			daemon.push({ v: 1, type: "preempted", reason: "stale" });
			await waitFor(() => finishes.length === 1 && preempts.length === 1);
			assert.deepEqual(finishes, [{ by: "web", count: 3 }]);
			assert.deepEqual(preempts, ["stale"]);
		} finally {
			conn.close();
			await daemon.close();
		}
	});

	it("url / ack / detach / ping 都说契约那套话", async () => {
		const daemon = await startDaemon("verbs.sock");
		const conn = await connectPhoto({ socketPath: daemon.socketPath });
		try {
			assert.equal(await conn.url(), "http://192.168.1.20:8787/?k=tok");
			await conn.detach();
			conn.ack(["a1", "a2"]);
			conn.ping();
			// ack 与 ping 不等回复，也要真的写出去
			await waitFor(() => daemon.receivedOn("ping").length === 1 && daemon.receivedOn("ack").length === 1);
			assert.deepEqual(daemon.receivedOn("ack")[0], { v: 1, type: "ack", ids: ["a1", "a2"] });
			assert.deepEqual(daemon.receivedOn("url")[0], { v: 1, type: "url" });
			assert.deepEqual(daemon.receivedOn("detach")[0], { v: 1, type: "detach" });
		} finally {
			conn.close();
			await daemon.close();
		}
	});

	it("守护回 error：等这条请求的人拿到异常，message 原样带出来", async () => {
		const daemon = await startDaemon("err.sock", {
			url: (_msg, reply) => reply({ v: 1, type: "error", message: "还没有会话" }),
		});
		const errors: string[] = [];
		const conn = await connectPhoto({ socketPath: daemon.socketPath, events: { onError: m => errors.push(m) } });
		try {
			await assert.rejects(() => conn.url(), /还没有会话/);
			// 有人在等的那条 error 不该再当成主动报错抛给上层
			assert.deepEqual(errors, []);
		} finally {
			conn.close();
			await daemon.close();
		}
	});

	it("没人等的 error 走 onError 回调", async () => {
		const daemon = await startDaemon("err2.sock");
		const errors: string[] = [];
		const conn = await connectPhoto({ socketPath: daemon.socketPath, events: { onError: m => errors.push(m) } });
		try {
			daemon.push({ v: 1, type: "error", message: "锁被人抢了" });
			await waitFor(() => errors.length === 1);
			assert.deepEqual(errors, ["锁被人抢了"]);
		} finally {
			conn.close();
			await daemon.close();
		}
	});
});

describe("connectPhoto：断线", () => {
	it("本端主动 close 不报 onClose（stop 之后不该再来一条「连接断了」）", async () => {
		const daemon = await startDaemon("intent.sock");
		const closes: string[] = [];
		const conn = await connectPhoto({ socketPath: daemon.socketPath, events: { onClose: r => closes.push(r) } });
		conn.close();
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.deepEqual(closes, []);
		await daemon.close();
	});

	it("对端断开：报一次 onClose，在途请求被拒", async () => {
		const daemon = await startDaemon("drop.sock", { url: () => {} });
		const closes: string[] = [];
		const conn = await connectPhoto({ socketPath: daemon.socketPath, events: { onClose: r => closes.push(r) } });
		try {
			const pending = conn.url();
			daemon.dropConnection();
			await assert.rejects(() => pending, /photo 连接已关闭/);
			await waitFor(() => closes.length === 1);
			// 干净断开时 reason 是空串；被 destroy 掐掉时带上内核给的错误文本，两者都对
			assert.ok(closes[0] === "" || /ECONNRESET|EPIPE|hang up/i.test(closes[0] ?? ""), `不该出现的断开原因：${closes[0]}`); 
		} finally {
			conn.close();
			await daemon.close();
		}
	});
});

describe("qrCodeText", () => {
	it("渲染得出就是字符串，渲染不出就是 undefined，不抛错", async () => {
		const qr = await qrCodeText("http://192.168.1.20:8787/?k=tok");
		assert.ok(qr === undefined || typeof qr === "string");
		if (typeof qr === "string") assert.ok(qr.includes("\u001b["), "ANSIUTF8 二维码应当带颜色转义");
	});
});
