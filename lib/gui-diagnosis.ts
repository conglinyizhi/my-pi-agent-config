// lib/gui-diagnosis.ts — GUI 不可用 / 回退 TUI 的原因诊断与修复建议
//
// 三个调用方共用这一层：
//   approval-channel   审批回退 TUI 前给原因
//   hub-channel        hub 在线、但本机 GUI 与适配器都没有时提前回退
//   extensions/*       /routing:gui /editor:gui /subagent:gui 的入口提示
//
// 只读诊断：查二进制候选位、hub socket / unit、构建工具链、会话显示变量。
// 这里不执行任何修复命令，只把「为什么」和「怎么修」拼成给人看的短文本。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根：lib/ 的上一级 */
export const REPO_ROOT = path.join(__dirname, "..");

/** 人工可读的排查文档（不被 pi 的 skill 扫描发现，只给人看） */
export const GUI_FALLBACK_DOC = path.join(REPO_ROOT, "skills", "clyzhi", "_internal", "gui-fallback-recovery.md");

/** 展示用路径：家目录前缀收成 ~ */
export function displayPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p;
}

/** 与 lib/gui-runner.ts 的 findGuiBinary 保持同一组候选位 */
export function guiBinaryCandidates(): string[] {
	return [
		path.join(os.homedir(), ".pi", "agent", "bin", "wails-gui"),
		path.join(REPO_ROOT, "wails-gui", "build", "bin", "wails-gui"),
	];
}

export interface GuiBinaryCandidate {
	path: string;
	exists: boolean;
	executable: boolean;
}

export interface GuiDiagnosis {
	/** 命中的可执行路径；null 表示候选位都没有可执行文件 */
	binary: string | null;
	candidates: GuiBinaryCandidate[];
	repoRoot: string;
	/** hub socket 是否存在 */
	hasHubSocket: boolean;
	/** pi-hub.service 是否 active；null 表示查不到（无 systemd 或超时） */
	hubUnitActive: boolean | null;
	hasWailsCli: boolean;
	hasGo: boolean;
	/** wails-gui/frontend/dist/index.html 是否已构建 */
	hasFrontendDist: boolean;
	/** webkit2gtk-4.1 是否可被 pkg-config 找到；null 表示 pkg-config 不可用 */
	hasWebkit2Gtk41: boolean | null;
	/** 当前会话有 DISPLAY / WAYLAND_DISPLAY */
	hasDisplayEnv: boolean;
}

export type GuiFallbackReason =
	| "no-binary"
	| "spawn-failed"
	| "timeout"
	| "exited"
	| "hub-unreachable"
	| "hub-no-channel";

/** runGuiWindow 的 reason → 诊断用的原因（aborted 不是故障，由调用方自行吞掉） */
export function classifyGuiFailure(reason: string | undefined): GuiFallbackReason {
	if (reason === "spawn") return "spawn-failed";
	if (reason === "timeout") return "timeout";
	if (reason === "exited") return "exited";
	return "no-binary";
}

function isExecutable(p: string): boolean {
	try {
		fs.accessSync(p, fs.constants.X_OK);
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function fileExists(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function inPath(name: string): boolean {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const dir of dirs) {
		if (isExecutable(path.join(dir, name))) return true;
		if (isExecutable(path.join(dir, `${name}.exe`))) return true;
	}
	return false;
}

function hubUnitActive(): boolean | null {
	try {
		const out = execFileSync("systemctl", ["--user", "is-active", "pi-hub.service"], {
			timeout: 800,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.toString("utf8").trim() === "active";
	} catch (err) {
		// is-active 对未运行单元也用非零退出码 + "inactive/failed"，能读到 stdout 就是答案
		const out = (err as { stdout?: Buffer }).stdout;
		if (out && out.length > 0) {
			const text = out.toString("utf8").trim();
			if (text === "active") return true;
			if (text === "inactive" || text === "failed" || text === "activating" || text === "deactivating") return false;
		}
		return null;
	}
}

function hasWebkit41(): boolean | null {
	try {
		execFileSync("pkg-config", ["--exists", "webkit2gtk-4.1"], { timeout: 800, stdio: "ignore" });
		return true;
	} catch (err) {
		// pkg-config 不在 / 命令失败要分开：前者查不到，后者是真缺库
		const code = (err as { status?: number }).status;
		if (code === undefined) return null;
		if (inPath("pkg-config")) return false;
		return null;
	}
}

/** 收集一次本机现状。checkCommands=false 时跳过 systemctl / pkg-config 这类子进程。 */
export function collectGuiDiagnosis(checkCommands = true): GuiDiagnosis {
	const candidates: GuiBinaryCandidate[] = guiBinaryCandidates().map((p) => ({
		path: p,
		exists: fs.existsSync(p),
		executable: isExecutable(p),
	}));
	const binary = candidates.find((c) => c.executable)?.path ?? null;

	return {
		binary,
		candidates,
		repoRoot: REPO_ROOT,
		hasHubSocket: fs.existsSync(path.join(os.homedir(), ".pi", "agent", "run", "hub.sock")),
		hubUnitActive: checkCommands ? hubUnitActive() : null,
		hasWailsCli: inPath("wails"),
		hasGo: inPath("go"),
		hasFrontendDist: fileExists(path.join(REPO_ROOT, "wails-gui", "frontend", "dist", "index.html")),
		hasWebkit2Gtk41: checkCommands ? hasWebkit41() : null,
		hasDisplayEnv: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
	};
}

/** 一句话说清这次为什么没走图形界面 */
export function guiFallbackReasonText(reason: GuiFallbackReason, d: GuiDiagnosis): string {
	switch (reason) {
		case "no-binary":
			return "没找到 wails-gui 二进制，图形审批窗起不来";
		case "spawn-failed":
			return "wails-gui 存在但进程起不来（不可执行或缺动态库）";
		case "timeout":
			return "图形窗没有在时限内给出结果（窗口没显示或卡住了）";
		case "exited":
			return "图形窗启动后直接退出，没有写出结果";
		case "hub-unreachable":
			return "连不上本机审批 hub（pi-hub.service 没起来）";
		case "hub-no-channel":
			return "hub 在跑，但本机 GUI 和 IM 适配器都不在线，没人能应答";
	}
}

/** 修复步骤：按诊断出的真实缺项给命令，不背模板 */
export function guiFallbackFixSteps(reason: GuiFallbackReason, d: GuiDiagnosis): string[] {
	const steps: string[] = [];
	const hubDown = !d.hasHubSocket || d.hubUnitActive === false;

	// hub-no-channel 的前提就是 hub 在跑（socket 在），别反过来劝人装 hub
	if (reason === "hub-unreachable" || (hubDown && reason !== "hub-no-channel")) {
		steps.push("起 hub：~/.pi/agent/hub/install.sh（看状态：systemctl --user status pi-hub.service）");
	}

	if (d.binary === null) {
		const stuck = d.candidates.find((c) => c.exists && !c.executable);
		if (stuck) {
			steps.push(`候选位有文件但不可执行：chmod +x ${stuck.path}`);
		} else {
			steps.push("构建：cd ~/.pi/agent/wails-gui && wails build -tags webkit2_41");
			// hub 只在启动时判定一次能不能拉闸门窗，构建完不重启就还是只能靠适配器
			steps.push("构建完重启 hub：systemctl --user restart pi-hub.service");
			if (!d.hasWailsCli) {
				steps.push(`没有 wails CLI：go install github.com/wailsapp/wails/v2/cmd/wails@latest${d.hasGo ? "" : "（且没找到 go，先装 Go）"}`);
			}
		}
	} else if (reason === "spawn-failed" || reason === "exited") {
		if (d.hasWebkit2Gtk41 === false) {
			steps.push("缺 WebKitGTK 4.1（wails-gui 的运行时依赖）：Arch 上 sudo pacman -S webkit2gtk-4.1");
		}
		steps.push("重构建一次：cd ~/.pi/agent/wails-gui && wails build -tags webkit2_41");
		steps.push("依赖自检：wails doctor");
	}

	if (reason === "timeout") {
		if (!d.hasDisplayEnv) {
			steps.push("当前会话没有 DISPLAY / WAYLAND_DISPLAY，图形窗无处显示；在图形会话里跑，或改用 /remote:allow-key");
		} else {
			steps.push("窗口可能被隐藏在多屏/别的虚拟桌面上；确认后在窗口里作答，或先 /remote:allow-key 走 IM 应答");
		}
	}

	if (reason === "hub-no-channel") {
		steps.push("接一个 IM 适配器（如飞书：pnpm add -g @larksuite/cli && lark-cli config init && lark-cli auth login）");
	}

	steps.push(`完整清单：${displayPath(GUI_FALLBACK_DOC)}`);
	return steps;
}

/** 给 TUI 标题用的一行短提示（不占太多行） */
export function guiFallbackTitleHint(reason: GuiFallbackReason, d = collectGuiDiagnosis(false)): string {
	return `（已回退终端审批：${guiFallbackReasonText(reason, d)}）`;
}

/** 给 notify 用的多行提示：第一行是原因，后面是修复步骤 */
export function formatGuiFallbackNotice(reason: GuiFallbackReason, d = collectGuiDiagnosis()): string {
	const lines = [`图形审批不可用，已回退终端：${guiFallbackReasonText(reason, d)}`];
	for (const [i, step] of guiFallbackFixSteps(reason, d).entries()) {
		lines.push(`${i + 1}. ${step}`);
	}
	return lines.join("\n");
}

const announced = new Set<string>();

/** 测试用：清掉进程内去重状态 */
export function resetGuiFallbackNotices(): void {
	announced.clear();
}

export interface AnnounceOptions {
	/** 跳过进程内去重，强制再提示一次 */
	force?: boolean;
	diagnosis?: GuiDiagnosis;
}

/**
 * 回退时提示一次。同一类原因在一个进程内只提示一次——审批回退会连续发生，
 * 每次都弹同一条通知会把真正要看的命令淹掉。
 *
 * 去重命中时不再跑诊断（collectGuiDiagnosis 要起 systemctl / pkg-config），
 * 返回空串表示「这次没提示」。
 */
export function announceGuiFallback(
	ctx: { ui?: { notify?(message: string, level?: string): void } } | undefined,
	reason: GuiFallbackReason,
	opts: AnnounceOptions = {},
): string {
	if (!opts.force && announced.has(reason)) return "";
	announced.add(reason);
	const notice = formatGuiFallbackNotice(reason, opts.diagnosis ?? collectGuiDiagnosis());
	try {
		ctx?.ui?.notify?.(notice, "warning");
	} catch {
		// 通知失败不影响审批本身
	}
	return notice;
}
