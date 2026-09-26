// lib/photo-channel.ts — 连本机 photo 守护抢锁收图（pi 侧客户端）
//
// 协议：JSON 行，Unix socket ~/.pi/agent/run/photo.sock，v:1。
// photo 守护有两个面：HTTP 给手机上传，socket 给 pi 抢锁、收图。这里只包 socket 那一面。
//
// 与 hub-channel 的写法差别：hub 是一问一答、每条 ask 带 requestId；photo 的信封
// 没有 id，响应只能按类型对号入座。所以等待队列按「期望的类型」入队：
// pi 侧同时最多一条 attach / url 在途，ping / ack 都不等回复（pong / ack-ok 到了直接丢），
// 不会串线。守护主动推的 arrived / finish / preempted 走 events 回调。
//
// 连接掉了只报一次 onClose，重连交给调用方（/photo:wait）决定，这里不自己重连：
// 反复重连只会在守护没起来的时候刷屏。

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const PHOTO_PROTOCOL_V = 1;
export const DEFAULT_PHOTO_SOCKET = join(homedir(), ".pi", "agent", "run", "photo.sock");

// 本地 Unix socket，连上就该立刻回；给足一个数量级但不让命令卡住输入
const CONNECT_MS = 800;
const REPLY_MS = 3000;
// close() 里等对端 FIN 的上限：超了直接 destroy，不让废连接挂在进程里
const CLOSE_GRACE_MS = 500;

export function photoSocketPath(): string {
	return process.env.PI_PHOTO_SOCKET?.trim() || DEFAULT_PHOTO_SOCKET;
}

/** 一条已落盘的图。path 是绝对路径，pi 直接读，不去猜守护的目录布局 */
export interface PhotoItem {
	id: string;
	path: string;
	mime: string;
	bytes?: number;
	ts?: string;
}

/** 锁的现持有者。since 是 RFC3339，直接拿给用户看，不本地化 */
export interface PhotoHolder {
	sessionId: string;
	name?: string;
	since: string;
}

export type PhotoAttachResult =
	| { ok: true; queued: number }
	| { ok: false; holder?: PhotoHolder };

/**
 * 抢占原因。契约里是封闭集合 {stale, forced}；真出现新值时原样传出去，
 * 调用方当成「锁没了」处理即可，不必在这里丢掉信息。
 */
export type PhotoPreemptReason = "stale" | "forced" | (string & {});

export interface PhotoEvents {
	/** 守护推来一批图（可能同时到多张，逐张处理） */
	onArrived?(items: PhotoItem[]): void;
	/** 手机端（网页）按了结束。锁不因此释放 */
	onFinish?(info: { by: string; count: number }): void;
	/** 锁被抢走：stale=心跳超时判假死，forced=别人 --force */
	onPreempted?(reason: PhotoPreemptReason): void;
	/** 守护报错；连接还在 */
	onError?(message: string): void;
	/** 连接断了（非本端主动 close）。reason 为空表示干净断开，否则是错误文本 */
	onClose?(reason: string): void;
}

export interface PhotoConnection {
	/** 抢锁。失败不抛错，把持有者带回来（busy 是正常结局，不是异常） */
	attach(sessionId: string, name: string, opts?: { force?: boolean }): Promise<PhotoAttachResult>;
	detach(): Promise<void>;
	/** 心跳：不等 pong。守护靠 30 秒无 ping 判监听者假死 */
	ping(): void;
	/** 把已注入会话的图回执给守护；没 ack 的图守护会留着 */
	ack(ids: string[]): void;
	url(): Promise<string>;
	close(): void;
	readonly closed: boolean;
}

export interface PhotoConnectOptions {
	socketPath?: string;
	events?: PhotoEvents;
	connectTimeoutMs?: number;
	replyTimeoutMs?: number;
}

interface PhotoEnvelope {
	v?: number;
	type?: string;
	sessionId?: string;
	name?: string;
	force?: boolean;
	queued?: number;
	holder?: PhotoHolder;
	items?: PhotoItem[];
	ids?: string[];
	url?: string;
	by?: string;
	count?: number;
	reason?: string;
	message?: string;
}

interface Pending {
	/** 认这些类型；"error" 总是额外接受，避免守护报错时整条请求挂到超时 */
	types: Set<string>;
	resolve(msg: PhotoEnvelope): void;
	reject(err: Error): void;
	timer: NodeJS.Timeout;
}

/**
 * 连上守护并握手。失败会把 socket 收掉再抛，调用方只管报告。
 * 传到 events 里的回调在 attach 之前就可能挂好——attach 成功的同一块数据里
 * 完全可能紧跟一批 arrived，回调必须在那之前就位。
 */
export async function connectPhoto(opts: PhotoConnectOptions = {}): Promise<PhotoConnection> {
	const path = opts.socketPath ?? photoSocketPath();
	const replyMs = opts.replyTimeoutMs ?? REPLY_MS;
	const events = opts.events ?? {};
	const sock = await connectUnix(path, opts.connectTimeoutMs ?? CONNECT_MS);

	let buf = "";
	let closed = false;
	/** 本端主动关的：不该再报 onClose，否则 stop / preempted 之后还会多一条「连接断了」 */
	let intentional = false;
	const pending: Pending[] = [];

	const failPending = (err: Error): void => {
		for (const p of pending.splice(0)) {
			clearTimeout(p.timer);
			p.reject(err);
		}
	};

	const writeLine = (msg: Record<string, unknown>): boolean => {
		if (closed || sock.destroyed) return false;
		try {
			sock.write(`${JSON.stringify(msg)}\n`);
			return true;
		} catch {
			return false;
		}
	};

	/** 发一条并等指定类型的回包；"error" 一律算拒绝 */
	const request = (types: string[], msg: Record<string, unknown>, timeoutMs = replyMs): Promise<PhotoEnvelope> => {
		return new Promise<PhotoEnvelope>((resolve, reject) => {
			if (closed) {
				reject(new Error("photo 连接已关闭"));
				return;
			}
			const entry: Pending = {
				types: new Set([...types, "error"]),
				resolve,
				reject,
				timer: setTimeout(() => {
					const i = pending.indexOf(entry);
					if (i >= 0) pending.splice(i, 1);
					reject(new Error(`photo 守护 ${timeoutMs}ms 没回 ${types.join("/")}`));
				}, timeoutMs),
			};
			entry.timer.unref?.();
			pending.push(entry);
			if (!writeLine(msg)) {
				const i = pending.indexOf(entry);
				if (i >= 0) pending.splice(i, 1);
				clearTimeout(entry.timer);
				reject(new Error("photo 连接已关闭"));
			}
		});
	};

	const handleMessage = (msg: PhotoEnvelope): void => {
		if (msg.type === "error") {
			// 有人在等答复就拒掉那条（attach / url / detach）；没人在等才是主动报错
			const idx = pending.findIndex(p => p.types.has("error"));
			const text = msg.message || "photo 守护报错";
			if (idx >= 0) {
				const [entry] = pending.splice(idx, 1);
				clearTimeout(entry.timer);
				entry.reject(new Error(text));
				return;
			}
			events.onError?.(text);
			return;
		}
		if (typeof msg.type === "string") {
			const idx = pending.findIndex(p => p.types.has(msg.type as string));
			if (idx >= 0) {
				const [entry] = pending.splice(idx, 1);
				clearTimeout(entry.timer);
				entry.resolve(msg);
				return;
			}
		}
		switch (msg.type) {
			case "arrived":
				events.onArrived?.(normalizeItems(msg.items));
				break;
			case "finish":
				events.onFinish?.({ by: msg.by ?? "", count: typeof msg.count === "number" ? msg.count : 0 });
				break;
			case "preempted":
				events.onPreempted?.(msg.reason ?? "stale");
				break;
			default:
				// hello-ok / pong / ack-ok 之类没人等就丢
				break;
		}
	};

	sock.on("data", (chunk: Buffer) => {
		buf += chunk.toString("utf8");
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			let msg: PhotoEnvelope;
			try {
				msg = JSON.parse(line) as PhotoEnvelope;
			} catch {
				// 半行 / 坏 JSON 直接跳过：一行解析不了不该把整条连接判死
				continue;
			}
			handleMessage(msg);
		}
	});

	let closeReason = "";
	sock.on("error", err => {
		closeReason = err instanceof Error ? err.message : String(err);
	});
	sock.on("close", () => {
		const wasClosed = closed;
		closed = true;
		failPending(new Error("photo 连接已关闭"));
		if (!intentional && !wasClosed) events.onClose?.(closeReason);
	});

	const close = (): void => {
		if (closed) return;
		intentional = true;
		closed = true;
		failPending(new Error("photo 连接已关闭"));
		// end() 只保证冲刷已写的数据；对端不回 FIN 就 destroy 兜底
		sock.end();
		const timer = setTimeout(() => sock.destroy(), CLOSE_GRACE_MS);
		timer.unref?.();
	};

	try {
		const hello = await request(["hello-ok"], { v: PHOTO_PROTOCOL_V, type: "hello", role: "pi" });
		if (typeof hello.v === "number" && hello.v !== PHOTO_PROTOCOL_V) {
			throw new Error(`photo 协议版本不一致：守护 v${hello.v}，pi 只认 v${PHOTO_PROTOCOL_V}`);
		}
	} catch (err) {
		close();
		throw err instanceof Error ? err : new Error(String(err));
	}

	const conn: PhotoConnection = {
		async attach(sessionId, name, o = {}) {
			const msg = await request(["attach-ok", "busy"], {
				v: PHOTO_PROTOCOL_V,
				type: "attach",
				sessionId,
				name,
				force: o.force === true,
			});
			if (msg.type === "attach-ok") return { ok: true, queued: typeof msg.queued === "number" ? msg.queued : 0 };
			return msg.holder ? { ok: false, holder: msg.holder } : { ok: false };
		},
		async detach() {
			await request(["detach-ok"], { v: PHOTO_PROTOCOL_V, type: "detach" });
		},
		ping() {
			writeLine({ v: PHOTO_PROTOCOL_V, type: "ping" });
		},
		ack(ids) {
			if (ids.length === 0) return;
			writeLine({ v: PHOTO_PROTOCOL_V, type: "ack", ids });
		},
		async url() {
			const msg = await request(["url-ok"], { v: PHOTO_PROTOCOL_V, type: "url" });
			const url = (msg.url ?? "").trim();
			if (!url) throw new Error("photo 守护没给上传地址");
			return url;
		},
		close,
		get closed() {
			return closed;
		},
	};
	return conn;
}

export interface QrOptions {
	timeoutMs?: number;
}

/**
 * 用本机 qrencode 把文本渲染成终端二维码（ANSIUTF8，半块字符）。
 * 失败返回 undefined：二维码只是「省得手打 URL」的便利，画不出来就只给 URL，
 * 不该让 /photo:url 因此报错。
 */
export function qrCodeText(text: string, opts: QrOptions = {}): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile(
			"qrencode",
			["-t", "ANSIUTF8", "-o", "-", text],
			{ timeout: opts.timeoutMs ?? 2000, maxBuffer: 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					resolve(undefined);
					return;
				}
				const qr = stdout.replace(/\s+$/, "");
				resolve(qr.length > 0 ? qr : undefined);
			},
		);
	});
}

/** 守护推来的 items 不保证每项都能用；没有绝对路径的项直接丢，别拿它去读文件 */
function normalizeItems(items: PhotoItem[] | undefined): PhotoItem[] {
	if (!Array.isArray(items)) return [];
	return items.filter(item => item && typeof item.path === "string" && item.path.length > 0 && typeof item.id === "string");
}

function connectUnix(path: string, timeoutMs: number): Promise<Socket> {
	try {
		accessSync(path, constants.R_OK);
	} catch (err) {
		return Promise.reject(err);
	}
	return new Promise((resolve, reject) => {
		const sock = createConnection({ path });
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("photo socket 连接超时"));
		}, timeoutMs);
		timer.unref?.();
		sock.once("connect", () => {
			clearTimeout(timer);
			resolve(sock);
		});
		sock.once("error", err => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
