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
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WINDOW, WINDOW_CONFIGS, buildInitData, parseArgv } from "./init-data.js";
import { buildEditorCommand, detectEditors } from "./editor-open.js";
import { resolveCliPath } from "./cli-path.js";
import { versionLabelFrom } from "./slot-version.js";
import { createServeBridge } from "./serve-bridge.js";
import { readStatusSnapshot } from "./status-file.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 槽根在 gui/electron 的上两级；仓库里跑时没有 manifest，标签为空 */
const VERSION = versionLabelFrom(resolve(HERE, "..", "..", "manifest.json"));
/** 前端产物：gui/frontend（Vue 工程，与引擎无关；两个引擎共用一份 dist） */
const FRONTEND_DIST = resolve(HERE, "..", "frontend", "dist");
/** 审核设置的 JSON 桥（主进程是纯 JS，读不了 .ts，也绝不在主进程重写 TOML 逻辑） */
const REVIEW_CLI = resolveCliPath("review-settings-cli.ts", { here: HERE });
/** 审核流程的 JSON 桥（数据层：图、体检、存盘） */
/** 审核规则表的 JSON 桥（数据层：读、序列化、校验、存盘） */
const RULES_CLI = resolveCliPath("review-rules-cli.ts", { here: HERE });
// subagent 状态快照的取数在 status-file.js（纯模块、有单测）：多会话并存时，
// 看板窗读的必须是它自己被指定的那份快照，不是全局那一份。

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

// ── 常驻桥 ──
// 一次性 spawn 每次保存都要冷启一个 node 并转译一遍模块图（同机实测 ~750ms），
// 而且 spawnSync 会把主进程整个卡住，所有窗口一起冻。所以默认走常驻进程：
// 只有第一次付冷启动，之后每个请求就是个来回；起不来或中途死掉再退回一次性。

/** 常驻桥：审核设置与审核流程各一条（同一份实现，见 serve-bridge.js） */
const reviewBridge = createServeBridge({
	cliPath: REVIEW_CLI,
	nodeBin: resolveNodeBin(),
	// 一次性回落的参数：set 走 set，其余按读处理
	oneShotArgs: (cmd) => [cmd === "set" ? "set" : "get"],
});

/** 设置窗的读写入口：常驻优先，拿不到就退回一次性 */
function reviewRequest(cmd, patch) {
	return reviewBridge.request(cmd, patch);
}

/** 收工：常驻进程不能留成孤儿 */
function stopReviewServe() {
	reviewBridge.stop();
}

/** 审核规则表的桥：get / save（数据层在 scripts/review-rules-cli.ts） */
const rulesBridge = createServeBridge({
	cliPath: RULES_CLI,
	nodeBin: resolveNodeBin(),
	// 一次性回落只够跑 get：save 要带补丁文件，回落路径给不了（常驻桥才是正路）
	oneShotArgs: (cmd) => [cmd],
});

let mainWindow = null;

function createWindow() {
	mainWindow = new BrowserWindow({
		width: config.width,
		height: config.height,
		minWidth: config.minWidth,
		minHeight: config.minHeight,
		// 标题中间带上槽与短 sha：A/B 切过之后一眼看得出在跑哪一份
		title: VERSION ? `${config.title} · ${VERSION}` : config.title,
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

	// ── 把文件/差异丢给本机编辑器 ──
	// 审核窗只负责显示，真要读代码还是去编辑器。命令在 editor-open.js 里拼好，
	// 这里只管探测、写临时文件、spawn（数组参数，不经 shell）。
	handle("editor:list", () => detectEditors(hasBinary));
	handle("editor:open", ({ editorId, target } = {}) => openTargetInEditor(editorId, target));
	handle("copyText", (text) => {
		clipboard.writeText(String(text ?? ""));
		return true;
	});

	// ── 审核设置（review 窗口）──
	// 读：每次都现读文件（改完即生效，设置窗自己也会再拉一次）。
	// 写：patch → 桥脚本；校验不过时原样把 issues 交给前端展示，文件没被动过。
	handle("review:load", () => reviewRequest("get"));
	handle("review:save", (patch) => reviewRequest("set", patch ?? {}));

	// 读：列流程与体检结果；选中一条再取它的图与源码（图可能不小，分开取）。
	// 写：save 先过越界检查再落盘，校验结果原样交给前端展示。
	handle("rules:get", () => rulesBridge.request("get"));
	handle("rules:save", (patch) => rulesBridge.request("save", patch ?? {}));

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
	handle("subagents:status", (requestedPath) => {
		// 状态快照可以直接给；补件队列的富化还没搬。
		// 带上实际路径与回退标记：前端要能看出读的是不是指定的那份。
		return readStatusSnapshot(requestedPath);
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
	flowsBridge.stop();
	app.quit();
});
app.on("will-quit", () => {
	stopReviewServe();
	flowsBridge.stop();
});

app.whenReady().then(() => {
	if (!existsSync(FRONTEND_DIST)) {
		process.stderr.write(`[gui] 找不到前端产物 ${FRONTEND_DIST}，先跑 vite build\n`);
	}
	registerIpc(readRequest());
	createWindow();
});

/** PATH 里找可执行文件（不 shell out：这个探测要快，也不受 PATH 里怪东西影响） */
function hasBinary(name) {
	if (!name) return false;
	const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
	for (const dir of dirs) {
		try {
			accessSync(join(dir, name), constants.X_OK);
			return true;
		} catch {
			// 继续找下一个目录
		}
	}
	return false;
}

/**
 * 打开目标：文件（可带行号）、两份文本的差异、或一份补丁。
 *
 * 文本内容也走这条：要交给编辑器看差异，就得先落成文件。落盘一律 0600，
 * 放在 tmpdir 下每次独立的小目录——审核窗里的内容是脚本给的，不该长期留着。
 */
function openTargetInEditor(editorId, target) {
	const editor = detectEditors(hasBinary).find((entry) => entry.id === editorId);
	if (!editor) return { ok: false, error: "这个编辑器本机没有（或已经不在 PATH 里）" };
	const kind = target?.kind;
	let request;
	try {
		if (kind === "diff") {
			const dir = mkdtempSync(join(tmpdir(), "pi-guard-diff-"));
			const left = join(dir, "a-old.txt");
			const right = join(dir, "b-new.txt");
			writeFileSync(left, String(target.left ?? ""), { mode: 0o600 });
			writeFileSync(right, String(target.right ?? ""), { mode: 0o600 });
			request = { kind: "diff", left, right };
		} else if (kind === "patch") {
			const dir = mkdtempSync(join(tmpdir(), "pi-guard-patch-"));
			const file = join(dir, "change.patch");
			writeFileSync(file, String(target.patchText ?? ""), { mode: 0o600 });
			request = { kind: "open", path: file };
		} else {
			request = { kind: "open", path: String(target?.path ?? ""), line: target?.line };
		}
	} catch (error) {
		return { ok: false, error: `临时文件写不出去：${error?.message ?? error}` };
	}
	const command = buildEditorCommand(editor, request);
	if (command.error) return { ok: false, error: command.error };
	try {
		const child = spawn(command.bin, command.args, { detached: true, stdio: "ignore" });
		child.on("error", () => {}); // 起不来也不该把主进程带走
		child.unref();
	} catch (error) {
		return { ok: false, error: `起不来：${error?.message ?? error}` };
	}
	return { ok: true, editor: { id: editor.id, label: editor.label }, argv: [command.bin, ...command.args] };
}

