// extensions/photo/index.test.ts — /photo:wait|stop|url 的接线
//
// 跑法：node --experimental-strip-types extensions/photo/index.test.ts
//
// 用假的 pi / ctx 跑真 handler，守护那边起一个真的假 socket 守护（在临时目录里）：
// 这里要钉的是「接线接对了没」与状态机（监听态、状态栏、ack 与否、幂等清理），
// 协议细节由 channel.test.ts 覆盖。

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { PHOTO_PROTOCOL_V } from "../../lib/photo-channel.ts";
import photoExtension from "./index.ts";

type Msg = Record<string, unknown> & { type?: string };

interface TestDaemon {
	socketPath: string;
	received: Msg[];
	receivedOn(type: string): Msg[];
	push(msg: Record<string, unknown>): void;
	dropConnection(): void;
	connectionCount(): number;
	close(): Promise<void>;
}

type Reply = (msg: unknown) => void;
type Hook = (msg: Msg, reply: Reply) => void;

async function startDaemon(dir: string, name: string, hooks: Partial<Record<string, Hook>> = {}): Promise<TestDaemon> {
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
				const hook = msg.type ? hooks[msg.type] : undefined;
				if (hook) {
					hook(msg, reply);
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

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.ok(predicate(), `等 ${timeoutMs}ms 条件仍未成立`);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> };

/** 假的 pi：收下 handler / command，并把注入会话的消息记下来 */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const injected: Array<{ content: unknown; options: unknown }> = [];
	let sendFailAt = 0;
	let calls = 0;
	return {
		handlers,
		commands,
		injected,
		/** 第 n 次调用 sendUserMessage 时抛出（模拟注入失败） */
		failSendAt(n: number) {
			sendFailAt = n;
		},
		api: {
			on(type: string, handler: Handler) {
				const list = handlers.get(type) ?? [];
				list.push(handler);
				handlers.set(type, list);
			},
			registerCommand(name: string, command: Command) {
				commands.set(name, command);
			},
			getSessionName: () => "林汐",
			sendUserMessage(content: unknown, options?: unknown) {
				calls += 1;
				if (sendFailAt !== 0 && calls === sendFailAt) throw new Error("队列满了");
				injected.push({ content, options });
			},
		},
	};
}

function fakeCtx(sessionId = "sess-1") {
	const notices: Array<{ message: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	return {
		notices,
		statuses,
		/** 状态栏最后一次写入（没写过就是 undefined） */
		lastStatus: () => statuses.at(-1),
		ctx: {
			hasUI: true,
			mode: "tui",
			ui: {
				notify(message: string, level = "info") {
					notices.push({ message, level });
				},
				setStatus(_key: string, text: string | undefined) {
					statuses.push(text);
				},
			},
			sessionManager: { getSessionId: () => sessionId },
		},
	};
}

let dir = "";
let daemon: TestDaemon | undefined;
let current: ReturnType<typeof load> | undefined;

/** 装一次扩展：拿到命令与 handler，socket 指向假守护 */
function load(d: TestDaemon, opts: { pingMs?: number } = {}) {
	const pi = fakePi();
	const qrCalls: string[] = [];
	photoExtension(pi.api as never, {
		socketPath: () => d.socketPath,
		pingMs: opts.pingMs ?? 10_000,
		qrCode: async text => {
			qrCalls.push(text);
			return "█▀█\n▀▀▀";
		},
	});
	return {
		pi,
		qrCalls,
		wait: pi.commands.get("photo:wait") as Command,
		stop: pi.commands.get("photo:stop") as Command,
		url: pi.commands.get("photo:url") as Command,
		shutdown: pi.handlers.get("session_shutdown")?.[0] as Handler,
		sessionStart: pi.handlers.get("session_start")?.[0] as Handler,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-photo-ext-"));
});

afterEach(async () => {
	if (daemon) {
		await daemon.close();
		daemon = undefined;
	}
	rmSync(dir, { recursive: true, force: true });
	current = undefined;
});

/** 每对用例独立的启动：假守护 + 装载扩展（并触发一次 session_start 把 ctx 交进去） */
async function boot(name: string, hooks: Partial<Record<string, Hook>> = {}, opts: { pingMs?: number } = {}) {
	daemon = await startDaemon(dir, name, hooks);
	const env = fakeCtx();
	current = load(daemon, opts);
	await current.sessionStart({ type: "session_start" }, env.ctx);
	return { d: daemon, env };
}

/** 造一张真图，返回它的绝对路径 */
function makeImage(name: string, body = "fake-jpeg-bytes"): string {
	const path = join(dir, name);
	writeFileSync(path, body);
	return path;
}

describe("/photo:wait", () => {
	it("attach 成功：命令立刻返回、状态栏进入监听、不阻塞后续推送", async () => {
		const { d, env } = await boot("ok.sock");
		await current?.wait.handler("", env.ctx);

		assert.equal(d.receivedOn("attach").length, 1);
		assert.equal(env.lastStatus(), "📷 监听中 · 已收 0 张");
		assert.match(env.notices.at(-1)?.message ?? "", /照片监听已就绪/);
		// 「立刻返回」：此时还没有任何图片被注入
		assert.equal(current?.pi.injected.length, 0);

		// 推送照样进得来
		d.push({
			v: 1,
			type: "arrived",
			items: [{ id: "a1", path: makeImage("a.jpg"), mime: "image/jpeg" }],
		});
		await waitFor(() => current?.pi.injected.length === 1);
		assert.equal(env.lastStatus(), "📷 监听中 · 已收 1 张");
	});

	it("busy：提示谁占着（带 since），不进监听态", async () => {
		const { d, env } = await boot("busy.sock", {
			attach: (_msg, reply) =>
				reply({
					v: 1,
					type: "busy",
					holder: { sessionId: "sess-9", name: "别的会话", since: "2025-09-26T03:00:00Z" },
				}),
		});
		await current?.wait.handler("", env.ctx);

		const notice = env.notices.at(-1);
		assert.equal(notice?.level, "warning");
		assert.match(notice?.message ?? "", /别的会话/);
		assert.match(notice?.message ?? "", /sess-9/);
		assert.match(notice?.message ?? "", /2025-09-26T03:00:00Z/);
		assert.match(notice?.message ?? "", /--force/);
		assert.ok(!env.statuses.includes("📷 监听中 · 已收 0 张"), "busy 不该进监听态");
	});

	it("--force：把抢占传下去，抢到就进监听态", async () => {
		const { d, env } = await boot("force.sock");
		await current?.wait.handler("--force", env.ctx);
		assert.equal((d.receivedOn("attach")[0] as Record<string, unknown>).force, true);
		assert.equal(env.lastStatus(), "📷 监听中 · 已收 0 张");
	});

	it("重复 wait：提示已在监听，不再抢一次锁", async () => {
		const { d, env } = await boot("twice.sock");
		await current?.wait.handler("", env.ctx);
		await current?.wait.handler("", env.ctx);
		assert.equal(d.receivedOn("attach").length, 1);
		assert.match(env.notices.at(-1)?.message ?? "", /已经在监听中/);
	});

	it("守护不在：报连不上，状态栏干净", async () => {
		daemon = await startDaemon(dir, "gone.sock");
		const d = daemon;
		await d.close();
		daemon = undefined;
		const env = fakeCtx();
		current = load(d);
		await current.wait.handler("", env.ctx);

		const notice = env.notices.at(-1);
		assert.equal(notice?.level, "error");
		assert.match(notice?.message ?? "", /连不上 photo 守护/);
		assert.ok(!env.statuses.includes("📷 监听中 · 已收 0 张"));
	});
});

describe("arrived：逐张注入并 ack", () => {
	it("两张图各自注入 + 一次性 ack 成功的那两张", async () => {
		const { d, env } = await boot("inject.sock");
		await current?.wait.handler("", env.ctx);

		const one = makeImage("one.jpg", "one-bytes");
		const two = makeImage("two.png", "two-bytes");
		d.push({
			v: 1,
			type: "arrived",
			items: [
				{ id: "a1", path: one, mime: "image/jpeg" },
				{ id: "a2", path: two, mime: "image/png" },
			],
		});
		await waitFor(() => current?.pi.injected.length === 2);

		assert.deepEqual(current?.pi.injected[0], {
			content: [
				{ type: "text", text: "（手机发来的照片）" },
				{ type: "image", data: readFileSync(one).toString("base64"), mimeType: "image/jpeg" },
			],
			options: { deliverAs: "followUp" },
		});
		assert.deepEqual(current?.pi.injected[1], {
			content: [
				{ type: "text", text: "（手机发来的照片）" },
				{ type: "image", data: readFileSync(two).toString("base64"), mimeType: "image/png" },
			],
			options: { deliverAs: "followUp" },
		});

		await waitFor(() => d.receivedOn("ack").length === 1);
		assert.deepEqual(d.receivedOn("ack")[0], { v: 1, type: "ack", ids: ["a1", "a2"] });
		assert.equal(env.lastStatus(), "📷 监听中 · 已收 2 张");
	});

	it("mime 缺失时按扩展名兜底（读不到就给 image/jpeg）", async () => {
		const { d, env } = await boot("mime.sock");
		await current?.wait.handler("", env.ctx);
		d.push({
			v: 1,
			type: "arrived",
			items: [{ id: "w1", path: makeImage("shot.webp"), mime: "" }, { id: "x1", path: makeImage("blob.bin"), mime: "" }],
		});
		await waitFor(() => current?.pi.injected.length === 2);
		assert.equal((current?.pi.injected[0].content as any)[1].mimeType, "image/webp");
		assert.equal((current?.pi.injected[1].content as any)[1].mimeType, "image/jpeg");
	});

	it("某张读文件失败：只 ack 成功的那张，报一行错，不影响其它张", async () => {
		const { d, env } = await boot("partial.sock");
		await current?.wait.handler("", env.ctx);

		const good = makeImage("good.jpg");
		d.push({
			v: 1,
			type: "arrived",
			items: [
				{ id: "bad1", path: join(dir, "not-there.jpg"), mime: "image/jpeg" },
				{ id: "ok1", path: good, mime: "image/jpeg" },
			],
		});
		await waitFor(() => d.receivedOn("ack").length === 1);

		assert.deepEqual(d.receivedOn("ack")[0], { v: 1, type: "ack", ids: ["ok1"] });
		assert.equal(current?.pi.injected.length, 1);
		const errors = env.notices.filter(n => n.level === "error");
		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /照片注入失败/);
		assert.match(errors[0].message, /not-there\.jpg/);
		assert.equal(env.lastStatus(), "📷 监听中 · 已收 1 张");
	});

	it("注入抛错：那一张不 ack", async () => {
		const { d, env } = await boot("injectfail.sock");
		await current?.wait.handler("", env.ctx);
		current?.pi.failSendAt(1);

		d.push({ v: 1, type: "arrived", items: [{ id: "a1", path: makeImage("a.jpg"), mime: "image/jpeg" }] });
		await waitFor(() => env.notices.some(n => n.level === "error"));

		assert.equal(current?.pi.injected.length, 0);
		assert.deepEqual(d.receivedOn("ack"), []);
		assert.match(env.notices.at(-1)?.message ?? "", /队列满了/);
	});
});

describe("finish / preempted / 断线", () => {
	it("finish 只提示，不释放锁", async () => {
		const { d, env } = await boot("finish.sock");
		await current?.wait.handler("", env.ctx);
		d.push({ v: 1, type: "finish", by: "web", count: 3 });
		await waitFor(() => env.notices.some(n => /手机端已结束/.test(n.message)));

		assert.match(env.notices.at(-1)?.message ?? "", /共收 3 张/);
		assert.deepEqual(d.receivedOn("detach"), [], "finish 不该自动 detach");
		assert.equal(env.lastStatus(), "📷 监听中 · 已收 0 张");
	});

	it("preempted：清监听态与状态栏，说明是谁抢的", async () => {
		const { d, env } = await boot("preempt.sock");
		await current?.wait.handler("", env.ctx);
		d.push({ v: 1, type: "preempted", reason: "stale" });
		await waitFor(() => env.lastStatus() === undefined);

		assert.match(env.notices.at(-1)?.message ?? "", /心跳超时/);
		assert.equal(env.notices.at(-1)?.level, "warning");
		// 锁已经在别人手里，不需要（也不该）再 detach
		assert.deepEqual(d.receivedOn("detach"), []);

		// 已经退出监听：stop 只说一句「没在监听」
		await current?.stop.handler("", env.ctx);
		assert.match(env.notices.at(-1)?.message ?? "", /当前没有在监听照片/);
	});

	it("forced 抢占的文案与 stale 区分开", async () => {
		const { d, env } = await boot("forced.sock");
		await current?.wait.handler("", env.ctx);
		d.push({ v: 1, type: "preempted", reason: "forced" });
		await waitFor(() => env.lastStatus() === undefined);
		assert.match(env.notices.at(-1)?.message ?? "", /强制抢走/);
	});

	it("守护掉线：清监听态、报一次，不自动重连", async () => {
		const { d, env } = await boot("drop.sock");
		await current?.wait.handler("", env.ctx);
		assert.equal(d.connectionCount(), 1);

		d.dropConnection();
		await waitFor(() => env.notices.some(n => /连接断了/.test(n.message)));
		assert.equal(env.lastStatus(), undefined);

		await sleep(80);
		assert.equal(d.connectionCount(), 1, "不该自动重连");

		// 再 wait 才重新连
		await current?.wait.handler("", env.ctx);
		assert.equal(d.connectionCount(), 2);
	});
});

describe("/photo:stop 与 session_shutdown", () => {
	it("stop：detach 并清状态栏，报本次收了几张", async () => {
		const { d, env } = await boot("stop.sock");
		await current?.wait.handler("", env.ctx);
		d.push({ v: 1, type: "arrived", items: [{ id: "a1", path: makeImage("a.jpg"), mime: "image/jpeg" }] });
		await waitFor(() => current?.pi.injected.length === 1);

		await current?.stop.handler("", env.ctx);
		assert.equal(d.receivedOn("detach").length, 1);
		assert.equal(env.lastStatus(), undefined);
		assert.match(env.notices.at(-1)?.message ?? "", /已停止监听照片，本次共收 1 张/);
	});

	it("没在监听时 stop：只提示一句", async () => {
		const { env } = await boot("idle.sock");
		await current?.stop.handler("", env.ctx);
		assert.equal(env.notices.length, 1);
		assert.match(env.notices[0].message, /当前没有在监听照片/);
	});

	it("session_shutdown 幂等：detach 只发一次，状态栏清掉", async () => {
		const { d, env } = await boot("shutdown.sock");
		await current?.wait.handler("", env.ctx);
		await current?.shutdown({ type: "session_shutdown", reason: "quit" }, env.ctx);
		await current?.shutdown({ type: "session_shutdown", reason: "quit" }, env.ctx);

		await waitFor(() => d.receivedOn("detach").length === 1);
		await sleep(30);
		assert.equal(d.receivedOn("detach").length, 1, "第二次 shutdown 不该再 detach");
		assert.equal(env.lastStatus(), undefined);
	});

	it("没在监听时 shutdown：空操作，不报错", async () => {
		const { d, env } = await boot("shutdown-idle.sock", {}, {});
		await current?.shutdown({ type: "session_shutdown", reason: "reload" }, env.ctx);
		assert.deepEqual(d.receivedOn("detach"), []);
	});
});

describe("心跳与 /photo:url", () => {
	it("进监听态后按间隔 ping 守护", async () => {
		const { d, env } = await boot("ping.sock", {}, { pingMs: 40 });
		await current?.wait.handler("", env.ctx);
		await waitFor(() => d.receivedOn("ping").length >= 2, 1000);
		assert.deepEqual(d.receivedOn("ping")[0], { v: 1, type: "ping" });

		// 退出监听后不再 ping
		await current?.stop.handler("", env.ctx);
		const seen = d.receivedOn("ping").length;
		await sleep(120);
		assert.equal(d.receivedOn("ping").length, seen, "stop 后心跳必须停");
	});

	it("在监听中：url 走同一条连接，通知里带地址与二维码", async () => {
		const { d, env } = await boot("url.sock");
		await current?.wait.handler("", env.ctx);
		await current?.url.handler("", env.ctx);

		assert.equal(d.receivedOn("url").length, 1);
		assert.equal(d.connectionCount(), 1, "监听中不该另开一条连接");
		const message = env.notices.at(-1)?.message ?? "";
		assert.match(message, /http:\/\/192\.168\.1\.20:8787\/\?k=tok/);
		assert.match(message, /█▀█/);
		assert.deepEqual(current?.qrCalls, ["http://192.168.1.20:8787/?k=tok"]);
	});

	it("没在监听：另开一条短连接问 URL，问完就关", async () => {
		const { d, env } = await boot("url-idle.sock");
		await current?.url.handler("", env.ctx);
		assert.equal(d.receivedOn("url").length, 1);
		assert.equal(d.connectionCount(), 1);
		await waitFor(() => d.receivedOn("detach").length === 0);
		assert.ok(env.notices.at(-1)?.message.includes("http://"));
	});

	it("守护回了 error：给一行带原文的报错", async () => {
		const { env } = await boot("url-err.sock", {
			url: (_msg, reply) => reply({ v: 1, type: "error", message: "还没有会话" }),
		});
		await current?.url.handler("", env.ctx);
		const notice = env.notices.at(-1);
		assert.equal(notice?.level, "error");
		assert.match(notice?.message ?? "", /还没有会话/);
	});
});
