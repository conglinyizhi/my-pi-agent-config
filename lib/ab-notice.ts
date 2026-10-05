// lib/ab-notice.ts — A/B 更新引擎留给人的一句话
//
// 晋升、回退、协议不匹配这类事发生时未必有人正看着窗口，所以先落成文件，
// 等下一次会话启动时读出来露一面，然后清掉（消费掉，避免每次都提示）。

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AB_COMPONENTS, type AbComponent } from "./ab-tag.ts";

export function noticePath(runtimeRoot: string, component: AbComponent): string {
	return join(runtimeRoot, component, "notice.txt");
}

/** 读走并清空某个组件的提示行；目录或文件不在就给空数组 */
export function takeNotices(runtimeRoot: string, component: AbComponent): string[] {
	const path = noticePath(runtimeRoot, component);
	if (!existsSync(path)) return [];
	try {
		const lines = readFileSync(path, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
		// 先清空再返回：读失败时不清，宁可能重复一次也别丢
		writeFileSync(path, "", "utf8");
		return lines;
	} catch {
		return [];
	}
}

/** 两个组件都读一遍；没有提示的组件不出现在结果里 */
export function takeAllNotices(runtimeRoot: string): Array<{ component: AbComponent; lines: string[] }> {
	const out: Array<{ component: AbComponent; lines: string[] }> = [];
	for (const component of AB_COMPONENTS) {
		const lines = takeNotices(runtimeRoot, component);
		if (lines.length > 0) out.push({ component, lines });
	}
	return out;
}

/** 丢弃某个组件的提示（用于测试与手工清理） */
export function clearNotices(runtimeRoot: string, component: AbComponent): void {
	const path = noticePath(runtimeRoot, component);
	if (existsSync(path)) rmSync(path, { force: true });
}
