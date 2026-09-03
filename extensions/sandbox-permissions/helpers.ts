// helpers.ts — sandbox-allow 的纯函数（无副作用，供单测；index.ts 只做工具注册）
//
// 升权通道与 scripts/sandbox-shell.mjs 的 env 契约一一对应：
//   PI_SANDBOX_DISABLE=1            → 完全开放（sandbox-shell 直接透传 bash）
//   PI_SANDBOX_RW_EXTRA=<p>:<p>... → 额外可写根（叠加在默认 cwd 之上，不替换）

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeSandboxRoots } from "./session-access.ts";

export type Permission = "full-access" | "write-paths";

/** 单条命令进程树的默认内存上限（MB）= 1GiB。与 scripts/sandbox-shell.mjs 的 DEFAULT_MEMORY_MB 对齐。 */
export const DEFAULT_MEMORY_MB = 1024;
/** 内存上限的可申请最大值（MB）= 32GiB。超过则拒绝，防止 LLM 申请任意内存。 */
export const MAX_MEMORY_MB = 32 * 1024;

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

/** 展开前导 `~`（pi SettingsManager 会 normalize，但这里直接读 settings.json 原始值，需自行展开） */
export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return p;
}

/** 读取 settings.shellPath（展开 ~）；缺失 / 解析失败返回 undefined */
export function readShellPath(): string | undefined {
	try {
		const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
		const p = settings.shellPath;
		return typeof p === "string" && p ? expandTilde(p) : undefined;
	} catch {
		return undefined;
	}
}

/** 写路径规范化：相对路径基于 cwd 解析、消除 ..、去重，并拒绝根目录。 */
export function resolveWritePaths(paths: string[] | undefined, cwd: string): string[] {
	return normalizeSandboxRoots(paths, cwd);
}

/**
 * 构造单次 spawn 的升权 env（仅影响该子进程；不碰 process.env）。
 *   full-access：清除既有沙箱约束，PI_SANDBOX_DISABLE=1（完全开放）
 *   write-paths：保留既有 PI_SANDBOX_RW/READONLY（子 agent 场景），仅叠加 PI_SANDBOX_RW_EXTRA
 *
 * 内存限制与文件系统沙箱正交：sandbox-shell 对缺省 MEMORY_MB 的进程默认 1GiB。
 *   memoryMb 为正整数 → 注入 PI_SANDBOX_MEMORY_MB（内存墙按该值执行）
 *   memoryMb 缺省 → 删除 PI_SANDBOX_MEMORY_MB，走 sandbox-shell 默认 1GiB
 * 不注入 PI_SANDBOX_MEMORY_DISABLE：那是 /yolo 全降零的专属，由调用方（allow.ts / bash-guard）注入。
 */
export function buildEscalationEnv(
	base: NodeJS.ProcessEnv,
	permission: Permission,
	writePaths: string[],
	memoryMb?: number,
): NodeJS.ProcessEnv {
	const env = { ...base };
	if (permission === "full-access") {
		delete env.PI_SANDBOX_RW;
		delete env.PI_SANDBOX_READONLY;
		delete env.PI_SANDBOX_RW_EXTRA;
		env.PI_SANDBOX_DISABLE = "1";
	} else {
		// write-paths 不能继承一个会把它升级为 full-access 的父进程标志。
		delete env.PI_SANDBOX_DISABLE;
		if (writePaths.length > 0) env.PI_SANDBOX_RW_EXTRA = writePaths.join(":");
		else delete env.PI_SANDBOX_RW_EXTRA;
	}
	if (typeof memoryMb === "number" && Number.isInteger(memoryMb) && memoryMb > 0) {
		env.PI_SANDBOX_MEMORY_MB = String(memoryMb);
	} else {
		delete env.PI_SANDBOX_MEMORY_MB;
	}
	return env;
}

/** 校验内存上限参数（MB）：正整数且在 [1, MAX_MEMORY_MB] 内，否则返回错误文案。 */
export function validateMemoryMb(memoryMb: unknown): string | undefined {
	if (memoryMb === undefined) return undefined;
	if (typeof memoryMb !== "number" || !Number.isFinite(memoryMb) || !Number.isInteger(memoryMb)) {
		return "memoryMb 必须是整数（MB）";
	}
	if (memoryMb < 1) return "memoryMb 必须 ≥ 1 MB";
	if (memoryMb > MAX_MEMORY_MB) return `memoryMb 不能超过 ${MAX_MEMORY_MB} MB`;
	return undefined;
}

/** 构造审批标题（给用户看：命令 + 权限 + 理由；只此一次） */
export function buildApprovalTitle(
	command: string,
	permission: Permission,
	writePaths: string[],
	justification: string | undefined,
	timeout: number | undefined,
	memoryMb?: number,
): string {
	const cmd = command.length > 200 ? command.slice(0, 200) + "…" : command;
	const permText =
		permission === "full-access"
			? "完全开放（不做任何沙箱限制）"
			: `保持只读沙箱，额外可写：${writePaths.join("、") || "（无）"}`;
	const just = (justification ?? "").replace(/\s+/g, " ").trim();
	const memText = memoryMb === undefined ? `默认 1GiB（${DEFAULT_MEMORY_MB} MB）` : `${memoryMb} MB`;
	return [
		"⚠️ 请求跨越沙箱执行单条命令（仅此一次）",
		"",
		`命令：${cmd}`,
		`权限：${permText}`,
		`内存上限：${memText}（超出即终止进程组）`,
		`理由：${just || "（未提供）"}`,
		`执行时限：${timeout === undefined ? "默认" : `${timeout} 秒`}（仅在批准后生效）`,
		"",
		"是否允许？",
	].join("\n");
}
