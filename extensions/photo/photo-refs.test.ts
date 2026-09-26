// extensions/photo/photo-refs.test.ts — lib/photo-refs 的 HTTP 客户端契约
//
// 跑法：node --experimental-strip-types extensions/photo/photo-refs.test.ts
//
// 每个用例起一个真的假守护（临时端口，见 fake-daemon.ts），不碰真 photo 守护。
// 这里钉的是「有没有按契约说话」：地址与口令怎么带、404 怎么算、失败是否可读、
// useRef 会不会把异常甩给调用方。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { networkInterfaces } from "node:os";
import { createPhotoRefs, listRefs, pickLanHost, reachableBase } from "../../lib/photo-refs.ts";
import { startFakeDaemon, startSilentServer, waitFor, type FakeDaemon } from "./fake-daemon.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

let dir = "";
let tokenFile = "";
let daemon: FakeDaemon | undefined;
let silent: Awaited<ReturnType<typeof startSilentServer>> | undefined;
/** 用例里被改过的环境变量，afterEach 里恢复 */
const touchedEnv = new Set<string>();

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-photo-refs-"));
	tokenFile = join(dir, "token");
	writeFileSync(tokenFile, `${TOKEN}\n`);
});

afterEach(async () => {
	if (daemon) {
		await daemon.close();
		daemon = undefined;
	}
	if (silent) {
		await silent.close();
		silent = undefined;
	}
	for (const key of touchedEnv) delete process.env[key];
	touchedEnv.clear();
	rmSync(dir, { recursive: true, force: true });
});

function setEnv(key: string, value: string): void {
	touchedEnv.add(key);
	process.env[key] = value;
}

describe("listRefs", () => {
	it("拿回池子，请求带上 ?k=<口令>", async () => {
		daemon = await startFakeDaemon({
			refs: [
				{ ref: 1, path: "/tmp/a/1.jpg", bytes: 1234, ts: "2026-09-26T05:00:00Z", lastUsed: "2026-09-26T05:01:00Z" },
				{ ref: 3, path: "/tmp/a/3.png", bytes: 99 },
			],
		});
		const refs = createPhotoRefs({ base: daemon.base, tokenFile });
		const pool = await refs.listRefs();

		assert.equal(pool.pool, 2);
		assert.deepEqual(pool.items, [
			{ ref: 1, path: "/tmp/a/1.jpg", bytes: 1234, ts: "2026-09-26T05:00:00Z", lastUsed: "2026-09-26T05:01:00Z" },
			{ ref: 3, path: "/tmp/a/3.png", bytes: 99 },
		]);
		assert.equal(daemon.requestsOn("GET", "/refs").length, 1);
		assert.equal(daemon.requests[0].token, TOKEN);
	});

	it("形状不完整的条目直接丢掉，不用它去读文件", async () => {
		daemon = await startFakeDaemon({
			refs: [
				{ ref: 1, path: "/tmp/a/1.jpg" },
				{ ref: 2, path: "" } as { ref: number; path: string },
			],
		});
		const pool = await createPhotoRefs({ base: daemon.base, tokenFile }).listRefs();
		assert.deepEqual(pool.items.map((item) => item.ref), [1]);
	});

	it("守护没跑：错误里说清连不上谁", async () => {
		daemon = await startFakeDaemon();
		const base = daemon.base;
		await daemon.close();
		daemon = undefined;

		await assert.rejects(
			() => createPhotoRefs({ base, tokenFile, timeoutMs: 1000 }).listRefs(),
			/连不上 photo 守护/,
		);
	});

	it("守护不回话：按超时处理，不无限等", async () => {
		silent = await startSilentServer();
		await assert.rejects(
			() => createPhotoRefs({ base: silent?.base ?? "", tokenFile, timeoutMs: 150 }).listRefs(),
			/没响应|超时/,
		);
	});

	it("守护不认口令：错误提到口令，不拿网络问题糊过去", async () => {
		daemon = await startFakeDaemon({ expectToken: "别的口令", refs: [{ ref: 1, path: "/tmp/a/1.jpg" }] });
		await assert.rejects(
			() => createPhotoRefs({ base: daemon?.base ?? "", tokenFile }).listRefs(),
			/口令/,
		);
	});

	it("口令文件不存在：可读的「守护还没初始化」，不是裸 ENOENT", async () => {
		daemon = await startFakeDaemon();
		await assert.rejects(
			() => createPhotoRefs({ base: daemon?.base ?? "", tokenFile: join(dir, "没有这个文件") }).listRefs(),
			(err: Error) => {
				assert.match(err.message, /守护还没初始化/);
				assert.match(err.message, /口令文件不存在/);
				assert.doesNotMatch(err.message, /ENOENT/);
				return true;
			},
		);
	});

	it("口令文件是空的：同样报「守护还没初始化」", async () => {
		daemon = await startFakeDaemon();
		const empty = join(dir, "empty-token");
		writeFileSync(empty, "\n");
		await assert.rejects(
			() => createPhotoRefs({ base: daemon?.base ?? "", tokenFile: empty }).listRefs(),
			/口令文件是空的/,
		);
	});

	it("默认入口读 PI_PHOTO_BASE 与 PI_PHOTO_TOKEN_FILE", async () => {
		daemon = await startFakeDaemon({ refs: [{ ref: 5, path: "/tmp/a/5.webp" }] });
		setEnv("PI_PHOTO_BASE", `${daemon.base}/`);
		setEnv("PI_PHOTO_TOKEN_FILE", tokenFile);

		const pool = await listRefs();
		assert.deepEqual(pool.items.map((item) => item.ref), [5]);
	});
});

describe("getRef", () => {
	it("命中：拿回那一条", async () => {
		daemon = await startFakeDaemon({ refs: [{ ref: 3, path: "/tmp/a/3.jpg", bytes: 7 }] });
		const item = await createPhotoRefs({ base: daemon.base, tokenFile }).getRef(3);
		assert.deepEqual(item, { ref: 3, path: "/tmp/a/3.jpg", bytes: 7 });
	});

	it("404：返回 undefined，不当异常", async () => {
		daemon = await startFakeDaemon({ refs: [{ ref: 1, path: "/tmp/a/1.jpg" }] });
		const item = await createPhotoRefs({ base: daemon.base, tokenFile }).getRef(9);
		assert.equal(item, undefined);
	});

	it("回了 200 但形状不认识：抛可读错误，不当成「没有」", async () => {
		daemon = await startFakeDaemon({ refs: [{ ref: 7, path: "/tmp/a/7.jpg" }] });
		// 守护回 200 {ref:7}，缺 path —— 这种只能算协议坏了，不能悄悄当 404
		daemon.refs = [{ ref: 7 } as { ref: number; path: string }];
		await assert.rejects(
			() => createPhotoRefs({ base: daemon?.base ?? "", tokenFile }).getRef(7),
			/形状不认识/,
		);
	});
});

describe("useRef", () => {
	it("成功：守护收到 POST /refs/<n>/use，调用方不等也不抛", async () => {
		daemon = await startFakeDaemon({ refs: [{ ref: 4, path: "/tmp/a/4.jpg" }] });
		const refs = createPhotoRefs({ base: daemon.base, tokenFile });
		refs.useRef(4);
		await waitFor(() => daemon !== undefined && daemon.requestsOn("POST", "/refs/4/use").length === 1);
		assert.equal(daemon.requestsOn("POST", "/refs/4/use")[0].token, TOKEN);
	});

	it("守护回 500：不抛，只记一行日志", async () => {
		daemon = await startFakeDaemon({ useStatus: 500 });
		const lines: string[] = [];
		createPhotoRefs({ base: daemon.base, tokenFile, logger: (message) => lines.push(message) }).useRef(4);
		await waitFor(() => lines.length > 0);
		assert.match(lines[0], /#4/);
		assert.match(lines[0], /HTTP 500/);
	});

	it("守护根本连不上：也不抛", async () => {
		daemon = await startFakeDaemon();
		const base = daemon.base;
		await daemon.close();
		daemon = undefined;

		const lines: string[] = [];
		createPhotoRefs({ base, tokenFile, timeoutMs: 1000, logger: (message) => lines.push(message) }).useRef(4);
		await waitFor(() => lines.length > 0);
		assert.match(lines[0], /回执没发出去/);
	});

	it("口令文件读不到：同样只记日志，不让调用方炸", async () => {
		const lines: string[] = [];
		createPhotoRefs({ tokenFile: join(dir, "没有这个文件"), logger: (message) => lines.push(message) }).useRef(1);
		await waitFor(() => lines.length > 0);
		assert.match(lines[0], /守护还没初始化/);
	});
});

describe("uploadUrl", () => {
	it("/status 给了 url：用它，并保证带 ?k=", async () => {
		daemon = await startFakeDaemon({ statusUrl: "http://192.168.1.20:8787/" });
		const url = await createPhotoRefs({ base: daemon.base, tokenFile }).uploadUrl();
		assert.equal(url, `http://192.168.1.20:8787/?k=${TOKEN}`);
	});

	it("/status 没给 url：按 BASE 拼", async () => {
		daemon = await startFakeDaemon();
		const url = await createPhotoRefs({ base: daemon.base, tokenFile }).uploadUrl();
		assert.equal(url, `${daemon.base}/?k=${TOKEN}`);
	});

	it("守护回 401：抛口令错误，不退回一个用不了的地址", async () => {
		daemon = await startFakeDaemon({ expectToken: "别的口令" });
		await assert.rejects(
			() => createPhotoRefs({ base: daemon?.base ?? "", tokenFile }).uploadUrl(),
			/口令/,
		);
	});

	it("守护没跑：退回 BASE 拼出来的地址（上传页就在根路径）", async () => {
		daemon = await startFakeDaemon();
		const base = daemon.base;
		await daemon.close();
		daemon = undefined;
		const url = await createPhotoRefs({ base, tokenFile, timeoutMs: 1000 }).uploadUrl();
		assert.equal(url, `${base}/?k=${TOKEN}`);
	});
});

describe("手机地址兜底", () => {
	function iface(address: string, opts: { internal?: boolean; family?: string } = {}) {
		return {
			address,
			netmask: "255.255.255.0",
			family: opts.family ?? "IPv4",
			mac: "00:00:00:00:00:00",
			internal: opts.internal ?? false,
			cidr: `${address}/24`,
		};
	}
	/** 造一份假的网卡清单：回环 + 用例给定的那几张 */
	const withIfaces = (list: Array<ReturnType<typeof iface>>) =>
		({
			lo: [iface("127.0.0.1", { internal: true })],
			eth0: list,
		}) as unknown as ReturnType<typeof networkInterfaces>;

	it("默认地址是回环时，换成本机局域网 IPv4（端口不变）", () => {
		const interfaces = withIfaces([iface("192.168.1.7")]);
		assert.equal(reachableBase("http://127.0.0.1:8787", interfaces), "http://192.168.1.7:8787");
		assert.equal(reachableBase("http://0.0.0.0:8787", interfaces), "http://192.168.1.7:8787");
	});

	it("私有网段优先，跳过链路本地", () => {
		const interfaces = withIfaces([iface("169.254.3.4"), iface("100.64.0.1"), iface("10.0.0.9")]);
		assert.equal(pickLanHost(interfaces), "10.0.0.9");
		assert.equal(pickLanHost(withIfaces([iface("100.64.0.1")])), "100.64.0.1");
		assert.equal(pickLanHost(withIfaces([iface("fe80::1", { family: "IPv6" })])), undefined);
	});

	it("没一个能用的地址就原样返回", () => {
		const interfaces = withIfaces([]);
		assert.equal(pickLanHost(interfaces), undefined);
		assert.equal(reachableBase("http://127.0.0.1:8787", interfaces), "http://127.0.0.1:8787");
	});

	it("非回环地址一个字节也不动", () => {
		const interfaces = withIfaces([iface("192.168.1.7")]);
		assert.equal(reachableBase("http://10.0.0.5:9999", interfaces), "http://10.0.0.5:9999");
	});

	it("uploadUrl 用显式 base 时不做替换（假守护的地址得原样）", async () => {
		daemon = await startFakeDaemon();
		const url = await createPhotoRefs({ base: daemon.base, tokenFile }).uploadUrl();
		assert.equal(url, `${daemon.base}/?k=${TOKEN}`);
	});
});
