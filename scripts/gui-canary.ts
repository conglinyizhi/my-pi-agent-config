// gui-canary.ts — 切换前强制金丝雀：真起一次候选，验它能活、能干净退出
//
// 由来：A/B 的“干净往返”来自正在跑的那一版，证明不了候选那版能跑。
// 2026-10-05 打包时删了 flowsBridge 的定义却漏下两处调用，包照样打进槽，
// 提督开窗时崩在 will-quit 上——没有任何环节会去启动新构建。
//
// 查三件事，缺一条就不许晋升：
//   1. 起得来（宽限期内进程还活着）
//   2. 日志里没有崩溃标记（Uncaught / ReferenceError / A JavaScript error …）
//   3. 收到 TERM 之后退得干净——退出路径上的崩溃通常表现为"卡住不退"：
//      Electron 会弹崩溃对话框，异常反而不落进日志，所以这条不能只靠关键字
//
// 没有图形会话时不算通过：返回 skipped，交给调用方（ab-update 会拒绝生成候选，
// 要越过就 FORCE=1）。宁可不晋升，也不假装验过。

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 日志里出现这些就当崩了（Electron 的未捕获异常都带这些字样） */
const CRASH_MARKERS = ["Uncaught", "ReferenceError", "TypeError", "A JavaScript error", "not defined", "Cannot find module"];

export interface CanaryResult {
	ok: boolean;
	/** 没跑（比如没有图形会话）：ok=false 且这里说明原因 */
	skipped?: string;
	reason: string;
	/** 日志尾部，失败时贴给人看 */
	logTail?: string;
}

export interface CanaryOptions {
	/** 仓库根（默认 cwd） */
	repoRoot?: string;
	/** 宽限期：这段时间内进程必须还活着 */
	graceMs?: number;
	/** 收到 TERM 之后最多等多久 */
	quitWaitMs?: number;
	/** 交给子进程的环境（缺省沿用当前环境） */
	env?: NodeJS.ProcessEnv;
}

export interface CanaryDeps {
	spawn?: typeof nodeSpawn;
	sleep?: (ms: number) => Promise<void>;
	hasDisplay?: () => boolean;
}

function hasGraphicalSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.WAYLAND_DISPLAY || env.DISPLAY);
}

function findCrash(log: string): string | undefined {
	for (const marker of CRASH_MARKERS) {
		if (log.includes(marker)) return marker;
	}
	return undefined;
}

/** 跑一次金丝雀。失败时 reason 是给人看的一句话，logTail 是证据 */
export async function runGuiCanary(options: CanaryOptions = {}, deps: CanaryDeps = {}): Promise<CanaryResult> {
	const spawn = deps.spawn ?? nodeSpawn;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const hasDisplay = deps.hasDisplay ?? (() => hasGraphicalSession(options.env ?? process.env));
	const repoRoot = options.repoRoot ?? process.cwd();
	const graceMs = options.graceMs ?? 8000;
	const quitWaitMs = options.quitWaitMs ?? 4000;

	if (!hasDisplay()) {
		return { ok: false, skipped: "没有图形会话（DISPLAY / WAYLAND_DISPLAY 都空）", reason: "环境不足，没验" };
	}

	const preview = join(repoRoot, "bin", "gui-preview.sh");
	if (!existsSync(preview)) return { ok: false, reason: `找不到 ${preview}` };

	let child: ChildProcess;
	let log = "";
	try {
		child = spawn(preview, ["gate"], { cwd: repoRoot, env: { ...(options.env ?? process.env) }, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		return { ok: false, reason: `起不来：${error instanceof Error ? error.message : String(error)}` };
	}
	child.stdout?.on("data", (chunk: Buffer) => { log += chunk.toString(); });
	child.stderr?.on("data", (chunk: Buffer) => { log += chunk.toString(); });

	let exited = false;
	let exitCode: number | null = null;
	let exitSignal: string | null = null;
	child.on("exit", (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });

	await sleep(graceMs);
	if (exited) {
		return { ok: false, reason: `宽限期内就退了（code=${exitCode} signal=${exitSignal}）`, logTail: log.slice(-800) };
	}
	const earlyCrash = findCrash(log);
	if (earlyCrash) {
		child.kill("SIGTERM");
		return { ok: false, reason: `日志里有崩溃标记：${earlyCrash}`, logTail: log.slice(-800) };
	}

	// 活过宽限期：收工。退出路径上的崩溃在这一步暴露（flowsBridge 那次就是它）
	child.kill("SIGTERM");
	await sleep(quitWaitMs);
	if (!exited) {
		child.kill("SIGKILL");
		return { ok: false, reason: `收到 TERM 之后 ${quitWaitMs}ms 没退`, logTail: log.slice(-800) };
	}
	const killedBySignal = exitSignal !== null;
	if (!killedBySignal && exitCode !== 0 && exitCode !== 143) {
		return { ok: false, reason: `退出码 ${exitCode}（既不是 0，也不是被 TERM 收走）`, logTail: log.slice(-800) };
	}
	const lateCrash = findCrash(log);
	if (lateCrash) {
		return { ok: false, reason: `退出路径上崩了：${lateCrash}`, logTail: log.slice(-800) };
	}
	return { ok: true, reason: `起来了、活过 ${graceMs}ms、退出干净（日志 ${log.length} 字节）` };
}

/** 命令行入口：node --experimental-strip-types scripts/gui-canary.ts [--repo-root <dir>] [--json] */
async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const json = argv.includes("--json");
	const at = argv.indexOf("--repo-root");
	const repoRoot = at >= 0 && argv[at + 1] ? argv[at + 1] : process.cwd();
	const result = await runGuiCanary({ repoRoot });
	if (json) {
		process.stdout.write(JSON.stringify(result) + "\n");
	} else {
		process.stdout.write((result.ok ? "金丝雀通过：" : result.skipped ? "金丝雀没跑：" : "金丝雀没过：") + result.reason + "\n");
		if (result.logTail) process.stdout.write("--- 日志尾部 ---\n" + result.logTail + "\n");
	}
	process.exit(result.ok ? 0 : 1);
}

// 只在被当脚本跑时执行：测试会 import 本文件，不能顺手把 Electron 起了
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}

