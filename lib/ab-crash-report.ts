// lib/ab-crash-report.ts — 崩溃报告：给人看的那一份
//
// 现场（lib/ab-crash.ts）是给机器看的：目录 0700、JSON、只留在状态目录。
// 这一份是给人的：追加到 ~/.pi/agent/ab_update.crash.md，标题一行就能看出该修什么，
// 下面跟崩溃详情、崩溃模块与调用上下文，接上现场路径。
//
// 位置放在 agent 目录（提督 2026-10-05 定的），方便随手打开、随手修。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AbComponent } from "./ab-slots.ts";

/** 报告超过这个大小就只留最新的部分（默认 256 KiB） */
export const REPORT_MAX_BYTES = 256 * 1024;

export interface CrashReport {
	at: string;
	component: AbComponent | "flow";
	/** 阶段：加载扩展 / 启动窗口 / 审批往返 / 自检…… */
	stage: string;
	/** 一句话说清出了什么（进标题） */
	summary: string;
	/** 崩溃模块：文件与函数 */
	module?: string;
	error?: { name?: string; message?: string; stack?: string };
	/** 调用上下文：键值对，按行渲染 */
	context?: Record<string, string | number | boolean | undefined>;
	/** 相关文件（现场目录、请求文件、日志……） */
	files?: string[];
	/** 一行处置建议 */
	hint?: string;
}

/** 时间戳写成 2026-10-05 12:34:56 +0800 这种能直接读的样子 */
export function humanStamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, "0");
	const offsetMin = -date.getTimezoneOffset();
	const sign = offsetMin >= 0 ? "+" : "-";
	const offset = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}${pad(Math.abs(offsetMin) % 60)}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset}`;
}

/** 一条报告：标题一行给结论，正文给详情、模块与上下文 */
export function formatCrashReport(report: CrashReport): string {
	const lines: string[] = [];
	lines.push(`# [${humanStamp(report.at)}] // TODO 修：${report.summary}`);
	lines.push("");
	lines.push(`- 组件：${report.component}`);
	lines.push(`- 阶段：${report.stage}`);
	if (report.module) lines.push(`- 崩溃模块：${report.module}`);
	if (report.hint) lines.push(`- 处置：${report.hint}`);
	if (report.error) {
		lines.push("");
		lines.push("## 错误");
		lines.push("```");
		if (report.error.name || report.error.message) {
			lines.push(`${report.error.name ?? "Error"}: ${report.error.message ?? "(没有消息)"}`);
		}
		if (report.error.stack) lines.push(report.error.stack.trimEnd());
		lines.push("```");
	}
	const contextEntries = Object.entries(report.context ?? {}).filter(([, value]) => value !== undefined);
	if (contextEntries.length > 0) {
		lines.push("");
		lines.push("## 调用上下文");
		for (const [key, value] of contextEntries) lines.push(`- ${key}: ${String(value)}`);
	}
	if (report.files && report.files.length > 0) {
		lines.push("");
		lines.push("## 相关文件");
		for (const file of report.files) lines.push(`- ${file}`);
	}
	lines.push("");
	return lines.join("\n");
}

/** 报告文件的位置：默认 ~/.pi/agent/ab_update.crash.md */
export function crashReportPath(agentDir?: string): string {
	const dir = agentDir ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(dir, "ab_update.crash.md");
}

/** 按条目切开（标题行是分界），截断与去重都用它 */
export function splitReports(text: string): string[] {
	return text
		.split(/^(?=# \[)/m)
		.map((part) => part.trimEnd())
		.filter((part) => part.trim() !== "");
}

/**
 * 追加一条报告。返回落盘路径与最终大小。
 *
 * 超过 maxBytes 时只留最新的部分：报告是给人看的，翻到几千行就没人看了。
 */
export function appendCrashReport(
	report: CrashReport,
	options: { agentDir?: string; maxBytes?: number } = {},
): { path: string; bytes: number } {
	const path = crashReportPath(options.agentDir);
	const maxBytes = options.maxBytes ?? REPORT_MAX_BYTES;
	const entry = formatCrashReport(report);
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	let text = existing === "" ? entry : `${existing.trimEnd()}\n\n${entry}`;
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		const reports = splitReports(text);
		// 从最新往回留，留到接近上限为止
		const kept: string[] = [];
		let size = 0;
		for (let index = reports.length - 1; index >= 0; index -= 1) {
			const part = reports[index] as string;
			const partSize = Buffer.byteLength(`${part}\n\n`, "utf8");
			if (size + partSize > maxBytes && kept.length > 0) break;
			size += partSize;
			kept.unshift(part);
		}
		text = `${kept.join("\n\n")}\n`;
	}
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, { mode: 0o600 });
	return { path, bytes: existsSync(path) ? statSync(path).size : Buffer.byteLength(text, "utf8") };
}
