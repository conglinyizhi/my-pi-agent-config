// lib/review-flow/load.ts — 加载作者写的流程
//
// 约定：目录下每个 .ts / .js 文件对应一条流程，**文件名就是流程 id**（bash-pre.ts 覆盖内置的 bash-pre）。
// 文件形状两种都收：
//
//   export default (kit) => kit.flow({ ... })     // 推荐：工具集注入，运行时不需要 import
//   export default { flow: {...}, nodes: {...} }  // 也行：自己把两半拼好
//
// 加载失败一律不抛给审核路径：写一条崩溃报告 + 退回内置那条，审核面绝不因为作者的脚本写坏而失守。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendCrashReport } from "../ab-crash-report.ts";
import { createKit } from "./kit.ts";
import { checkFlowSource, formatViolations } from "./source-guard.ts";
import type { NodeImpl } from "./runner.ts";
import { describeProblems, validateFlow } from "./validate.ts";
import type { Flow } from "./types.ts";

export interface LoadedFlow {
	id: string;
	flow: Flow;
	/** 作者自己的节点实现（按节点 id） */
	nodes: Record<string, NodeImpl>;
	/** 从哪个文件来的 */
	source: string;
}

/** 作者流程目录：默认 ~/.pi/agent/review-flows，可用 PI_REVIEW_FLOWS_DIR 换 */
export function flowsDir(explicit?: string): string {
	return explicit ?? process.env.PI_REVIEW_FLOWS_DIR ?? join(homedir(), ".pi", "agent", "review-flows");
}

/** kit 扩展的文件名：作者自己的 SDK 从这儿进来 */
export const KIT_FILE = "kit.ts";

/**
 * 装载作者自己的 SDK，并挂到 kit 上交给流程用。
 *
 * 这个文件**不受流程的越界检查约束**：它是宿主侧的代码（你自己写、你自己信），
 * 而流程是单文件的判定脚本。分界线在这里：能力从 kit 进来，流程只管判定。
 *
 * 形状：export default (kit) => ({ ...kit, my: { ... } })
 */
export async function loadKitExtra(dir = flowsDir()): Promise<{ kit: ReturnType<typeof createKit>; source?: string }> {
	const path = join(dir, KIT_FILE);
	if (!existsSync(path)) return { kit: createKit() };
	try {
		const url = `${pathToFileURL(path).href}?v=${Date.now()}`;
		const mod = (await import(url)) as { default?: unknown };
		if (typeof mod.default !== "function") return { kit: createKit(), source: path };
		const base = createKit();
		const extended = (mod.default as (kit: unknown) => unknown)(base);
		if (!extended || typeof extended !== "object") return { kit: base, source: path };
		return { kit: extended as ReturnType<typeof createKit>, source: path };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		appendCrashReport({
			at: new Date().toISOString(),
			component: "audit",
			stage: "加载审核流程",
			summary: `kit 扩展没加载上，流程只能用内置节点：${message}`,
			module: path,
			hint: `改好 ${path} 后 /reload；不影响内置节点`,
		});
		return { kit: createKit(), source: path };
	}
}

/** 目录里有哪些流程文件（文件名去掉扩展名就是流程 id） */
export function listFlowFiles(dir: string): Array<{ id: string; path: string }> {
	if (!existsSync(dir)) return [];
	const out: Array<{ id: string; path: string }> = [];
	for (const name of readdirSync(dir)) {
		if (!/\.(ts|js|mts|mjs)$/.test(name)) continue;
		if (name.startsWith("_") || name.endsWith(".d.ts")) continue;
		// kit.ts 是"sdk 注入"那个文件，不是流程
		if (name === KIT_FILE) continue;
		out.push({ id: name.replace(/\.(ts|js|mts|mjs)$/, ""), path: join(dir, name) });
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 把作者给的默认导出收成 { flow, nodes } */
export function normalizeExport(
	exported: unknown,
	kit: unknown = createKit(),
): { flow: Flow; nodes: Record<string, NodeImpl> } | { error: string } {
	const value = typeof exported === "function" ? (exported as (kit: unknown) => unknown)(kit) : exported;
	if (!value || typeof value !== "object") return { error: "默认导出既不是函数也不是对象" };
	const record = value as { flow?: unknown; nodes?: unknown };
	if (!record.flow || typeof record.flow !== "object") return { error: "没有 flow 字段（用 kit.flow({...}) 收口）" };
	return {
		flow: record.flow as Flow,
		nodes: (record.nodes && typeof record.nodes === "object" ? record.nodes : {}) as Record<string, NodeImpl>,
	};
}

/** 加载一个流程文件；任何问题都返回 error，不抛 */
export async function loadFlowFile(
	id: string,
	path: string,
	kit?: unknown,
): Promise<LoadedFlow | { error: string; id: string; source: string }> {
	try {
		// 先看源码，再决定要不要执行它：越界的文件根本不会被 import 进来
		const source = readFileSync(path, "utf8");
		const violations = await checkFlowSource(source, path);
		if (violations.length > 0) return { error: formatViolations(violations, path), id, source: path };

		// Node 自带类型擦除（v26 的 process.features.typescript === "strip"），
		// 所以 .ts 直接 import 就行，不必借 pi 包里那份 jiti。
		// 带令牌是防缓存：同一个路径改完再加载要拿到新的那份。
		const url = `${pathToFileURL(path).href}?v=${Date.now()}`;
		const mod = (await import(url)) as { default?: unknown };
		const normalized = normalizeExport(mod.default, kit);
		if ("error" in normalized) return { error: normalized.error, id, source: path };
		const problems = validateFlow(normalized.flow);
		if (problems.length > 0) return { error: describeProblems(normalized.flow.id, problems), id, source: path };
		return { id, flow: normalized.flow, nodes: normalized.nodes, source: path };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `加载失败：${message}`, id, source: path };
	}
}

let cache: { dir: string; flows: Map<string, LoadedFlow> } | undefined;

/**
 * 按 id 取一条作者流程；目录只扫一次（改完流程要 /reload 或重开会话才生效）。
 * 找不到就返回 undefined，调用方退回内置那条。
 */
export async function findFlow(id: string, dir = flowsDir()): Promise<LoadedFlow | undefined> {
	if (!cache || cache.dir !== dir) {
		const { flows } = await loadFlows(dir);
		cache = { dir, flows };
	}
	return cache.flows.get(id);
}

/** 测试用：清掉目录缓存 */
export function resetFlowCache(): void {
	cache = undefined;
}

/**
 * 加载整个目录。坏掉的流程不影响别的：它自己退回内置那条，并留一条崩溃报告。
 */
export async function loadFlows(dir = flowsDir()): Promise<{ flows: Map<string, LoadedFlow>; problems: Array<{ id: string; source: string; error: string }> }> {
	const flows = new Map<string, LoadedFlow>();
	const problems: Array<{ id: string; source: string; error: string }> = [];
	// 先装作者的 SDK（kit 扩展），流程拿到的是扩展后的那一份
	const { kit } = await loadKitExtra(dir);
	for (const { id, path } of listFlowFiles(dir)) {
		const loaded = await loadFlowFile(id, path, kit);
		if ("error" in loaded) {
			problems.push({ id, source: path, error: loaded.error });
			appendCrashReport({
				at: new Date().toISOString(),
				component: "audit",
				stage: "加载审核流程",
				summary: `自写流程 ${id} 没加载上，已退回内置那条：${loaded.error.split("\n")[0] ?? ""}`,
				module: path,
				context: { 流程: id, 目录: dir },
				hint: `改好 ${path} 后重开一次会话（或 /reload）；不影响内置流程`,
			});
			continue;
		}
		flows.set(id, loaded);
	}
	return { flows, problems };
}
