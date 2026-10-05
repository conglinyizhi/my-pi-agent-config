// gui/electron/serve-bridge.test.mjs — 常驻 CLI 桥（注入假 spawn，不真起进程）
// 跑法：node --test gui/electron/serve-bridge.test.mjs

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createServeBridge } from "./serve-bridge.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 假的子进程：能收写、能吐 stdout、能被杀（杀的时候像真的那样发 exit） */
function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stdout.setEncoding = () => {};
	child.stderr = new EventEmitter();
	child.stderr.setEncoding = () => {};
	child.writes = [];
	child.stdin = { write: (line) => child.writes.push(line), on: () => {} };
	child.kill = () => {
		child.killed = true;
		child.emit("exit");
	};
	return child;
}

function bridge(overrides = {}) {
	const child = overrides.child ?? fakeChild();
	const oneShot = overrides.oneShot ?? { ok: true, from: "one-shot" };
	const instance = createServeBridge({
		cliPath: HERE + "/serve-bridge.js",
		nodeBin: "node",
		spawnImpl: overrides.spawnImpl ?? (() => child),
		spawnSyncImpl: () => ({ stdout: JSON.stringify(oneShot), stderr: "" }),
		timeoutMs: overrides.timeoutMs ?? 200,
	});
	return { instance, child };
}

describe("常驻 CLI 桥", () => {
	it("一个来回：请求写进去，响应按顺序认领", async () => {
		const { instance, child } = bridge();
		const promise = instance.request("get", { id: "x" });
		assert.equal(child.writes.length, 1);
		const sent = JSON.parse(child.writes[0]);
		assert.equal(sent.cmd, "get");
		assert.deepEqual(sent.patch, { id: "x" });
		child.stdout.emit("data", JSON.stringify({ id: sent.id, ok: true, value: 7 }) + "\n");
		assert.deepEqual(await promise, { id: sent.id, ok: true, value: 7 });
		instance.stop();
	});

	it("两个请求：响应按顺序分别交给对应的人", async () => {
		const { instance, child } = bridge();
		const first = instance.request("list");
		const second = instance.request("get", { id: "a" });
		child.stdout.emit("data", JSON.stringify({ ok: true, who: "first" }) + "\n");
		child.stdout.emit("data", JSON.stringify({ ok: true, who: "second" }) + "\n");
		assert.equal((await first).who, "first");
		assert.equal((await second).who, "second");
		instance.stop();
	});

	it("起不来就退回一次性", async () => {
		const { instance } = bridge({
			spawnImpl: () => { throw new Error("没有 node"); },
			oneShot: { ok: true, from: "one-shot" },
		});
		assert.equal((await instance.request("list")).from, "one-shot");
	});

	it("卡住的桥：超时就拆掉，这一次退回一次性", async () => {
		const child = fakeChild();
		const { instance } = bridge({ child, timeoutMs: 20, spawnImpl: () => child });
		const payload = await instance.request("list");
		assert.equal(payload.from, "one-shot");
		assert.equal(child.killed, true, "卡住的那条要被拆掉");
	});

	it("stop：常驻进程不留成孤儿", async () => {
		const { instance, child } = bridge();
		void instance.request("list");
		instance.stop();
		assert.equal(child.killed, true);
	});
});
