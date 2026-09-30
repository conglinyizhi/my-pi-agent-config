// lib/hub-jobs.ts — dsh-jobs 的 hub 加速通道（可选）
//
// 定位：**加速，不是真相**。任务状态的唯一来源永远是快照目录里的文件
// （extensions/dsh-jobs/snapshot.ts），这里只做一件事：把「文件变了」这件事
// 尽快告诉别人，让面板不用等下一次轮询。
//
// 因此三条硬约束：
//   1. 连不上 hub（没装 / 没起来 / 版本旧）就是静默失败，返回 false，**不抛不重试**。
//      hub 是可选件，它的缺席不能让写快照这件正事变慢或失败。
//   2. 推的是信号不是状态。payload 里放什么由调用方决定，但收方拿到后应当**重读文件**，
//      而不是直接拿 payload 当状态用——否则就有两份真相了。
//   3. 不落任何新的持久化。连接用完即关，不做保活重连（面板刷新是人的节奏，不值当）。
//
// 与审批通道（lib/hub-channel.ts）共用 socket 路径、连接与 JSON 行协议。

import { createConnection, type Socket } from "node:net";
import { CONNECT_MS, hubSocketPath, PROTOCOL_V, writeLine } from "./hub-channel.ts";

/** 推一次 job 变化。返回是否真的送到 hub（false = hub 不在/连不上，调用方不用管）。 */
export async function pushJobUpdate(
	payload: Record<string, unknown>,
	opts: { socketPath?: string; sessionId?: string; timeoutMs?: number } = {},
): Promise<boolean> {
	const path = opts.socketPath ?? hubSocketPath();
	let sock: Socket | undefined;
	try {
		// 用 const 接住：赋给外部 let 的话，闭包里 TS 不认这次赋值，
		// 每个回调里都得再加一次非空断言（这一层就是被 tsc 报出来的）
		const conn = await connectFor(path, opts.timeoutMs ?? CONNECT_MS);
		sock = conn;
		return await new Promise<boolean>((resolve) => {
			let buf = "";
			let done = false;
			const finish = (ok: boolean) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				try { conn.destroy(); } catch {}
				resolve(ok);
			};
			// 兜底：hub 收了却不回执（不该发生）也不能把调用方挂住
			const timer = setTimeout(() => finish(false), Math.max(500, (opts.timeoutMs ?? CONNECT_MS) * 4));

			conn.on("data", (chunk) => {
				buf += chunk.toString("utf8");
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line) as { type?: string };
						if (msg.type === "jobpush-ok") finish(true);
						else if (msg.type === "hello-ok") {
							// 握手完成才发正式消息，与 hub 的 hello 约定一致
							writeLine(conn, { v: PROTOCOL_V, type: "jobpush", id: "jobpush", sessionId: opts.sessionId, payload });
						}
					} catch {
						// 半截/坏行：继续读
					}
				}
			});
			conn.on("error", () => finish(false));
			conn.on("close", () => finish(false));

			writeLine(conn, { v: PROTOCOL_V, type: "hello", role: "pi" });
		});
	} catch {
		try { sock?.destroy(); } catch {}
		return false;
	}
}

/**
 * 订阅 job 变化。返回一个取消函数；hub 不在时返回 undefined（调用方据此保持轮询）。
 *
 * 拿到信号后**重读文件**，不要用 payload 当状态。onUpdate 里抛错只影响这一次通知。
 */
export async function watchJobUpdates(
	onUpdate: (payload: Record<string, unknown>) => void,
	opts: { socketPath?: string; timeoutMs?: number } = {},
): Promise<(() => void) | undefined> {
	const path = opts.socketPath ?? hubSocketPath();
	let conn: Socket;
	try {
		conn = await connectFor(path, opts.timeoutMs ?? CONNECT_MS);
	} catch {
		return undefined;
	}

	let buf = "";
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		try { conn.destroy(); } catch {}
	};
	conn.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			let msg: { type?: string; payload?: unknown };
			try {
				msg = JSON.parse(line) as typeof msg;
			} catch {
				continue;
			}
			if (msg.type === "hello-ok") {
				writeLine(conn, { v: PROTOCOL_V, type: "jobwatch", id: "jobwatch" });
			} else if (msg.type === "jobupdate") {
				try {
					onUpdate((msg.payload ?? {}) as Record<string, unknown>);
				} catch {
					// 回调抛错只吞掉这一次：订阅关系不该因为消费方出错而断
				}
			}
		}
	});
	// hub 掉线：连接关掉就是取消，调用方那边会自然退回轮询
	conn.on("error", close);
	conn.on("close", close);

	writeLine(conn, { v: PROTOCOL_V, type: "hello", role: "pi" });
	return close;
}

/** 连 hub；连不上直接抛（调用方接住并降级） */
function connectFor(path: string, timeoutMs: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const sock = createConnection({ path });
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("hub connect timeout"));
		}, timeoutMs);
		sock.once("connect", () => {
			clearTimeout(timer);
			resolve(sock);
		});
		sock.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
