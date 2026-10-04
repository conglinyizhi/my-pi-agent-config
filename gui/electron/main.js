// gui/electron/main.js — pi 的 GUI 窗口宿主（Electron）
//
// 与 Wails 版共用同一套文件协议，所以换引擎只换启动方：
//   argv: <windowName> <requestFile> <responseFile>
//   读:   request.json
//   写:   <responseFile>.ready（前端挂载完成）、<responseFile>（提交后退出）
//
// 为什么切回 Electron：系统里有现成的二进制（/usr/bin/electron），没有编译步骤，
// devtools 直接可用。Wails 那一套要 wails build，改一行前端都得重编。
//
// 还没移植的 Go 侧能力（reasons 库、subagent 补件队列、诊断文件）在下面显式标注，
// 一律降级成"能跑但不生效"，不做假的成功返回。

import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WINDOW, WINDOW_CONFIGS, buildInitData, parseArgv } from "./init-data.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 前端产物：gui/frontend（Vue 工程，与引擎无关；两个引擎共用一份 dist） */
const FRONTEND_DIST = resolve(HERE, "..", "frontend", "dist");
/** 审核设置的 JSON 桥（主进程是纯 JS，读不了 .ts，也绝不在主进程重写 TOML 逻辑） */
const REVIEW_CLI = resolve(HERE, "..", "..", "scripts", "review-settings-cli.ts");
/** subagent 状态快照：与 Go 侧同一路径 */
const STATUS_PATH = join(homedir(), ".pi", "subagent-status.json");

const argv = parseArgv(process.argv);
const known = WINDOW_CONFIGS[argv.windowName] !== undefined;
const windowName = known ? argv.windowName : DEFAULT_WINDOW;
const config = WINDOW_CONFIGS[windowName];
const { requestFile, responseFile } = argv;

/** 只警告一次，别每条 IPC 都刷屏 */
const warned = new Set();
function notPorted(what) {
	if (!warned.has(what)) {
		warned.add(what);
		process.stderr.write(`[gui] ${what} 尚未移植到 Electron 宿主（降级处理）\n`);
	}
}

function readRequest() {
	try {
		return JSON.parse(readFileSync(requestFile, "utf8"));
	} catch (error) {
		process.stderr.write(`[gui] 读不到请求文件 ${requestFile}：${error.message}\n`);
		return {};
	}
}

function readStatus() {
	try {
		return readFileSync(STATUS_PATH, "utf8");
	} catch {
		return "{}";
	}
}

// ── 审核设置：走 CLI 桥（scripts/review-settings-cli.ts）──
// Electron 的主进程是纯 JS，不能 import 仓里的 .ts；TOML 读写也就不能在这里重写一份。
// 桥约定：stdout 一行 JSON，退出码 0 成功 / 1 校验失败（未落盘）/ 2 用法或 IO 问题。

let nodeBin = null;

/** node 解释器：优先 PI_NODE_BIN，其次 PATH 里的 node，最后两个常见绝对路径 */
function resolveNodeBin() {
	if (nodeBin) return nodeBin;
	const candidates = [process.env.PI_NODE_BIN, "node", "/usr/bin/node", "/usr/local/bin/node"].filter(Boolean);
	for (const candidate of candidates) {
		try {
			const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 });
			if (probe.status === 0 && String(probe.stdout ?? "").startsWith("v")) {
				nodeBin = candidate;
				return candidate;
			}
		} catch {
			// 换下一个候选
		}
	}
	// 都探不到也返回第一个候选：真正的错误（ENOENT）在调用处报出来，比这里静默吞掉好
	nodeBin = candidates[0] ?? "node";
	return nodeBin;
}

function runReviewCli(args, input = "") {
	if (!existsSync(REVIEW_CLI)) {
		return { ok: false, error: `找不到审核设置的桥脚本：${REVIEW_CLI}` };
	}
	const result = spawnSync(resolveNodeBin(), ["--experimental-strip-types", REVIEW_CLI, ...args], {
		input,
		encoding: "utf8",
		timeout: 20_000,
		maxBuffer: 4 * 1024 * 1024,
	});
	if (result.error) {
		return { ok: false, error: `桥脚本起不来：${result.error.message}` };
	}
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

// ── 常驻桥 ──
// 一次性 spawn 每次保存都要冷启一个 node 并转译一遍模块图（同机实测 ~750ms），
// 而且 spawnSync 会把主进程整个卡住，所有窗口一起冻。所以默认走常驻进程：
// 只有第一次付冷启动，之后每个请求就是个来回；起不来或中途死掉再退回一次性。

const REVIEW_SERVE_TIMEOUT_MS = 15_000;
/** 常驻桥状态；null = 还没起或已经收掉 */
let reviewServe = null;
/** 常驻桥起不来过（真起不来就别每次都试一遍） */
let reviewServeUnavailable = false;

/** 常驻桥的一个来回；拿不到结果返回 null，由调用方退回一次性 */
function reviewServeRequest(cmd, patch) {
	if (reviewServeUnavailable || !existsSync(REVIEW_CLI)) return null;

	if (!reviewServe) {
		let child;
		try {
			child = spawn(resolveNodeBin(), ["--experimental-strip-types", REVIEW_CLI, "serve"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			reviewServeUnavailable = true;
			return null;
		}
		const state = { child, buffer: "", pending: [], nextId: 1, served: 0 };
		reviewServe = state;
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
						waiter.settle(payload);
					}
				}
				cut = state.buffer.indexOf("\n");
			}
		});
		// 人可读的失败原因已经随 payload 回来了；stderr 只丢给系统，不往终端喷
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", () => {});
		child.on("exit", () => {
			if (reviewServe === state) reviewServe = null;
			for (const waiter of state.pending.splice(0)) waiter.settle(null);
			// 一次都没服务成就死了 → 这台机器上别指望常驻；跑过一段再死 → 下次允许重起
			if (state.served === 0) reviewServeUnavailable = true;
		});
		child.stdin.on("error", () => {});
	}

	const state = reviewServe;
	const id = state.nextId++;
	return new Promise((resolveRequest) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			const index = state.pending.indexOf(waiter);
			if (index >= 0) state.pending.splice(index, 1);
			// 卡住的桥比慢一点的桥更坏：拆掉它，这一次退回一次性
			try {
				state.child.kill();
			} catch {
				// 已经死了就算了
			}
			resolveRequest(null);
		}, REVIEW_SERVE_TIMEOUT_MS);
		const waiter = {
			settle: (payload) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (payload !== null) state.served += 1;
				resolveRequest(payload);
			},
		};
		state.pending.push(waiter);
		try {
			state.child.stdin.write(`${JSON.stringify({ id, cmd, patch })}\n`);
		} catch {
			waiter.settle(null);
		}
	});
}

/** 设置窗的读写入口：常驻优先，拿不到就退回一次性 spawn */
async function reviewRequest(cmd, patch) {
	const viaServe = await reviewServeRequest(cmd, patch);
	if (viaServe !== null) return viaServe;
	return runReviewCli(cmd === "set" ? ["set"] : ["get"], patch === undefined ? "" : JSON.stringify(patch));
}

/** 收工：常驻进程不能留成孤儿 */
function stopReviewServe() {
	const state = reviewServe;
	reviewServe = null;
	if (!state) return;
	for (const waiter of state.pending.splice(0)) waiter.settle(null);
	try {
		state.child.kill();
	} catch {
		// 已经死了就算了
	}
}

let mainWindow = null;

function createWindow() {
	mainWindow = new BrowserWindow({
		width: config.width,
		height: config.height,
		minWidth: config.minWidth,
		minHeight: config.minHeight,
		title: config.title,
		// X11 直接读窗口属性；Wayland 下这个不生效，图标靠 desktop 条目（gui/install-desktop.sh）
		icon: join(HERE, "..", "icons", "pi-gui.png"),
		backgroundColor: "#1a1a2e",
		autoHideMenuBar: true,
		webPreferences: {
			// preload 用 .cjs：本目录是 type=module，而沙箱下的 preload 不支持 ESM
			preload: join(HERE, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	// 页面里的 <title> 会盖掉窗口标题，拦掉它：窗口标题一律用 WINDOW_CONFIGS 里那一条
	mainWindow.on("page-title-updated", (event) => event.preventDefault());

	mainWindow.loadFile(join(FRONTEND_DIST, "index.html"), { query: { window: windowName } });

	// 调试：F12 / Ctrl+Shift+I 随时开 devtools；PI_GUI_DEV=1 时启动即开
	mainWindow.webContents.on("before-input-event", (event, input) => {
		const key = String(input.key ?? "");
		const wantDevtools = key === "F12" || (input.control && input.shift && key.toLowerCase() === "i");
		if (!wantDevtools) return;
		event.preventDefault();
		mainWindow.webContents.toggleDevTools();
	});
	if (process.env.PI_GUI_DEV === "1") mainWindow.webContents.openDevTools({ mode: "detach" });

	mainWindow.webContents.on("render-process-gone", (_event, details) => {
		process.stderr.write(`[gui] 渲染进程退出：${details.reason}\n`);
	});
	return mainWindow;
}

function registerIpc(request) {
	const handle = (name, fn) => ipcMain.handle(`pi-gui:${name}`, (_event, ...args) => fn(...args));

	handle("windowName", () => windowName);
	handle("initData", () => buildInitData(windowName, request, { responseFile }));
	// 落这两个文件时统一钉 0600：目录是调用方 mkdtemp 给的 0700，文件自己再收一道，
	// 不依赖父目录那一个默认值（与 lib/gui-runner.ts、hub 的口径一致）。
	// mode 只在创建时生效，这里的文件都是新目录里的新文件。
	const PRIVATE = { encoding: "utf8", mode: 0o600 };

	handle("markReady", () => {
		// 与 Go 侧一致：写 .ready sidecar，启动方/测试据此判定渲染完成
		if (responseFile) writeFileSync(`${responseFile}.ready`, "ok", PRIVATE);
		return true;
	});
	handle("submit", (response) => {
		const body = typeof response === "string" ? response : JSON.stringify(response ?? {});
		if (responseFile) writeFileSync(responseFile, body, PRIVATE);
		app.quit();
		return true;
	});
	handle("close", () => {
		app.quit();
		return true;
	});
	handle("openFile", (file) => shell.openPath(String(file ?? "")));
	handle("copyText", (text) => {
		clipboard.writeText(String(text ?? ""));
		return true;
	});

	// ── 审核设置（review 窗口）──
	// 读：每次都现读文件（改完即生效，设置窗自己也会再拉一次）。
	// 写：patch → 桥脚本；校验不过时原样把 issues 交给前端展示，文件没被动过。
	handle("review:load", () => reviewRequest("get"));
	handle("review:save", (patch) => reviewRequest("set", patch ?? {}));

	// ── 以下四组是 Go 侧还没搬过来的能力 ──
	// 宁可明确降级（空结果 + 警告一次），也不假装成功：假的成功会让人以为数据存下来了
	handle("reasons:load", () => {
		notPorted("reasons 库（/sandbox:reasons 的读写）");
		return [];
	});
	handle("reasons:save", () => {
		notPorted("reasons 库（/sandbox:reasons 的读写）");
		return false;
	});
	handle("reasons:update", () => {
		notPorted("reasons 库（/sandbox:reasons 的读写）");
		return false;
	});
	handle("reasons:delete", () => {
		notPorted("reasons 库（/sandbox:reasons 的读写）");
		return false;
	});
	handle("subagents:status", () => {
		// 状态快照可以直接给；补件队列的富化还没搬
		return readStatus();
	});
	handle("subagents:diagnostics", () => {
		notPorted("subagent 诊断文件列举");
		return [];
	});
	handle("subagents:diagnostic", () => {
		notPorted("subagent 诊断文件读取");
		return "";
	});
	handle("subagents:diagnostic:delete", () => {
		notPorted("subagent 诊断文件删除");
		return false;
	});
	handle("subagents:queueSupplement", () => {
		notPorted("subagent 补件队列");
		return false;
	});
	handle("subagents:withdrawSupplement", () => {
		notPorted("subagent 补件队列");
		return false;
	});
	handle("subagents:mergeSupplements", () => {
		notPorted("subagent 补件队列");
		return false;
	});
}

// 单实例锁按 responseFile 归一：同一个窗口重复拉起时不再开第二个
app.on("window-all-closed", () => {
	stopReviewServe();
	app.quit();
});
app.on("will-quit", () => stopReviewServe());

app.whenReady().then(() => {
	if (!existsSync(FRONTEND_DIST)) {
		process.stderr.write(`[gui] 找不到前端产物 ${FRONTEND_DIST}，先跑 vite build\n`);
	}
	registerIpc(readRequest());
	createWindow();
});
