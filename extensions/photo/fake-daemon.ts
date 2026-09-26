// extensions/photo/fake-daemon.ts — 单测共用的假 photo 守护
//
// 真起一个 HTTP 服务（127.0.0.1 的临时端口），照契约回 /refs、/refs/<n>、/refs/<n>/use、/status，
// 每个用例都能改池子内容、改某个接口的返回码、或者干脆不回话。
// 这里只服务单测；pi 只加载目录里的 index.ts，不会碰到它。

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRef {
	ref: number;
	path: string;
	bytes?: number;
	ts?: string;
	lastUsed?: string;
}

export interface FakeDaemon {
	base: string;
	/** 按到达顺序记下每次请求（token 从 query 里取出来单放，便于断言带上没有） */
	requests: Array<{ method: string; path: string; token: string }>;
	/** 池子内容，用例里直接改 */
	refs: FakeRef[];
	pool: number;
	/** /refs/<n>/use 的返回码 */
	useStatus: number;
	/** /status 的返回码；/status 里的 url 字段（空串 = 不下发这个字段） */
	statusCode: number;
	statusUrl: string;
	/** 设了就开始校验口令，对不上一律 401 */
	expectToken?: string;
	requestsOn(method: string, path: string): Array<{ method: string; path: string; token: string }>;
	close(): Promise<void>;
}

export interface FakeDaemonOptions {
	refs?: FakeRef[];
	pool?: number;
	useStatus?: number;
	statusCode?: number;
	statusUrl?: string;
	expectToken?: string;
}

export async function startFakeDaemon(opts: FakeDaemonOptions = {}): Promise<FakeDaemon> {
	const daemon: FakeDaemon = {
		base: "",
		requests: [],
		refs: opts.refs ?? [],
		pool: opts.pool ?? (opts.refs ?? []).length,
		useStatus: opts.useStatus ?? 204,
		statusCode: opts.statusCode ?? 200,
		statusUrl: opts.statusUrl ?? "",
		expectToken: opts.expectToken,
		requestsOn: (method, path) => daemon.requests.filter((r) => r.method === method && r.path === path),
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};

	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const token = url.searchParams.get("k") ?? "";
		daemon.requests.push({ method: req.method ?? "", path: url.pathname, token });

		const json = (status: number, body: unknown): void => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};

		if (daemon.expectToken !== undefined && token !== daemon.expectToken) {
			json(401, { error: "unauthorized" });
			return;
		}

		if (url.pathname === "/refs" && req.method === "GET") {
			json(200, { pool: daemon.pool, items: daemon.refs });
			return;
		}
		const useMatch = /^\/refs\/(\d+)\/use$/.exec(url.pathname);
		if (useMatch && req.method === "POST") {
			if (daemon.useStatus >= 400) json(daemon.useStatus, { error: "no" });
			else res.writeHead(daemon.useStatus).end();
			return;
		}
		const refMatch = /^\/refs\/(\d+)$/.exec(url.pathname);
		if (refMatch && req.method === "GET") {
			const n = Number(refMatch[1]);
			const item = daemon.refs.find((entry) => entry.ref === n);
			if (!item) {
				json(404, { error: "没有这个编号" });
				return;
			}
			json(200, item);
			return;
		}
		if (url.pathname === "/status" && req.method === "GET") {
			const body: Record<string, unknown> = { listener: null, queued: 0, delivered: daemon.refs.length };
			if (daemon.statusUrl !== "") body.url = daemon.statusUrl;
			json(daemon.statusCode, body);
			return;
		}
		json(404, { error: "not found" });
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	daemon.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return daemon;
}

/** 一个只挂着不答话的 HTTP 服务：用来验超时（连接建立得成，就是没有响应） */
export async function startSilentServer(): Promise<{ base: string; close(): Promise<void> }> {
	let hanging: Server;
	hanging = createServer(() => {
		// 有意不回：请求会一直挂着，被客户端的 timeout / abort 掐掉
	});
	await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
	return {
		base: `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`,
		close: () => new Promise<void>((resolve) => hanging.close(() => resolve())),
	};
}

/** 等一个条件成立；超时抛错，避免断言挂死在永远不会到来的事件上 */
export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (!predicate()) throw new Error(`等 ${timeoutMs}ms 条件仍未成立`);
}
