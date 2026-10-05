// serve-bridge.js — 常驻 CLI 桥：主进程是纯 JS，读不了 .ts，数据层走桥脚本
//
// 形状：常驻进程 + 一行一个 JSON 的来回；起不来或卡住就退回一次性 spawn。
// 起不来过就记住，别每次都试一遍；卡住的桥比慢一点的桥更坏，超时直接拆掉。
//
// 抽出来是因为这东西要复用在两处（审核设置、审核流程）。spawn 与时钟都注入，方便单测。

import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

export function createServeBridge(options) {
	const {
		cliPath,
		nodeBin,
		timeoutMs = 15_000,
		oneShotTimeoutMs = 20_000,
		oneShotArgs = (cmd, patch) => [cmd],
		oneShotInput = (_cmd, patch) => (patch === undefined ? "" : JSON.stringify(patch)),
		spawnImpl = spawn,
		spawnSyncImpl = spawnSync,
		argvPrefix = ["--experimental-strip-types"],
	} = options;

	let serve = null;
	let unavailable = false;

	function startServe() {
		if (unavailable || !existsSync(cliPath)) return null;
		if (serve) return serve;
		let child;
		try {
			child = spawnImpl(nodeBin, [...argvPrefix, cliPath, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
		} catch {
			unavailable = true;
			return null;
		}
		const state = { child, buffer: "", pending: [], nextId: 1, served: 0 };
		serve = state;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			state.buffer += chunk;
			let cut = state.buffer.indexOf("\n");
			while (cut >= 0) {
				const line = state.buffer.slice(0, cut).trim();
				state.buffer = state.buffer.slice(cut + 1);
				if (line !== "") {
					const waiter = state.pending.shift();
					if (waiter) {
						let payload;
						try {
							payload = JSON.parse(line);
						} catch {
							payload = { ok: false, error: `桥输出不是 JSON：${line.slice(0, 120)}` };
						}
						// 串行桥：响应按请求顺序回来，谁等就交给谁
						waiter.settle(payload);
					}
				}
				cut = state.buffer.indexOf("\n");
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", () => {});
		child.on("exit", () => {
			if (serve === state) serve = null;
			for (const waiter of state.pending.splice(0)) waiter.settle(null);
			if (state.served === 0) unavailable = true;
		});
		child.stdin.on("error", () => {});
		return state;
	}

	function serveRequest(cmd, patch) {
		const state = startServe();
		if (!state) return Promise.resolve(null);
		const id = state.nextId;
		state.nextId += 1;
		return new Promise((resolveRequest) => {
			let settled = false;
			const waiter = {
				settle: (payload) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (payload !== null) state.served += 1;
					resolveRequest(payload);
				},
			};
			const timer = setTimeout(() => {
				if (settled) return;
				const index = state.pending.indexOf(waiter);
				if (index >= 0) state.pending.splice(index, 1);
				try {
					state.child.kill();
				} catch {
					// 已经死了就算了
				}
				waiter.settle(null);
			}, timeoutMs);
			state.pending.push(waiter);
			try {
				state.child.stdin.write(`${JSON.stringify({ id, cmd, patch })}\n`);
			} catch {
				waiter.settle(null);
			}
		});
	}

	function oneShot(cmd, patch) {
		if (!existsSync(cliPath)) return { ok: false, error: `找不到桥脚本：${cliPath}` };
		const result = spawnSyncImpl(nodeBin, [...argvPrefix, cliPath, ...oneShotArgs(cmd, patch)], {
			input: oneShotInput(cmd, patch),
			encoding: "utf8",
			timeout: oneShotTimeoutMs,
			maxBuffer: 4 * 1024 * 1024,
		});
		if (result.error) return { ok: false, error: `桥脚本起不来：${result.error.message}` };
		const stdout = String(result.stdout ?? "").trim();
		if (!stdout) {
			const stderr = String(result.stderr ?? "").trim().split("\n")[0] ?? "";
			return { ok: false, error: `桥脚本没有输出${stderr ? `：${stderr}` : ""}` };
		}
		try {
			return JSON.parse(stdout.split("\n").at(-1));
		} catch {
			return { ok: false, error: `桥脚本输出不是 JSON：${stdout.slice(0, 200)}` };
		}
	}

	return {
		/** 常驻优先，拿不到就退回一次性 */
		async request(cmd, patch) {
			const viaServe = await serveRequest(cmd, patch);
			if (viaServe !== null) return viaServe;
			return oneShot(cmd, patch);
		},
		/** 收工：常驻进程不能留成孤儿 */
		stop() {
			const state = serve;
			serve = null;
			if (!state) return;
			for (const waiter of state.pending.splice(0)) waiter.settle(null);
			try {
				state.child.kill();
			} catch {
				// 已经死了就算了
			}
		},
	};
}
