// content.ts — 规则 md 的读取，按「路径 + mtime + size」缓存
//
// 段文本每轮装配都要取一次，直接 readFileSync 会把同一份文件读一遍又一遍。
// 缓存键是绝对路径，失效条件是 mtimeMs 或 size 变了；文件改了就重读，
// 没改就一直用内存里那份。
//
// 读失败一律返回结构化结果，不抛：调用方（段文本）要的是「拿不到就空段」，
// 让一个坏文件把整次会话装配带崩是不划算的。

import { readFileSync, statSync } from "node:fs";

export interface FileRead {
	ok: boolean;
	text: string;
	/** 失败原因（ok=false 时非空） */
	reason?: string;
	/** 文件字节数（ok=true 时） */
	bytes?: number;
	/** 是否命中缓存（诊断用） */
	cached?: boolean;
}

interface CacheEntry {
	mtimeMs: number;
	size: number;
	text: string;
}

const cache = new Map<string, CacheEntry>();

function describeError(err: unknown): string {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") return "文件不存在";
	if (code === "EACCES") return "无读权限";
	if (code === "EISDIR") return "是目录";
	return err instanceof Error ? err.message : String(err);
}

/** 读文本（带缓存）。绝不抛异常。 */
export function readTextCached(path: string): FileRead {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch (err) {
		return { ok: false, text: "", reason: describeError(err) };
	}
	if (!stat.isFile()) return { ok: false, text: "", reason: "不是普通文件" };

	const hit = cache.get(path);
	if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
		return { ok: true, text: hit.text, bytes: hit.size, cached: true };
	}

	try {
		const text = readFileSync(path, "utf8");
		cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, text });
		return { ok: true, text, bytes: stat.size };
	} catch (err) {
		return { ok: false, text: "", reason: describeError(err) };
	}
}

/** 清空缓存（测试与 /repo-prompts 强制重读用） */
export function clearContentCache(): void {
	cache.clear();
}

/** 缓存条数（诊断用） */
export function contentCacheSize(): number {
	return cache.size;
}
