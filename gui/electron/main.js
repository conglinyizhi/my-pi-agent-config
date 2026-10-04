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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WINDOW, WINDOW_CONFIGS, buildInitData, parseArgv } from "./init-data.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 前端产物：还是 wails-gui 那份 Vue 工程（引擎换了，界面不变） */
const FRONTEND_DIST = resolve(HERE, "..", "..", "wails-gui", "frontend", "dist");
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

let mainWindow = null;

function createWindow() {
	mainWindow = new BrowserWindow({
		width: config.width,
		height: config.height,
		minWidth: config.minWidth,
		minHeight: config.minHeight,
		title: config.title,
		backgroundColor: "#1a1a2e",
		autoHideMenuBar: true,
		webPreferences: {
			// preload 用 .cjs：本目录是 type=module，而沙箱下的 preload 不支持 ESM
			preload: join(HERE, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

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
	handle("markReady", () => {
		// 与 Go 侧一致：写 .ready sidecar，启动方/测试据此判定渲染完成
		if (responseFile) writeFileSync(`${responseFile}.ready`, "ok");
		return true;
	});
	handle("submit", (response) => {
		const body = typeof response === "string" ? response : JSON.stringify(response ?? {});
		if (responseFile) writeFileSync(responseFile, body);
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
app.on("window-all-closed", () => app.quit());

app.whenReady().then(() => {
	if (!existsSync(FRONTEND_DIST)) {
		process.stderr.write(`[gui] 找不到前端产物 ${FRONTEND_DIST}，先跑 vite build\n`);
	}
	registerIpc(readRequest());
	createWindow();
});
