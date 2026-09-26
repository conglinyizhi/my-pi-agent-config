// extensions/photo/index.ts — 手机拍照，直接发进当前 pi 会话
//
//   /photo:wait [--force]  向本机 photo 守护抢独占锁，进入后台监听态（命令立刻返回）
//   /photo:stop            释放锁、退出监听
//   /photo:url             拿手机上传地址（顺带画一个终端二维码）
//
// 分工：HTTP（手机上传）与落盘在 photo 守护那边；pi 这边只做三件事——
// 抢锁、把 arrived 的图作为用户消息注入当前会话、注入成功再 ack。
//
// 两条硬约束：
//   1. 长连接与心跳定时器只在命令执行时开。扩展 factory 里不建 socket、不起定时器
//      （reload / 启动阶段不该有网络副作用）。
//   2. 图片走 pi.sendUserMessage([...], { deliverAs: "followUp" }) 注入，不写进系统提示词
//      或工具描述——那些位置一动，prompt 缓存全废。
//
// 没 ack 的图守护会留着，下一轮监听还能收到；所以「读文件失败 / 注入失败」的那张
// 绝不 ack，只报一行错，不影响同一批里的其它张。

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	connectPhoto,
	photoSocketPath,
	qrCodeText,
	type PhotoConnectOptions,
	type PhotoConnection,
	type PhotoItem,
	type PhotoPreemptReason,
} from "../../lib/photo-channel.ts";

/** 状态栏用的 key。stop / 掉线 / preempted 都要清掉它 */
const STATUS_KEY = "photo";
/** 心跳间隔。守护超过 30 秒没收到 ping 就判这个监听者假死，10 秒给三次余量 */
const PING_MS = 10_000;

interface Listener {
	conn: PhotoConnection;
	sessionId: string;
	/** 会话名，给守护记 holder 用（抢锁失败时对方能看出是谁占着） */
	name: string;
	/** 已注入当前会话的张数（失败的不算，状态栏显示的就是这个） */
	received: number;
	/** 心跳定时器。抢到锁（attach-ok）之后才起：没拿到锁的连接不该替别人续命 */
	timer?: NodeJS.Timeout;
}

export interface PhotoExtensionDeps {
	/** 测试注入：默认 lib/photo-channel 的 connectPhoto */
	connect?: (opts: PhotoConnectOptions) => Promise<PhotoConnection>;
	/** 测试注入：默认 photoSocketPath() */
	socketPath?: () => string;
	/** 测试注入：默认 qrCodeText */
	qrCode?: (text: string) => Promise<string | undefined>;
	/** 心跳间隔（毫秒）。生产固定 10 秒，单测调小以免等真实时间 */
	pingMs?: number;
}

export default function photoExtension(pi: ExtensionAPI, deps: PhotoExtensionDeps = {}): void {
	const connect = deps.connect ?? connectPhoto;
	const socketPath = deps.socketPath ?? photoSocketPath;
	const qrCode = deps.qrCode ?? qrCodeText;
	const pingMs = deps.pingMs ?? PING_MS;

	/** 当前的监听态。undefined = 没在监听 */
	let listener: Listener | undefined;
	/**
	 * 最近一次拿到的 ctx。推送（arrived / finish / preempted）到达时手上没有 ctx，
	 * 状态栏与通知只能借最近这次。会话换了之后它可能已经过期，所以一律 try/catch：
	 * 提示是锦上添花，注入图片才是本职。
	 */
	let lastCtx: ExtensionContext | undefined;

	const setStatus = (text: string | undefined): void => {
		try {
			if (!lastCtx?.hasUI) return;
			lastCtx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// 没有 UI（rpc / print）或 ctx 已过期：状态栏本来就不存在，跳过
		}
	};

	const notify = (message: string, level: "info" | "warning" | "error" = "info"): void => {
		try {
			lastCtx?.ui.notify(message, level);
		} catch {
			// 同上：提示失败不能影响收图
		}
	};

	const statusText = (received: number): string => `📷 监听中 · 已收 ${received} 张`;

	/**
	 * 退出监听态：停心跳、按需 detach、断连接、清状态栏。
	 * 幂等——state 不是当前 listener 时只收自己的尾巴，不清别人刚立起来的状态。
	 */
	async function teardown(state: Listener, opts: { detach: boolean }): Promise<void> {
		if (listener === state) {
			listener = undefined;
			setStatus(undefined);
		}
		if (state.timer) clearInterval(state.timer);
		if (opts.detach && !state.conn.closed) {
			try {
				await state.conn.detach();
			} catch {
				// 守护那边可能已经先把锁收了：detach 失败不影响本地退出监听
			}
		}
		state.conn.close();
	}

	/** 逐张读文件 → 注入会话 → 收齐成功的 id 再一次性 ack */
	async function injectItems(state: Listener, items: PhotoItem[]): Promise<void> {
		const injected: string[] = [];
		for (const item of items) {
			try {
				const data = await readFile(item.path);
				await Promise.resolve(
					pi.sendUserMessage(
						[
							{ type: "text", text: "（手机发来的照片）" },
							{ type: "image", data: data.toString("base64"), mimeType: mimeOf(item) },
						],
						{ deliverAs: "followUp" },
					),
				);
				injected.push(item.id);
				state.received += 1;
			} catch (err) {
				// 这张不 ack：守护留着它，/photo:wait 重新连上还能推过来
				notify(`照片注入失败（${item.path}）：${errorText(err)}；这张没回执，守护会留着`, "error");
			}
		}
		if (injected.length === 0) return;
		state.conn.ack(injected);
		setStatus(statusText(state.received));
		notify(`收到 ${injected.length} 张照片，已排入当前会话（本轮结束后处理）`, "info");
	}

	const preemptText = (reason: PhotoPreemptReason): string =>
		reason === "forced"
			? "照片锁被别的会话强制抢走了"
			: reason === "stale"
				? "照片锁被收回（心跳超时，可能机器休眠过）"
				: `照片锁被收回（${reason}）`;

	/** 建立一条连接的推送回调。state 是闭包变量：attach 之前就挂好，图不会掉缝里 */
	function eventsFor(state: () => Listener | undefined): PhotoConnectOptions["events"] {
		return {
			onArrived: items => {
				const current = state();
				if (current) void injectItems(current, items);
			},
			onFinish: info => {
				if (!state()) return;
				notify(`手机端已结束，本轮共收 ${info.count} 张；锁还在，要退出用 /photo:stop`, "info");
			},
			onPreempted: reason => {
				const current = state();
				if (!current) return;
				void teardown(current, { detach: false }).then(() => {
					notify(`${preemptText(reason)}，已退出监听；要接着收就再 /photo:wait`, "warning");
				});
			},
			onError: message => notify(`photo 守护报错：${message}`, "error"),
			onClose: reason => {
				const current = state();
				if (!current) return;
				void teardown(current, { detach: false }).then(() => {
					// 不自动重连：守护不在时重连只会刷屏，下一次 /photo:wait 重连就行
					const detail = reason ? `（${reason}）` : "";
					notify(`photo 连接断了${detail}，已退出监听；要继续收就 /photo:wait`, "warning");
				});
			},
		};
	}

	async function beginWait(ctx: ExtensionCommandContext, force: boolean): Promise<void> {
		const sessionId = sessionIdOf(ctx);
		const name = sessionNameOf(pi);
		const state: { current?: Listener } = {};
		const conn = await connect({
			socketPath: socketPath(),
			events: eventsFor(() => state.current),
		});

		// 先把状态立起来再 attach：守护回 attach-ok 的同一块数据里可能紧跟一批 arrived，
		// 等 await 返回再挂状态的话，那批图就掉在缝里了。
		const pendingListener: Listener = { conn, sessionId, name, received: 0 };
		state.current = pendingListener;
		listener = pendingListener;

		let result: Awaited<ReturnType<PhotoConnection["attach"]>>;
		try {
			result = await conn.attach(sessionId, name, { force });
		} catch (err) {
			await teardown(pendingListener, { detach: false });
			notify(`photo 抢锁失败：${errorText(err)}`, "error");
			return;
		}
		if (listener !== pendingListener) {
			// 抢锁途中被 stop / 掉线收走了：这条 attach 的结果已经没有意义
			await teardown(pendingListener, { detach: true });
			return;
		}
		if (!result.ok) {
			await teardown(pendingListener, { detach: false });
			notify(`${busyText(result.holder)}；要抢用 /photo:wait --force`, "warning");
			return;
		}

		// 抢到锁才开始 ping：守护靠心跳判活，没拿到锁的连接不该替真正的持有者续命
		pendingListener.timer = setInterval(() => conn.ping(), pingMs);
		pendingListener.timer.unref?.();
		setStatus(statusText(0));
		const queued = result.queued > 0 ? `；守护那边还有 ${result.queued} 张排队，会马上推过来` : "";
		notify(`照片监听已就绪：手机打开 /photo:url 给的地址拍照即可${queued}`, "info");
	}

	/** url 消息不需要监听态：没在监听就用一条短连接问一次，问完就关 */
	async function fetchUrl(): Promise<string> {
		if (listener) return listener.conn.url();
		const conn = await connect({ socketPath: socketPath() });
		try {
			return await conn.url();
		} finally {
			conn.close();
		}
	}

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
	});

	pi.on("session_shutdown", async () => {
		// 幂等：没在监听就是空操作；重复触发也不会发第二次 detach
		const current = listener;
		if (current) await teardown(current, { detach: true });
	});

	pi.registerCommand("photo:wait", {
		description: "向本机 photo 守护抢锁并进入后台监听态；手机发来的照片作为用户消息注入本会话（--force 抢占）",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const force = /(^|\s)--force(\s|$)/.test(args ?? "");
			if (listener) {
				notify(`已经在监听中（已收 ${listener.received} 张）；要换会话先 /photo:stop`, "info");
				return;
			}
			try {
				await beginWait(ctx, force);
			} catch (err) {
				notify(`连不上 photo 守护（${socketPath()}）：${errorText(err)}。先确认守护在跑`, "error");
			}
		},
	});

	pi.registerCommand("photo:stop", {
		description: "释放照片锁、退出监听态",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			const current = listener;
			if (!current) {
				notify("当前没有在监听照片", "info");
				return;
			}
			await teardown(current, { detach: true });
			notify(`已停止监听照片，本次共收 ${current.received} 张`, "info");
		},
	});

	pi.registerCommand("photo:url", {
		description: "显示手机上传地址（附终端二维码）",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			let url: string;
			try {
				url = await fetchUrl();
			} catch (err) {
				notify(`拿不到手机上传地址：${errorText(err)}`, "error");
				return;
			}
			// 二维码是便利，不是功能本身：qrencode 不在 / 超时就不画，URL 照给
			const qr = await qrCode(url);
			const head = `手机上传地址（手机与电脑在同一局域网，浏览器打开）：\n${url}`;
			notify(qr ? `${head}\n\n${qr}` : head, "info");
		},
	});
}

/** 会话 id：拿不到就给空串，守护那边至少能看出是个没名字的会话 */
function sessionIdOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager?.getSessionId?.() ?? "";
	} catch {
		return "";
	}
}

function sessionNameOf(pi: ExtensionAPI): string {
	try {
		return pi.getSessionName() ?? "";
	} catch {
		return "";
	}
}

function busyText(holder?: { sessionId?: string; name?: string; since?: string }): string {
	if (!holder) return "照片锁被占用（守护没说是谁）";
	const who = holder.name?.trim() || "（无名会话）";
	const sid = holder.sessionId ? ` ${holder.sessionId}` : "";
	const since = holder.since ? ` 自 ${holder.since} 起` : "";
	return `照片锁被占用：${who}${sid}${since}`;
}

/** 守护给的 mime 为空时按扩展名兜底：image/* 塞错 mime 会让模型看不到图 */
function mimeOf(item: PhotoItem): string {
	const given = item.mime?.trim();
	if (given) return given;
	const ext = basename(item.path).toLowerCase();
	if (ext.endsWith(".png")) return "image/png";
	if (ext.endsWith(".webp")) return "image/webp";
	if (ext.endsWith(".gif")) return "image/gif";
	return "image/jpeg";
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
