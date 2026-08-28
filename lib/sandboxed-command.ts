// lib/sandboxed-command.ts — 受保护本地命令执行（公共库）
//
// 目的：把「在 pi 沙盒体系下执行 shell 命令」提成可复用的公共层。内建 bash 工具
// 与 sandbox-allow 都经由 pi 的 shellPath（scripts/sandbox-shell.mjs）执行，把命令
// 包进 Landlock 内核写保护；本库对齐同一通道，供需要启动 shell/后台进程的扩展复用，
// 避免各家用裸 spawn(shell:true) 绕过沙盒。
//
// 对外形态：两种消费方式，按调用方需要选。
//   1. createSandboxedCommandJob() — 返回 dsh-jobs 的 JobStart。bash_background
//      依赖进程内后台任务注册表，job 的 start/cancel/done/readOutput 一次性对齐
//      JobRegistry 契约，语义与现有 providers.ts 完全一致。
//   2. createSandboxedExec() — 返回 BashOperations.exec 形态的薄封装，供一次性
//      执行（如 sandbox-allow 或未来其他工具）直接用，等价 createLocalBashOperations。
//
// 依赖 pi 导出：createLocalBashOperations 走 settings.shellPath（sandbox-shell.mjs），
// 命令经 Landlock（--ro / + --rw <cwd>/tmp）内核级写保护；abort 时杀整棵进程树。
//
// 注意：本库只负责「执行通道」的受保护化，不涉及其它工具的鉴权/审批流程——
// 那是调用方（gate/allow）的职责。公共库保证的是：任何 shell 命令从本库发出，
// 都在 pi 的沙盒通道内，而非裸 spawn。

import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { addSessionWriteDirsToEnv } from "../extensions/sandbox-permissions/session-access.ts";

import type { JobHooks, JobOutcome, JobStart } from "../extensions/dsh-jobs/registry.ts";

/** 输出累积上限（超限截断并标注，防内存膨胀）；与 dsh-jobs 原 providers 一致 */
export const MAX_OUTPUT_BYTES = 1_000_000;

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

/** 读取 settings.shellPath（展开 ~）；缺失 / 解析失败返回 undefined（回退 pi 默认 shell） */
export function readShellPath(): string | undefined {
	try {
		const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
		const p = settings.shellPath;
		return typeof p === "string" && p ? expandTilde(p) : undefined;
	} catch {
		return undefined;
	}
}

/** 展开前导 `~` */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return p;
}

export interface SandboxedCommandOptions {
	/** 工作目录；缺省用当前 cwd */
	cwd?: string;
	/** 额外环境变量。缺省不传，pi 用默认 shell env；传入会被当作整份 env */
	env?: NodeJS.ProcessEnv;
	/** 超时（秒）；与 pi 内建 bash 的 timeout 参数一致 */
	timeoutMs?: number;
	/** 启动时捕获的 session ID；缺省不继承 session 临时授权 */
	sessionId?: string;
}

/** 一次性执行形态：返回 BashOperations.exec 封装，等价 createLocalBashOperations({shellPath}) */
export function createSandboxedExec(options: SandboxedCommandOptions = {}) {
	const ops = createLocalBashOperations({ shellPath: readShellPath() });
	return (
		command: string,
		cwd?: string,
		extra?: { signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
	) =>
		ops.exec(command, cwd ?? options.cwd ?? process.cwd(), {
			onData: () => {}, // 一次性执行不流式；需流式用 job 形态
			signal: extra?.signal,
			timeout: extra?.timeout ?? options.timeoutMs,
			env: addSessionWriteDirsToEnv(extra?.env ?? options.env, options.sessionId),
		});
}

/**
 * 构造一个受保护 bash 后台任务声明（交 JobRegistry.start 注册）。
 * run() 同步返回 hooks（JobRegistry 契约）；启动与结算在内部闭环。
 * 执行通道 = createLocalBashOperations（shellPath → sandbox-shell.mjs → Landlock）。
 */
export function createSandboxedCommandJob(
	command: string,
	options: SandboxedCommandOptions = {},
): JobStart {
	return {
		kind: "bash",
		label: command,
		run(): JobHooks {
			const chunks: string[] = [];
			let total = 0;
			// cancel 通过 abort signal 触发（createLocalBashOperations 会杀整棵进程树）
			const ac = new AbortController();

			const append = (text: string): void => {
				if (total >= MAX_OUTPUT_BYTES) return;
				const room = MAX_OUTPUT_BYTES - total;
				chunks.push(room >= text.length ? text : text.slice(0, room) + "\n[output truncated]");
				total += Math.min(text.length, room);
			};

			const done = new Promise<JobOutcome>((resolve) => {
				const ops = createLocalBashOperations({ shellPath: readShellPath() });
				const cwd = options.cwd ?? process.cwd();

				// createLocalBashOperations.exec：abort → reject("aborted")；
				// timeout → reject("timeout:<s>")；成功 resolve({exitCode})。
				// .then 与 .catch 互斥，promise 恰好结算一次，无需额外 settled 位。
				ops
					.exec(command, cwd, {
						onData: (d) => append(d.toString()),
						signal: ac.signal,
						timeout: options.timeoutMs,
						env: addSessionWriteDirsToEnv(options.env, options.sessionId),
					})
					.then((result) => {
						resolve({
							status: result.exitCode === 0 ? "completed" : "failed",
							detail: result.exitCode === 0 ? undefined : `exit code: ${result.exitCode ?? "?"}`,
						});
					})
					.catch((err) => {
						const msg = err instanceof Error ? err.message : String(err);
						if (msg === "aborted") resolve({ status: "killed", detail: "killed by abort" });
						else if (msg.startsWith("timeout:")) resolve({ status: "failed", detail: `timed out after ${msg.split(":")[1]}s` });
						else resolve({ status: "failed", detail: msg });
					});
			});

			return {
				cancel: (_reason?: string) => {
					if (!ac.signal.aborted) ac.abort();
				},
				done,
				readOutput: () => chunks.join(""),
			};
		},
	};
}
