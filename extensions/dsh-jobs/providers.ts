// providers.ts — dsh-jobs 的 bash 后台任务提供方（spawn 子进程）
//
// 语义：kind="bash"，label=命令，hooks 提供 cancel（杀进程）/ done（exit 结算）/
// readOutput（stdout+stderr 累积增量，上限截断）。

import { spawn, type ChildProcess } from "node:child_process";
import type { JobHooks, JobOutcome, JobStart } from "./registry.ts";

/** 输出累积上限（超限截断并标注，防内存膨胀） */
export const MAX_OUTPUT_BYTES = 1_000_000;

export interface BashBackgroundOptions {
	cwd: string;
}

/**
 * 构造一个 bash 后台任务声明（交 JobRegistry.start 注册）。
 * @param command 完整 shell 命令
 * @param options 工作目录等
 */
export function bashBackground(command: string, options: BashBackgroundOptions): JobStart {
	return {
		kind: "bash",
		label: command,
		run(): JobHooks {
			const chunks: string[] = [];
			let total = 0;
			let child: ChildProcess | undefined;

			const append = (text: string): void => {
				if (total >= MAX_OUTPUT_BYTES) return;
				const room = MAX_OUTPUT_BYTES - total;
				chunks.push(room >= text.length ? text : text.slice(0, room) + "\n[output truncated]");
				total += Math.min(text.length, room);
			};

			const done = new Promise<JobOutcome>((resolve) => {
				child = spawn(command, {
					cwd: options.cwd,
					shell: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
				child.stdout!.on("data", (data: Buffer) => append(data.toString()));
				child.stderr!.on("data", (data: Buffer) => append(data.toString()));
				child.on("error", (err) => {
					resolve({ status: "failed", detail: err.message });
				});
				child.on("close", (code, signal) => {
					if (signal) {
						// 被 kill（child.kill 触发）→ 结算 killed
						resolve({ status: "killed", detail: `killed by ${signal}` });
						return;
					}
					resolve({
						status: code === 0 ? "completed" : "failed",
						detail: `exit code: ${code ?? "?"}`,
					});
				});
			});

			return {
				cancel: (reason?: string) => {
					if (child && !child.killed) child.kill();
				},
				done,
				readOutput: () => chunks.join(""),
			};
		},
	};
}
