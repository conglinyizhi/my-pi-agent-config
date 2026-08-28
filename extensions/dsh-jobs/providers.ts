// providers.ts — dsh-jobs 的 bash 后台任务提供方（走 pi 沙盒通道）
//
// 说明：原实现用 child_process.spawn(command, { shell: true }) 直接起 bash，
// 绕过 pi 的 shellPath（scripts/sandbox-shell.mjs）Landlock 内核写保护；危险命令
// 审批（gate）与敏感路径黑名单（guard）也因工具名非 "bash" 而放行。
//
// 2026-08 重构：bash 后台执行改走公共库 lib/sandboxed-command.ts 的
// createSandboxedCommandJob，底层复用 pi 的 createLocalBashOperations({shellPath})，
// 与内建 bash、sandbox-allow 走同一沙盒通道。本文件只保留对外接口 bashBackground，
// 供 tools.ts 引用，签名与语义不变。

import { createSandboxedCommandJob } from "../../lib/sandboxed-command.ts";
import type { JobStart } from "./registry.ts";

/** 输出累积上限（与公共库一致；公共库已导出同值） */
export const MAX_OUTPUT_BYTES = 1_000_000;

export interface BashBackgroundOptions {
	cwd: string;
	sessionId?: string;
}

/**
 * 构造一个受保护的 bash 后台任务声明（交 JobRegistry.start 注册）。
 * @param command 完整 shell 命令
 * @param options 工作目录等
 */
export function bashBackground(command: string, options: BashBackgroundOptions): JobStart {
	return createSandboxedCommandJob(command, { cwd: options.cwd, sessionId: options.sessionId });
}
